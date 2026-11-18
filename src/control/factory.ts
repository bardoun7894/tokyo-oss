import { execFile } from "child_process";
import express from "express";
import { errorBody } from "./contract";
import { redact } from "./redact";

/**
 * The software factory (kanban queue) as a source of the Control API. The factory runs on this server (one repo, D16), no ssh.
 * Only `factory status --json`, `flow <id>`, `fix <id>`, `retry <id>`, `pause` and `resume` are run, as the local `FACTORY_BIN`
 * with a fixed argv, and every reply is mapped field by field into the shapes below: nothing the factory prints reaches the
 * phone as is. A factory that does not answer only leaves the lists empty (`reachable: false`).
 */
export type FactoryExec = (args: string[]) => Promise<{ code: number; stdout: string }>;

export interface FactoryOptions {
  exec?: FactoryExec;
  now?: () => number;
  ttlMs?: number;
}

export const FACTORY_COLUMNS = ["backlog", "blocked", "in-progress", "done", "failed"] as const;
export const MERGE_OUTCOMES = ["merged", "conflict", "gate", "protected", "error"] as const;
export const VALIDATIONS = ["pass", "fail", "skipped"] as const;
export const STEP_KINDS = ["route", "plan", "build", "gate", "validate", "review", "merge", "rebuild", "fix"] as const;
export const STEP_STATES = ["pending", "running", "pass", "fail", "skipped"] as const;
export const FIX_STATES = ["none", "running", "pass", "fail"] as const;
export const FIX_RUNTIMES = ["claude", "agent"] as const;
type Column = (typeof FACTORY_COLUMNS)[number];
type Validation = (typeof VALIDATIONS)[number];
type MergeOutcome = (typeof MERGE_OUTCOMES)[number];
export type FixRuntime = (typeof FIX_RUNTIMES)[number];

export interface FactoryCounts { backlog: number; blocked: number; inProgress: number; done: number; failed: number }
export interface FactoryStep {
  name: string; kind: (typeof STEP_KINDS)[number]; round: number | null; state: (typeof STEP_STATES)[number];
  startedAt: string | null; endedAt: string | null; ms: number | null; summary: string;
}
export interface FactoryFix {
  attempts: number; auto: boolean; runtime: FixRuntime | null; state: (typeof FIX_STATES)[number];
  runId: string | null; startedAt: string | null; endedAt: string | null;
}
export interface FactoryFlow {
  id: string; column: Column; steps: FactoryStep[]; fix: FactoryFix; logs: { gate: string; merge: string; fix: string };
}
export interface FactoryTicket {
  id: string; title: string; epic: string | null; column: Column; dependsOn: string[]; adw: string | null; runId: string | null;
  rounds: number; mergeOutcome: MergeOutcome | null; validation: Validation | null; error: string | null; updatedAt: string;
  steps: FactoryStep[]; fix: FactoryFix;
}
export interface FactoryMerge { at: string; ticket: string; branch: string; outcome: MergeOutcome; commit: string | null }
export interface FactoryAlert { at: string; level: "warn" | "error"; ticket: string | null; message: string }
export interface FactoryHoldout { epic: string | null; passed: number | null; failed: number | null; at: string | null }
export interface FactoryStatus {
  reachable: boolean; generatedAt: string | null; target: string | null; paused: boolean; holdout: FactoryHoldout;
  counts: FactoryCounts; tickets: FactoryTicket[]; merges: FactoryMerge[]; alerts: FactoryAlert[];
}
export type FactoryActionResult = { status: 200 | 404 | 409 | 503; body: Record<string, unknown> };

const FACTORY_TIMEOUT_MS = 10_000;
const MAX_STEPS = 60;
const LOG_TAIL = 4000;
/** Read per call so a test (or an operator restart with a new env) can point at another binary. */
const factoryBin = () => process.env.FACTORY_BIN || "/usr/local/bin/factory";
/** The contract's [A-Za-z0-9_.-]{1,64}, minus a leading `-` or `.`: an id must never read as an option or a path. */
const TICKET_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

/** Run the local factory binary, fixed argv, no shell. A non-zero exit resolves (the caller reads the code); a missing binary or a timeout rejects. */
const localExec: FactoryExec = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      factoryBin(), args,
      { timeout: FACTORY_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
      (err: any, stdout) => {
        if (!err) return resolve({ code: 0, stdout: String(stdout) });
        if (typeof err.code === "number" && !err.killed) return resolve({ code: err.code, stdout: String(stdout) });
        reject(err);
      },
    );
  });

const s = (v: unknown, max: number): string => (typeof v === "string" ? redact(v).slice(0, max) : "");
const sOrNull = (v: unknown, max: number): string | null => (typeof v === "string" && v ? redact(v).slice(0, max) : null);
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const pick = <T extends string>(set: readonly T[], v: unknown): T | null =>
  typeof v === "string" && (set as readonly string[]).includes(v) ? (v as T) : null;
/** A known outcome, or "error" for any other non-empty string, so a new factory value never drops the row. */
const outcomeOrNull = (v: unknown): MergeOutcome | null =>
  pick(MERGE_OUTCOMES, v) ?? (typeof v === "string" && v ? "error" : null);
const intOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const idOrNull = (v: unknown): string | null => (typeof v === "string" && TICKET_ID.test(v) ? v : null);
const roundOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null);

/** A step with an unknown kind or state, or no name, is dropped (null): never the ticket. */
export function mapStep(x: any): FactoryStep | null {
  const kind = pick(STEP_KINDS, x?.kind);
  const state = pick(STEP_STATES, x?.state);
  const name = sOrNull(x?.name, 80);
  if (!kind || !state || !name) return null;
  return {
    name, kind, round: roundOrNull(x.round), state, startedAt: sOrNull(x.startedAt, 40), endedAt: sOrNull(x.endedAt, 40),
    ms: intOrNull(x.ms), summary: s(x.summary, 200),
  };
}

export function mapFix(x: any): FactoryFix {
  const o = x && typeof x === "object" && !Array.isArray(x) ? x : {};
  return {
    attempts: n(o.attempts), auto: o.auto === true, runtime: pick(FIX_RUNTIMES, o.runtime), state: pick(FIX_STATES, o.state) ?? "none",
    runId: sOrNull(o.runId, 80), startedAt: sOrNull(o.startedAt, 40), endedAt: sOrNull(o.endedAt, 40),
  };
}

export function mapTicket(x: any): FactoryTicket | null {
  const id = idOrNull(x?.id);
  const column = pick(FACTORY_COLUMNS, x?.column);
  if (!id || !column) return null;
  return {
    id, title: s(x.title, 120), epic: sOrNull(x.epic, 64), column,
    dependsOn: (Array.isArray(x.dependsOn) ? x.dependsOn : []).map(idOrNull).filter((d: string | null): d is string => d !== null).slice(0, 20),
    adw: sOrNull(x.adw, 40), runId: sOrNull(x.runId, 80), rounds: n(x.rounds), mergeOutcome: outcomeOrNull(x.mergeOutcome),
    validation: pick(VALIDATIONS, x.validation),
    error: sOrNull(x.error, 300), updatedAt: s(x.updatedAt, 40),
    steps: list(x.steps, mapStep, MAX_STEPS), fix: mapFix(x.fix),
  };
}

export function mapFlow(j: any): FactoryFlow | null {
  const id = idOrNull(j?.id);
  const column = pick(FACTORY_COLUMNS, j?.column);
  if (!id || !column) return null;
  const l = j.logs && typeof j.logs === "object" ? j.logs : {};
  return {
    id, column, steps: list(j.steps, mapStep, MAX_STEPS), fix: mapFix(j.fix),
    logs: { gate: s(l.gate, LOG_TAIL), merge: s(l.merge, LOG_TAIL), fix: s(l.fix, LOG_TAIL) },
  };
}

const mapStarted = (j: any, runtime: FixRuntime) => {
  const ticket = idOrNull(j?.ticket);
  const fixRunId = sOrNull(j?.fixRunId, 80);
  if (j?.started !== true || !ticket || !fixRunId) return null;
  return { started: true, ticket, runtime: pick(FIX_RUNTIMES, j.runtime) ?? runtime, fixRunId };
};

export function mapMerge(x: any): FactoryMerge | null {
  const ticket = idOrNull(x?.ticket);
  if (!ticket) return null;
  const outcome = outcomeOrNull(x.outcome);
  if (!outcome) return null;
  return { at: s(x.at, 40), ticket, branch: s(x.branch, 120), outcome, commit: sOrNull(x.commit, 40) };
}

export function mapAlert(x: any): FactoryAlert | null {
  if (typeof x?.message !== "string") return null;
  return { at: s(x.at, 40), level: x.level === "error" ? "error" : "warn", ticket: idOrNull(x.ticket), message: s(x.message, 300) };
}

function list<T>(v: unknown, map: (x: any) => T | null, max: number): T[] {
  return (Array.isArray(v) ? v : []).map(map).filter((x): x is T => x !== null).slice(0, max);
}

export function mapHoldout(h: any): FactoryHoldout {
  const o = h && typeof h === "object" && !Array.isArray(h) ? h : {};
  return { epic: sOrNull(o.epic, 64), passed: intOrNull(o.passed), failed: intOrNull(o.failed), at: sOrNull(o.at, 40) };
}

const DOWN = (): FactoryStatus => ({
  reachable: false, generatedAt: null, target: null, paused: false, holdout: mapHoldout(null),
  counts: { backlog: 0, blocked: 0, inProgress: 0, done: 0, failed: 0 }, tickets: [], merges: [], alerts: [],
});

export function mapStatus(j: any): FactoryStatus | null {
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const c = j.counts ?? {};
  return {
    reachable: true, generatedAt: sOrNull(j.generatedAt, 40), target: sOrNull(j.target, 64), paused: j.paused === true,
    holdout: mapHoldout(j.holdout),
    counts: { backlog: n(c.backlog), blocked: n(c.blocked), inProgress: n(c.inProgress), done: n(c.done), failed: n(c.failed) },
    tickets: list(j.tickets, mapTicket, 100), merges: list(j.merges, mapMerge, 20), alerts: list(j.alerts, mapAlert, 20),
  };
}

export class Factory {
  private cache: { at: number; value: FactoryStatus } | null = null;
  private inflight: Promise<FactoryStatus> | null = null;
  private readonly exec: FactoryExec;

  constructor(private readonly opts: FactoryOptions = {}) {
    this.exec = opts.exec ?? localExec;
  }

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  /** The board; cached for ttlMs, a failure included so a down factory costs one run per window. Never throws. */
  status(): Promise<FactoryStatus> {
    if (this.cache && this.now() - this.cache.at < (this.opts.ttlMs ?? 15_000)) return Promise.resolve(this.cache.value);
    this.inflight ??= this.load().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async load(): Promise<FactoryStatus> {
    let value = DOWN();
    try {
      const r = await this.exec(["status", "--json"]);
      if (r.code === 0) value = mapStatus(JSON.parse(r.stdout)) ?? value;
      else console.warn(`[control-api] factory status: exit ${r.code}`);
    } catch (e: any) {
      console.warn(`[control-api] factory status: ${e?.message ?? e}`);
    }
    this.cache = { at: this.now(), value };
    return value;
  }

  async failedCount(): Promise<number> {
    return (await this.status()).counts.failed;
  }

  /** Run one action. Null when the factory did not answer with a JSON line. */
  private async act(args: string[]): Promise<{ ok: boolean; message: string } | null> {
    try {
      const r = await this.exec(args);
      const line = r.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
      let j: any = null;
      try { j = JSON.parse(line); } catch { /* not a JSON line */ }
      const message = typeof j?.message === "string" ? j.message : "";
      if (r.code === 0 && j && typeof j === "object") return { ok: j.ok === true, message };
      if (r.code === 2) return { ok: false, message };
      return null;
    } catch (e: any) {
      console.warn(`[control-api] factory ${args[0]}: ${e?.message ?? e}`);
      return null;
    } finally {
      this.cache = null;
    }
  }

  async retry(id: string): Promise<FactoryActionResult> {
    if (!TICKET_ID.test(id)) return { status: 404, body: { message: "Unknown ticket" } };
    const r = await this.act(["retry", id]);
    if (!r) return { status: 503, body: {} };
    if (r.ok) return { status: 200, body: { ok: true } };
    return { status: /unknown|not found|no such/i.test(r.message) ? 404 : 409, body: {} };
  }

  /** One ticket's workflow. 404 on exit 2, 503 when the factory does not answer with a usable flow. */
  async flow(id: string): Promise<FactoryActionResult> {
    if (!TICKET_ID.test(id)) return { status: 404, body: {} };
    try {
      const r = await this.exec(["flow", id, "--json"]);
      if (r.code === 2) return { status: 404, body: {} };
      if (r.code === 0) {
        const f = mapFlow(JSON.parse(r.stdout));
        if (f) return { status: 200, body: { ...f } };
      }
    } catch (e: any) {
      console.warn(`[control-api] factory flow: ${e?.message ?? e}`);
    }
    return { status: 503, body: {} };
  }

  /** Start a fix on a failed ticket. 404 unknown, 409 not failed or `fix_running` (exit 3), 503 unreachable. */
  async fix(id: string, runtime: FixRuntime): Promise<FactoryActionResult> {
    if (!TICKET_ID.test(id)) return { status: 404, body: {} };
    try {
      const r = await this.exec(["fix", id, "--runtime", runtime, "--json"]);
      this.cache = null;
      if (r.code === 3) return { status: 409, body: { error: "fix_running" } };
      let j: any = null;
      try { j = JSON.parse(r.stdout.trim().split("\n").filter(Boolean).pop() ?? ""); } catch { /* not a JSON line */ }
      if (r.code === 2) {
        const message = typeof j?.message === "string" ? j.message : "";
        return { status: /unknown|not found|no such|bad id/i.test(message) ? 404 : 409, body: {} };
      }
      const started = r.code === 0 ? mapStarted(j, runtime) : null;
      if (started) return { status: 200, body: started };
    } catch (e: any) {
      console.warn(`[control-api] factory fix: ${e?.message ?? e}`);
    }
    return { status: 503, body: {} };
  }

  async setPaused(paused: boolean): Promise<FactoryActionResult> {
    const r = await this.act([paused ? "pause" : "resume"]);
    return r?.ok ? { status: 200, body: { paused } } : { status: 503, body: {} };
  }
}

export function factoryRoutes(factory: Factory): express.Router {
  const r = express.Router();
  r.get("/factory", async (_req, res) => { res.json(await factory.status()); });

  r.post("/factory/tickets/:id/retry", async (req, res) => {
    const out = await factory.retry(req.params.id);
    if (out.status === 200) return res.json(out.body);
    if (out.status === 404) return res.status(404).json(errorBody("not_found", "Unknown ticket"));
    if (out.status === 409) return res.status(409).json(errorBody("conflict", "Ticket is not failed"));
    res.status(503).json(errorBody("unavailable", "The factory is not reachable"));
  });

  r.get("/factory/tickets/:id/flow", async (req, res) => {
    const out = await factory.flow(req.params.id);
    if (out.status === 200) return res.json(out.body);
    if (out.status === 404) return res.status(404).json(errorBody("not_found", "Unknown ticket"));
    res.status(503).json(errorBody("unavailable", "The factory is not reachable"));
  });

  r.post("/factory/tickets/:id/fix", async (req, res) => {
    const runtime = req.body?.runtime === undefined ? "claude" : pick(FIX_RUNTIMES, req.body.runtime);
    if (!runtime) return res.status(400).json(errorBody("bad_request", "runtime must be claude or agent"));
    const out = await factory.fix(req.params.id, runtime);
    if (out.status === 200 || out.status === 409 && "error" in out.body) return res.status(out.status).json(out.body);
    if (out.status === 404) return res.status(404).json(errorBody("not_found", "Unknown ticket"));
    if (out.status === 409) return res.status(409).json(errorBody("conflict", "Ticket is not failed"));
    res.status(503).json(errorBody("unavailable", "The factory is not reachable"));
  });

  for (const [path, paused] of [["pause", true], ["resume", false]] as const) {
    r.post(`/factory/${path}`, async (_req, res) => {
      const out = await factory.setPaused(paused);
      if (out.status === 200) return res.json(out.body);
      res.status(503).json(errorBody("unavailable", "The factory is not reachable"));
    });
  }
  return r;
}
