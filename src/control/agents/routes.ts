import express from "express";
import { requireCap } from "../auth";
import { errorBody } from "../contract";
import type { ActionKind } from "../actions/confirm";
import { prepareToken } from "../actions/tokens";
import type { OpsStore } from "../ops-store";
import { PROJECT_NAME } from "../paging";
import { clientAddress, rateLimit } from "../rate-limit";
import type { Device } from "../store";
import type { GhIds } from "../gh/ids";
import type { OpsResult } from "../ops-godhome";
import { GH_ID } from "../gh/ids";
import { MAX_AGENT_TEXT } from "../gh/client";
import { resolveLiveAgent } from "./kinds/agent_prompt";
import { liveReply } from "./live";
import { findDuplicate, MAX_PROMPT, promptAudit } from "./start";
import { listTargets, resolveTarget, VARIANTS, type TargetsDeps, type Variant } from "./targets";

/** Agent targets, run start and live prompts (G1..G4). */
export interface AgentsDeps {
  targets: TargetsDeps;
  ops: OpsStore;
  runs: { listRuns(f: { project: string; status: string; limit: number }): import("../store").ControlRun[] };
  /** The action kinds of this area; wiring hands them to the ops confirm route (X16). */
  kinds: readonly ActionKind[];
  /** G3: GodHome's herdr agents and the opaque ids that stand for them. */
  live: { ids: GhIds; herdrAgents(fresh?: boolean): Promise<OpsResult> };
  now?: () => number;
}

const WRITE_LIMIT = 30;

export function agentsRoutes(deps: AgentsDeps): express.Router {
  const r = express.Router();
  const now = deps.now ?? Date.now;
  const iso = (ms: number) => new Date(ms).toISOString();
  const writeLimit = rateLimit({ max: WRITE_LIMIT, windowMs: 60_000, key: (req) => (req as express.Request & { deviceId?: string }).deviceId ?? "anon" });

  // G1: the projects a run can start in.
  r.get("/agents/targets", requireCap("agents:start"), async (_req, res) => {
    try {
      res.json({ projects: await listTargets(deps.targets) });
    } catch (e: any) {
      console.warn(`[control-api] agents targets: ${String(e?.name ?? "Error").slice(0, 40)}`);
      res.status(503).json(errorBody("unavailable", "Projects are unavailable"));
    }
  });

  // G2: prepare a run. Nothing starts here; the confirm (X16, kind agent_run) does.
  r.post("/agents/runs", requireCap("agents:start"), writeLimit, async (req, res) => {
    const started = performance.now();
    const device = res.locals.device as Device;
    const { project, prompt, variant } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof project !== "string" || !PROJECT_NAME.test(project)) return res.status(400).json(errorBody("bad_request", `project must match ${PROJECT_NAME.source}`));
    if (typeof prompt !== "string" || prompt.trim().length === 0 || prompt.length > MAX_PROMPT) return res.status(400).json(errorBody("bad_request", `prompt must be 1 to ${MAX_PROMPT} characters`));
    if (variant !== undefined && !(VARIANTS as readonly unknown[]).includes(variant)) return res.status(400).json(errorBody("bad_request", `variant must be ${VARIANTS.join(" or ")}`));
    const chosen = ((variant as Variant | undefined) ?? "kb-dev") as Variant;
    const params = JSON.stringify({ ...promptAudit(prompt), variant: chosen });
    const audit = (result: string, detail: string): void => {
      deps.ops.audit({
        at: now(), deviceId: device.id, deviceName: device.name, addr: clientAddress(req), action: "agent.run.prepare", subject: project,
        params, result, detail, durMs: Math.round(performance.now() - started),
      });
    };
    try {
      const target = resolveTarget(deps.targets, project);
      if (!target) { audit("not_found", "No such project"); return res.status(404).json(errorBody("not_found", "No such project")); }
      const dup = findDuplicate(deps.runs, project, prompt);
      if (dup) {
        audit("conflict", "duplicate");
        return res.status(409).json({ ...errorBody("conflict", "A run with this prompt is already queued or running"), runId: dup.id });
      }
      const host = target.location === "laptop" ? "mac" : "server";
      const queued = host === "mac" && !(await deps.targets.macOnline().catch(() => false));
      const { actionId, expiresAt } = prepareToken(deps.ops, {
        kind: "agent_run", deviceId: device.id, subject: project, targetId: project, payload: { project, prompt, variant: chosen }, now: now(),
      });
      audit("ok", "");
      res.json({ actionId, project, host, queued, expiresAt: iso(expiresAt) });
    } catch (e: any) {
      console.warn(`[control-api] agents run prepare: ${String(e?.name ?? "Error").slice(0, 40)}`);
      audit("unavailable", "prepare failed");
      res.status(503).json(errorBody("unavailable", "Could not prepare the run"));
    }
  });

  // G3: GodHome's live agents, mapped. An outage is a 200 with reachable:false (spec 003 FR3), never an error.
  r.get("/agents/live", requireCap("agents:start"), async (_req, res) => {
    let got: OpsResult | null = null;
    try {
      got = await deps.live.herdrAgents();
    } catch (e: any) {
      console.warn(`[control-api] agents live: ${String(e?.name ?? "Error").slice(0, 40)}`);
    }
    res.json(liveReply(got, deps.live.ids, now()));
  });

  // G4: prepare a prompt for one live agent. The agent is looked up here to name it on the confirm sheet and again, uncached, at confirm.
  r.post("/agents/live/:id/prompt", requireCap("agents:start"), writeLimit, async (req, res) => {
    const started = performance.now();
    const device = res.locals.device as Device;
    const id = String(req.params.id);
    if (!GH_ID.test(id)) return res.status(400).json(errorBody("bad_request", `id must match ${GH_ID.source}`));
    const text = (req.body ?? {}).text;
    if (typeof text !== "string" || text.trim().length === 0 || text.length > MAX_AGENT_TEXT) return res.status(400).json(errorBody("bad_request", `text must be 1 to ${MAX_AGENT_TEXT} characters`));
    const audit = (result: string, detail: string): void => {
      deps.ops.audit({
        at: now(), deviceId: device.id, deviceName: device.name, addr: clientAddress(req), action: "agent.prompt.prepare", subject: id,
        params: JSON.stringify(promptAudit(text)), result, detail, durMs: Math.round(performance.now() - started),
      });
    };
    try {
      const found = await resolveLiveAgent({ ids: deps.live.ids, listAgents: deps.live.herdrAgents }, id, false, now());
      if ("status" in found) {
        audit(found.code, found.message);
        return res.status(found.status).json(errorBody(found.code as "not_found", found.message));
      }
      const { actionId, expiresAt } = prepareToken(deps.ops, { kind: "agent_prompt", deviceId: device.id, subject: id, targetId: id, payload: { text }, now: now() });
      audit("ok", "");
      res.json({ actionId, label: found.label, expiresAt: iso(expiresAt) });
    } catch (e: any) {
      console.warn(`[control-api] agents prompt prepare: ${String(e?.name ?? "Error").slice(0, 40)}`);
      audit("unavailable", "prepare failed");
      res.status(503).json(errorBody("unavailable", "GodHome is not reachable"));
    }
  });
  return r;
}
