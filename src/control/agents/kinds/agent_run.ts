import crypto from "crypto";
import type { ControlRun } from "../../store";
import type { OpsStore } from "../../ops-store";
import type { ActionKind } from "../../actions/confirm";
import { findDuplicate, previewOf, promptAudit, type StartRun } from "../start";
import { resolveTarget, type TargetsDeps, type Variant } from "../targets";

export const DEVICE_RUNS = 6;
export const DEVICE_WINDOW_MS = 10 * 60 * 1000;
export const GLOBAL_RUNS = 20;
export const GLOBAL_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AgentRunKindDeps {
  ops: OpsStore;
  targets: TargetsDeps;
  runs: {
    listRuns(f: { project: string; status: string; limit: number }): ControlRun[];
    insertRun(r: ControlRun): void;
    deleteRun(id: string): void;
  };
  startRun: StartRun;
  newRunId?: () => string;
  feed?: { add(e: { source: string; text: string; kind?: "info" }): unknown };
}

export interface AgentRunPayload { project: string; prompt: string; variant: Variant }

/**
 * G2 confirm (spec 012 D7): the 003 write-spec path. The checks run before the token is spent (target still startable, duplicate
 * guard, 6 starts per 10 min per device, 20 per day overall). Then the queued run row is written, and only then the runner is asked,
 * so the run is visible from the first moment; a runner that fails takes the row back out.
 */
export function agentRunKind(d: AgentRunKindDeps): ActionKind {
  return {
    name: "agent_run",
    cap: "agents:start",
    confirmAction: "agent.run.confirm",
    feed: d.feed,
    check: ({ payload, device, now }) => {
      const p = payload as AgentRunPayload | null;
      let target;
      try {
        target = p ? resolveTarget(d.targets, p.project) : null;
      } catch (e: any) {
        console.warn(`[control-api] agent_run check: ${String(e?.name ?? "Error").slice(0, 40)}`);
        return { status: 503, code: "unavailable", message: "Project data is unavailable" };
      }
      if (!p || !target) return { status: 404, code: "not_found", message: "No such project" };
      const dup = findDuplicate(d.runs, p.project, p.prompt);
      if (dup) return { status: 409, code: "conflict", message: "A run with this prompt is already queued or running", extra: { runId: dup.id } };
      const mine = d.ops.kindUses("agent_run", now() - DEVICE_WINDOW_MS, device.id);
      if (mine.length >= DEVICE_RUNS) {
        return { status: 429, code: "rate_limited", message: "Too many runs started from this device; try again later", retryAfterSec: Math.max(1, Math.ceil((mine[0]! + DEVICE_WINDOW_MS - now()) / 1000)) };
      }
      const all = d.ops.kindUses("agent_run", now() - GLOBAL_WINDOW_MS);
      if (all.length >= GLOBAL_RUNS) {
        return { status: 429, code: "rate_limited", message: "Too many runs started today; try again later", retryAfterSec: Math.max(1, Math.ceil((all[0]! + GLOBAL_WINDOW_MS - now()) / 1000)) };
      }
      return null;
    },
    run: async ({ payload, device, now }) => {
      const p = payload as AgentRunPayload;
      const target = resolveTarget(d.targets, p.project)!;
      const host = target.location === "laptop" ? "mac" : "server";
      const audit = JSON.stringify(promptAudit(p.prompt));
      const runId = (d.newRunId ?? (() => crypto.randomBytes(4).toString("hex")))();
      d.runs.insertRun({
        id: runId, project: p.project, source: "tokyo", status: "queued", model: null, harness: "claude", worker: null, tier: null,
        promptPreview: previewOf(p.prompt), startedAt: now(), endedAt: null, exitCode: null, host, offerId: null, workspace: null,
      });
      const started = await d.startRun({ project: p.project, prompt: p.prompt, variant: p.variant, runId });
      if (!started.ok) {
        d.runs.deleteRun(runId);
        const status = started.kind === "not_found" ? 404 : started.kind === "conflict" ? 409 : 503;
        return {
          ok: false, result: started.kind, detail: started.message, status, params: audit,
          body: { error: { code: started.kind === "not_found" ? "not_found" : started.kind === "conflict" ? "conflict" : "unavailable", message: started.message } },
        };
      }
      const offline = host === "mac" && !(await d.targets.macOnline().catch(() => false));
      return {
        ok: true, result: "ok", detail: runId, params: audit,
        body: { runId, state: offline ? "queued" : "running" },
        feed: `Started agent run ${runId} in ${p.project} from device ${device.name}`,
      };
    },
  };
}
