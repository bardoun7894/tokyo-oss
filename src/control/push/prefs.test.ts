import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { controlApp } from "../test-app";
import { OpsStore } from "../ops-store";
import { PushStore } from "./store";

async function setup() {
  const db = new Database(":memory:");
  const push = new PushStore(db);
  const app = await controlApp({ push: { store: push, audit: new OpsStore(db), baseUrl: () => "https://ntfy.203-0-113-10.sslip.io" } }, db);
  const put = (body: unknown, auth = app.auth) => app.srv.call("PUT", "/control-api/v1/devices/me/notify", body, auth);
  return { ...app, db, push, put };
}
const ALL = { approvals: true, runs: true, deploys: true, reminders: true, incidents: "critical" };

test("P3 defaults: approvals, runs, deploys, reminders on and incidents critical", async () => {
  const s = await setup();
  const r = await s.get("/devices/me/notify");
  assert.deepEqual([r.status, r.json], [200, ALL]);
  await s.close();
});

test("P4 stores all five fields and answers the same shape; P3 reads them back", async () => {
  const s = await setup();
  const body = { approvals: true, runs: false, deploys: true, reminders: false, incidents: "warning" };
  const r = await s.put(body);
  assert.deepEqual([r.status, r.json], [200, body]);
  assert.deepEqual((await s.get("/devices/me/notify")).json, body);
  for (const incidents of ["off", "critical", "warning"]) assert.equal((await s.put({ ...ALL, incidents })).status, 200, incidents);
  await s.close();
});

test("P4 needs every field and rejects other values with 400 bad_request, storing nothing", async () => {
  const s = await setup();
  const bad: unknown[] = [
    {}, null, "x", [], { ...ALL, approvals: undefined }, { ...ALL, runs: undefined }, { ...ALL, deploys: undefined }, { ...ALL, reminders: undefined }, { ...ALL, incidents: undefined },
    { ...ALL, approvals: "true" }, { ...ALL, runs: 1 }, { ...ALL, deploys: null }, { ...ALL, reminders: "yes" },
    { ...ALL, incidents: "all" }, { ...ALL, incidents: "Critical" }, { ...ALL, incidents: true }, { ...ALL, incidents: "" },
  ];
  for (const b of bad) {
    const r = await s.put(b);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.equal(r.json.error.code, "bad_request");
  }
  assert.deepEqual((await s.get("/devices/me/notify")).json, ALL);
  await s.close();
});

test("preferences are per device and survive the push registration being cleared", async () => {
  const s = await setup();
  const login = await s.srv.call("POST", "/control-api/v1/auth/login", { username: "admin", password: "pw", deviceName: "two" });
  const two = { authorization: `Bearer ${login.json.deviceToken}` };
  await s.put({ ...ALL, approvals: false, incidents: "off" });
  assert.deepEqual((await s.srv.call("GET", "/control-api/v1/devices/me/notify", undefined, two)).json, ALL);
  await s.put({ ...ALL, runs: false }, two);
  assert.equal((await s.get("/devices/me/notify")).json.approvals, false);
  await s.srv.call("DELETE", "/control-api/v1/devices/me/push", undefined, s.auth);
  assert.equal((await s.get("/devices/me/notify")).json.incidents, "off");
  await s.close();
});

test("P3 and P4 need a bearer token", async () => {
  const s = await setup();
  assert.equal((await s.srv.call("GET", "/control-api/v1/devices/me/notify")).status, 401);
  assert.equal((await s.srv.call("PUT", "/control-api/v1/devices/me/notify", ALL)).status, 401);
  await s.close();
});
