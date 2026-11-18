import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";
import Database from "better-sqlite3";
import { ControlStore, DEVICE_TTL_MS } from "./store";
import { createControlRouter } from "./router";
import { LoginThrottle } from "./rate-limit";
import { bearerAuth, requireCap, revokeAllDevices } from "./auth";
import { serveApp } from "./test-http";

const T0 = Date.parse("2026-10-09T09:00:00Z");

async function setup() {
  const store = new ControlStore(new Database(":memory:"));
  let now = T0;
  const router = createControlRouter({
    store, now: () => now, throttle: new LoginThrottle(),
    checkCredentials: (u, p) => u === "admin" && p === "pw",
  });
  const app = express();
  app.use("/control-api", router);
  const srv = await serveApp(app);
  const login = (over: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    srv.call("POST", "/control-api/v1/auth/login", { username: "admin", password: "pw", deviceName: "Pixel", ...over }, headers);
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  return { store, srv, login, auth, setNow: (n: number) => (now = n) };
}

test("login success: token is 64 hex and only its SHA-256 is stored", async () => {
  const { store, srv, login } = await setup();
  const r = await login();
  assert.equal(r.status, 200);
  assert.match(r.json.deviceToken, /^[0-9a-f]{64}$/);
  assert.match(r.json.deviceId, /^d_[0-9a-f]{8}$/);
  assert.equal(r.json.expiresAt, new Date(T0 + DEVICE_TTL_MS).toISOString());
  const hash = crypto.createHash("sha256").update(r.json.deviceToken).digest("hex");
  assert.equal(store.findByTokenHash(hash, T0)!.id, r.json.deviceId);
  await srv.close();
});

test("login: bad body is 400, wrong password 401 and counted, 9th failure is 429", async () => {
  const { srv, login } = await setup();
  assert.equal((await login({ deviceName: undefined })).status, 400);
  assert.equal((await login({ password: 5 })).status, 400);
  for (let i = 0; i < 8; i++) {
    const r = await login({ password: "bad" });
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { error: { code: "unauthorized", message: "Invalid credentials" } });
  }
  const blocked = await login({ password: "bad" });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error.code, "rate_limited");
  assert.ok(Number(blocked.headers["retry-after"]) > 0);
  assert.equal((await login()).status, 429, "even the right password is refused while blocked");
  await srv.close();
});

test("login throttle is per client address (X-Real-IP from loopback peer)", async () => {
  const { srv, login } = await setup();
  for (let i = 0; i < 8; i++) await login({ password: "bad" }, { "x-real-ip": "9.9.9.9" });
  assert.equal((await login({ password: "bad" }, { "x-real-ip": "9.9.9.9" })).status, 429);
  assert.equal((await login({}, { "x-real-ip": "8.8.8.8" })).status, 200);
  await srv.close();
});

test("token works on a protected route, expired token is 401, sliding expiry", async () => {
  const { srv, login, auth, setNow } = await setup();
  const { deviceToken } = (await login()).json;
  const ok = await srv.call("GET", "/control-api/v1/devices", undefined, auth(deviceToken));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.devices.length, 1);
  assert.deepEqual(Object.keys(ok.json.devices[0]).sort(), ["caps", "createdAt", "current", "id", "lastSeenAt", "name", "push"]);
  assert.equal(ok.json.devices[0].current, true);
  assert.equal(ok.json.devices[0].push, false);
  setNow(T0 + DEVICE_TTL_MS - 1000);
  assert.equal((await srv.call("GET", "/control-api/v1/devices", undefined, auth(deviceToken))).status, 200);
  setNow(T0 + 2 * DEVICE_TTL_MS);
  assert.equal((await srv.call("GET", "/control-api/v1/devices", undefined, auth(deviceToken))).status, 401);
  await srv.close();
});

test("no token, malformed header and unknown token all give the same 401 body", async () => {
  const { srv } = await setup();
  const bodies = [];
  for (const h of [{}, { authorization: "Bearer" }, { authorization: "Basic abc" }, { authorization: "Bearer xyz" }, { authorization: "Bearer " + "0".repeat(64) }]) {
    const r = await srv.call("GET", "/control-api/v1/devices", undefined, h as Record<string, string>);
    assert.equal(r.status, 401);
    bodies.push(JSON.stringify(r.json));
  }
  assert.equal(new Set(bodies).size, 1);
  assert.deepEqual(JSON.parse(bodies[0]), { error: { code: "unauthorized", message: "Unauthorized" } });
  await srv.close();
});

test("logout revokes only this device; DELETE /devices/:id revokes another", async () => {
  const { srv, login, auth } = await setup();
  const a = (await login({ deviceName: "A" })).json;
  const b = (await login({ deviceName: "B" })).json;
  const c = (await login({ deviceName: "C" })).json;
  assert.deepEqual((await srv.call("POST", "/control-api/v1/auth/logout", {}, auth(a.deviceToken))).json, { ok: true });
  assert.equal((await srv.call("GET", "/control-api/v1/devices", undefined, auth(a.deviceToken))).status, 401);
  assert.equal((await srv.call("GET", "/control-api/v1/devices", undefined, auth(b.deviceToken))).status, 200);
  assert.equal((await srv.call("DELETE", `/control-api/v1/devices/${c.deviceId}`, undefined, auth(b.deviceToken))).status, 200);
  assert.equal((await srv.call("GET", "/control-api/v1/devices", undefined, auth(c.deviceToken))).status, 401);
  assert.equal((await srv.call("DELETE", `/control-api/v1/devices/${c.deviceId}`, undefined, auth(b.deviceToken))).status, 404);
  assert.equal((await srv.call("DELETE", "/control-api/v1/devices/..%2f..", undefined, auth(b.deviceToken))).status, 404);
  await srv.close();
});

test("POST /devices stores the FCM token; bad values are 400", async () => {
  const { srv, store, login, auth } = await setup();
  const a = (await login()).json;
  assert.equal((await srv.call("POST", "/control-api/v1/devices", { fcmToken: "x".repeat(4097) }, auth(a.deviceToken))).status, 400);
  assert.equal((await srv.call("POST", "/control-api/v1/devices", { fcmToken: 5 }, auth(a.deviceToken))).status, 400);
  assert.equal((await srv.call("POST", "/control-api/v1/devices", {}, auth(a.deviceToken))).status, 400);
  assert.deepEqual((await srv.call("POST", "/control-api/v1/devices", { fcmToken: "tok" }, auth(a.deviceToken))).json, { ok: true });
  assert.deepEqual(store.pushTokens(), ["tok"]);
  assert.equal((await srv.call("GET", "/control-api/v1/devices", undefined, auth(a.deviceToken))).json.devices[0].push, true);
  await srv.close();
});

test("a dashboard password change revokes every device", async () => {
  const { srv, store, login, auth } = await setup();
  const a = (await login()).json;
  const b = (await login()).json;
  assert.equal(revokeAllDevices(store), 2);
  for (const d of [a, b]) assert.equal((await srv.call("GET", "/control-api/v1/devices", undefined, auth(d.deviceToken))).status, 401);
  await srv.close();
});

test("requireCap: 403 forbidden envelope when the device lacks the cap, pass-through when it has it", async () => {
  const db = new Database(":memory:");
  const store = new ControlStore(db);
  const deps = { store, now: () => T0, throttle: new LoginThrottle(), checkCredentials: (u: string, p: string) => u === "admin" && p === "pw" };
  const app = express();
  const guarded = express.Router();
  guarded.use(bearerAuth(deps));
  guarded.get("/w", requireCap("ops:write"), (_req, res) => res.json({ ok: true }));
  guarded.get("/s", requireCap("ops:service"), (_req, res) => res.json({ ok: true }));
  app.use("/g", guarded);
  app.use("/control-api", createControlRouter(deps));
  const srv = await serveApp(app);
  const login = await srv.call("POST", "/control-api/v1/auth/login", { username: "admin", password: "pw", deviceName: "Pixel" });
  const h = { authorization: `Bearer ${login.json.deviceToken}` };
  assert.equal((await srv.call("GET", "/g/w", undefined, h)).status, 200, "default caps include ops:write");
  const denied = await srv.call("GET", "/g/s", undefined, h);
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.json, { error: { code: "forbidden", message: "Device lacks ops:service" } });
  db.prepare("UPDATE control_devices SET caps = 'ops:read,ops:write,ops:service' WHERE id = ?").run(login.json.deviceId);
  assert.equal((await srv.call("GET", "/g/s", undefined, h)).status, 200);
  db.prepare("UPDATE control_devices SET caps = 'ops:read' WHERE id = ?").run(login.json.deviceId);
  assert.equal((await srv.call("GET", "/g/w", undefined, h)).status, 403);
  assert.equal((await srv.call("GET", "/g/w")).status, 401, "no bearer stays 401, not 403");
  await srv.close();
});

test("GET /devices adds caps and keeps every old key", async () => {
  const { srv, login, auth } = await setup();
  const { deviceToken } = (await login()).json;
  const r = await srv.call("GET", "/control-api/v1/devices", undefined, auth(deviceToken));
  assert.deepEqual(Object.keys(r.json.devices[0]).sort(), ["caps", "createdAt", "current", "id", "lastSeenAt", "name", "push"]);
  assert.deepEqual(r.json.devices[0].caps, ["ops:read", "ops:write"]);
  await srv.close();
});
