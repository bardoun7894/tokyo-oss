import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { summarize, summaryLines, countTasks, fsRepoReader, type RepoReader, type TriageEntry } from "./summary";

const snap: TriageEntry = {
  name: "tokyo", host: "server", commits: 12, specs_total: 6, specs_missing_plan: 1, specs_missing_tasks: 2,
  open_tasks: 14, completeness: 3, next_action: "fix-defects",
};

function reader(over: Partial<RepoReader> = {}): RepoReader {
  return {
    specs: () => [
      { name: "001-a", hasSpec: true, hasPlan: true, hasTasks: true, tasksDone: 5, tasksOpen: 0 },
      { name: "002-b", hasSpec: true, hasPlan: true, hasTasks: true, tasksDone: 2, tasksOpen: 3 },
      { name: "003-c", hasSpec: true, hasPlan: false, hasTasks: false, tasksDone: 0, tasksOpen: 0 },
      { name: "004-d", hasSpec: true, hasPlan: true, hasTasks: false, tasksDone: 0, tasksOpen: 0 },
    ],
    merged7d: () =>
      Array.from({ length: 7 }, (_, i) => ({ sha: `s${i}`, subject: `m${i}`, at: `2026-10-0${i + 1}T00:00:00Z` })),
    gaps: () => [{ code: "G1", text: "no tests", severity: "P1", source: "readiness-audit" }],
    ...over,
  };
}
const recs = ["R1", "R2", "R3", "R4"].map((code) => ({
  code, title: `t${code}`, kind: "feature", why: "w", evidence: [], size: "S" as const, impact: 3,
}));

test("server project: counts from the repo, merged capped at 5, recs capped at 3", () => {
  const s = summarize({ name: "tokyo", location: "server" }, snap, reader(), recs);
  assert.equal(s.done.specs_complete, 1);
  assert.equal(s.done.tasks_done, 7);
  assert.equal(s.done.tasks_total, 10);
  assert.equal(s.done.merged_7d.length, 5);
  assert.deepEqual(Object.keys(s.done.merged_7d[0]), ["sha", "subject", "at"]);
  assert.equal(s.missing.open_tasks, 3);
  assert.deepEqual(s.missing.specs_incomplete, [
    { name: "003-c", missing: ["plan", "tasks"] },
    { name: "004-d", missing: ["tasks"] },
  ]);
  assert.equal(s.missing.gaps.length, 1);
  assert.deepEqual(s.missing.recommendations.map((r) => r.code), ["R1", "R2", "R3"]);
});

test("mac project uses snapshot numbers only", () => {
  let touched = false;
  const spy = reader({ specs: () => { touched = true; return []; } });
  const s = summarize({ name: "crmdemo", location: "laptop" }, { ...snap, host: "mac" }, spy, []);
  assert.equal(touched, false);
  assert.equal(s.missing.open_tasks, 14);
  assert.equal(s.done.tasks_done, 0);
  assert.deepEqual(s.done.merged_7d, []);
  assert.deepEqual(s.missing.gaps, []);
});

test("no reader: snapshot numbers, no throw", () => {
  const s = summarize({ name: "tokyo", location: "server" }, snap, null, []);
  assert.equal(s.missing.open_tasks, 14);
  assert.equal(s.missing.gaps.length, 0);
});

test("malformed tasks.md counts as 0", () => {
  assert.deepEqual(countTasks("\u0000\u0001 garbage [ ] - [x"), { done: 0, open: 0 });
  assert.deepEqual(countTasks(""), { done: 0, open: 0 });
  assert.deepEqual(countTasks("- [x] a\n- [X] b\n  - [ ] c\n* [ ] not a dash"), { done: 2, open: 1 });
});

test("a reader that throws yields zeros", () => {
  const boom = reader({ specs: () => { throw new Error("x"); }, merged7d: () => { throw new Error("y"); }, gaps: () => { throw new Error("z"); } });
  const s = summarize({ name: "tokyo", location: "server" }, snap, boom, []);
  assert.equal(s.done.tasks_total, 0);
  assert.deepEqual(s.done.merged_7d, []);
  assert.deepEqual(s.missing.gaps, []);
});

test("card lines", () => {
  const s = summarize({ name: "tokyo", location: "server" }, snap, reader(), recs);
  const [done, missing] = summaryLines(s);
  assert.equal(done, "Done: 1 specs complete, 7/10 tasks, 5 merged in 7d");
  assert.equal(missing, "Missing: 3 open tasks, 2 specs incomplete, 1 gaps");
});

test("fsRepoReader: specs, gaps.json (defaults filled), merged commits", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-"));
  fs.mkdirSync(path.join(dir, "specs/001-x"), { recursive: true });
  fs.writeFileSync(path.join(dir, "specs/001-x/spec.md"), "# s");
  fs.writeFileSync(path.join(dir, "specs/001-x/plan.md"), "# p");
  fs.writeFileSync(path.join(dir, "specs/001-x/tasks.md"), "- [x] a\n- [ ] b\n");
  fs.mkdirSync(path.join(dir, "specs/_audit/2026-10-01"), { recursive: true });
  fs.mkdirSync(path.join(dir, "specs/_audit/2026-10-08"), { recursive: true });
  fs.writeFileSync(path.join(dir, "specs/_audit/2026-10-01/gaps.json"), JSON.stringify([{ code: "OLD", text: "old" }]));
  fs.writeFileSync(path.join(dir, "specs/_audit/2026-10-08/gaps.json"), JSON.stringify([{ code: "G1", text: "new" }]));
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "feat: hello");
  const r = fsRepoReader(dir);
  assert.deepEqual(r.specs(), [{ name: "001-x", hasSpec: true, hasPlan: true, hasTasks: true, tasksDone: 1, tasksOpen: 1 }]);
  assert.deepEqual(r.gaps(), [{ code: "G1", text: "new", severity: "P2", source: "readiness-audit" }]);
  const m = r.merged7d();
  assert.equal(m.length, 1);
  assert.equal(m[0].subject, "feat: hello");
  assert.match(m[0].sha, /^[0-9a-f]{7,}$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("fsRepoReader on a missing path returns empties", () => {
  const r = fsRepoReader("/nonexistent/zzz");
  assert.deepEqual(r.specs(), []);
  assert.deepEqual(r.gaps(), []);
  assert.deepEqual(r.merged7d(), []);
});
