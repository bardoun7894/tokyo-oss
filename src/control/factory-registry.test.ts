import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { getJob, listJobs, projectsSummary } from "./factory-registry";
import contract from "./factory-registry-contract.json";

// Verbatim from control/migrations/001_core.sql (software-factory).
const SCHEMA = `
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, owner TEXT NOT NULL, brief_sha TEXT, status TEXT NOT NULL,
  grade TEXT, created_at TEXT NOT NULL, ended_at TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE job_phases (
  job_id TEXT NOT NULL REFERENCES jobs(id), phase TEXT NOT NULL, seq INTEGER NOT NULL, status TEXT NOT NULL,
  run_id TEXT, exit_code INTEGER, reason TEXT, started_at TEXT, ended_at TEXT, PRIMARY KEY (job_id, phase)
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, job_id TEXT, parent_run TEXT, source TEXT NOT NULL, project TEXT, host TEXT, pid INTEGER,
  pane TEXT, name TEXT, label TEXT, status TEXT NOT NULL, exit_code INTEGER, reason TEXT, started_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE problems (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, project TEXT, dedupe_key TEXT NOT NULL UNIQUE,
  detail TEXT, created_at TEXT NOT NULL, alerted_at TEXT, resolved_at TEXT
);
CREATE INDEX idx_jobs_project_status ON jobs(project, status);
CREATE INDEX idx_runs_job_id ON runs(job_id);
CREATE INDEX idx_runs_status ON runs(status);
CREATE INDEX idx_problems_kind_resolved ON problems(kind, resolved_at);
-- control/migrations/002_approvals.sql
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('repair','sync','protected-path','low-grade','reviewer-unavailable')),
  project TEXT NOT NULL,
  job_id TEXT,
  run_id TEXT,
  repo_path TEXT,
  branch TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  title TEXT,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','stale')),
  answered_by TEXT,
  answered_at TEXT,
  created_at TEXT NOT NULL,
  landed_run TEXT
);
CREATE INDEX idx_approvals_status_project ON approvals(status, project);
-- control/migrations/003 to 006 (P6): scorecards, reviews, review_picks, runs model/branch/role/harness/fallback_from/advisor
CREATE TABLE scorecards (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, run_id TEXT, project TEXT NOT NULL, branch TEXT NOT NULL, head_sha TEXT NOT NULL,
  merged_sha TEXT, grade TEXT, checks_json TEXT, evidence_dir TEXT, created_at TEXT NOT NULL, merged_at TEXT
);
CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, branch TEXT NOT NULL, head_sha TEXT NOT NULL, reviewer_model TEXT,
  family TEXT, verdict TEXT, p0_count INTEGER, p1_count INTEGER, round INTEGER, evidence_file TEXT, created_at TEXT NOT NULL
);
CREATE TABLE review_picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, branch TEXT NOT NULL, head_sha TEXT NOT NULL, reviewer_model TEXT,
  family TEXT, created_at TEXT NOT NULL
);
ALTER TABLE runs ADD COLUMN model TEXT;
ALTER TABLE runs ADD COLUMN branch TEXT;
ALTER TABLE runs ADD COLUMN role TEXT;
ALTER TABLE runs ADD COLUMN harness TEXT;
ALTER TABLE runs ADD COLUMN fallback_from TEXT;
ALTER TABLE runs ADD COLUMN advisor INTEGER;
`;

const PHASES = ["intake", "route", "build", "merge", "grade", "deploy", "readback"];

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-registry-"));
  const file = path.join(dir, "registry.db");
  const db = new Database(file);
  db.exec(SCHEMA);
  const job = db.prepare("INSERT INTO jobs (id, project, owner, brief_sha, status, grade, created_at, ended_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)");
  for (let i = 1; i <= 5; i++) {
    job.run(`j${i}`, i % 2 ? "alpha" : "beta", "owner", "abc", i === 5 ? "running" : "done", i === 5 ? null : "A", `2026-10-2${i}T10:00:00Z`, null, `2026-10-2${i}T11:00:00Z`);
  }
  const phase = db.prepare("INSERT INTO job_phases (job_id, phase, seq, status, run_id, exit_code, reason, started_at, ended_at) VALUES (?,?,?,?,?,?,?,?,?)");
  PHASES.forEach((p, i) => phase.run("j1", p, i + 1, p === "deploy" ? "fail" : "pass", `r${i + 1}`, p === "deploy" ? 1 : 0, p === "deploy" ? "token API_TOKEN=abc123 rejected" : null, "2026-10-21T10:00:00Z", "2026-10-21T10:05:00Z"));
  db.prepare("INSERT INTO runs (id, job_id, source, host, pid, pane, name, label, status, started_at, model, branch, role, harness, fallback_from, advisor) VALUES ('r1','j1','herdr','h',42,'p1','build','DB_PASSWORD=hunter2','done','2026-10-21T10:00:00Z','xai/grok-4.7','p6-t1','doer','grok','proxy/claude-sonnet-5-5',1)").run();
  db.prepare("INSERT INTO problems (kind, project, dedupe_key, created_at) VALUES ('lost-worker','alpha','k1','2026-10-21T10:00:00Z'),('lost-worker','alpha','k2','2026-10-21T10:00:00Z'),('red-integ','beta','k3','2026-10-21T10:00:00Z')").run();
  db.prepare("INSERT INTO problems (kind, project, dedupe_key, created_at, resolved_at) VALUES ('red-integ','alpha','k4','2026-10-21T10:00:00Z','2026-10-22T10:00:00Z')").run();
  db.close();
  process.env.FACTORY_REGISTRY_DB = file;
  process.env.FACTORY_CONTROL_DIR = dir;
  return { dir, file };
}

test("lists fixture jobs paged", () => {
  fixture();
  const p1 = listJobs({ limit: 2 });
  assert.ok(p1.available);
  assert.deepEqual(p1.jobs.map((j) => j.id), ["j5", "j4"]);
  assert.equal(p1.nextOffset, 2);
  const p3 = listJobs({ limit: 2, offset: 4 });
  assert.ok(p3.available);
  assert.deepEqual(p3.jobs.map((j) => j.id), ["j1"]);
  assert.equal(p3.nextOffset, null);
  const alpha = listJobs({ project: "alpha", status: "done", limit: 10 });
  assert.ok(alpha.available);
  assert.deepEqual(alpha.jobs.map((j) => j.id), ["j3", "j1"]);
  assert.equal(alpha.jobs[0].grade, "A");
});

test("job detail has 8 steps", () => {
  fixture();
  const r = getJob("j1");
  assert.ok(r.available && r.job);
  assert.deepEqual(r.job.steps.map((s) => s.name), [...PHASES, "registry"]);
  const deploy = r.job.steps.find((s) => s.name === "deploy")!;
  assert.equal(deploy.status, "fail");
  assert.equal(deploy.exitCode, 1);
  assert.deepEqual(deploy.runIds, ["r6"]);
  assert.equal(deploy.reason, "token API_TOKEN=[redacted] rejected");
  assert.equal(r.job.runs.length, 1);
  assert.equal(r.job.runs[0].label, "DB_PASSWORD=[redacted]");
  assert.equal("pid" in r.job.runs[0], false);
  const j5 = getJob("j5");
  assert.ok(j5.available && j5.job);
  assert.equal(j5.job.steps.length, 8);
  assert.ok(j5.job.steps.slice(0, 7).every((s) => s.status === "pending"));
  const none = getJob("nope");
  assert.ok(none.available && none.job === null);
});

test("projects summary: halt, pause, grade, open problems", () => {
  const { dir } = fixture();
  fs.mkdirSync(path.join(dir, "state"));
  fs.writeFileSync(path.join(dir, "state", "alpha.halt"), "");
  const r = projectsSummary();
  assert.ok(r.available);
  const alpha = r.projects.find((p) => p.project === "alpha")!;
  const beta = r.projects.find((p) => p.project === "beta")!;
  assert.equal(alpha.halted, true);
  assert.equal(alpha.paused, false);
  assert.equal(beta.halted, false);
  assert.equal(alpha.lastGrade, "A");
  assert.deepEqual(alpha.openProblems, { "lost-worker": 2 });
  assert.deepEqual(beta.openProblems, { "red-integ": 1 });
});

test("drops unknown columns", () => {
  fixture();
  const w = new Database(process.env.FACTORY_REGISTRY_DB!);
  for (const t of ["jobs", "job_phases", "runs", "problems"]) w.exec(`ALTER TABLE ${t} ADD COLUMN secret_note TEXT DEFAULT 'LEAKED-VALUE'`);
  w.close();
  const out = JSON.stringify([listJobs({ limit: 10 }), getJob("j1"), projectsSummary()]);
  assert.ok(out.includes('"j1"'));
  assert.ok(!out.includes("secret_note") && !out.includes("LEAKED-VALUE") && !out.includes("secretNote"));
});

test("missing db is unavailable not a throw", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-registry-"));
  process.env.FACTORY_REGISTRY_DB = path.join(dir, "absent.db");
  assert.deepEqual(listJobs({ limit: 5 }), { available: false });
  assert.deepEqual(getJob("j1"), { available: false });
  assert.deepEqual(projectsSummary(), { available: false });
  const bad = path.join(dir, "corrupt.db");
  fs.writeFileSync(bad, "this is not a sqlite file, just text padding ".repeat(50));
  process.env.FACTORY_REGISTRY_DB = bad;
  assert.deepEqual(listJobs({ limit: 5 }), { available: false });
  assert.deepEqual(getJob("j1"), { available: false });
  assert.deepEqual(projectsSummary(), { available: false });
});

test("contract json matches the fixture schema", () => {
  const { file } = fixture();
  const db = new Database(file, { readonly: true });
  assert.equal(contract.version, 1);
  assert.deepEqual(Object.keys(contract.tables).sort(), ["approvals", "job_phases", "jobs", "problems", "review_picks", "reviews", "runs", "scorecards"]);
  for (const [table, cols] of Object.entries(contract.tables)) {
    const actual = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    assert.deepEqual(actual, cols, table);
  }
  db.close();
});

// The software factory's own copy of the contract: Tokyo's file is a verbatim copy of it (P6.T1).
const SF_CONTRACTS = [
  process.env.FACTORY_SF_CONTRACT,
  "/root/projects/software-factory/control/contract/registry-v1.json",
  "/root/projects/software-factory-wt/p6-integ/control/contract/registry-v1.json",
].filter((p): p is string => !!p && fs.existsSync(p));

test("contract file equals the SF file", { skip: SF_CONTRACTS.length ? false : "no software-factory checkout on this host" }, () => {
  for (const sf of SF_CONTRACTS) {
    assert.deepEqual(contract, JSON.parse(fs.readFileSync(sf, "utf8")), sf);
  }
  assert.ok((contract.tables.runs as string[]).includes("harness"));
});

test("old registry without the columns still reads", () => {
  const { file } = fixture();
  // Rebuild `runs` as it was before migrations 004 and 006: the contract lists the columns, the db does not have them.
  const w = new Database(file);
  w.exec(`
    CREATE TABLE runs_old AS SELECT id, job_id, parent_run, source, project, host, pid, pane, name, label, status, exit_code, reason, started_at, ended_at FROM runs;
    DROP TABLE runs; ALTER TABLE runs_old RENAME TO runs;
  `);
  w.close();
  const r = getJob("j1");
  assert.ok(r.available && r.job);
  assert.equal(r.job.runs.length, 1);
  assert.equal(r.job.runs[0].id, "r1");
  assert.equal(r.job.runs[0].label, "DB_PASSWORD=[redacted]");
  for (const k of ["model", "harness", "role"]) assert.equal(k in r.job.runs[0], false, k);
});

test("new run columns are read, redacted, and nothing else leaks", () => {
  fixture();
  const r = getJob("j1");
  assert.ok(r.available && r.job);
  const run = r.job.runs[0];
  assert.equal(run.model, "xai/grok-4.7");
  assert.equal(run.harness, "grok");
  assert.equal(run.role, "doer");
  for (const k of ["branch", "fallbackFrom", "advisor"]) assert.equal(k in run, false, k);
});
