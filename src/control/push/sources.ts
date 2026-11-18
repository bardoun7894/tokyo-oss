import { deployProgress } from "../ops-deploy";
import { listIncidents } from "../ops-incidents";
import type { OpsStore } from "../ops-store";
import { actionRow, deployRow, type OffersDeps } from "../offers";
import { missionRow } from "../mission-offers";
import type { ControlRun } from "../store";
import type { PushEvent } from "./format";

// Snapshot readers for the dispatcher: each answers "what is true now" as keyed events, and the dispatcher diffs them
// against the keys it has seen. Names, ids and states only; nothing here reads a prompt, a log or a path.

export interface SourceEvent {
  /** The event key of plan section 5, unique per (source, thing that happened). */
  key: string;
  event: PushEvent;
  /** A device that caused the event itself (a run stopped from the app) and must not be told. */
  except?: string;
}
export interface PushSource { name: string; read(): SourceEvent[] | Promise<SourceEvent[]> }

export interface OfferSourceDeps {
  offers: Pick<OffersDeps, "now" | "listActions" | "listDeploys" | "listMissions">;
  getRun(id: string): ControlRun | undefined;
  /** Whether the Mac still holds the run of an approved deploy (see deployProgress). */
  waiting?(runId: string): boolean;
}

/** A pending action, deploy or mission offer is one `approval.new` (key `offer:<id>`). */
export function offersSource(d: OfferSourceDeps): PushSource {
  return {
    name: "offers",
    read: () => {
      const now = d.offers.now();
      const rows = [
        ...d.offers.listActions().map((o) => actionRow(o, now)),
        ...d.offers.listDeploys().map((o) => deployRow(o, now)),
        ...(d.offers.listMissions?.() ?? []).map((m) => missionRow(m, now)),
      ];
      return rows.filter((r) => r.state === "pending").map((r) => ({ key: `offer:${r.id}`, event: { type: "approval.new", id: r.id, project: r.project } }));
    },
  };
}

/** A deploy offer that ended is one `deploy.result` (key `deploy:<offerId>:<outcome>`), by the X12 outcome rules. */
export function deploysSource(d: OfferSourceDeps): PushSource {
  return {
    name: "deploys",
    read: () => {
      const now = d.offers.now();
      const out: SourceEvent[] = [];
      for (const o of d.offers.listDeploys()) {
        const run = o.runId ? d.getRun(o.runId) : undefined;
        const p = deployProgress(o, run, now, o.runId ? d.waiting?.(o.runId) === true : false);
        if (p.outcome === "succeeded" || p.outcome === "failed" || p.outcome === "skipped") {
          out.push({ key: `deploy:${o.id}:${p.outcome}`, event: { type: "deploy.result", id: o.id, project: o.project.name, outcome: p.outcome } });
        }
      }
      return out;
    },
  };
}

export interface RunSourceDeps {
  /** Recently active runs, any status (the Control run table). */
  listRuns(): ControlRun[];
  /** The device that stopped a run from the app, when known: it is not told about its own action. */
  stoppedBy?(runId: string): string | undefined;
}

/** A run that ended is one `run.finished` (succeeded) or `run.failed` (failed, stopped); key `run:<id>:<final status>`. */
export function runsSource(d: RunSourceDeps): PushSource {
  return {
    name: "runs",
    read: () => {
      const out: SourceEvent[] = [];
      for (const r of d.listRuns()) {
        const key = `run:${r.id}:${r.status}`;
        if (r.status === "succeeded") out.push({ key, event: { type: "run.finished", id: r.id, project: r.project } });
        else if (r.status === "failed") out.push({ key, event: { type: "run.failed", id: r.id, project: r.project, outcome: "failed" } });
        else if (r.status === "stopped") {
          const except = d.stoppedBy?.(r.id);
          out.push({ key, event: { type: "run.failed", id: r.id, project: r.project, outcome: "stopped" }, ...(except ? { except } : {}) });
        }
      }
      return out;
    },
  };
}

export interface IncidentSourceDeps {
  godhome: { summary(window: string): Promise<{ reachable: boolean; data: unknown }> };
  /** The 003 overlay (acked, muted, manually resolved) and the opaque id map. */
  ops: OpsStore;
  now(): number;
}

/**
 * Open critical and warning incidents of X5, with the 003 overlay applied: acked, muted and manually resolved ones are
 * not listed, so they never push. One event per episode (key `incident:<opaque id>:<firstAt>`): a later `lastAt` on the
 * same open incident is not a new event. GodHome unreachable throws, so the dispatcher neither seeds nor sees events
 * from a stale answer and logs one line for the outage.
 */
export function incidentsSource(d: IncidentSourceDeps): PushSource {
  return {
    name: "incidents",
    read: async () => {
      const got = await d.godhome.summary("all");
      if (!got.reachable || got.data === null) throw new Error("unreachable");
      const now = d.now();
      const { items } = listIncidents(got.data, { state: "open", limit: 200 }, d.ops, [], now);
      const out: SourceEvent[] = [];
      for (const i of items) {
        if (i.acked || (i.severity !== "critical" && i.severity !== "warning")) continue;
        const first = i.firstAt ? Math.floor(Date.parse(i.firstAt) / 1000) : 0;
        out.push({ key: `incident:${i.id}:${first}`, event: { type: "incident.new", id: i.id, level: i.severity, title: i.title } });
      }
      return out;
    },
  };
}

/** Who stopped which run from the app, kept in memory for an hour: the stopping device is not told about its own action. */
export class StopLog {
  private readonly stops = new Map<string, { deviceId: string; at: number }>();
  constructor(private readonly ttlMs = 60 * 60 * 1000, private readonly now: () => number = Date.now) {}

  record(runId: string, deviceId: string): void {
    const t = this.now();
    for (const [id, s] of this.stops) if (t - s.at > this.ttlMs) this.stops.delete(id);
    this.stops.set(runId, { deviceId, at: t });
  }

  who(runId: string): string | undefined {
    const s = this.stops.get(runId);
    if (!s) return undefined;
    if (this.now() - s.at > this.ttlMs) { this.stops.delete(runId); return undefined; }
    return s.deviceId;
  }
}
