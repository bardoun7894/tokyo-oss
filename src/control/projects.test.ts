import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { TriageStore } from "../finish-apps/triage-store";
import type { RepoReader } from "../finish-apps/summary";
import { controlApp } from "./test-app";

const NOW = Date.parse("2026-10-09T09:00:00Z");
const rec = (n: number) => ({ code: `R${n}`, title: `Rec ${n}`, kind: "feature", why: "w", evidence: ["e"], size: "M", impact: 3, extra: "x" });
const reader = (over: Partial<RepoReader> = {}): RepoReader => ({
  specs: () => [
    { name: "001-a", hasSpec: true, hasPlan: true, hasTasks: true, tasksDone: 5, tasksOpen: 0 },
    { name: "002-b", hasSpec: true, hasPlan: false, hasTasks: false, tasksDone: 0, tasksOpen: 0 },
    { name: "003-c", hasSpec: true, hasPlan: true, hasTasks: true, tasksDone: 2, tasksOpen: 3 },
  ],
  merged7d: () => [{ sha: "8f60fc2", subject: "spec(007): x", at: "2026-10-08T10:00:00Z" }],
  gaps: () => [{ code: "G1", text: "no tests", severity: "P1", source: "defects" }, { code: "G2", text: "odd" } as any],
  ...over,
});
const tokyo = { name: "tokyo", host: "server", completeness: 3, next_action: "fix-defects", commits: 12, last_commit: "2026-10-08", specs_total: 3, specs_missing_plan: 1, specs_missing_tasks: 1, open_tasks: 3 };
const macapp = { name: "macapp", host: "mac", completeness: 1, next_action: "write-specs", open_tasks: 7, customer: false };

async function setup(opts: { reader?: RepoReader | null; pending?: Record<string, string>; latestThrows?: boolean } = {}) {
  const db = new Database(":memory:");
  const triage = new TriageStore(db);
  const readerCalls: string[] = [];
  const t: any = opts.latestThrows ? { latest: () => { throw new Error("db down"); }, history: () => [] } : triage;
  const app = await controlApp({
    projects: {
      triage: t,
      readerFor: (p) => { readerCalls.push(p.name); return opts.reader === undefined ? reader() : opts.reader; },
      pendingOfferFor: (n) => opts.pending?.[n] ?? null,
    },
    now: () => NOW,
  }, db);
  return { ...app, triage, readerCalls };
}

test("list: latest snapshot with history, pendingOffer, done and missing in snake_case, recommendations capped at 3", async () => {
  const s = await setup({ pending: { tokyo: "a1b2c3d4" } });
  for (let i = 1; i <= 35; i++) {
    const d = `2026-09-${String(i).padStart(2, "0")}`;
    if (i <= 30) s.triage.upsert(d, "tokyo", { ...tokyo, completeness: 1 }, [], []);
  }
  s.triage.upsert("2026-10-08", "tokyo", { ...tokyo, completeness: 2 }, [], []);
  s.triage.upsert("2026-10-09", "tokyo", tokyo, [1, 2, 3, 4, 5].map(rec), []);
  s.triage.upsert("2026-10-09", "macapp", macapp, [rec(1)], []);
  const r = await s.get("/projects");
  assert.equal(r.status, 200);
  assert.equal(r.json.asOf, "2026-10-09");
  assert.deepEqual(r.json.projects.map((p: any) => p.name), ["macapp", "tokyo"]);
  const p = r.json.projects.find((x: any) => x.name === "tokyo");
  assert.equal(p.host, "server");
  assert.equal(p.customer, false);
  assert.equal(p.completeness, 3);
  assert.equal(p.nextAction, "fix-defects");
  assert.equal(p.commits, 12);
  assert.equal(p.specsTotal, 3);
  assert.equal(p.specsMissingPlan, 1);
  assert.equal(p.openTasks, 3);
  assert.equal(p.pendingOffer, "a1b2c3d4");
  assert.equal(p.history.length, 30);
  assert.deepEqual(p.history.at(-1), { date: "2026-10-09", completeness: 3 });
  assert.deepEqual(p.history.at(-2), { date: "2026-10-08", completeness: 2 });
  assert.deepEqual(p.done, {
    specs_complete: 1, tasks_done: 7, tasks_total: 10,
    merged_7d: [{ sha: "8f60fc2", subject: "spec(007): x", at: "2026-10-08T10:00:00Z" }],
  });
  assert.equal(p.missing.open_tasks, 3);
  assert.deepEqual(p.missing.specs_incomplete, [{ name: "002-b", missing: ["plan", "tasks"] }]);
  assert.deepEqual(p.missing.gaps, [
    { code: "G1", text: "no tests", severity: "P1", source: "defects" },
    { code: "G2", text: "odd", severity: "P2", source: "readiness-audit" },
  ]);
  assert.equal(p.missing.recommendations.length, 3);
  assert.deepEqual(Object.keys(p.missing.recommendations[0]).sort(), ["code", "evidence", "impact", "kind", "size", "title", "why"]);
  assert.equal(r.json.projects[0].pendingOffer, null);
});

test("empty store is 200 with asOf null; a store failure is 503 unavailable", async () => {
  const a = await setup();
  const r = await a.get("/projects");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { asOf: null, projects: [] });
  await a.close();
  const b = await setup({ latestThrows: true });
  const f = await b.get("/projects");
  assert.equal(f.status, 503);
  assert.equal(f.json.error.code, "unavailable");
  await b.close();
});

test("Mac projects use the snapshot numbers and never touch a repo reader", async () => {
  const s = await setup();
  s.triage.upsert("2026-10-09", "macapp", macapp, [], [{ code: "G9", text: "snap gap", severity: "P0", source: "readiness-audit" }]);
  const r = await s.get("/projects");
  const p = r.json.projects[0];
  assert.equal(p.host, "mac");
  assert.deepEqual(p.done, { specs_complete: 0, tasks_done: 0, tasks_total: 7, merged_7d: [] });
  assert.equal(p.missing.open_tasks, 7);
  assert.deepEqual(p.missing.gaps.map((g: any) => [g.code, g.severity]), [["G9", "P0"]]);
  assert.deepEqual(s.readerCalls, []);
});

test("detail adds specs, gaps and recentRuns; missing gaps.json gives gaps []", async () => {
  const s = await setup({ reader: reader({ gaps: () => [] }) });
  s.triage.upsert("2026-10-09", "tokyo", tokyo, [rec(1)], []);
  s.store.insertRun({ id: "aaaaaaa1", project: "tokyo", source: "tokyo", status: "succeeded", model: null, harness: "claude", worker: null, tier: null, promptPreview: "p", startedAt: NOW - 1000, endedAt: NOW, exitCode: 0, host: "server", offerId: null, workspace: "secret-label" });
  s.store.insertRun({ id: "bbbbbbb1", project: "other", source: "tokyo", status: "running", model: null, harness: null, worker: null, tier: null, promptPreview: "p", startedAt: NOW, endedAt: null, exitCode: null, host: "server", offerId: null, workspace: null });
  const r = await s.get("/projects/tokyo");
  assert.equal(r.status, 200);
  assert.equal(r.json.name, "tokyo");
  assert.deepEqual(r.json.gaps, []);
  assert.equal(r.json.specs.length, 3);
  assert.deepEqual(r.json.specs[1], { name: "002-b", hasSpec: true, hasPlan: false, hasTasks: false, tasksDone: 0, tasksOpen: 0 });
  assert.deepEqual(r.json.recentRuns.map((x: any) => x.id), ["aaaaaaa1"]);
  assert.equal(JSON.stringify(r.json).includes("secret-label"), false);
  assert.equal(r.json.done.specs_complete, 1);
});

test("unknown project is 404; a name that is not a valid project name is 400", async () => {
  const s = await setup();
  s.triage.upsert("2026-10-09", "tokyo", tokyo, [], []);
  assert.equal((await s.get("/projects/nope")).status, 404);
  assert.equal((await s.get("/projects/nope")).json.error.code, "not_found");
  const bad = await s.get("/projects/..%2Fx");
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "bad_request");
  assert.equal((await s.get("/projects/" + "a".repeat(65))).status, 400);
});
