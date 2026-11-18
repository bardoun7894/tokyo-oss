import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { controlApp } from "../test-app";
import { OpsStore } from "../ops-store";
import { PushStore } from "./store";

const BASE = "https://ntfy.203-0-113-10.sslip.io";
const TOPIC = "upAb12Cd34Ef56Gh";
const NOW = Date.parse("2026-10-17T12:00:00Z");

async function setup(baseUrl: string | null = BASE) {
  const db = new Database(":memory:");
  const store = new PushStore(db);
  const ops = new OpsStore(db);
  const withPush = await controlApp({ push: { store, audit: ops, baseUrl: () => baseUrl, now: () => NOW } }, db);
  const put = (p: string, body: unknown) => withPush.srv.call("PUT", "/control-api/v1" + p, body, withPush.auth);
  const del = (p: string) => withPush.srv.call("DELETE", "/control-api/v1" + p, undefined, withPush.auth);
  const me = (withPush.store.listDevices()[0]).id;
  return { ...withPush, db, store, ops, push: store, put, del, me };
}

test("P1 registers the topic for the calling device and answers baseUrl and the last 4 chars", async () => {
  const s = await setup();
  const r = await s.put("/devices/me/push", { endpoint: `${BASE}/${TOPIC}?up=1`, keys: { p256dh: "BFakeKey_-1", auth: "FakeAuth_-1" } });
  assert.deepEqual([r.status, r.json], [200, { ok: true, baseUrl: BASE, topicHint: "56Gh" }]);
  assert.deepEqual([s.push.get(s.me)!.topic, s.push.get(s.me)!.p256dh, s.push.get(s.me)!.auth], [TOPIC, "BFakeKey_-1", "FakeAuth_-1"]);
  const again = await s.put("/devices/me/push", { endpoint: `${BASE}/upZz99Yy88Xx77Ww` });
  assert.equal(again.status, 200);
  assert.deepEqual([s.push.get(s.me)!.topic, s.push.get(s.me)!.p256dh], ["upZz99Yy88Xx77Ww", null]);
  await s.close();
});

test("P1 rejects an endpoint that is not the configured base + /up<id> with 400 bad_request, and malformed keys", async () => {
  const s = await setup();
  for (const endpoint of [`https://evil.example/${TOPIC}`, `http://ntfy.203-0-113-10.sslip.io/${TOPIC}`, `https://x@ntfy.203-0-113-10.sslip.io/${TOPIC}`, `${BASE}/${TOPIC}/../x`, `${BASE}/${TOPIC}?up=1&a=b`, `${BASE}/up${"a".repeat(65)}`, 5, undefined]) {
    const r = await s.put("/devices/me/push", { endpoint });
    assert.equal(r.status, 400, String(endpoint));
    assert.equal(r.json.error.code, "bad_request");
  }
  for (const keys of ["x", { p256dh: 1, auth: "a" }, { p256dh: "a".repeat(300), auth: "a" }, { p256dh: "bad key!", auth: "a" }, { p256dh: "BKey" }]) {
    const r = await s.put("/devices/me/push", { endpoint: `${BASE}/${TOPIC}`, keys });
    assert.equal(r.status, 400, JSON.stringify(keys));
  }
  assert.equal(s.push.get(s.me), undefined, "nothing stored by a rejected call");
  await s.close();
});

test("P1 answers 503 unavailable when push is not configured (no ntfy.json), and P6 reports not registered", async () => {
  const s = await setup(null);
  const r = await s.put("/devices/me/push", { endpoint: `${BASE}/${TOPIC}` });
  assert.deepEqual([r.status, r.json.error.code], [503, "unavailable"]);
  assert.deepEqual((await s.get("/devices/me/push")).json, { registered: false, encrypted: false });
  await s.close();
});

test("P6 reports registered, lastSentAt, lastError; P2 clears the registration", async () => {
  const s = await setup();
  assert.deepEqual((await s.get("/devices/me/push")).json, { registered: false, encrypted: false });
  await s.put("/devices/me/push", { endpoint: `${BASE}/${TOPIC}` });
  assert.deepEqual((await s.get("/devices/me/push")).json, { registered: true, baseUrl: BASE, lastSentAt: null, lastError: null, encrypted: false });
  s.push.recordFailure(s.me, "unreachable", NOW - 5000);
  assert.equal((await s.get("/devices/me/push")).json.lastError, "unreachable");
  s.push.recordSent(s.me, NOW - 60_000);
  assert.deepEqual((await s.get("/devices/me/push")).json, { registered: true, baseUrl: BASE, lastSentAt: "2026-10-17T11:59:00.000Z", lastError: null, encrypted: false });
  const d = await s.del("/devices/me/push");
  assert.deepEqual([d.status, d.json], [200, { ok: true }]);
  assert.deepEqual((await s.get("/devices/me/push")).json, { registered: false, encrypted: false });
  assert.equal((await s.del("/devices/me/push")).status, 200, "clearing twice is fine");
  await s.close();
});

test("P1 and P2 write push.register audit rows with the topic hint only, never the endpoint or the keys", async () => {
  const s = await setup();
  await s.put("/devices/me/push", { endpoint: `${BASE}/${TOPIC}`, keys: { p256dh: "BSecretKeyValue", auth: "SecretAuthValue" } });
  await s.del("/devices/me/push");
  const rows = s.db.prepare("SELECT action, subject, params, result, detail FROM control_ops_audit ORDER BY id").all() as { action: string; subject: string; params: string; result: string; detail: string }[];
  assert.deepEqual(rows.map((r) => [r.action, r.subject, r.result]), [["push.register", s.me, "ok"], ["push.register", s.me, "ok"]]);
  const all = JSON.stringify(rows);
  for (const secret of [TOPIC, "SecretKeyValue", "SecretAuthValue", "ntfy.91"]) assert.ok(!all.includes(secret), secret);
  assert.ok(rows[0].params.includes("56Gh"));
  await s.close();
});

test("the push routes need a bearer token, and a registration is per device", async () => {
  const s = await setup();
  for (const [m, p] of [["GET", "/devices/me/push"], ["PUT", "/devices/me/push"], ["DELETE", "/devices/me/push"]] as const) {
    const r = await s.srv.call(m, "/control-api/v1" + p, m === "PUT" ? {} : undefined);
    assert.equal(r.status, 401, `${m} ${p}`);
  }
  const login = await s.srv.call("POST", "/control-api/v1/auth/login", { username: "admin", password: "pw", deviceName: "other" });
  const other = { authorization: `Bearer ${login.json.deviceToken}` };
  await s.put("/devices/me/push", { endpoint: `${BASE}/${TOPIC}` });
  const r = await s.srv.call("GET", "/control-api/v1/devices/me/push", undefined, other);
  assert.deepEqual(r.json, { registered: false, encrypted: false });
  await s.close();
});

test("T6.1 P6 reports encrypted:true only for a device that stored both p256dh and auth", async () => {
  const s = await setup();
  await s.put("/devices/me/push", { endpoint: `${BASE}/${TOPIC}` });
  assert.equal((await s.get("/devices/me/push")).json.encrypted, false);
  await s.put("/devices/me/push", { endpoint: `${BASE}/${TOPIC}`, keys: { p256dh: "BFakeKey_-1", auth: "FakeAuth_-1" } });
  assert.equal((await s.get("/devices/me/push")).json.encrypted, true);
  await s.put("/devices/me/push", { endpoint: `${BASE}/${TOPIC}` });
  assert.equal((await s.get("/devices/me/push")).json.encrypted, false, "a re-registration without keys goes back to plaintext");
  await s.close();
});
