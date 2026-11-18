import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import express from "express";
import Database from "better-sqlite3";
import { controlApp } from "../test-app";
import { OpsStore } from "../ops-store";
import { serveApp } from "../test-http";
import { createControlRouter } from "../router";
import { ControlStore } from "../store";
import { LoginThrottle } from "../rate-limit";
import { LIFE_ROWS, matchLife } from "./table";
import { wireLife } from "./wire";

const FIXTURES = path.join(process.cwd(), "test-fixtures", "life");
const sample = (id: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, id + ".json"), "utf8")) as { id: string; method: string; path: string; query: string | null; body: unknown };

/** The key set of a JSON value: object keys, recursively, with arrays folded into the union of their elements' keys. */
function keySet(v: unknown, prefix = ""): string[] {
  if (Array.isArray(v)) return [...new Set(v.flatMap((x) => keySet(x, prefix + "[]")))];
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => [prefix + "." + k, ...keySet(x, prefix + "." + k)]).sort();
  return [];
}

test("every allowlisted GET answers through the gateway with its sample's key set (bytes row L8 is the media task)", async () => {
  const db = new Database(":memory:");
  // A stand-in for the dashboard: answers each listed GET with the captured sample of its row.
  const dashboard = express.Router();
  const hits: string[] = [];
  dashboard.use((req, res) => {
    const row = matchLife(req.method, req.path.replace(/^\/api/, ""));
    if (!row) { res.status(404).json({ error: "unlisted reached the dashboard" }); return; }
    hits.push(row.id);
    res.json(sample(row.id).body);
  });
  const t = await controlApp({ life: { dashboard, ops: new OpsStore(db) } }, db);
  t.store.setCaps(t.store.listDevices()[0]!.id, ["life:read"]);
  const gets = LIFE_ROWS.filter((r) => r.method === "GET" && r.id !== "L8");
  assert.equal(gets.length, 40);
  for (const row of gets) {
    const s = sample(row.id);
    const url = s.path.replace(/:[A-Za-z]+/g, "x1") + (s.query ? "?" + s.query : "");
    const r = await t.get("/life/api" + url);
    assert.equal(r.status, 200, row.id);
    assert.deepEqual(keySet(r.json), keySet(s.body), `${row.id} ${row.pattern}`);
    assert.deepEqual(r.json, s.body, `${row.id}: a sample holds no path, so the scrub changes nothing`);
  }
  assert.deepEqual(hits, gets.map((g) => g.id));
  await t.close();
});

test("the dashboard session middleware is not involved: bearer only, and a cookie alone gets nothing", async () => {
  const db = new Database(":memory:");
  const store = new ControlStore(db);
  const app = express();
  const reached: string[] = [];
  const dashboard = express.Router();
  dashboard.get("/api/goals", (req, res) => { reached.push("goals:" + String(req.headers.cookie)); res.json([]); });
  app.use("/control-api", createControlRouter({ store, throttle: new LoginThrottle(), checkCredentials: (u, p) => u === "admin" && p === "pw", life: { dashboard, ops: new OpsStore(db) } }));
  // What the dashboard server does after the Control router: everything else needs the session cookie.
  app.use((_req, res) => { res.status(401).json({ error: "Unauthorized" }); });
  const srv = await serveApp(app);
  const login = await srv.call("POST", "/control-api/v1/auth/login", { username: "admin", password: "pw", deviceName: "t" });
  store.setCaps(store.listDevices()[0]!.id, ["life:read"]);
  const ok = await srv.call("GET", "/control-api/v1/life/api/goals", undefined, { authorization: `Bearer ${login.json.deviceToken}`, cookie: "tokyo_session=abc" });
  assert.equal(ok.status, 200);
  assert.deepEqual(reached, ["goals:undefined"], "the dashboard handler ran without the cookie");
  const cookieOnly = await srv.call("GET", "/control-api/v1/life/api/goals", undefined, { cookie: "tokyo_session=abc" });
  assert.equal(cookieOnly.status, 401);
  assert.equal(cookieOnly.json.error.code, "unauthorized", "the Control envelope, not the dashboard's");
  assert.equal(reached.length, 1);
  await srv.close();
});

test("the same dashboard path outside the gateway prefix is not reachable through /control-api", async () => {
  const db = new Database(":memory:");
  const dashboard = express.Router();
  dashboard.use((_req, res) => { res.json({ reached: true }); });
  const t = await controlApp({ life: { dashboard, ops: new OpsStore(db) } }, db);
  t.store.setCaps(t.store.listDevices()[0]!.id, ["life:read", "life:write"]);
  for (const p of ["/api/goals", "/life/goals", "/life", "/life/apix/goals", "/life/api/../auth/password"]) {
    const r = await t.get(p);
    assert.ok(r.status === 404 || r.status === 501, `${p} -> ${r.status}`);
    assert.notDeepEqual(r.json, { reached: true }, p);
  }
  await t.close();
});

test("wireLife builds the live gateway without loading the dashboard router", () => {
  const db = new Database(":memory:");
  const deps = wireLife(db);
  assert.equal(typeof deps.dashboard, "function");
  assert.ok(deps.ops instanceof OpsStore);
  assert.ok(!Object.keys(require.cache).some((k) => k.endsWith("/src/dashboard/routes.ts")), "loaded on the first request only");
});
