import { execFile } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import express from "express";
import type { HerdrHost } from "../herdr-run";
import { RUN_STATUSES, errorBody, normRunStatus, viewLogEvent, viewRun } from "./contract";
import { PROJECT_NAME, pageOf, parsePage } from "./paging";
import { redact } from "./redact";
import type { ControlRun, ControlStore } from "./store";
import type { RunRow } from "./contract";
import type { Monitor } from "./monitor";
import { factorySubmit } from "./factory-submit";

const DEFAULT_LIMIT = 20;
const RUN_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const TAIL_BYTES = 64 * 1024;
const CHUNK_BYTES = 256 * 1024;
const MAX_EVENTS = 200;
const MAX_WAIT_S = 25;
const MAX_Q = 200;
const PREVIEW = 200;
const OPEN = new Set(["queued", "running"]);

export interface RunsDeps {
  /** The herdr host a run lives on; the API's `mac` is the herdr `laptop` host. */
  hostFor(host: "mac" | "server"): HerdrHost | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How often a long-poll rechecks the host. Default 2000. */
  pollMs?: number;
}

// --- recording (called by executeClaude) ---

export interface RunStart {
  id: string; project: string; host: "mac" | "server"; prompt: string;
  model: string | null; tier: string | null; label: string; now: number;
  source?: ControlRun["source"];
  /** The deploy offer this run answers (G6); a row queued with its own offer keeps it when this is absent. */
  offerId?: string;
}

/**
 * A `queued` row written when a deploy is approved (K1), before herdr starts anything, so an approved offer always has a run to
 * follow even when the start fails or the Mac is offline. An existing row is never overwritten.
 */
export function recordRunQueued(store: ControlStore, s: { id: string; project: string; host: "mac" | "server"; prompt: string; now: number; offerId: string }): void {
  if (store.getRun(s.id)) return;
  store.insertRun({
    id: s.id, project: s.project, source: "tokyo", status: "queued", model: null, harness: "claude", worker: null, tier: null,
    promptPreview: redact(s.prompt).slice(0, PREVIEW), startedAt: s.now, endedAt: null, exitCode: null, host: s.host, offerId: s.offerId, workspace: null,
  });
}

// --- factory registry (fire and forget; never changes what is stored) ---

export type RegistryExec = (bin: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string }>;
const defaultExec: RegistryExec = (bin, args, opts) =>
  new Promise((resolve, reject) => execFile(bin, args, { ...opts, maxBuffer: 64 * 1024 }, (err, stdout) => (err ? reject(err) : resolve({ stdout: String(stdout) }))));
let registryExec: RegistryExec = defaultExec;
/** Test hook: replaces the exec used for `frun`. Call with no argument to restore the default. */
export function setRunRegistryExec(fn?: RegistryExec): void { registryExec = fn ?? defaultExec; }

const REGISTRY_TIMEOUT_MS = 4000;
const REGISTRY_PROJECT = /^[a-z0-9._-]+$/;
/** Tokyo run id to the `frun` run id, kept until the run finishes. */
const frunIds = new Map<string, string>();

const frunBin = () => process.env.FACTORY_FRUN || "/usr/local/bin/frun";

/**
 * Registers a newly started server run: `factory submit` with the redacted prompt as the brief, then `frun start`. Run ids made of
 * `tokyo:HOST:PID:EPOCH` collide if two runs start in the same second from the same process; `--pid` is passed only if a child pid
 * is available (it is not here). Never throws and is never awaited by the caller.
 */
function registerRunStarted(s: RunStart): void {
  const exec = registryExec;
  // Under the node test runner the live frun is never called (it would write the live registry); tests inject an exec or FACTORY_FRUN.
  if (exec === defaultExec && !process.env.FACTORY_FRUN && process.env.NODE_TEST_CONTEXT) return;
  void (async () => {
    const project = s.project.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!REGISTRY_PROJECT.test(project)) return;
    let dir: string | undefined;
    try {
      let jobId: string | null = null;
      try {
        dir = await mkdtemp(join(tmpdir(), "tokyo-run-brief-"));
        const file = join(dir, "brief.md");
        await writeFile(file, redact(s.prompt), { mode: 0o600 });
        jobId = await factorySubmit(project, file, "tokyo");
      } catch { /* no brief file or no job: the run is still registered, without a job */ }
      const args = ["start", "--source", "tokyo", "--project", project, "--name", s.id, "--label", s.label, ...(jobId ? ["--job", jobId] : [])];
      const out = await exec(frunBin(), args, { timeout: REGISTRY_TIMEOUT_MS });
      const frunId = String(out?.stdout ?? "").split("\n")[0].trim();
      if (frunId) frunIds.set(s.id, frunId);
    } catch { /* registry down: ignored */ } finally {
      if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  })();
}

function registerRunFinished(id: string, code: number): void {
  const frunId = frunIds.get(id);
  if (!frunId) return;
  frunIds.delete(id);
  void (async () => {
    try { await registryExec(frunBin(), ["finish", frunId, String(code)], { timeout: REGISTRY_TIMEOUT_MS }); } catch { /* ignored */ }
  })();
}

/** The run is on its way: adopts a `queued` row (write-spec) or inserts a new one. */
export function recordRunStarted(store: ControlStore, s: RunStart): void {
  const live = { status: "running" as const, model: s.model, harness: "claude", worker: s.label, tier: s.tier, workspace: s.label };
  if (store.getRun(s.id)) return store.updateRun(s.id, { ...live, ...(s.offerId ? { offerId: s.offerId } : {}) });
  store.insertRun({
    id: s.id, project: s.project, source: s.source ?? "tokyo", ...live, promptPreview: redact(s.prompt).slice(0, PREVIEW),
    startedAt: s.now, endedAt: null, exitCode: null, host: s.host, offerId: s.offerId ?? null,
  });
  if (s.host === "server") registerRunStarted(s);
}

/** Closes an open run. A run Tokyo already marked stopped keeps that status. */
export function recordRunFinished(store: ControlStore, id: string, f: { ok: boolean; exitCode: number | null; model?: string | null; now: number }): void {
  const row = store.getRun(id);
  if (!row || !OPEN.has(row.status)) return;
  store.updateRun(id, { status: f.ok ? "succeeded" : "failed", exitCode: f.exitCode, endedAt: f.now, ...(f.model ? { model: f.model } : {}) });
  registerRunFinished(id, f.exitCode ?? (f.ok ? 0 : 1));
}

export function recordRunFailedToStart(store: ControlStore, id: string, now: number): void {
  const row = store.getRun(id);
  if (row && OPEN.has(row.status)) store.updateRun(id, { status: "failed", endedAt: now });
}

// --- log parsing ---

interface Ev { t: number; kind: string; text: string; tool: string | null }

function toolSummary(name: string, input: any): string {
  const v = input?.command ?? input?.file_path ?? input?.path ?? input?.pattern ?? input?.description ?? input?.url ?? "";
  return `${name}${v ? `: ${String(v)}` : ""}`;
}

/** One stream-json line to log events. Tool output (user messages) is never forwarded. */
function parseLine(line: string, t: number): Ev[] {
  let j: any;
  try { j = JSON.parse(line); } catch { return []; }
  const clean = (text: string) => redact(text).slice(0, 2000);
  if (j?.type === "system" && j.subtype === "init") return [{ t, kind: "system", text: clean(`Session started${j.model ? ` (${j.model})` : ""}`), tool: null }];
  if (j?.type === "result") return [{ t, kind: "result", text: clean(String(j.result ?? "")), tool: null }];
  if (j?.type === "assistant" && Array.isArray(j.message?.content)) {
    const out: Ev[] = [];
    for (const b of j.message.content) {
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) out.push({ t, kind: "assistant", text: clean(b.text), tool: null });
      else if (b?.type === "tool_use" && typeof b.name === "string") out.push({ t, kind: "tool", text: clean(toolSummary(b.name, b.input)), tool: b.name.slice(0, 40) });
    }
    return out;
  }
  return [];
}

interface Chunk { lines: string[]; start: number }

/** Complete lines from `after`, or from the last 64 KB when `after` is undefined (the cut-off partial first line is dropped). */
async function readChunk(host: HerdrHost, id: string, after: number | undefined): Promise<Chunk> {
  if (after !== undefined) {
    const r = await host.readFrom(id, after, CHUNK_BYTES);
    return { lines: r.text.split("\n").slice(0, -1), start: after };
  }
  const size = await host.size(id);
  const from = Math.max(0, (size ?? 0) - TAIL_BYTES);
  if (from === 0) {
    const r = await host.readFrom(id, 0, CHUNK_BYTES);
    return { lines: r.text.split("\n").slice(0, -1), start: 0 };
  }
  const r = await host.readFrom(id, from - 1, CHUNK_BYTES);
  const cut = r.text.indexOf("\n") + 1;
  return { lines: r.text.slice(cut).split("\n").slice(0, -1), start: from - 1 + Buffer.byteLength(r.text.slice(0, cut)) };
}

/**
 * What the app may offer on a run row (spec section 5), decided here so the app infers nothing. `stop` needs a handle and a
 * running run: a herdr workspace, or a monitor run (the monitor relays it). `log` needs somewhere a log can come from: the same
 * handle. Rows without a workspace (S2, queued) get neither; there is no `retry` (X13 was dropped, G3).
 */
export function runActions(run: RunRow, fromMonitor: boolean): ("stop" | "log")[] {
  const handle = fromMonitor || !!run.workspace;
  return [...(handle && run.status === "running" ? ["stop" as const] : []), ...(handle ? ["log" as const] : [])];
}

const bad = (res: express.Response, message: string) => res.status(400).json(errorBody("bad_request", message));

export function runsRoutes(store: ControlStore, deps?: RunsDeps, monitor?: Monitor): express.Router {
  const r = express.Router();
  const now = deps?.now ?? Date.now;
  const sleep = deps?.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const hostOf = (run: ControlRun) => deps?.hostFor(run.host);

  r.get("/runs", (req, res) => {
    const page = parsePage(req, DEFAULT_LIMIT);
    if (typeof page === "string") return bad(res, page);
    const project = typeof req.query.project === "string" && req.query.project ? req.query.project : undefined;
    if (project !== undefined && !PROJECT_NAME.test(project)) return bad(res, "Invalid project name");
    const status = typeof req.query.status === "string" && req.query.status ? req.query.status : undefined;
    if (status !== undefined && !(RUN_STATUSES as readonly string[]).includes(status)) return bad(res, "Invalid status");
    const watched = (monitor?.listRuns() ?? []).filter((x: RunRow) =>
      (project === undefined || x.project === project) && (status === undefined || x.status === status) &&
      (page.before === undefined || x.startedAt < page.before) &&
      (page.since === undefined || x.startedAt >= page.since || (x.endedAt ?? -1) >= page.since));
    const rows: RunRow[] = [...store.listRuns({ project, status, before: page.before, since: page.since, limit: page.limit + 1 }), ...watched]
      .sort((a, b) => b.startedAt - a.startedAt);
    const { page: items, next } = pageOf(rows, page.limit, (x) => x.startedAt);
    const fromMonitor = new Set(watched.map((x) => x.id));
    res.json({ runs: items.map((x) => ({ ...viewRun(x), actions: runActions(x, fromMonitor.has(x.id)) })), next });
  });

  const find = (id: string) => (RUN_ID.test(id) ? store.getRun(id) : undefined);
  const notFound = (res: express.Response) => res.status(404).json(errorBody("not_found", "No such run"));

  r.get("/runs/:id", (req, res) => {
    const id = String(req.params.id);
    const own = find(id);
    const run = own ?? (RUN_ID.test(id) ? monitor?.getRun(id) : undefined);
    if (!run) return notFound(res);
    res.json({ ...viewRun(run), actions: runActions(run, !own) });
  });

  /** A monitor run's reply, passed through in the contract's shapes; a monitor that is down is 503. */
  const relay = (res: express.Response, out: { status: number; json: any } | Error, ok: (json: any) => unknown) => {
    if (out instanceof Error) {
      console.error("[control-api] monitor call failed:", out.message);
      return res.status(503).json(errorBody("unavailable", "Cannot reach the monitor"));
    }
    if (out.status === 200) return res.json(ok(out.json));
    if (out.status === 404) return notFound(res);
    if (out.status === 409) return res.status(409).json(errorBody("conflict", "The run is not running"));
    return res.status(503).json(errorBody("unavailable", "The monitor could not answer"));
  };

  r.get("/runs/:id/log", async (req, res) => {
    const run0 = find(String(req.params.id));
    const watched = run0 || !RUN_ID.test(String(req.params.id)) ? undefined : monitor?.getRun(String(req.params.id));
    if (!run0 && !watched) return notFound(res);
    const rawAfter = req.query.after, rawWait = req.query.wait, rawQ = req.query.q;
    if (rawAfter !== undefined && !(typeof rawAfter === "string" && /^\d{1,12}$/.test(rawAfter))) return bad(res, "after must be a cursor from a previous response");
    if (rawWait !== undefined && !(typeof rawWait === "string" && /^\d{1,2}$/.test(rawWait) && Number(rawWait) <= MAX_WAIT_S)) return bad(res, `wait must be 0 to ${MAX_WAIT_S}`);
    if (rawQ !== undefined && !(typeof rawQ === "string" && rawQ.length <= MAX_Q)) return bad(res, `q must be at most ${MAX_Q} characters`);
    const after = rawAfter === undefined ? undefined : Number(rawAfter);
    const q = typeof rawQ === "string" && rawQ ? rawQ.toLowerCase() : undefined;
    if (watched) {
      const out = await monitor!.log(watched.id, rawAfter, rawWait === undefined ? 0 : Number(rawWait)).catch((e: Error) => e);
      return relay(res, out, (j) => ({
        events: (Array.isArray(j?.events) ? j.events : []).slice(0, MAX_EVENTS)
          .map((e: any) => ({ t: Date.parse(e?.t) || now(), kind: String(e?.kind), text: redact(String(e?.text ?? "")).slice(0, 2000), tool: typeof e?.tool === "string" ? e.tool.slice(0, 40) : null }))
          .filter((e: Ev) => !q || e.text.toLowerCase().includes(q))
          .map(viewLogEvent),
        cursor: /^\d{1,12}$/.test(String(j?.cursor)) ? String(j.cursor) : (rawAfter ?? "0"),
        done: j?.done === true,
        status: normRunStatus(j?.status) ?? "failed",
      }));
    }
    const deadline = now() + (rawWait === undefined ? 0 : Number(rawWait)) * 1000;
    const host = hostOf(run0!);

    let cursor = after ?? 0;
    let from: number | undefined = after;
    let events: Ev[] = [];
    let done = false;
    let status = run0!.status;
    for (;;) {
      const run = store.getRun(run0!.id) ?? run0!;
      status = run.status;
      let consumed = 0;
      if (host) {
        try {
          const chunk = await readChunk(host, run.id, from);
          cursor = chunk.start;
          from = cursor;
          for (const line of chunk.lines) {
            const evs = parseLine(line, now()).filter((e) => !q || e.text.toLowerCase().includes(q));
            if (events.length > 0 && events.length + evs.length > MAX_EVENTS) break;
            events.push(...evs);
            cursor += Buffer.byteLength(line) + 1;
            consumed++;
          }
        } catch { /* no readable log for this run (not a herdr run, or the file is not there yet) */ }
      }
      const exited = OPEN.has(run.status) && host ? (await host.read(run.id, "exit_code").catch(() => null)) !== null : !OPEN.has(run.status);
      done = exited && consumed === 0;
      if (consumed > 0 || done || now() >= deadline) break;
      await sleep(deps?.pollMs ?? 2000);
    }
    res.json({ events: events.map(viewLogEvent), cursor: String(cursor), done, status: normRunStatus(status) ?? "failed" });
  });

  r.post("/runs/:id/stop", async (req, res) => {
    const run = find(String(req.params.id));
    const watched = run || !RUN_ID.test(String(req.params.id)) ? undefined : monitor?.getRun(String(req.params.id));
    if (watched) return relay(res, await monitor!.stop(watched.id).catch((e: Error) => e), () => ({ ok: true, status: "stopped" }));
    if (!run) return notFound(res);
    if (run.status !== "running") return res.status(409).json(errorBody("conflict", "The run is not running"));
    const host = hostOf(run);
    if (!run.workspace) return res.status(409).json(errorBody("conflict", "This run cannot be stopped from the app"));
    if (!host) return res.status(503).json(errorBody("unavailable", "Cannot reach the run's host"));
    try {
      await host.stop(run.workspace);
    } catch (e: any) {
      console.error("[control-api] stop failed:", e?.message ?? e);
      return res.status(503).json(errorBody("unavailable", "Could not stop the run"));
    }
    // A killed workspace may never write exit_code, so Tokyo ends the row itself.
    const fresh = store.getRun(run.id);
    if (fresh && fresh.status === "running") store.updateRun(run.id, { status: "stopped", endedAt: now() });
    res.json({ ok: true, status: "stopped" });
  });

  return r;
}
