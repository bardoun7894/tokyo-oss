import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import express from "express";
import Database from "better-sqlite3";
import { bearerAuth, type ControlDeps } from "./auth";
import { LoginThrottle } from "./rate-limit";
import { ControlStore } from "./store";
import { serveApp } from "./test-http";
import { controlApp } from "./test-app";
import { factoryRegistryRoutes } from "./factory-routes";
import examples from "./factory-contract-examples.json";

const MIGRATION = "/root/projects/software-factory-wt/main/control/migrations/001_core.sql";
const PHASES = ["intake", "route", "build", "merge", "grade", "deploy", "readback"];
const LOG_LINE = "ERROR " + "compile step output line ".repeat(40);

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-routes-"));
  const file = path.join(dir, "registry.db");
  const db = new Database(file);
  db.exec(fs.readFileSync(MIGRATION, "utf8"));
  const job = db.prepare("INSERT INTO jobs (id, project, owner, brief_sha, status, grade, created_at, ended_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)");
  for (let i = 1; i <= 5; i++) {
    job.run(`j${i}`, i % 2 ? "alpha" : "beta", "owner", "abc123", i === 5 ? "running" : "done", i === 5 ? null : "A", `2026-10-2${i}T10:00:00Z`, i === 5 ? null : `2026-10-2${i}T10:30:00Z`, `2026-10-2${i}T11:00:00Z`);
  }
  const phase = db.prepare("INSERT INTO job_phases (job_id, phase, seq, status, run_id, exit_code, reason, started_at, ended_at) VALUES (?,?,?,?,?,?,?,?,?)");
  PHASES.forEach((p, i) =>
    phase.run("j1", p, i + 1, p === "deploy" ? "fail" : "pass", `r${i + 1}`, p === "deploy" ? 1 : 0,
      p === "deploy" ? `deploy failed, see /home/tokyo-agent/work/x/deploy.log and /root/projects/software-factory/runs/r6/out.txt\n${LOG_LINE}` : null,
      "2026-10-21T10:00:00Z", "2026-10-21T10:05:00Z"));
  db.prepare("INSERT INTO runs (id, job_id, source, host, pid, pane, name, label, status, exit_code, reason, started_at, ended_at) VALUES ('r6','j1','herdr','h',42,'p1','deploy','deploy j1','failed',1,?, '2026-10-21T10:00:00Z','2026-10-21T10:05:00Z')")
    .run(`exit 1 in /root/tokyo/ops/deploy.sh ${LOG_LINE}`);
  db.prepare("INSERT INTO problems (kind, project, dedupe_key, created_at) VALUES ('lost-worker','alpha','k1','2026-10-21T10:00:00Z'),('red-integ','beta','k3','2026-10-21T10:00:00Z')").run();
  db.close();
  process.env.FACTORY_REGISTRY_DB = file;
  process.env.FACTORY_CONTROL_DIR = dir;
  fs.mkdirSync(path.join(dir, "state"));
  fs.writeFileSync(path.join(dir, "state", "alpha.halt"), "");
  return { dir, file };
}

async function app(router = factoryRegistryRoutes()) {
  const store = new ControlStore(new Database(":memory:"));
  const deps: ControlDeps = { store, throttle: new LoginThrottle(), checkCredentials: () => true };
  const token = crypto.randomBytes(32).toString("hex");
  store.createDevice({ name: "t", tokenHash: crypto.createHash("sha256").update(token).digest("hex"), now: Date.now() });
  const srv = express();
  srv.use("/control-api/v1", bearerAuth(deps), router);
  const s = await serveApp(srv);
  const get = (p: string) => s.call("GET", "/control-api/v1" + p, undefined, { authorization: `Bearer ${token}` });
  return { s, get };
}

const kind = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/** Same keys and value types; a null on either side matches any type; `openProblems` has data-driven keys. */
function sameShape(example: unknown, live: unknown, at: string): void {
  if (example === null || live === null) return;
  assert.equal(kind(live), kind(example), `type at ${at}`);
  if (Array.isArray(example)) {
    assert.ok(example.length > 0, `example array at ${at} must not be empty`);
    for (const item of live as unknown[]) sameShape(example[0], item, `${at}[]`);
  } else if (typeof example === "object") {
    const e = example as Record<string, unknown>;
    const l = live as Record<string, unknown>;
    if (at.endsWith("openProblems")) {
      for (const v of Object.values(l)) assert.equal(typeof v, "number", `count at ${at}`);
      return;
    }
    assert.deepEqual(Object.keys(l).sort(), Object.keys(e).sort(), `keys at ${at}`);
    for (const k of Object.keys(e)) sameShape(e[k], l[k], `${at}.${k}`);
  }
}

test("401 without token", async () => {
  fixture();
  const { s, get } = await app();
  for (const p of ["/factory/jobs", "/factory/jobs/j1", "/factory/projects"]) {
    const r = await s.call("GET", "/control-api/v1" + p);
    assert.equal(r.status, 401, p);
    assert.equal(r.json.error.code, "unauthorized");
  }
  const bad = await s.call("GET", "/control-api/v1/factory/jobs", undefined, { authorization: "Bearer " + "0".repeat(64) });
  assert.equal(bad.status, 401);
  assert.equal((await get("/factory/jobs")).status, 200);
});

test("lists jobs", async () => {
  fixture();
  const { get } = await app();
  const p1 = await get("/factory/jobs?limit=2");
  assert.equal(p1.status, 200);
  assert.deepEqual(p1.json.jobs.map((j: { id: string }) => j.id), ["j5", "j4"]);
  assert.equal(p1.json.nextOffset, 2);
  assert.equal("available" in p1.json, false);
  const p3 = await get("/factory/jobs?limit=2&offset=4");
  assert.deepEqual(p3.json.jobs.map((j: { id: string }) => j.id), ["j1"]);
  assert.equal(p3.json.nextOffset, null);
  const f = await get("/factory/jobs?project=alpha&status=done");
  assert.deepEqual(f.json.jobs.map((j: { id: string }) => j.id), ["j3", "j1"]);
  assert.equal(f.json.jobs[0].grade, "A");
  assert.equal((await get("/factory/jobs")).json.jobs.length, 5);
});

test("400 on bad params", async () => {
  fixture();
  const { get } = await app();
  for (const q of ["limit=0", "limit=101", "limit=abc", "offset=-1", "offset=x", "project=a%20b", "project=../x", "status=a;b", "project=a&project=b", "before=2026-10-01T00:00:00Z"]) {
    const r = await get("/factory/jobs?" + q);
    assert.equal(r.status, 400, q);
    assert.equal(r.json.error.code, "bad_request", q);
  }
});

test("job detail has 8 steps and runs", async () => {
  fixture();
  const { get } = await app();
  const r = await get("/factory/jobs/j1");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.job.steps.map((x: { name: string }) => x.name), [...PHASES, "registry"]);
  const deploy = r.json.job.steps.find((x: { name: string }) => x.name === "deploy");
  assert.equal(deploy.status, "fail");
  assert.equal(deploy.exitCode, 1);
  assert.deepEqual(deploy.runIds, ["r6"]);
  assert.equal(r.json.job.runs.length, 1);
  assert.equal("pid" in r.json.job.runs[0], false);
});

test("404 unknown job", async () => {
  fixture();
  const { get } = await app();
  for (const id of ["nope", "x".repeat(300), "a%20b"]) {
    const r = await get("/factory/jobs/" + id);
    assert.equal(r.status, 404, id);
    assert.equal(r.json.error.code, "not_found");
  }
});

test("projects: halt, grade, open problems", async () => {
  fixture();
  const { get } = await app();
  const r = await get("/factory/projects");
  assert.equal(r.status, 200);
  const alpha = r.json.projects.find((p: { project: string }) => p.project === "alpha");
  assert.equal(alpha.halted, true);
  assert.equal(alpha.lastGrade, "A");
  assert.deepEqual(alpha.openProblems, { "lost-worker": 1 });
});

test("503 when registry missing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-routes-"));
  process.env.FACTORY_REGISTRY_DB = path.join(dir, "absent.db");
  const { get } = await app();
  for (const p of ["/factory/jobs", "/factory/jobs/j1", "/factory/projects"]) {
    const r = await get(p);
    assert.equal(r.status, 503, p);
    assert.equal(r.json.error.code, "unavailable");
  }
});

test("injected reader is used", async () => {
  const reader = { listJobs: () => ({ available: true as const, jobs: [], nextOffset: null }), getJob: () => ({ available: true as const, job: null }), projectsSummary: () => ({ available: false as const }) };
  const { get } = await app(factoryRegistryRoutes(reader));
  assert.deepEqual((await get("/factory/jobs")).json, { jobs: [], nextOffset: null });
  assert.equal((await get("/factory/jobs/j1")).status, 404);
  assert.equal((await get("/factory/projects")).status, 503);
});

test("no log text in any field", async () => {
  const { dir } = fixture();
  const { get } = await app();
  const bodies = [await get("/factory/jobs/j1"), await get("/factory/jobs"), await get("/factory/projects")].map((r) => r.json);
  const text = JSON.stringify(bodies);
  for (const bad of ["/home/", "/root/", "deploy.log", "out.txt", "deploy.sh", dir, LOG_LINE.slice(0, 300)]) assert.ok(!text.includes(bad), `leaked ${bad}`);
  const job = bodies[0].job;
  const deploy = job.steps.find((x: { name: string }) => x.name === "deploy");
  assert.ok(deploy.reason.startsWith("deploy failed"), deploy.reason);
  assert.ok(deploy.reason.includes("[path]"));
  const walk = (v: unknown): void => {
    if (typeof v === "string") { assert.ok(v.length <= 200, `long string: ${v.slice(0, 40)}`); assert.ok(!v.includes("\n")); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(bodies);
  assert.ok(job.runs[0].reason.length > 0);
});

test("mounted in the Control router behind bearer auth", async () => {
  fixture();
  const c = await controlApp();
  const anon = await c.srv.call("GET", "/control-api/v1/factory/jobs");
  assert.equal(anon.status, 401);
  assert.equal(anon.json.error.code, "unauthorized");
  const authed = await c.get("/factory/jobs");
  assert.equal(authed.status, 200);
  assert.equal(authed.json.jobs.length, 5);
});

test("examples file validates against the route responses", async () => {
  fixture();
  const { get } = await app();
  assert.equal(examples.version, 1);
  sameShape(examples.CF1.body, (await get("/factory/jobs?limit=2")).json, "CF1");
  sameShape(examples.CF1.body, (await get("/factory/jobs?project=alpha")).json, "CF1");
  sameShape(examples.CF2.body, (await get("/factory/jobs/j1")).json, "CF2");
  sameShape(examples.CF2.body, (await get("/factory/jobs/j5")).json, "CF2");
  sameShape(examples.CF3.body, (await get("/factory/projects")).json, "CF3");
  assert.deepEqual([examples.CF1.route, examples.CF2.route, examples.CF3.route], ["GET /v1/factory/jobs", "GET /v1/factory/jobs/:id", "GET /v1/factory/projects"]);
});

test("jobs route returns model and harness when present", async () => {
  const { file } = fixture();
  const w = new Database(file);
  w.exec(`ALTER TABLE runs ADD COLUMN model TEXT; ALTER TABLE runs ADD COLUMN harness TEXT; ALTER TABLE runs ADD COLUMN role TEXT; ALTER TABLE runs ADD COLUMN branch TEXT;`);
  w.prepare("UPDATE runs SET model = 'xai/grok-4.7', harness = 'grok', role = 'doer', branch = 'p6-t1' WHERE id = 'r6'").run();
  w.close();
  const { get } = await app();
  const r = await get("/factory/jobs/j1");
  assert.equal(r.status, 200);
  const run = r.json.job.runs[0];
  assert.equal(run.model, "xai/grok-4.7");
  assert.equal(run.harness, "grok");
  assert.equal(run.role, "doer");
  assert.equal("branch" in run, false);
  // Without the columns (the older fixtures above) the keys are absent, which keeps CF2 as published.
  fixture();
  const old = await get("/factory/jobs/j1");
  for (const k of ["model", "harness", "role"]) assert.equal(k in old.json.job.runs[0], false, k);
});
