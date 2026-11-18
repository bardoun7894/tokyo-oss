import express from "express";
import { requireCap } from "./auth";
import { errorBody } from "./contract";
import { isOpsWindow, OpsInputError, type OpsGodhome, type StopResult } from "./ops-godhome";
import { mapEngine, mapNetwork, mapOverview, mapTraceDetail, mapTraces } from "./ops-map";
import { parsePage, PROJECT_NAME } from "./paging";
import { adjustedCounts, applyIncidentWrite, findIncident, needsYouHidden, findSourceItem, fixNote, fixPrompt, incidentResolved, INCIDENT_ID, INCIDENT_KINDS, INCIDENT_STATES, listIncidents, MUTE_MINUTES, type IncidentKind, type IncidentStateFilter, type IncidentWrite } from "./ops-incidents";
import { clientAddress, rateLimit } from "./rate-limit";
import { redact } from "./redact";
import type { OpsStore } from "./ops-store";
import { TASK_SENDER, type TasksDeps } from "./tasks";
import type { ControlRun, Device } from "./store";
import type { DeployOffer } from "../deploy-offers";
import { DEPLOY_OFFER_ID, deployProgress } from "./ops-deploy";
import { resolveRestart, type AllowEntry, type Exec } from "./ops-restart";
import { mountConfirm, type ActionKind } from "./actions/confirm";
import { prepareToken } from "./actions/tokens";
import { restartKind } from "./actions/kinds/restart";

const GRAPH_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const IDEM_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const WRITE_LIMIT = 30;
const MAX_HISTORY = 50;
const AUDIT_ROWS = 100;
/** The action name the phone sees: the route's `fix-task` is the `fixTask` of actions[]. */
const actionName = (a: string): string => (a === "fix-task" ? "fixTask" : a);
const INCIDENT_ACTIONS = new Set(["ack", "mute", "resolve", "reopen", "fix-task"]);

/** X3 `limit`: 1 to 50, default 20; null for anything else (a repeated or empty parameter included). */
function parseTraceLimit(v: unknown): number | null {
  if (v === undefined) return 20;
  if (typeof v !== "string" || !/^\d{1,2}$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= 50 ? n : null;
}

/** What the ops routes need from the world. Absent from `ControlDeps` means the routes are not mounted. */
export interface OpsDeps {
  godhome: Pick<OpsGodhome, "summary" | "runs" | "run" | "graph"> & Partial<Pick<OpsGodhome, "stopRun">>;
  /** The opaque incident id map; shares the Control db. */
  store: OpsStore;
  /** Projects that have a mission config (`/tasks/options`); the fix task needs the incident's project in it. */
  taskProjects?: () => { name: string; engine: "claude" | "dsh" }[];
  /** X12: the deploy offers (persisted, so an offer survives a reload) and the Control run rows they started. */
  deploys?: { get(id: string): DeployOffer | undefined; /** True while the run waits in the laptop queue for the Mac (it will start; do not call it expired). */ waiting?(runId: string): boolean };
  runs?: { getRun(id: string): ControlRun | undefined };
  /** The proposal path of `POST /tasks` (set by the router from `ControlDeps.tasks`); without it the fix task is unavailable. */
  tasks?: TasksDeps;
  /** X15 and X16 (spec section 7). Absent means the restart routes are not mounted and no incident offers `restart`. */
  restart?: {
    /** The validated allowlist; read per request (the loader caches by mtime). */
    allowlist(): readonly AllowEntry[];
    exec: Exec;
    sleep?: (ms: number) => Promise<void>;
    /** One info line for the owner's feed after a restart. */
    feed?: { add(e: { source: string; text: string; kind?: "info" }): unknown };
  };
  /** Further kinds of fingerprint action the one X16 confirm route dispatches to (agent_run, agent_prompt, ...), built where their deps are. */
  kinds?: readonly ActionKind[];
  now?: () => number;
}

/** The Control API's ops routes (X1 to X17 over time), mounted behind bearerAuth. */
export function opsRoutes(deps: OpsDeps): express.Router {
  const r = express.Router();
  const now = deps.now ?? Date.now;
  const iso = (ms: number) => new Date(ms).toISOString();
  /** Projects whose incidents may offer a fix task, read per request (the mission config can change). */
  const fixProjects = (): ReadonlySet<string> => new Set((deps.taskProjects?.() ?? []).map((p) => p.name));
  /** An incident the restart allowlist covers (T4.2); the device cap is checked by mapIncident. */
  const restartable = deps.restart ? (item: Record<string, any>): boolean => resolveRestart(item, deps.restart!.allowlist()) !== null : undefined;

  // X1: overview
  r.get("/ops/overview", requireCap("ops:read"), async (req, res) => {
    const window = req.query.window === undefined ? "24h" : req.query.window;
    if (!isOpsWindow(window)) return res.status(400).json(errorBody("bad_request", "window must be 24h, 7d or all"));
    try {
      const got = await deps.godhome.summary(window);
      if (got.data === null) return res.json({ fetchedAt: iso(now()), reachable: false });
      // The same overlay and adjustedCounts as X5, so the two screens agree.
      const overlay = deps.store.overlay(now());
      const adj = { counts: adjustedCounts(got.data, overlay, now()), hideNeeds: needsYouHidden(got.data, overlay) };
      res.json({ fetchedAt: iso(got.fetchedAt || now()), reachable: got.reachable, ...mapOverview(got.data, window, adj) });
    } catch (e: any) {
      if (e instanceof OpsInputError) return res.status(400).json(errorBody("bad_request", e.message));
      // Name only: a message from the client or a mapper may quote what it was handed.
      console.warn(`[control-api] ops overview: ${String(e?.name ?? "Error").slice(0, 40)}`);
      res.json({ fetchedAt: iso(now()), reachable: false });
    }
  });


  // X2: live map
  r.get("/ops/map", requireCap("ops:read"), async (req, res) => {
    const window = req.query.window === undefined ? "24h" : req.query.window;
    if (!isOpsWindow(window)) return res.status(400).json(errorBody("bad_request", "window must be 24h, 7d or all"));
    const mode = req.query.mode === undefined ? "agents" : req.query.mode;
    if (mode !== "agents" && mode !== "engine") return res.status(400).json(errorBody("bad_request", "mode must be agents or engine"));
    const project = req.query.project;
    if (project !== undefined && (typeof project !== "string" || !PROJECT_NAME.test(project))) {
      return res.status(400).json(errorBody("bad_request", `project must match ${PROJECT_NAME.source}`));
    }
    const graph = req.query.graph;
    if (mode === "engine" && graph !== undefined && (typeof graph !== "string" || !GRAPH_NAME.test(graph) || /^\.+$/.test(graph))) {
      return res.status(400).json(errorBody("bad_request", `graph must match ${GRAPH_NAME.source}`));
    }
    const down = () => res.json({ fetchedAt: iso(now()), reachable: false });
    try {
      if (mode === "agents") {
        const got = await deps.godhome.summary(window);
        if (got.data === null) return down();
        return res.json({ fetchedAt: iso(got.fetchedAt || now()), reachable: got.reachable, ...mapNetwork(got.data, { project }) });
      }
      const [runs, g] = await Promise.all([deps.godhome.runs(), graph === undefined ? null : deps.godhome.graph(graph as string)]);
      if (g?.notFound) return res.status(404).json(errorBody("not_found", "No such graph"));
      if (runs.data === null || (g && g.data === null)) return down();
      const fetched = Math.min(runs.fetchedAt || now(), g ? g.fetchedAt || now() : Infinity);
      res.json({ fetchedAt: iso(fetched), reachable: runs.reachable && (g?.reachable ?? true), ...mapEngine(runs.data, g?.data ?? null, graph as string | undefined) });
    } catch (e: any) {
      if (e instanceof OpsInputError) return res.status(400).json(errorBody("bad_request", e.message));
      console.warn(`[control-api] ops map: ${String(e?.name ?? "Error").slice(0, 40)}`);
      down();
    }
  });


  // X3: traces list
  r.get("/ops/traces", requireCap("ops:read"), async (req, res) => {
    const limit = parseTraceLimit(req.query.limit);
    if (limit === null) return res.status(400).json(errorBody("bad_request", "limit must be an integer from 1 to 50"));
    let before: number | undefined;
    if (req.query.before !== undefined) {
      const t = typeof req.query.before === "string" ? Date.parse(req.query.before) : NaN;
      if (Number.isNaN(t)) return res.status(400).json(errorBody("bad_request", "before must be an ISO-8601 timestamp"));
      before = t;
    }
    try {
      const got = await deps.godhome.runs();
      if (got.data === null) return res.json({ fetchedAt: iso(now()), reachable: false });
      res.json({ fetchedAt: iso(got.fetchedAt || now()), reachable: got.reachable, ...mapTraces(got.data, { limit, before }, now()) });
    } catch (e: any) {
      console.warn(`[control-api] ops traces: ${String(e?.name ?? "Error").slice(0, 40)}`);
      res.json({ fetchedAt: iso(now()), reachable: false });
    }
  });

  // X4: trace detail. A detail with no fresh GodHome behind it is a 503, not an empty 200.
  r.get("/ops/traces/:id", requireCap("ops:read"), async (req, res) => {
    const id = String(req.params.id);
    if (!GRAPH_NAME.test(id) || /^\.+$/.test(id)) return res.status(400).json(errorBody("bad_request", `id must match ${GRAPH_NAME.source}`));
    try {
      const got = await deps.godhome.run(id);
      if (got.notFound) return res.status(404).json(errorBody("not_found", "No such run"));
      if (!got.reachable || got.data === null) return res.status(503).json(errorBody("unavailable", "GodHome is not reachable"));
      res.json({ fetchedAt: iso(got.fetchedAt || now()), reachable: true, ...mapTraceDetail(got.data, now()) });
    } catch (e: any) {
      if (e instanceof OpsInputError) return res.status(400).json(errorBody("bad_request", e.message));
      console.warn(`[control-api] ops trace: ${String(e?.name ?? "Error").slice(0, 40)}`);
      res.status(503).json(errorBody("unavailable", "GodHome is not reachable"));
    }
  });


  // X5: incident list. Reads the `all` window: an incident stays listed until GodHome resolves it, whatever its age.
  r.get("/ops/incidents", requireCap("ops:read"), async (req, res) => {
    const state = req.query.state === undefined ? "open" : req.query.state;
    if (typeof state !== "string" || !(INCIDENT_STATES as readonly string[]).includes(state)) {
      return res.status(400).json(errorBody("bad_request", "state must be open, resolved, muted or all"));
    }
    const kind = req.query.kind;
    if (kind !== undefined && (typeof kind !== "string" || !(INCIDENT_KINDS as readonly string[]).includes(kind))) {
      return res.status(400).json(errorBody("bad_request", "kind must be check, review, deploy or agent"));
    }
    const project = req.query.project;
    if (project !== undefined && (typeof project !== "string" || !PROJECT_NAME.test(project))) {
      return res.status(400).json(errorBody("bad_request", `project must match ${PROJECT_NAME.source}`));
    }
    const page = parsePage(req, 20);
    if (typeof page === "string") return res.status(400).json(errorBody("bad_request", page));
    try {
      const got = await deps.godhome.summary("all");
      if (got.data === null) return res.json({ fetchedAt: iso(now()), reachable: false });
      const caps = (res.locals.device as Device).caps;
      const body = listIncidents(got.data, { state: state as IncidentStateFilter, kind: kind as IncidentKind | undefined, project, since: page.since, before: page.before, limit: page.limit }, deps.store, caps, now(), fixProjects(), restartable);
      res.json({ fetchedAt: iso(got.fetchedAt || now()), reachable: got.reachable, ...body });
    } catch (e: any) {
      console.warn(`[control-api] ops incidents: ${String(e?.name ?? "Error").slice(0, 40)}`);
      res.json({ fetchedAt: iso(now()), reachable: false });
    }
  });

  // X6: one incident. Without a fresh GodHome behind it the answer is 503, like X4.
  r.get("/ops/incidents/:id", requireCap("ops:read"), async (req, res) => {
    const id = String(req.params.id);
    if (!INCIDENT_ID.test(id)) return res.status(400).json(errorBody("bad_request", `id must match ${INCIDENT_ID.source}`));
    if (deps.store.sourceId(id) === null) return res.status(404).json(errorBody("not_found", "No such incident"));
    try {
      const got = await deps.godhome.summary("all");
      if (!got.reachable || got.data === null) return res.status(503).json(errorBody("unavailable", "GodHome is not reachable"));
      const found = findIncident(got.data, id, deps.store, (res.locals.device as Device).caps, now(), fixProjects(), restartable);
      if (!found) return res.status(404).json(errorBody("not_found", "No such incident"));
      const history = deps.store.history(id, MAX_HISTORY).map((h) => ({ at: iso(h.at), action: actionName(h.action), device: h.device }));
      res.json({ fetchedAt: iso(got.fetchedAt || now()), reachable: true, ...found, history });
    } catch (e: any) {
      console.warn(`[control-api] ops incident: ${String(e?.name ?? "Error").slice(0, 40)}`);
      res.status(503).json(errorBody("unavailable", "GodHome is not reachable"));
    }
  });

  // X12: deploy progress by offer id. Tokyo-local (offer plus run row), so it does not depend on GodHome.
  if (deps.deploys) {
    r.get("/ops/deploys/:offerId", requireCap("ops:read"), (req, res) => {
      const id = String(req.params.offerId);
      if (!DEPLOY_OFFER_ID.test(id)) return res.status(400).json(errorBody("bad_request", `offerId must match ${DEPLOY_OFFER_ID.source}`));
      const offer = deps.deploys!.get(id);
      if (!offer) return res.status(404).json(errorBody("not_found", "No such offer"));
      const run = offer.runId ? deps.runs?.getRun(offer.runId) : undefined;
      res.json({ fetchedAt: iso(now()), reachable: true, ...deployProgress(offer, run, now(), !!offer.runId && deps.deploys!.waiting?.(offer.runId) === true) });
    });
  }

  // X17: the last write attempts, newest first. No address, parameters or detail leave Tokyo.
  r.get("/ops/audit", requireCap("ops:read"), (req, res) => {
    const raw = req.query.limit;
    let limit = AUDIT_ROWS;
    if (raw !== undefined) {
      if (typeof raw !== "string" || !/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > AUDIT_ROWS) {
        return res.status(400).json(errorBody("bad_request", `limit must be an integer from 1 to ${AUDIT_ROWS}`));
      }
      limit = Number(raw);
    }
    const entries = deps.store.recent(limit).map((e) => ({
      at: iso(e.at), device: e.device, action: INCIDENT_ACTIONS.has(e.action) ? `incident.${actionName(e.action)}` : e.action, subject: e.subject, result: e.result,
    }));
    res.json({ fetchedAt: iso(now()), reachable: true, entries });
  });

  // X7 to X10: incident writes. Each needs ops:write, counts against 30 writes a minute per device, takes an optional
  // Idempotency-Key and leaves one audit row per attempt on a known incident (ok, conflict, not_found, unavailable).
  const writeLimit = rateLimit({ max: WRITE_LIMIT, windowMs: 60_000, key: (req) => (req as express.Request & { deviceId?: string }).deviceId ?? "anon" });
  const writeIncident = (action: IncidentWrite | "fix-task"): express.RequestHandler => async (req, res) => {
    const started = performance.now();
    const device = res.locals.device as Device;
    const id = String(req.params.id);
    if (!INCIDENT_ID.test(id)) return res.status(400).json(errorBody("bad_request", `id must match ${INCIDENT_ID.source}`));
    let minutes: number | undefined;
    if (action === "mute") {
      minutes = req.body?.minutes;
      if (typeof minutes !== "number" || !(MUTE_MINUTES as readonly number[]).includes(minutes)) {
        return res.status(400).json(errorBody("bad_request", `minutes must be one of ${MUTE_MINUTES.join(", ")}`));
      }
    }
    let note: string | undefined;
    if (action === "fix-task" && req.body?.note !== undefined) {
      if (typeof req.body.note !== "string" || req.body.note.length > 500) return res.status(400).json(errorBody("bad_request", "note must be a string of at most 500 characters"));
      note = req.body.note;
    }
    const header = req.headers["idempotency-key"];
    if (header !== undefined && (typeof header !== "string" || !IDEM_KEY.test(header))) {
      return res.status(400).json(errorBody("bad_request", `Idempotency-Key must match ${IDEM_KEY.source}`));
    }
    const idemKey = header as string | undefined;
    if (idemKey !== undefined) {
      const prior = deps.store.findIdem(action, idemKey);
      if (prior) {
        if (prior.deviceId !== device.id || prior.subject !== id || prior.response === null) {
          return res.status(409).json(errorBody("conflict", "Idempotency-Key was already used for another request"));
        }
        return res.json(JSON.parse(prior.response));
      }
    }
    const source = deps.store.sourceId(id);
    if (source === null) return res.status(404).json(errorBody("not_found", "No such incident"));

    const audit = (result: string, detail: string, response?: unknown): boolean => deps.store.audit({
      at: now(), deviceId: device.id, deviceName: device.name, addr: clientAddress(req), action, subject: id,
      params: redact(JSON.stringify(action === "mute" ? { minutes } : action === "fix-task" && note?.trim() ? { note: fixNote(note) } : {})), result, detail, durMs: Math.round(performance.now() - started),
      ...(result === "ok" && idemKey !== undefined ? { idemKey } : {}),
      ...(response !== undefined ? { response: JSON.stringify(response) } : {}),
    });
    const fail = (status: number, code: "not_found" | "conflict" | "unavailable", message: string) => {
      audit(code, message);
      return res.status(status).json(errorBody(code, message));
    };
    try {
      const got = await deps.godhome.summary("all");
      if (!got.reachable || got.data === null) return fail(503, "unavailable", "GodHome is not reachable");
      const item = findSourceItem(got.data, source);
      if (!item) return fail(404, "not_found", "No such incident");
      let body: Record<string, unknown>;
      if (action === "fix-task") {
        if (incidentResolved(item, deps.store, now())) return fail(409, "conflict", "Incident is already resolved");
        // The same proposal path as POST /tasks. A project without a mission config creates no offer.
        const project = String(item.project ?? "");
        const ref = fixProjects().has(project) ? deps.tasks?.getProject(project) : undefined;
        const missionId = ref && deps.tasks ? await deps.tasks.propose(ref, { content: fixPrompt(item, note), sender_name: TASK_SENDER, jid: "control-app" }) : null;
        if (!ref || !missionId) return fail(404, "not_found", "No mission config for this project");
        body = { fetchedAt: iso(got.fetchedAt || now()), reachable: true, offerId: missionId, project: ref.name };
      } else {
        const out = applyIncidentWrite(action, item, id, deps.store, device.id, now(), minutes);
        if (!out.ok) return out.status === 409 ? fail(409, "conflict", out.message) : res.status(400).json(errorBody("bad_request", out.message));
        body = { fetchedAt: iso(got.fetchedAt || now()), reachable: true, incident: findIncident(got.data, id, deps.store, device.caps, now(), fixProjects(), restartable) };
      }
      // A lost race on the key means the same request already finished: answer with what it stored.
      if (!audit("ok", "", body) && idemKey !== undefined) {
        const won = deps.store.findIdem(action, idemKey);
        if (won?.response) return res.json(JSON.parse(won.response));
      }
      res.json(body);
    } catch (e: any) {
      console.warn(`[control-api] ops ${action}: ${String(e?.name ?? "Error").slice(0, 40)}`);
      fail(503, "unavailable", "GodHome is not reachable");
    }
  };
  for (const action of ["ack", "mute", "resolve", "reopen", "fix-task"] as const) {
    r.post(`/ops/incidents/:id/${action}`, requireCap("ops:write"), writeLimit, writeIncident(action));
  }

  // X14: stop a GodHome engine run. The id is checked here and again in the client; GodHome's {ok:false} (unknown or
  // finished run, G10) is a 409. The only call made is POST /runs/:id/stop, with no body.
  r.post("/ops/engine-runs/:id/stop", requireCap("ops:write"), writeLimit, async (req, res) => {
    const started = performance.now();
    const device = res.locals.device as Device;
    const id = String(req.params.id);
    if (!GRAPH_NAME.test(id) || /^\.+$/.test(id)) return res.status(400).json(errorBody("bad_request", `id must match ${GRAPH_NAME.source}`));
    const audit = (result: string, detail: string): void => {
      deps.store.audit({
        at: now(), deviceId: device.id, deviceName: device.name, addr: clientAddress(req), action: "engine.stop", subject: id,
        params: "{}", result, detail, durMs: Math.round(performance.now() - started),
      });
    };
    let outcome: StopResult = { status: "unreachable" };
    try {
      if (deps.godhome.stopRun) outcome = await deps.godhome.stopRun(id);
    } catch (e: any) {
      console.warn(`[control-api] ops engine stop: ${String(e?.name ?? "Error").slice(0, 40)}`);
    }
    if (outcome.status === "unreachable") {
      audit("unavailable", "GodHome is not reachable");
      return res.status(503).json(errorBody("unavailable", "GodHome is not reachable"));
    }
    if (outcome.status === "not_running") {
      audit("conflict", "Run is not running");
      return res.status(409).json(errorBody("conflict", "Run is not running"));
    }
    audit("ok", "");
    res.json({ fetchedAt: iso(now()), reachable: true, ok: true, status: "stopped" });
  });

  if (deps.restart) mountRestart(r, deps, deps.restart, writeLimit, now, iso);
  const kinds: ActionKind[] = [
    ...(deps.restart ? [restartKind(deps.store, { allowlist: deps.restart.allowlist, exec: deps.restart.exec, sleep: deps.restart.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))), feed: deps.restart.feed })] : []),
    ...(deps.kinds ?? []),
  ];
  if (kinds.length > 0) mountConfirm(r, { store: deps.store, kinds, now }, writeLimit);

  return r;
}

/**
 * X15 prepare (spec section 7). It re-fetches the incident, resolves its target from the raw GodHome item and the allowlist, and
 * stores a 120 s single-use token bound to the device. The confirm (X16) is actions/confirm.ts; the restart body is kinds/restart.ts.
 */
function mountRestart(
  r: express.Router, deps: OpsDeps, rs: NonNullable<OpsDeps["restart"]>, writeLimit: express.RequestHandler,
  now: () => number, iso: (ms: number) => string,
): void {
  r.post("/ops/incidents/:id/restart", requireCap("ops:service"), writeLimit, async (req, res) => {
    const started = performance.now();
    const device = res.locals.device as Device;
    const id = String(req.params.id);
    if (!INCIDENT_ID.test(id)) return res.status(400).json(errorBody("bad_request", `id must match ${INCIDENT_ID.source}`));
    const source = deps.store.sourceId(id);
    if (source === null) return res.status(404).json(errorBody("not_found", "No such incident"));
    const audit = (result: string, detail: string, params = "{}"): boolean => deps.store.audit({
      at: now(), deviceId: device.id, deviceName: device.name, addr: clientAddress(req), action: "restart.prepare", subject: id,
      params, result, detail, durMs: Math.round(performance.now() - started),
    });
    const fail = (status: number, code: "not_found" | "conflict" | "unavailable", message: string) => {
      audit(code, message);
      return res.status(status).json(errorBody(code, message));
    };
    try {
      const got = await deps.godhome.summary("all");
      if (!got.reachable || got.data === null) return fail(503, "unavailable", "GodHome is not reachable");
      const item = findSourceItem(got.data, source);
      if (!item) return fail(404, "not_found", "No such incident");
      const entry = resolveRestart(item, rs.allowlist());
      if (!entry) return fail(404, "not_found", "This incident cannot be restarted from the app");
      if (incidentResolved(item, deps.store, now())) return fail(409, "conflict", "Incident is already resolved");
      const { actionId, expiresAt } = prepareToken(deps.store, { kind: "restart", deviceId: device.id, subject: id, targetId: entry.id, incidentId: id, now: now() });
      audit("ok", "", JSON.stringify({ target: entry.id }));
      res.json({ fetchedAt: iso(now()), reachable: true, actionId, kind: entry.kind, label: entry.label, expiresAt: iso(expiresAt) });
    } catch (e: any) {
      console.warn(`[control-api] ops restart prepare: ${String(e?.name ?? "Error").slice(0, 40)}`);
      fail(503, "unavailable", "GodHome is not reachable");
    }
  });
}
