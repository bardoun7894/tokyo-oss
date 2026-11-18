import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { controlApp } from "../test-app";
import { OpsStore } from "../ops-store";
import { ControlStore } from "../store";
import { Dispatcher } from "./dispatcher";
import { Publisher, type FetchLike, type NtfyConfig } from "./publisher";
import { runsSource, StopLog } from "./sources";
import { PushStore } from "./store";
import { wirePush, stopPush } from "./wire";

const BASE = "https://ntfy.203-0-113-10.sslip.io";
const TOPIC = "upAb12Cd34Ef56Gh";
const PUBLISH_TOKEN = "tk_e2ePublisherToken0123456789";
const T0 = Date.parse("2026-10-17T12:00:00Z");

async function stack(opts: { config?: NtfyConfig | null; runs?: boolean } = {}) {
  const db = new Database(":memory:");
  const clock = { t: T0 };
  const store = new PushStore(db);
  const ops = new OpsStore(db);
  const recorded: { url: string; auth: string; body: any }[] = [];
  const fetch: FetchLike = async (url, init) => { recorded.push({ url, auth: init.headers.Authorization, body: JSON.parse(String(init.body)) }); return { status: 200 }; };
  const config = opts.config === undefined ? ({ baseUrl: BASE, publishToken: PUBLISH_TOKEN, format: "up" } as NtfyConfig) : opts.config;
  const publisher = new Publisher({ store, config: () => config, fetch, now: () => clock.t, log: () => {}, retryDelayMs: 0 });
  const stops = new StopLog(60 * 60 * 1000, () => clock.t);
  const control = new ControlStore(db);
  const dispatcher = new Dispatcher({
    store, publisher, now: () => clock.t, format: () => config?.format ?? "up", log: () => {},
    sources: [runsSource({ listRuns: () => control.listRuns({ limit: 50 }), stoppedBy: (id) => stops.who(id) })],
  });
  const stopped: string[] = [];
  const app = await controlApp({
    push: { store, audit: ops, baseUrl: () => config?.baseUrl ?? null, format: () => config?.format ?? "up", now: () => clock.t, flush: () => dispatcher.tick(), stops },
    runs: opts.runs ? ({ hostFor: () => ({ stop: async (ws: string) => { stopped.push(ws); } }) } as any) : undefined,
  }, db);
  const meId = app.store.listDevices()[0].id;
  return { ...app, db, clock, store, push: store, recorded, dispatcher, stops, stopped, meId, control };
}

test("e2e: login -> P1 -> P5 -> the recorder sees exactly one test payload on the loopback publish URL", async () => {
  const s = await stack();
  assert.equal((await s.srv.call("PUT", "/control-api/v1/devices/me/push", { endpoint: `${BASE}/${TOPIC}?up=1` }, s.auth)).status, 200);
  const r = await s.post("/devices/me/push/test", {});
  assert.deepEqual([r.status, r.json], [200, { ok: true, queuedAt: "2026-10-17T12:00:00.000Z" }]);
  assert.equal(s.recorded.length, 1);
  assert.equal(s.recorded[0].url, `http://127.0.0.1:2586/${TOPIC}?up=1`);
  assert.equal(s.recorded[0].auth, `Bearer ${PUBLISH_TOKEN}`);
  assert.deepEqual(s.recorded[0].body, { v: 1, t: "test", id: "1", title: "Test notification" });
  const p6 = (await s.get("/devices/me/push")).json;
  assert.deepEqual([p6.registered, p6.lastSentAt, p6.lastError], [true, "2026-10-17T12:00:00.000Z", null]);
  const audit = s.db.prepare("SELECT action, result FROM control_ops_audit WHERE action = 'push.test'").all();
  assert.deepEqual(audit, [{ action: "push.test", result: "ok" }]);
  assert.ok(!JSON.stringify(r.json).includes(PUBLISH_TOKEN));
  await s.close();
});

test("P5 without a registration is 409 not_registered", async () => {
  const s = await stack();
  const r = await s.post("/devices/me/push/test", {});
  assert.deepEqual([r.status, r.json.error.code], [409, "not_registered"]);
  assert.equal(s.recorded.length, 0);
  await s.close();
});

test("P5 allows 3 per 10 minutes per device: the 4th is 429 with Retry-After, and the window then reopens", async () => {
  const s = await stack();
  await s.srv.call("PUT", "/control-api/v1/devices/me/push", { endpoint: `${BASE}/${TOPIC}` }, s.auth);
  for (let i = 1; i <= 3; i++) {
    s.clock.t += 1000;
    assert.equal((await s.post("/devices/me/push/test", {})).status, 200, `call ${i}`);
  }
  s.clock.t += 1000;
  const fourth = await s.post("/devices/me/push/test", {});
  assert.equal(fourth.status, 429);
  assert.equal(fourth.json.error.code, "rate_limited");
  assert.ok(Number(fourth.headers["retry-after"]) > 0);
  assert.equal(s.recorded.length, 3);
  assert.deepEqual(s.recorded.map((x) => x.body.id), ["1", "2", "3"], "each test push has its own id");
  s.clock.t += 11 * 60 * 1000;
  assert.equal((await s.post("/devices/me/push/test", {})).status, 200);
  assert.equal(s.recorded.length, 4);
  await s.close();
});

test("P5 is 503 unavailable when push is not configured, and needs a bearer token", async () => {
  const s = await stack({ config: null });
  assert.deepEqual([(await s.post("/devices/me/push/test", {})).status], [503]);
  assert.equal((await s.srv.call("POST", "/control-api/v1/devices/me/push/test", {})).status, 401);
  await s.close();
});

test("a run stopped from the app is not pushed to the device that stopped it, and is to another registered device", async () => {
  const s = await stack({ runs: true });
  const second = await s.srv.call("POST", "/control-api/v1/auth/login", { username: "admin", password: "pw", deviceName: "tablet" });
  const auth2 = { authorization: `Bearer ${second.json.deviceToken}` };
  await s.srv.call("PUT", "/control-api/v1/devices/me/push", { endpoint: `${BASE}/${TOPIC}` }, s.auth);
  await s.srv.call("PUT", "/control-api/v1/devices/me/push", { endpoint: `${BASE}/upZz99Yy88Xx77Ww` }, auth2);
  s.control.insertRun({
    id: "abc12345", project: "demo-site", source: "tokyo", status: "running", model: null, harness: null, worker: null, tier: null, promptPreview: "",
    startedAt: T0 - 1000, endedAt: null, exitCode: null, host: "server", offerId: null, workspace: "ws-1",
  });
  await s.dispatcher.tick(); // seed: the run is still running
  const stop = await s.post("/runs/abc12345/stop", {});
  assert.equal(stop.status, 200, JSON.stringify(stop.json));
  assert.deepEqual(s.stopped, ["ws-1"]);
  await s.dispatcher.tick();
  const topics = s.recorded.map((x) => x.url.split("/")[3].split("?")[0]);
  assert.deepEqual(topics, ["upZz99Yy88Xx77Ww"], "only the tablet hears about the stop");
  assert.deepEqual([s.recorded[0].body.t, s.recorded[0].body.o], ["run.failed", "stopped"]);
  await s.close();
});

test("wirePush: with no ntfy config push is off, P1 and P5 answer 503, P6 says not registered; with a config file it is on", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tk-push-"));
  const db = new Database(":memory:");
  const ops = new OpsStore(db);
  const prev = process.env.CONTROL_NTFY_CONFIG;
  try {
    process.env.CONTROL_NTFY_CONFIG = path.join(dir, "absent.json");
    const off = wirePush(db, { load: () => { throw new Error("runner must not load"); }, godhome: { summary: async () => ({ reachable: false, data: null }) } as any, ops })!;
    assert.ok(off, "the routes stay mounted");
    assert.equal(off.baseUrl(), null);
    const a = await controlApp({ push: off }, db);
    assert.equal((await a.srv.call("PUT", "/control-api/v1/devices/me/push", { endpoint: `${BASE}/${TOPIC}` }, a.auth)).status, 503);
    assert.equal((await a.post("/devices/me/push/test", {})).status, 503);
    assert.deepEqual((await a.get("/devices/me/push")).json, { registered: false, encrypted: false });
    await a.close();
    stopPush();

    const file = path.join(dir, "ntfy.json");
    fs.writeFileSync(file, JSON.stringify({ baseUrl: BASE, publishToken: PUBLISH_TOKEN }), { mode: 0o600 });
    process.env.CONTROL_NTFY_CONFIG = file;
    const on = wirePush(new Database(":memory:"), { load: () => { throw new Error("runner must not load"); }, godhome: { summary: async () => ({ reachable: false, data: null }) } as any, ops })!;
    assert.equal(on.baseUrl(), BASE);
    stopPush();
  } finally {
    if (prev === undefined) delete process.env.CONTROL_NTFY_CONFIG; else process.env.CONTROL_NTFY_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("StopLog remembers who stopped a run for an hour", () => {
  let t = T0;
  const log = new StopLog(1000, () => t);
  log.record("r1", "d_00000001");
  assert.equal(log.who("r1"), "d_00000001");
  assert.equal(log.who("r2"), undefined);
  t += 1001;
  assert.equal(log.who("r1"), undefined);
});
