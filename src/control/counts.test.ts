import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import express from "express";
import Database from "better-sqlite3";
import { ControlStore } from "./store";
import { bearerAuth, loginHandler, type ControlDeps } from "./auth";
import { LoginThrottle } from "./rate-limit";
import { countsRoutes, type CountsOps } from "./counts";
import type { OpsResult } from "./ops-godhome";
import { serveApp } from "./test-http";
import { OpsStore } from "./ops-store";
import { muteKey } from "./ops-incidents";

const NOW = Date.parse("2026-10-16T09:00:00Z");
const MIN = 60_000;
const summary = () => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "test-fixtures", "ops-summary-all.json"), "utf8"));
const OLD_KEYS = ["factoryFailed", "failedRuns24h", "pendingOffers", "runningRuns"];

const run = (id: string, over: Record<string, unknown> = {}) => ({
  id, project: "tokyo", source: "tokyo" as const, status: "succeeded" as const, model: null, harness: null, worker: null, tier: null,
  promptPreview: "p", startedAt: NOW - 120 * MIN, endedAt: NOW - 119 * MIN, exitCode: 0, host: "server" as const, offerId: null, workspace: null, ...over,
});

async function setup(ops?: CountsOps) {
  const db = new Database(":memory:");
  const store = new ControlStore(db);
  store.insertRun(run("aaaaaaa1", { status: "running", endedAt: null, exitCode: null }));
  store.insertRun(run("aaaaaaa2", { status: "failed", endedAt: NOW - 60 * MIN, exitCode: 1 }));
  store.insertRun(run("aaaaaaa3", { status: "failed", endedAt: NOW - 25 * 60 * MIN, exitCode: 1 }));
  const deps: ControlDeps = { store, now: () => NOW, throttle: new LoginThrottle(), checkCredentials: (u, p) => u === "admin" && p === "pw" };
  const app = express();
  app.use(express.json());
  const v1 = express.Router();
  v1.post("/auth/login", loginHandler(deps));
  v1.use(bearerAuth(deps));
  v1.use(countsRoutes(store, undefined, () => NOW, undefined, undefined, ops));
  app.use("/v1", v1);
  const srv = await serveApp(app);
  const login = await srv.call("POST", "/v1/auth/login", { username: "admin", password: "pw", deviceName: "t" });
  const auth = { authorization: `Bearer ${login.json.deviceToken}` };
  return { srv, db, deviceId: login.json.deviceId as string, get: () => srv.call("GET", "/v1/counts", undefined, auth) };
}

const opsWith = (impl: (w: string) => Promise<OpsResult>) => {
  const calls: string[] = [];
  const ops: CountsOps = { godhome: { summary: async (w: string) => { calls.push(w); return impl(w); } } };
  return { ops, calls };
};
const good = (data: unknown = summary()): OpsResult => ({ reachable: true, data, fetchedAt: NOW - 1000 });

test("GET /counts without ops deps: exactly the four existing fields", async () => {
  const t = await setup();
  const r = await t.get();
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { factoryFailed: 0, pendingOffers: 0, runningRuns: 1, failedRuns24h: 1 });
  assert.deepEqual(Object.keys(r.json).sort(), OLD_KEYS);
  await t.srv.close();
});

test("GET /counts with ops: adds incidentsOpen and incidentsCritical (GodHome's all-window counts), every old field keeps its value", async () => {
  const base = await setup();
  const before = (await base.get()).json;
  await base.srv.close();
  const { ops, calls } = opsWith(async () => good());
  const t = await setup(ops);
  const r = await t.get();
  const s = summary();
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ...before, incidentsOpen: s.incidents.counts.open, incidentsCritical: s.incidents.counts.critical });
  assert.equal(r.json.incidentsOpen, 43);
  assert.equal(r.json.incidentsCritical, 14);
  assert.deepEqual(calls, ["all"]);
  await t.srv.close();
});

test("GET /counts: a real zero is sent as 0", async () => {
  const s = summary();
  s.incidents.counts = { open: 0, critical: 0, warning: 0, notice: 0, resolved: 5 };
  const { ops } = opsWith(async () => good(s));
  const t = await setup(ops);
  const r = await t.get();
  assert.equal(r.json.incidentsOpen, 0);
  assert.equal(r.json.incidentsCritical, 0);
  await t.srv.close();
});

test("GET /counts: GodHome unreachable, throwing, stale past the limit or malformed omits the two fields and keeps the rest", async () => {
  const cases: [string, () => Promise<OpsResult>][] = [
    ["down", async () => ({ reachable: false, data: null, fetchedAt: 0 })],
    ["throws", async () => { throw new Error("connect ECONNREFUSED Bearer tok-SECRET-1"); }],
    ["stale", async () => ({ reachable: false, data: summary(), fetchedAt: NOW - 120_000 })],
    ["malformed", async () => ({ reachable: true, data: "<html>", fetchedAt: NOW })],
  ];
  for (const [name, impl] of cases) {
    const { ops } = opsWith(impl);
    const t = await setup(ops);
    const r = await t.get();
    assert.equal(r.status, 200, name);
    assert.deepEqual(r.json, { factoryFailed: 0, pendingOffers: 0, runningRuns: 1, failedRuns24h: 1 }, name);
    assert.ok(!/tok-SECRET/.test(JSON.stringify(r.json)), name);
    await t.srv.close();
  }
});

test("GET /counts: a device without ops:read gets the old four fields and GodHome is not asked; no bearer is 401", async () => {
  const { ops, calls } = opsWith(async () => good());
  const t = await setup(ops);
  t.db.prepare("UPDATE control_devices SET caps = 'ops:write' WHERE id = ?").run(t.deviceId);
  const r = await t.get();
  assert.deepEqual(Object.keys(r.json).sort(), OLD_KEYS);
  assert.deepEqual(calls, []);
  assert.equal((await t.srv.call("GET", "/v1/counts")).status, 401);
  await t.srv.close();
});

test("GET /counts with an ops store: the incident counts leave out what the overlay hides, never below 0", async () => {
  const s = summary();
  const crit = s.incidents.items.find((i: any) => i.kind !== "agent" && (i.state === "open" || i.state === "recovering") && i.severity === "critical");
  const db = new Database(":memory:");
  const opsStore = new OpsStore(db);
  opsStore.mute(muteKey(crit), NOW + 60 * MIN, "d_aaaaaaaa", NOW);
  const t = await setup({ godhome: { summary: async () => good() }, store: opsStore });
  const r = await t.get();
  assert.equal(r.json.incidentsOpen, 43 - 1);
  assert.equal(r.json.incidentsCritical, 14 - 1);
  await t.srv.close();
});
