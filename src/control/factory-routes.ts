import { execFile } from "child_process";
import express, { type Request } from "express";
import { requireCap } from "./auth";
import { errorBody } from "./contract";
import { getJob, listJobs, projectsSummary, type JobDetail, type JobRun, type JobStep, type JobSummary, type ProjectSummary } from "./factory-registry";
import { PROJECT_NAME, parsePage } from "./paging";
import { redact } from "./redact";

/**
 * Factory registry routes (spec 001, CF1 to CF3): jobs, one job as 8 steps, and per-project state, read from `registry.db`.
 * Mounted behind `bearerAuth` (P0.T4 adds the one mount line in router.ts). Every field is picked by name, so a field added
 * to the reader never reaches the phone, and free text is cut down to one short redacted line with no filesystem paths.
 * CF4 (P1.T1) adds the halt/unhalt/pause/unpause switches, which run the fixed `factoryctl` binary.
 */
export type RegistryReader = { listJobs: typeof listJobs; getJob: typeof getJob; projectsSummary: typeof projectsSummary };

const defaultReader: RegistryReader = { listJobs, getJob, projectsSummary };

/** Runs `factoryctl` with this argv; `code` is its exit code, or null when it could not run (spawn error, timeout). */
export type FactoryCtl = (argv: string[]) => Promise<{ code: number | null }>;

const CTL_TIMEOUT_MS = 10_000;
const MAX_REASON = 200;
const CTL_VERBS = ["halt", "unhalt", "pause", "unpause"] as const;
/** `factoryctl unhalt` and `unpause` have no `--reason` option. */
const CTL_TAKES_REASON = new Set<string>(["halt", "pause"]);

/** Fixed argv, execFile, never a shell string. The binary is read per call so a test can point it at a fake. */
const defaultCtl: FactoryCtl = (argv) =>
  new Promise((resolve) => {
    try {
      execFile(process.env.FACTORYCTL_BIN || "/usr/local/bin/factoryctl", argv, { timeout: CTL_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (err: any) => {
        if (!err) return resolve({ code: 0 });
        resolve({ code: typeof err.code === "number" && !err.killed ? err.code : null });
      });
    } catch {
      resolve({ code: null });
    }
  });

/** Optional `reason` of a CF4 body: a string of at most 200 chars, control chars stripped. A string is the reason, null is "none". */
function ctlReason(body: unknown): string | null | undefined {
  const v = body && typeof body === "object" ? (body as Record<string, unknown>).reason : undefined;
  if (v === undefined) return null;
  if (typeof v !== "string" || v.length > MAX_REASON) return undefined;
  return v.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim() || null;
}

const DEFAULT_LIMIT = 50;
const MAX_TEXT = 160;
const MAX_ID = 128;
const STATUS = /^[A-Za-z0-9_-]{1,32}$/;
const OFFSET = /^\d{1,6}$/;
const ABS_PATH = /(?<![\w:\/])\/[\w.@%+~-][^\s'"]*/g;
const HOME_PATH = /(?<![\w:\/])~\/[^\s'"]*/g;

/** First line only, secrets and paths replaced, capped: a reason, never log text. */
function line(v: string | null): string | null {
  if (v === null) return null;
  const first = redact(v.split(/\r?\n/, 1)[0]).replace(ABS_PATH, "[path]").replace(HOME_PATH, "[path]").replace(/\s+/g, " ").trim();
  return first.length > MAX_TEXT ? `${first.slice(0, MAX_TEXT)}…` : first;
}

const viewJob = (j: JobSummary) => ({
  id: j.id, project: j.project, owner: j.owner, briefSha: j.briefSha, status: j.status, grade: j.grade,
  createdAt: j.createdAt, endedAt: j.endedAt, updatedAt: j.updatedAt,
});

const viewStep = (s: JobStep) => ({
  name: s.name, status: s.status, runIds: s.runIds, exitCode: s.exitCode, reason: line(s.reason), startedAt: s.startedAt, endedAt: s.endedAt,
});

const viewRun = (r: JobRun) => ({
  id: r.id, jobId: r.jobId, parentRun: r.parentRun, source: r.source, project: r.project, name: line(r.name), label: line(r.label),
  status: r.status, exitCode: r.exitCode, reason: line(r.reason), startedAt: r.startedAt, endedAt: r.endedAt,
  ...(r.model !== undefined ? { model: line(r.model) } : {}),
  ...(r.harness !== undefined ? { harness: line(r.harness) } : {}),
  ...(r.role !== undefined ? { role: line(r.role) } : {}),
});

const viewDetail = (j: JobDetail) => ({ ...viewJob(j), steps: j.steps.map(viewStep), runs: j.runs.map(viewRun) });

const viewProject = (p: ProjectSummary) => ({
  project: p.project, halted: p.halted, paused: p.paused, lastGrade: p.lastGrade, openProblems: p.openProblems,
});

const unavailable = () => errorBody("unavailable", "The factory registry is not reachable");

/** Query values as plain strings; an array or object (`?project=a&project=b`) is a 400. */
function jobsQuery(req: Request): { project?: string; status?: string; limit: number; offset: number } | string {
  for (const k of ["project", "status", "limit", "offset", "before", "since"]) {
    if (req.query[k] !== undefined && typeof req.query[k] !== "string") return `${k} must be a single value`;
  }
  if (req.query.before !== undefined || req.query.since !== undefined) return "before and since are not supported here; page with offset";
  const page = parsePage(req, DEFAULT_LIMIT);
  if (typeof page === "string") return page;
  const { project, status, offset } = req.query as Record<string, string | undefined>;
  if (project !== undefined && !PROJECT_NAME.test(project)) return "project is not a valid project name";
  if (status !== undefined && !STATUS.test(status)) return "status is not a valid status";
  if (offset !== undefined && !OFFSET.test(offset)) return "offset must be an integer from 0 to 999999";
  return { ...(project !== undefined ? { project } : {}), ...(status !== undefined ? { status } : {}), limit: page.limit, offset: Number(offset ?? 0) };
}

export function factoryRegistryRoutes(reader: RegistryReader = defaultReader, ctl: FactoryCtl = defaultCtl): express.Router {
  const r = express.Router();

  r.get("/factory/jobs", (req, res) => {
    const q = jobsQuery(req);
    if (typeof q === "string") return res.status(400).json(errorBody("bad_request", q));
    const out = reader.listJobs(q);
    if (!out.available) return res.status(503).json(unavailable());
    res.json({ jobs: out.jobs.map(viewJob), nextOffset: out.nextOffset });
  });

  r.get("/factory/jobs/:id", (req, res) => {
    const id = String(req.params.id);
    if (id.length > MAX_ID) return res.status(404).json(errorBody("not_found", "No such job"));
    const out = reader.getJob(id);
    if (!out.available) return res.status(503).json(unavailable());
    if (!out.job) return res.status(404).json(errorBody("not_found", "No such job"));
    res.json({ job: viewDetail(out.job) });
  });

  r.get("/factory/projects", (_req, res) => {
    const out = reader.projectsSummary();
    if (!out.available) return res.status(503).json(unavailable());
    res.json({ projects: out.projects.map(viewProject) });
  });

  // Deviation from the spec's `factory:run`: a new capability would edit store.ts (owned by 012), so the existing `ops:run` guards these.
  for (const verb of CTL_VERBS) r.post(`/factory/projects/:p/${verb}`, requireCap("ops:run"), async (req, res) => {
    const project = String(req.params.p);
    const out = reader.projectsSummary();
    if (!out.available) return res.status(503).json(unavailable());
    if (!PROJECT_NAME.test(project) || !out.projects.some((x) => x.project === project)) return res.status(404).json(errorBody("not_found", "No such project"));
    const reason = ctlReason(req.body);
    if (reason === undefined) return res.status(400).json(errorBody("bad_request", `reason must be a string of at most ${MAX_REASON} characters`));
    const argv = [verb, project, ...(reason && CTL_TAKES_REASON.has(verb) ? [`--reason=${reason}`] : [])];
    const { code } = await ctl(argv);
    if (code !== 0) return res.status(502).json({ ...errorBody("unavailable", `factoryctl ${verb} failed`), exitCode: code });
    res.json({ ok: true, project, action: verb });
  });

  return r;
}
