import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import Database from "better-sqlite3";
import { ControlStore } from "./store";
import { createControlRouter } from "./router";
import { LoginThrottle } from "./rate-limit";
import { serveApp } from "./test-http";
import { OpsStore } from "./ops-store";
import { PushStore } from "./push/store";
import { fakeGh } from "./gh/test-support";
import { GhIds } from "./gh/ids";

// Every route of the plan.md API reference except login.
const ROUTES: [string, string][] = [
  ["POST", "/auth/logout"], ["GET", "/devices"], ["DELETE", "/devices/d_3f9a1c20"], ["POST", "/devices"],
  ["GET", "/projects"], ["GET", "/projects/tokyo"], ["GET", "/offers"], ["POST", "/offers/a1b2c3d4/answer"],
  ["GET", "/runs"], ["GET", "/runs/9f31ac02"], ["GET", "/runs/9f31ac02/log"], ["POST", "/runs/9f31ac02/stop"],
  ["POST", "/tasks"], ["POST", "/projects/tokyo/recommendations/R1/write-spec"], ["GET", "/counts"],
];

async function setup() {
  const store = new ControlStore(new Database(":memory:"));
  const app = express();
  // Same order as server.ts: the control router first, then json for everything else, then an "internal" sentinel.
  app.use("/control-api", createControlRouter({ store, throttle: new LoginThrottle(), checkCredentials: (u, p) => u === "admin" && p === "pw" }));
  app.use(express.json());
  app.all("/api/internal/x", (_req, res) => { res.status(200).json({ leaked: true }); });
  const srv = await serveApp(app);
  const login = await srv.call("POST", "/control-api/v1/auth/login", { username: "admin", password: "pw", deviceName: "t" });
  return { srv, auth: { authorization: `Bearer ${login.json.deviceToken}` } };
}

test("every route in the API reference answers 401 with the same envelope when unauthenticated", async () => {
  const { srv } = await setup();
  for (const [m, p] of ROUTES) {
    const r = await srv.call(m, "/control-api/v1" + p, m === "GET" || m === "DELETE" ? undefined : {});
    assert.equal(r.status, 401, `${m} ${p}`);
    assert.deepEqual(r.json, { error: { code: "unauthorized", message: "Unauthorized" } }, `${m} ${p}`);
  }
  await srv.close();
});

test("unknown path under /control-api/ is a 404 envelope (authenticated or not outside v1)", async () => {
  const { srv, auth } = await setup();
  const nf = { error: { code: "not_found", message: "Not found" } };
  assert.deepEqual((await srv.call("GET", "/control-api/nothing")).json, nf);
  assert.deepEqual((await srv.call("GET", "/control-api/")).json, nf);
  assert.deepEqual((await srv.call("GET", "/control-api/v1/nothing", undefined, auth)).json, nf);
  assert.equal((await srv.call("GET", "/control-api/v1/nothing", undefined, auth)).status, 404);
  assert.equal((await srv.call("GET", "/control-api/v1x/devices", undefined, auth)).status, 404);
  await srv.close();
});

test("paths outside /control-api/v1/ never reach internal endpoints", async () => {
  const { srv, auth } = await setup();
  for (const p of [
    "/control-api/../api/internal/x", "/control-api/%2e%2e/api/internal/x", "/control-api/v1/../../api/internal/x",
    "/control-api/v1/%2e%2e/%2e%2e/api/internal/x", "/control-api//api/internal/x", "/control-api/v1/..%2f..%2fapi/internal/x",
  ]) {
    for (const h of [{}, auth]) {
      const r = await srv.call("GET", p, undefined, h);
      assert.notEqual(r.json?.leaked, true, p);
      assert.ok([401, 404].includes(r.status), `${p} -> ${r.status}`);
    }
  }
  // sanity: the sentinel is reachable on its own path
  assert.equal((await srv.call("GET", "/api/internal/x")).json.leaked, true);
  await srv.close();
});

test("body over 64 KB is 413, malformed JSON is 400, both in the envelope", async () => {
  const { srv, auth } = await setup();
  const big = await srv.call("POST", "/control-api/v1/devices", { fcmToken: "x".repeat(70 * 1024) }, auth);
  assert.equal(big.status, 413);
  assert.equal(big.json.error.code, "bad_request");
  const bad = await srv.call("POST", "/control-api/v1/devices", "{not json", auth);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "bad_request");
  const badLogin = await srv.call("POST", "/control-api/v1/auth/login", "{nope");
  assert.equal(badLogin.status, 400);
  await srv.close();
});

test("responses are JSON utf-8 and carry no-store", async () => {
  const { srv, auth } = await setup();
  const r = await srv.call("GET", "/control-api/v1/devices", undefined, auth);
  assert.match(String(r.headers["content-type"]), /application\/json; charset=utf-8/);
  assert.equal(r.headers["cache-control"], "no-store");
  await srv.close();
});

test("authenticated device is rate limited to 120 requests a minute", async () => {
  const { srv, auth } = await setup();
  let last = 0;
  for (let i = 0; i < 121; i++) last = (await srv.call("GET", "/control-api/v1/devices", undefined, auth)).status;
  assert.equal(last, 429);
  await srv.close();
});

test("spec 012 stubs: an area whose deps exist answers 501 in the control envelope; without deps it is a 404", async () => {
  const { controlApp } = await import("./test-app");
  const off = await controlApp();
  const nf = { error: { code: "not_found", message: "Not found" } };
  for (const p of ["/devices/me/push", "/agents/targets", "/ops/services", "/life/manifest", "/ops/gh/fleet"]) {
    const r = await off.get(p);
    assert.deepEqual([r.status, r.json], [404, nf], p);
  }
  await off.close();

  const pdb = new Database(":memory:");
  const on = await controlApp({ push: { store: new PushStore(pdb), audit: new OpsStore(pdb), baseUrl: () => null }, life: { dashboard: (_q, _r, next) => next(), ops: new OpsStore(pdb) }, gh: { client: fakeGh(), ids: new GhIds(pdb), ops: new OpsStore(pdb), allowlist: () => [] } }, pdb);
  // /agents/* and /ops/services are built (spec 012 T2.x, T3.x): their own tests are in agents/ and services/.
  // The GodHome routes are built (T5.x): K1 answers, and a path no K route owns is the router's own 404.
  assert.equal((await on.get("/ops/gh/fleet")).status, 200);
  assert.deepEqual([(await on.get("/ops/gh/nothing-here")).status, (await on.get("/ops/gh/nothing-here")).json], [404, nf]);
  // The life manifest and gateway are built (T4.x): a device without life:read is 403, an unlisted life path 404.
  assert.deepEqual([(await on.get("/life/manifest")).status, (await on.get("/life/api/anything")).status], [403, 404]);
  // existing routes are unaffected by the new mounts
  assert.equal((await on.get("/devices")).status, 200);
  assert.equal((await on.get("/nothing")).status, 404);
  const unauth = await on.srv.call("GET", "/control-api/v1/agents/targets");
  assert.equal(unauth.status, 401);
  await on.close();
});
