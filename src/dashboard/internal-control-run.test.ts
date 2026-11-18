import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import Database from "better-sqlite3";
import { ControlStore } from "../control/store";
import { serveApp } from "../control/test-http";
import { registerInternalControlRun } from "./internal-control-run";

async function setup() {
  const store = new ControlStore(new Database(":memory:"));
  const app = express();
  app.use(express.json());
  let n = 0;
  registerInternalControlRun(app, () => store, { now: () => 1_000_000 + n++, newId: () => (++n).toString(16).padStart(8, "0") });
  const srv = await serveApp(app);
  return { store, ...srv, post: (b: unknown, h: Record<string, string> = {}) => srv.call("POST", "/api/internal/control-run", b, h) };
}

const START = { action: "start", source: "jdelegate", project: "tokyo", model: "claude-sonnet-5-5", harness: "claude", worker: "control-api-c4", tier: "medium", host: "server" };

test("start inserts a running row and returns its id; finish sets endedAt, exitCode and succeeded", async () => {
  const s = await setup();
  const a = await s.post(START);
  assert.equal(a.status, 200);
  assert.match(a.json.id, /^[0-9a-f]{8}$/);
  let row = s.store.getRun(a.json.id)!;
  assert.deepEqual([row.source, row.status, row.project, row.model, row.harness, row.worker, row.tier, row.host], ["jdelegate", "running", "tokyo", "claude-sonnet-5-5", "claude", "control-api-c4", "medium", "server"]);
  assert.equal(row.endedAt, null);
  const f = await s.post({ action: "finish", id: a.json.id, exitCode: 0 });
  assert.equal(f.status, 200);
  row = s.store.getRun(a.json.id)!;
  assert.deepEqual([row.status, row.exitCode], ["succeeded", 0]);
  assert.ok(row.endedAt! > row.startedAt - 1);
  await s.close();
});

test("a non-zero exit code finishes failed, source server-agent and host laptop (→ mac) are accepted, fields may be omitted", async () => {
  const s = await setup();
  const a = await s.post({ action: "start", source: "server-agent", project: "up", host: "laptop" });
  const row = s.store.getRun(a.json.id)!;
  assert.deepEqual([row.source, row.host, row.model, row.harness, row.worker, row.tier], ["server-agent", "mac", null, null, null, null]);
  await s.post({ action: "finish", id: a.json.id, exitCode: 2 });
  assert.deepEqual([s.store.getRun(a.json.id)!.status, s.store.getRun(a.json.id)!.exitCode], ["failed", 2]);
  await s.close();
});

test("finish does not overwrite a run Tokyo already stopped; unknown id is 404", async () => {
  const s = await setup();
  const a = await s.post(START);
  s.store.updateRun(a.json.id, { status: "stopped", endedAt: 5 });
  assert.equal((await s.post({ action: "finish", id: a.json.id, exitCode: 0 })).status, 200);
  assert.deepEqual([s.store.getRun(a.json.id)!.status, s.store.getRun(a.json.id)!.endedAt], ["stopped", 5]);
  assert.equal((await s.post({ action: "finish", id: "ffffffff", exitCode: 0 })).status, 404);
  await s.close();
});

test("unknown source, action, host, harness, tier or a bad project is 400 and nothing is stored", async () => {
  const s = await setup();
  for (const bad of [
    { ...START, source: "tokyo" }, { ...START, source: "evil" }, { ...START, action: "nope" }, { ...START, host: "moon" },
    { ...START, harness: "vim" }, { ...START, tier: "huge" }, { ...START, project: "../x" }, { ...START, project: "" },
    { action: "finish", id: "zz", exitCode: 0 }, { action: "finish", id: "ffffffff", exitCode: "0" }, { action: "finish", id: "ffffffff" },
  ]) {
    assert.equal((await s.post(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(s.store.listRuns({}).length, 0);
  await s.close();
});

test("secrets and paths in worker, model or prompt are rejected", async () => {
  const s = await setup();
  for (const bad of [
    { worker: "/home/tokyo-agent/x" }, { worker: "ANTHROPIC_AUTH_TOKEN=abc" }, { worker: "a b" }, { worker: "w;rm" }, { worker: "x".repeat(65) },
    { model: "m/../x" }, { model: "sk-" + "a".repeat(30) }, { prompt: "see /root/.ssh/id_rsa" }, { prompt: "API_KEY=abc123 go" }, { prompt: "x".repeat(201) },
  ]) {
    assert.equal((await s.post({ ...START, ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await s.post({ ...START, prompt: "add dark mode" })).status, 200);
  assert.equal(s.store.listRuns({}).length, 1);
  assert.equal(s.store.listRuns({})[0].promptPreview, "add dark mode");
  await s.close();
});

test("a proxied request (X-Forwarded-For or X-Real-IP) is refused and stores nothing", async () => {
  const s = await setup();
  assert.equal((await s.post(START, { "x-forwarded-for": "1.2.3.4" })).status, 403);
  assert.equal((await s.post(START, { "x-real-ip": "1.2.3.4" })).status, 403);
  assert.equal(s.store.listRuns({}).length, 0);
  await s.close();
});
