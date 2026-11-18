import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { PROJECT_NAME } from "./paging";
import { redact } from "./redact";
import contract from "./factory-registry-contract.json";

/**
 * Read-only view of the software factory's `registry.db` (spec 001, CF1 to CF3). The file is written by the control scripts as
 * root; Tokyo opens it `readonly` per call and never writes. Every query names its columns (the ones in
 * `factory-registry-contract.json`) and every row is mapped field by field, so a column added to the db never reaches the phone.
 * A missing, locked or corrupt file answers `{ available: false }`, never a throw.
 */
export type Result<T> = ({ available: true } & T) | { available: false };

export interface JobSummary {
  id: string; project: string; owner: string; briefSha: string | null; status: string; grade: string | null;
  createdAt: string; endedAt: string | null; updatedAt: string;
}
export interface JobStep {
  name: string; status: string; runIds: string[]; exitCode: number | null; reason: string | null;
  startedAt: string | null; endedAt: string | null;
}
export interface JobRun {
  id: string; jobId: string | null; parentRun: string | null; source: string; project: string | null; name: string | null;
  label: string | null; status: string; exitCode: number | null; reason: string | null; startedAt: string; endedAt: string | null;
  /** P6 columns (D5): present only when the contract lists them and this registry has them. */
  model?: string | null; harness?: string | null; role?: string | null;
}
export interface JobDetail extends JobSummary { steps: JobStep[]; runs: JobRun[] }
export interface ProjectSummary {
  project: string; halted: boolean; paused: boolean; lastGrade: string | null; openProblems: Record<string, number>;
}

/** A pending row of `approvals` (D11): what a Control offer is built from. Free text is redacted. */
export interface PendingApproval {
  id: string; kind: string; project: string; branch: string; headSha: string; title: string | null; detail: string | null; createdAt: string;
}

export const JOB_PHASES = ["intake", "route", "build", "merge", "grade", "deploy", "readback"] as const;
const MAX_LIMIT = 100;
const BUSY_MS = 500;

const registryPath = () => process.env.FACTORY_REGISTRY_DB || "/root/.factory-control/registry.db";
const stateDir = () => path.join(process.env.FACTORY_CONTROL_DIR || "/root/.factory-control", "state");

function withDb<T>(fn: (db: Database.Database) => T): Result<T extends object ? T : never> {
  let db: Database.Database | undefined;
  try {
    db = new Database(registryPath(), { readonly: true, fileMustExist: true, timeout: BUSY_MS });
    return { available: true, ...(fn(db) as object) } as Result<T extends object ? T : never>;
  } catch {
    return { available: false };
  } finally {
    try { db?.close(); } catch { /* nothing to close */ }
  }
}

type Row = Record<string, any>;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const clean = (v: unknown): string | null => (typeof v === "string" ? redact(v) : null);

/** Extra `runs` columns Control may show (D5). A column is selected only when the contract lists it and the db has it (an older registry lacks them). */
const RUN_EXTRA = ["model", "harness", "role"] as const;
const RUN_COLS = "id, job_id, parent_run, source, project, name, label, status, exit_code, reason, started_at, ended_at";

function runExtraCols(db: Database.Database): (typeof RUN_EXTRA)[number][] {
  const listed = new Set<string>(contract.tables.runs);
  const have = new Set((db.prepare("PRAGMA table_info(runs)").all() as Row[]).map((c) => String(c.name)));
  return RUN_EXTRA.filter((c) => listed.has(c) && have.has(c));
}

const JOB_COLS = "id, project, owner, brief_sha, status, grade, created_at, ended_at, updated_at";

function toJob(r: Row): JobSummary {
  return {
    id: String(r.id), project: String(r.project), owner: String(r.owner), briefSha: str(r.brief_sha), status: String(r.status),
    grade: str(r.grade), createdAt: String(r.created_at), endedAt: str(r.ended_at), updatedAt: String(r.updated_at),
  };
}

export function listJobs(q: { project?: string; status?: string; limit: number; offset?: number }): Result<{ jobs: JobSummary[]; nextOffset: number | null }> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(q.limit) || 1));
  const offset = Math.max(0, Math.floor(q.offset ?? 0) || 0);
  return withDb((db) => {
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.project) { where.push("project = ?"); args.push(q.project); }
    if (q.status) { where.push("status = ?"); args.push(q.status); }
    const rows = db
      .prepare(`SELECT ${JOB_COLS} FROM jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...args, limit + 1, offset) as Row[];
    return { jobs: rows.slice(0, limit).map(toJob), nextOffset: rows.length > limit ? offset + limit : null };
  });
}

export function getJob(id: string): Result<{ job: JobDetail | null }> {
  return withDb((db) => {
    const row = db.prepare(`SELECT ${JOB_COLS} FROM jobs WHERE id = ?`).get(id) as Row | undefined;
    if (!row) return { job: null };
    const job = toJob(row);
    const phases = db
      .prepare("SELECT phase, seq, status, run_id, exit_code, reason, started_at, ended_at FROM job_phases WHERE job_id = ? ORDER BY seq")
      .all(id) as Row[];
    const byPhase = new Map(phases.map((p) => [String(p.phase), p]));
    const steps = JOB_PHASES.map((name, i) => {
      const p = byPhase.get(name);
      const step: JobStep = p
        ? {
            name, status: String(p.status), runIds: str(p.run_id) ? [String(p.run_id)] : [], exitCode: num(p.exit_code),
            reason: clean(p.reason), startedAt: str(p.started_at), endedAt: str(p.ended_at),
          }
        : { name, status: "pending", runIds: [], exitCode: null, reason: null, startedAt: null, endedAt: null };
      return { step, seq: num(p?.seq) ?? i + 1 };
    })
      .sort((a, b) => a.seq - b.seq)
      .map((s) => s.step);
    // View step: the job row closed with its final status.
    steps.push({ name: "registry", status: job.status, runIds: [], exitCode: null, reason: null, startedAt: job.createdAt, endedAt: job.endedAt });
    const extra = runExtraCols(db);
    const cols = [RUN_COLS, ...extra].join(", ");
    const runs = (db.prepare(`SELECT ${cols} FROM runs WHERE job_id = ? ORDER BY started_at, id`).all(id) as Row[]).map((r): JobRun => {
      const run: JobRun = {
        id: String(r.id), jobId: str(r.job_id), parentRun: str(r.parent_run), source: String(r.source), project: str(r.project),
        name: clean(r.name), label: clean(r.label), status: String(r.status), exitCode: num(r.exit_code), reason: clean(r.reason),
        startedAt: String(r.started_at), endedAt: str(r.ended_at),
      };
      for (const c of extra) run[c] = clean(r[c]);
      return run;
    });
    return { job: { ...job, steps, runs } };
  });
}

/** Projects named by a halt or pause file in the control state dir. */
function stateFlags(): { halted: Set<string>; paused: Set<string> } {
  const halted = new Set<string>();
  const paused = new Set<string>();
  try {
    for (const f of fs.readdirSync(stateDir())) {
      const m = /^(.+)\.(halt|pause)$/.exec(f);
      if (m && PROJECT_NAME.test(m[1])) (m[2] === "halt" ? halted : paused).add(m[1]);
    }
  } catch { /* no state dir: nothing halted */ }
  return { halted, paused };
}

export function projectsSummary(): Result<{ projects: ProjectSummary[] }> {
  return withDb((db) => {
    const flags = stateFlags();
    const names = new Set<string>([...flags.halted, ...flags.paused]);
    for (const r of db.prepare("SELECT DISTINCT project FROM jobs").all() as Row[]) if (str(r.project)) names.add(r.project);
    for (const r of db.prepare("SELECT DISTINCT project FROM problems WHERE project IS NOT NULL").all() as Row[]) if (str(r.project)) names.add(r.project);
    const grade = db.prepare("SELECT grade FROM jobs WHERE project = ? AND grade IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1");
    const problems = db.prepare("SELECT kind, COUNT(*) AS n FROM problems WHERE project = ? AND resolved_at IS NULL GROUP BY kind ORDER BY kind");
    const projects = [...names]
      .filter((p) => PROJECT_NAME.test(p))
      .sort()
      .map((project): ProjectSummary => {
        const openProblems: Record<string, number> = {};
        for (const r of problems.all(project) as Row[]) openProblems[String(r.kind)] = Number(r.n);
        return {
          project, halted: flags.halted.has(project), paused: flags.paused.has(project),
          lastGrade: str((grade.get(project) as Row | undefined)?.grade), openProblems,
        };
      });
    return { projects };
  });
}

/** Pending approvals, oldest first. `[]` when the db is unavailable or has no `approvals` table (an older registry). */
export function listPendingApprovals(): PendingApproval[] {
  const r = withDb((db) => ({
    approvals: (
      db
        .prepare("SELECT id, kind, project, branch, head_sha, title, detail, created_at FROM approvals WHERE status = 'pending' ORDER BY created_at, id")
        .all() as Row[]
    ).map(
      (a): PendingApproval => ({
        id: String(a.id), kind: String(a.kind), project: String(a.project), branch: String(a.branch), headSha: String(a.head_sha),
        title: clean(a.title), detail: clean(a.detail), createdAt: String(a.created_at),
      }),
    ),
  }));
  return r.available ? r.approvals : [];
}
