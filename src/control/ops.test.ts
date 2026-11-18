import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import express from "express";
import Database from "better-sqlite3";
import { ControlStore } from "./store";
import { bearerAuth, loginHandler, type ControlDeps } from "./auth";
import { LoginThrottle } from "./rate-limit";
import { opsRoutes, type OpsDeps } from "./ops";
import { OpsInputError, type OpsResult } from "./ops-godhome";
import { serveApp } from "./test-http";
import { OpsStore } from "./ops-store";
import { INCIDENT_ID, adjustedCounts } from "./ops-incidents";
import { mapNetwork, mapOverview } from "./ops-map";
import { graphBody, listView, MIN, phaseRec, runRec, T0 } from "./ops-fixtures";

const FIX = path.join(__dirname, "..", "..", "test-fixtures");
const summary = (w: string) => JSON.parse(fs.readFileSync(path.join(FIX, `ops-summary-${w}.json`), "utf8"));
const NOW = Date.parse("2026-10-16T09:00:00Z");

type Summary = OpsDeps["godhome"]["summary"];

async function setup(summaryImpl: Summary, extra: Partial<OpsDeps["godhome"]> = {}, opsExtra: Partial<OpsDeps> = {}) {
  const db = new Database(":memory:");
  const store = new ControlStore(db);
  const calls: string[] = [];
  const godhome = {
    summary: (async (w: string) => { calls.push(w); return summaryImpl(w); }) as Summary,
    runs: async () => { throw new Error("not used"); },
    run: async () => { throw new Error("not used"); },
    graph: async () => { throw new Error("not used"); },
    ...extra,
  } as OpsDeps["godhome"];
  const deps: ControlDeps = { store, now: () => NOW, throttle: new LoginThrottle(), checkCredentials: (u, p) => u === "admin" && p === "pw" };
  const app = express();
  app.use(express.json());
  const v1 = express.Router();
  v1.post("/auth/login", loginHandler(deps));
  v1.use(bearerAuth(deps));
  v1.use(opsRoutes({ godhome, now: () => NOW, store: new OpsStore(db), ...opsExtra }));
  app.use("/v1", v1);
  const srv = await serveApp(app);
  const login = await srv.call("POST", "/v1/auth/login", { username: "admin", password: "pw", deviceName: "t" });
  const auth = { authorization: `Bearer ${login.json.deviceToken}` };
  return {
    srv, db, calls, auth, deviceId: login.json.deviceId as string, get: (p: string) => srv.call("GET", "/v1" + p, undefined, auth),
    post: (p: string, body: unknown = {}, headers: Record<string, string> = {}) => srv.call("POST", "/v1" + p, body, { ...auth, ...headers }),
  };
}

const ok = (w: string, over: Partial<OpsResult> = {}): OpsResult => ({ reachable: true, data: summary(w), fetchedAt: NOW - 3000, ...over });

test("X1: 200 with fetchedAt, reachable and the mapped overview; window defaults to 24h", async () => {
  const t = await setup(async (w) => ok(w));
  const r = await t.get("/ops/overview");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { fetchedAt: "2026-10-16T08:59:57.000Z", reachable: true, ...mapOverview(summary("24h"), "24h") });
  assert.deepEqual(t.calls, ["24h"]);
  for (const w of ["7d", "all"]) {
    const x = await t.get(`/ops/overview?window=${w}`);
    assert.equal(x.status, 200);
    assert.equal(x.json.window.id, w);
  }
  assert.deepEqual(t.calls, ["24h", "7d", "all"]);
  await t.srv.close();
});

test("X1: window=bad is 400 bad_request and never reaches GodHome", async () => {
  const t = await setup(async (w) => ok(w));
  for (const q of ["bad", "", "24H", "7d&window=all", "7d,all"]) {
    const r = await t.get(`/ops/overview?window=${q}`);
    assert.equal(r.status, 400, q);
    assert.deepEqual(r.json, { error: { code: "bad_request", message: "window must be 24h, 7d or all" } });
  }
  assert.equal((await t.get("/ops/overview?window=24h&window=7d")).status, 400);
  assert.deepEqual(t.calls, []);
  await t.srv.close();
});

test("X1: GodHome throws -> 200 reachable:false, no detail of the error", async () => {
  const t = await setup(async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:8000 Bearer tok-SECRET-1"); });
  const r = await t.get("/ops/overview?window=7d");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { fetchedAt: "2026-10-16T09:00:00.000Z", reachable: false });
  await t.srv.close();
});

test("X1: GodHome down with nothing cached -> reachable:false; past the stale limit the last good data comes with reachable:false", async () => {
  const none = await setup(async () => ({ reachable: false, data: null, fetchedAt: 0 }));
  assert.deepEqual((await none.get("/ops/overview")).json, { fetchedAt: "2026-10-16T09:00:00.000Z", reachable: false });
  await none.srv.close();
  const old = await setup(async (w) => ok(w, { reachable: false, fetchedAt: NOW - 120_000 }));
  const r = await old.get("/ops/overview");
  assert.equal(r.status, 200);
  assert.equal(r.json.reachable, false);
  assert.equal(r.json.fetchedAt, "2026-10-16T08:58:00.000Z");
  assert.equal(r.json.kpi.done, summary("24h").agents.done);
  await old.srv.close();
});

test("X1: a malformed GodHome body is reachable:false, not a 500", async () => {
  const t = await setup(async () => ({ reachable: true, data: "<html>oops</html>", fetchedAt: NOW }));
  const r = await t.get("/ops/overview");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { fetchedAt: "2026-10-16T09:00:00.000Z", reachable: false });
  await t.srv.close();
});

test("X1: an input error from the client maps to 400", async () => {
  const t = await setup(async () => { throw new OpsInputError("window must be 24h, 7d or all"); });
  const r = await t.get("/ops/overview");
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, "bad_request");
  await t.srv.close();
});

test("X1: no bearer is 401; a device without ops:read is 403 forbidden", async () => {
  const t = await setup(async (w) => ok(w));
  assert.equal((await t.srv.call("GET", "/v1/ops/overview")).status, 401);
  t.db.prepare("UPDATE control_devices SET caps = 'ops:write' WHERE id = ?").run(t.deviceId);
  const r = await t.get("/ops/overview");
  assert.equal(r.status, 403);
  assert.deepEqual(r.json, { error: { code: "forbidden", message: "Device lacks ops:read" } });
  assert.deepEqual(t.calls, []);
  await t.srv.close();
});

test("X1: the incident overlay applies to counts and needsYou, so X1 and X5 agree (mute lowers critical and drops the needs-you entry)", async () => {
  const withNeeds = (w: string): OpsResult => {
    const s = summary(w);
    const crit = s.incidents.items.find((i: any) => i.kind === "deploy" && i.severity === "critical" && i.state === "open");
    s.needsYou = [
      { title: crit.title, project: crit.project, url: "", since: "2026-10-16T08:30:00.000Z" },
      { title: "Approve deploy", project: "tokyo", url: "", since: "2026-10-16T08:31:00.000Z" },
    ];
    return { reachable: true, data: s, fetchedAt: NOW - 3000 };
  };
  const t = await setup(async (w) => withNeeds(w));
  const before = (await t.get("/ops/overview?window=7d")).json;
  assert.equal(before.incidents.counts.critical, 1);
  assert.equal(before.needsYou.length, 2);
  const crit = await pick(t, (i) => i.kind === "deploy" && i.severity === "critical");
  assert.equal((await t.post(`/ops/incidents/${crit.id}/mute`, { minutes: 60 })).status, 200);
  const after = (await t.get("/ops/overview?window=7d")).json;
  const x5 = (await t.get("/ops/incidents?limit=100")).json.counts;
  assert.equal(after.incidents.counts.critical, 0);
  assert.equal(after.incidents.counts.open, before.incidents.counts.open - 1);
  assert.equal(after.incidents.counts.muted, 1);
  assert.deepEqual(after.needsYou.map((n: any) => n.title), ["Approve deploy"]);
  // X1 reads the 7d window and X5 the all window; both go through adjustedCounts, so the overlay shifts them the same way.
  assert.equal(after.incidents.counts.muted, x5.muted);
  // resolve instead of mute: leaves open, joins resolved, still drops from needsYou
  assert.equal((await t.post(`/ops/incidents/${crit.id}/reopen`)).status, 200);
  assert.equal((await t.get("/ops/overview?window=7d")).json.needsYou.length, 2);
  assert.equal((await t.post(`/ops/incidents/${crit.id}/resolve`)).status, 200);
  const res = (await t.get("/ops/overview?window=7d")).json;
  assert.equal(res.incidents.counts.critical, 0);
  assert.equal(res.incidents.counts.resolved, before.incidents.counts.resolved + 1);
  assert.equal(res.needsYou.length, 1);
  await t.srv.close();
});

const allKeys = (v: unknown): string[] =>
  Array.isArray(v) ? v.flatMap(allKeys) : typeof v === "object" && v !== null ? Object.entries(v).flatMap(([k, x]) => [k, ...allKeys(x)]) : [];

test("X1: GodHome's null series buckets reach the phone as null, never 0", async () => {
  const s = summary("24h");
  assert.ok(Object.values(s.series).some((a: any) => a.includes(null)), "the fixture has empty buckets");
  const t = await setup(async (w) => ok(w));
  const r = await t.get("/ops/overview");
  for (const k of ["success", "failed", "started", "durS"]) {
    assert.equal(r.json.series[k].length, s.series[k].length, k);
    s.series[k].forEach((v: number | null, i: number) => assert.equal(r.json.series[k][i], v, `${k}[${i}]`));
  }
  await t.srv.close();
});

// ---- T1.4: X2 -----------------------------------------------------------------------------------------------

const runsOk = (runs: any[]): OpsResult => ({ reachable: true, data: { runs: runs.map(listView) }, fetchedAt: NOW - 2000 });
const buildGraph = graphBody("build", ["plan", "code", "review"], [["review", "code"]]);
const engineRuns = [
  runRec("r1", "build", T0, { ended: T0 + MIN, ok: true, phases: [phaseRec("plan", "done", { ok: true, ms: 5 }), phaseRec("code", "failed", { ok: false, ms: 5 })] }),
  runRec("r2", "other", T0 + 5 * MIN, { ended: T0 + 6 * MIN, ok: true }),
];

test("X2 agents: default window 24h and mode agents; body equals the mapped network; no actions anywhere", async () => {
  const t = await setup(async (w) => ok(w));
  const r = await t.get("/ops/map");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { fetchedAt: "2026-10-16T08:59:57.000Z", reachable: true, ...mapNetwork(summary("24h"), {}) });
  assert.deepEqual(t.calls, ["24h"]);
  assert.ok(!allKeys(r.json).includes("actions"));
  const w7 = await t.get("/ops/map?window=7d&mode=agents");
  assert.equal(w7.status, 200);
  assert.deepEqual(w7.json.groups, mapNetwork(summary("7d"), {}).groups);
  assert.deepEqual(t.calls, ["24h", "7d"]);
  await t.srv.close();
});

test("X2 agents: project filter keeps one group; a bad window, mode or project is 400 and never reaches GodHome", async () => {
  const t = await setup(async (w) => ok(w));
  const first = mapNetwork(summary("24h"), {}).groups[0].project;
  const r = await t.get(`/ops/map?project=${encodeURIComponent(first)}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.groups.map((g: any) => g.project), [first]);
  const calls = t.calls.length;
  for (const q of ["window=bad", "mode=other", "mode=", "project=a%20b", "project=..%2Fx", `project=${"p".repeat(65)}`, "mode=agents&mode=engine"]) {
    const x = await t.get(`/ops/map?${q}`);
    assert.equal(x.status, 400, q);
    assert.equal(x.json.error.code, "bad_request", q);
  }
  assert.equal(t.calls.length, calls);
  await t.srv.close();
});

test("X2 agents: GodHome down, throwing or malformed is 200 reachable:false; stale data past the limit keeps reachable:false", async () => {
  const none = await setup(async () => ({ reachable: false, data: null, fetchedAt: 0 }));
  assert.deepEqual((await none.get("/ops/map")).json, { fetchedAt: "2026-10-16T09:00:00.000Z", reachable: false });
  await none.srv.close();
  const boom = await setup(async () => { throw new Error("connect ECONNREFUSED Bearer tok-SECRET-1"); });
  const b = await boom.get("/ops/map");
  assert.deepEqual(b.json, { fetchedAt: "2026-10-16T09:00:00.000Z", reachable: false });
  await boom.srv.close();
  const bad = await setup(async () => ({ reachable: true, data: "<html>", fetchedAt: NOW }));
  assert.deepEqual((await bad.get("/ops/map")).json, { fetchedAt: "2026-10-16T09:00:00.000Z", reachable: false });
  await bad.srv.close();
  const old = await setup(async (w) => ok(w, { reachable: false, fetchedAt: NOW - 120_000 }));
  const o = await old.get("/ops/map");
  assert.equal(o.json.reachable, false);
  assert.equal(o.json.fetchedAt, "2026-10-16T08:58:00.000Z");
  assert.ok(o.json.groups.length > 0);
  await old.srv.close();
});

test("X2 engine: phases in graph order with the last run's states, workflows from the runs; summary is not called", async () => {
  const seen: string[] = [];
  const t = await setup(async (w) => ok(w), {
    runs: async () => runsOk(engineRuns),
    graph: async (n: string) => { seen.push(n); return { reachable: true, data: buildGraph, fetchedAt: NOW - 1000 }; },
  });
  const r = await t.get("/ops/map?mode=engine&graph=build");
  assert.equal(r.status, 200);
  assert.equal(r.json.reachable, true);
  assert.equal(r.json.fetchedAt, "2026-10-16T08:59:58.000Z");
  assert.deepEqual(r.json.phases, [
    { id: "plan", status: "healthy", calls: 1, loop: false },
    { id: "code", status: "failing", calls: 1, loop: true },
    { id: "review", status: "idle", calls: 0, loop: false },
  ]);
  assert.deepEqual(r.json.workflows.map((w: any) => w.graph), ["other", "build"]);
  assert.deepEqual(seen, ["build"]);
  assert.deepEqual(t.calls, []);
  assert.ok(!/secret|PRIVATE|SECRET/i.test(JSON.stringify(r.json)));
  await t.srv.close();
});

test("X2 engine: no graph param gives workflows and no phases without asking for a graph", async () => {
  const t = await setup(async (w) => ok(w), { runs: async () => runsOk(engineRuns), graph: async () => { throw new Error("must not be called"); } });
  const r = await t.get("/ops/map?mode=engine");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.phases, []);
  assert.equal(r.json.workflows.length, 2);
  await t.srv.close();
});

test("X2 engine: an unknown graph is 404 not_found; a bad graph name is 400 and never reaches GodHome", async () => {
  let graphCalls = 0;
  const t = await setup(async (w) => ok(w), {
    runs: async () => runsOk(engineRuns),
    graph: async () => { graphCalls++; return { reachable: true, data: null, fetchedAt: NOW, notFound: true }; },
  });
  const nf = await t.get("/ops/map?mode=engine&graph=nope");
  assert.equal(nf.status, 404);
  assert.equal(nf.json.error.code, "not_found");
  assert.equal(graphCalls, 1);
  for (const g of ["..", ".", "a%2Fb", "a%20b", "g".repeat(65), "", "x&graph=y"]) {
    const x = await t.get(`/ops/map?mode=engine&graph=${g}`);
    assert.equal(x.status, 400, g);
  }
  assert.equal(graphCalls, 1);
  await t.srv.close();
});

test("X2 engine: GodHome unreachable or throwing is 200 reachable:false", async () => {
  const down = await setup(async (w) => ok(w), {
    runs: async () => ({ reachable: false, data: null, fetchedAt: 0 }),
    graph: async () => ({ reachable: false, data: null, fetchedAt: 0 }),
  });
  assert.deepEqual((await down.get("/ops/map?mode=engine&graph=build")).json, { fetchedAt: "2026-10-16T09:00:00.000Z", reachable: false });
  await down.srv.close();
  const boom = await setup(async (w) => ok(w), { runs: async () => { throw new Error("Bearer tok-SECRET-1"); } });
  assert.deepEqual((await boom.get("/ops/map?mode=engine")).json, { fetchedAt: "2026-10-16T09:00:00.000Z", reachable: false });
  await boom.srv.close();
});

test("X2: a device without ops:read is 403 and GodHome is not asked", async () => {
  const t = await setup(async (w) => ok(w));
  t.db.prepare("UPDATE control_devices SET caps = 'ops:write' WHERE id = ?").run(t.deviceId);
  assert.equal((await t.get("/ops/map")).status, 403);
  assert.deepEqual(t.calls, []);
  await t.srv.close();
});

// ---- T1.5: X3 and X4 ----------------------------------------------------------------------------------------

const traceRuns = () => [1, 2, 3, 4, 5].map((n) => runRec(`r${n}`, "build", T0 + n * 10 * MIN, { ended: T0 + n * 10 * MIN + MIN, ok: n !== 3, phases: [phaseRec("plan", "done", { ok: true, ms: 5, output: "SECRET OUTPUT" })] }));
const FORBID = ["input", "output", "cwd", "prompt", "parents", "tokensTotal", "cost"];

test("X3: newest first with limit 20 by default; body equals the mapped list; no input, cwd or output", async () => {
  const t = await setup(async (w) => ok(w), { runs: async () => runsOk(traceRuns()) });
  const r = await t.get("/ops/traces");
  assert.equal(r.status, 200);
  assert.equal(r.json.reachable, true);
  assert.equal(r.json.fetchedAt, "2026-10-16T08:59:58.000Z");
  assert.deepEqual(r.json.traces.map((x: any) => x.id), ["r5", "r4", "r3", "r2", "r1"]);
  assert.equal(r.json.next, null);
  assert.equal(r.json.lastRunAt, new Date(T0 + 51 * MIN).toISOString());
  for (const k of FORBID) assert.ok(!allKeys(r.json).includes(k), k);
  assert.ok(!/SECRET|PRIVATE|secret-project/.test(JSON.stringify(r.json)));
  await t.srv.close();
});

test("X3: limit pages with next and before; the last page has next null", async () => {
  const t = await setup(async (w) => ok(w), { runs: async () => runsOk(traceRuns()) });
  const p1 = await t.get("/ops/traces?limit=2");
  assert.deepEqual(p1.json.traces.map((x: any) => x.id), ["r5", "r4"]);
  assert.equal(p1.json.next, new Date(T0 + 40 * MIN).toISOString());
  const p2 = await t.get(`/ops/traces?limit=2&before=${encodeURIComponent(p1.json.next)}`);
  assert.deepEqual(p2.json.traces.map((x: any) => x.id), ["r3", "r2"]);
  const p3 = await t.get(`/ops/traces?limit=2&before=${encodeURIComponent(p2.json.next)}`);
  assert.deepEqual(p3.json.traces.map((x: any) => x.id), ["r1"]);
  assert.equal(p3.json.next, null);
  await t.srv.close();
});

test("X3: an empty or old list still says when the last run was", async () => {
  const t = await setup(async (w) => ok(w), { runs: async () => runsOk(traceRuns()) });
  const old = await t.get(`/ops/traces?before=${encodeURIComponent(new Date(T0).toISOString())}`);
  assert.deepEqual(old.json.traces, []);
  assert.equal(old.json.lastRunAt, new Date(T0 + 51 * MIN).toISOString());
  await t.srv.close();
  const none = await setup(async (w) => ok(w), { runs: async () => runsOk([]) });
  const e = await none.get("/ops/traces");
  assert.deepEqual([e.json.traces, e.json.next, e.json.lastRunAt], [[], null, null]);
  await none.srv.close();
});

test("X3: a bad limit or before is 400 and never reaches GodHome", async () => {
  let calls = 0;
  const t = await setup(async (w) => ok(w), { runs: async () => { calls++; return runsOk([]); } });
  for (const q of ["limit=0", "limit=51", "limit=-1", "limit=abc", "limit=", "limit=1.5", "limit=2&limit=3", "before=yesterday", "before=", "before=2026-10-16T09:00:00Z&before=x"]) {
    const x = await t.get(`/ops/traces?${q}`);
    assert.equal(x.status, 400, q);
    assert.equal(x.json.error.code, "bad_request", q);
  }
  assert.equal((await t.get("/ops/traces?limit=50")).status, 200);
  assert.equal((await t.get("/ops/traces?limit=1")).status, 200);
  assert.equal(calls, 2);
  await t.srv.close();
});

test("X3: GodHome down, throwing or malformed is 200 reachable:false; no bearer is 401; no ops:read is 403", async () => {
  const down = await setup(async (w) => ok(w), { runs: async () => ({ reachable: false, data: null, fetchedAt: 0 }) });
  assert.deepEqual((await down.get("/ops/traces")).json, { fetchedAt: "2026-10-16T09:00:00.000Z", reachable: false });
  await down.srv.close();
  const boom = await setup(async (w) => ok(w), { runs: async () => { throw new Error("Bearer tok-SECRET-1"); } });
  assert.deepEqual((await boom.get("/ops/traces")).json, { fetchedAt: "2026-10-16T09:00:00.000Z", reachable: false });
  await boom.srv.close();
  const bad = await setup(async (w) => ok(w), { runs: async () => ({ reachable: true, data: "<html>", fetchedAt: NOW }) });
  assert.deepEqual((await bad.get("/ops/traces")).json, { fetchedAt: "2026-10-16T09:00:00.000Z", reachable: false });
  assert.equal((await bad.srv.call("GET", "/v1/ops/traces")).status, 401);
  bad.db.prepare("UPDATE control_devices SET caps = 'ops:write' WHERE id = ?").run(bad.deviceId);
  assert.equal((await bad.get("/ops/traces")).status, 403);
  await bad.srv.close();
});

const detailFrom = (id: string) => runRec(id, "build", T0, {
  ended: T0 + MIN, ok: true, calls: 3,
  phases: [phaseRec("plan", "done", { ok: true, ms: 5, output: "SECRET OUTPUT", to: "code", tokens: 10 }), phaseRec("code", "done", { ok: true, ms: 6, output: "xy" })],
});

test("X4: detail has outputBytes and handoffs and never output or input", async () => {
  const seen: string[] = [];
  const t = await setup(async (w) => ok(w), { run: async (id: string) => { seen.push(id); return { reachable: true, data: detailFrom(id), fetchedAt: NOW - 1000 }; } });
  const r = await t.get("/ops/traces/tr_01");
  assert.equal(r.status, 200);
  assert.equal(r.json.reachable, true);
  assert.equal(r.json.fetchedAt, "2026-10-16T08:59:59.000Z");
  assert.equal(r.json.id, "tr_01");
  assert.equal(r.json.phases[0].outputBytes, 13);
  assert.deepEqual(r.json.handoffs, [{ from: "plan", to: "code", chars: 13, latencyMs: null, tokens: 10 }]);
  for (const k of FORBID) assert.ok(!allKeys(r.json).includes(k), k);
  assert.ok(!/SECRET|PRIVATE|secret-project/.test(JSON.stringify(r.json)));
  assert.deepEqual(seen, ["tr_01"]);
  await t.srv.close();
});

test("X4: a bad id is 400 and never reaches GodHome; an unknown id is 404 not_found", async () => {
  let calls = 0;
  const t = await setup(async (w) => ok(w), { run: async () => { calls++; return { reachable: true, data: null, fetchedAt: NOW, notFound: true }; } });
  for (const id of ["..", ".", "a%20b", "a%2Fb", "x".repeat(65), "a;b", "%E2%82%AC"]) {
    const x = await t.get(`/ops/traces/${id}`);
    assert.equal(x.status, 400, id);
    assert.equal(x.json.error.code, "bad_request", id);
  }
  assert.equal(calls, 0);
  const nf = await t.get("/ops/traces/tr_missing");
  assert.equal(nf.status, 404);
  assert.equal(nf.json.error.code, "not_found");
  await t.srv.close();
});

test("X4: GodHome unreachable, throwing or answering garbage is 503 unavailable, not 200", async () => {
  const down = await setup(async (w) => ok(w), { run: async () => ({ reachable: false, data: null, fetchedAt: 0 }) });
  const d = await down.get("/ops/traces/tr_01");
  assert.equal(d.status, 503);
  assert.equal(d.json.error.code, "unavailable");
  await down.srv.close();
  const stale = await setup(async (w) => ok(w), { run: async (id: string) => ({ reachable: false, data: detailFrom(id), fetchedAt: NOW - 120_000 }) });
  assert.equal((await stale.get("/ops/traces/tr_01")).status, 503);
  await stale.srv.close();
  const boom = await setup(async (w) => ok(w), { run: async () => { throw new Error("Bearer tok-SECRET-1"); } });
  const b = await boom.get("/ops/traces/tr_01");
  assert.equal(b.status, 503);
  assert.ok(!/tok-SECRET/.test(JSON.stringify(b.json)));
  await boom.srv.close();
  const bad = await setup(async (w) => ok(w), { run: async () => ({ reachable: true, data: "<html>", fetchedAt: NOW }) });
  assert.equal((await bad.get("/ops/traces/tr_01")).status, 503);
  assert.equal((await bad.srv.call("GET", "/v1/ops/traces/tr_01")).status, 401);
  bad.db.prepare("UPDATE control_devices SET caps = 'ops:write' WHERE id = ?").run(bad.deviceId);
  assert.equal((await bad.get("/ops/traces/tr_01")).status, 403);
  await bad.srv.close();
});

// ---- T1.6: X5 and X6 ----------------------------------------------------------------------------------------

const allSummary = () => summary("all");
const setupAll = (extra: Partial<OpsDeps["godhome"]> = {}) => setup(async (w) => ok(w === "all" ? "all" : w), extra);

test("X5: reads the all window; open items equal counts.open; counts and mttr are GodHome's; ids are opaque", async () => {
  const t = await setupAll();
  const r = await t.get("/ops/incidents?limit=100");
  assert.equal(r.status, 200);
  assert.deepEqual(t.calls, ["all"]);
  assert.equal(r.json.reachable, true);
  assert.equal(r.json.fetchedAt, "2026-10-16T08:59:57.000Z");
  const s = allSummary();
  assert.deepEqual(r.json.counts, adjustedCounts(s));
  assert.equal(r.json.mttrMs, s.incidents.mttr.meanMs);
  assert.equal(r.json.items.length, s.incidents.counts.open);
  assert.equal(r.json.next, null);
  for (const i of r.json.items) {
    assert.match(i.id, INCIDENT_ID);
    assert.ok(["check", "review", "deploy"].includes(i.kind));
    assert.ok(["open", "recovering"].includes(i.state));
    assert.ok(Array.isArray(i.actions) && i.actions.includes("ack"));
  }
  assert.ok(!/"durS"|"cwd"|"input"|"output"/.test(JSON.stringify(r.json)));
  await t.srv.close();
});

test("X5: default limit 20 and a next cursor; following before returns the rest once", async () => {
  const t = await setupAll();
  const first = await t.get("/ops/incidents");
  assert.equal(first.json.items.length >= 20, true);
  assert.notEqual(first.json.next, null);
  const seen = new Set<string>(first.json.items.map((i: any) => i.id));
  let next: string | null = first.json.next;
  for (let n = 0; next !== null && n < 10; n++) {
    const p = await t.get(`/ops/incidents?before=${encodeURIComponent(next)}`);
    assert.equal(p.status, 200);
    for (const i of p.json.items) { assert.ok(!seen.has(i.id), "no repeat"); seen.add(i.id); }
    next = p.json.next;
  }
  assert.equal(seen.size, allSummary().incidents.counts.open);
  await t.srv.close();
});

test("X5: state, kind, project and since filters; kind=agent shows the agent incidents counts leave out", async () => {
  const t = await setupAll();
  const s = allSummary();
  const resolved = await t.get("/ops/incidents?state=resolved&limit=100");
  assert.ok(resolved.json.items.length > 0 && resolved.json.items.every((i: any) => i.state === "resolved"));
  const reviews = await t.get("/ops/incidents?kind=review&limit=100");
  assert.ok(reviews.json.items.length > 0 && reviews.json.items.every((i: any) => i.kind === "review"));
  const project = reviews.json.items[0].project;
  const byProject = await t.get(`/ops/incidents?project=${encodeURIComponent(project)}&limit=100`);
  assert.ok(byProject.json.items.every((i: any) => i.project === project));
  const agents = await t.get("/ops/incidents?kind=agent&state=all&limit=100");
  assert.equal(agents.json.items.length, Math.min(100, s.incidents.items.filter((i: any) => i.kind === "agent").length));
  const newest = Math.max(...s.incidents.items.filter((i: any) => i.kind !== "agent" && i.state !== "resolved").map((i: any) => Date.parse(i.lastAt)));
  const none = await t.get(`/ops/incidents?since=${encodeURIComponent(new Date(newest).toISOString())}&limit=100`);
  assert.deepEqual(none.json.items, []);
  const some = await t.get(`/ops/incidents?since=${encodeURIComponent(new Date(newest - 1).toISOString())}&limit=100`);
  assert.ok(some.json.items.length >= 1);
  assert.deepEqual((await t.get("/ops/incidents?state=muted")).json.items, []);
  await t.srv.close();
});

test("X5: a bad state, kind, project, limit, before or since is 400 and never reaches GodHome", async () => {
  const t = await setupAll();
  for (const x of [
    "state=bad", "state=", "state=open&state=all", "kind=bad", "kind=", "project=a%20b", "project=", `project=${"p".repeat(65)}`,
    "limit=0", "limit=101", "limit=abc", "before=yesterday", "since=nope",
  ]) {
    const r = await t.get(`/ops/incidents?${x}`);
    assert.equal(r.status, 400, x);
    assert.equal(r.json.error.code, "bad_request", x);
  }
  assert.deepEqual(t.calls, []);
  await t.srv.close();
});

test("X5: a device without ops:write sees no actions; a device without ops:read gets 403", async () => {
  const t = await setupAll();
  t.db.prepare("UPDATE control_devices SET caps = 'ops:read' WHERE id = ?").run(t.deviceId);
  const r = await t.get("/ops/incidents?limit=100");
  assert.ok(r.json.items.length > 0 && r.json.items.every((i: any) => i.actions.length === 0));
  t.db.prepare("UPDATE control_devices SET caps = 'ops:write' WHERE id = ?").run(t.deviceId);
  assert.equal((await t.get("/ops/incidents")).status, 403);
  assert.equal((await t.srv.call("GET", "/v1/ops/incidents")).status, 401);
  await t.srv.close();
});

test("X5: GodHome down, throwing, stale past the limit or malformed is 200 reachable:false with no items key", async () => {
  const down = await setup(async () => ({ reachable: false, data: null, fetchedAt: 0 }));
  assert.deepEqual((await down.get("/ops/incidents")).json, { fetchedAt: "2026-10-16T09:00:00.000Z", reachable: false });
  await down.srv.close();
  const boom = await setup(async () => { throw new Error("Bearer tok-SECRET-1"); });
  assert.deepEqual((await boom.get("/ops/incidents")).json, { fetchedAt: "2026-10-16T09:00:00.000Z", reachable: false });
  await boom.srv.close();
  const bad = await setup(async () => ({ reachable: true, data: "<html>", fetchedAt: NOW }));
  assert.deepEqual((await bad.get("/ops/incidents")).json, { fetchedAt: "2026-10-16T09:00:00.000Z", reachable: false });
  await bad.srv.close();
  const old = await setup(async () => ok("all", { reachable: false, fetchedAt: NOW - 120_000 }));
  const o = await old.get("/ops/incidents");
  assert.equal(o.json.reachable, false);
  assert.ok(o.json.items.length > 0);
  await old.srv.close();
});

test("X6: the detail of an incident the list issued equals the list item plus an empty history", async () => {
  const t = await setupAll();
  const list = await t.get("/ops/incidents?state=all&limit=100");
  const pick = list.json.items[2];
  const r = await t.get(`/ops/incidents/${pick.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { fetchedAt: "2026-10-16T08:59:57.000Z", reachable: true, ...pick, history: [] });
  await t.srv.close();
});

test("X6: a bad id is 400, a never-issued id is 404, an id that left GodHome is 404", async () => {
  let gone = false;
  const t = await setup(async () => {
    const s = allSummary();
    if (gone) s.incidents.items = [];
    return { reachable: true, data: s, fetchedAt: NOW - 3000 };
  });
  const calls = () => t.calls.length;
  for (const id of ["i_3f2a9c1b7d4", "i_3f2a9c1b7d400", "I_3f2a9c1b7d40", "check:site:1", "i_3F2A9C1B7D40", "..", "i_3f2a9c1b7d4g", "a%20b"]) {
    const before = calls();
    const r = await t.get(`/ops/incidents/${id}`);
    assert.equal(r.status, 400, id);
    assert.equal(r.json.error.code, "bad_request", id);
    assert.equal(calls(), before, "GodHome is not asked for a bad id");
  }
  const unknown = await t.get("/ops/incidents/i_000000000000");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, "not_found");
  const list = await t.get("/ops/incidents?limit=1");
  gone = true;
  const left = await t.get(`/ops/incidents/${list.json.items[0].id}`);
  assert.equal(left.status, 404);
  await t.srv.close();
});

test("X6: GodHome unreachable, throwing, stale or malformed is 503 unavailable; 401 and 403 hold", async () => {
  const t = await setupAll();
  const list = await t.get("/ops/incidents");
  const id = list.json.items[0].id;
  await t.srv.close();
  const mk = async (impl: Summary) => {
    const x = await setup(impl);
    // the id must exist in this app's store: issue it through a list first
    await x.get("/ops/incidents");
    return x;
  };
  let mode: "ok" | "down" | "boom" | "stale" | "bad" = "ok";
  const x = await mk(async () => {
    if (mode === "down") return { reachable: false, data: null, fetchedAt: 0 };
    if (mode === "boom") throw new Error("Bearer tok-SECRET-1");
    if (mode === "stale") return ok("all", { reachable: false, fetchedAt: NOW - 120_000 });
    if (mode === "bad") return { reachable: true, data: "<html>", fetchedAt: NOW };
    return ok("all");
  });
  const own = (await x.get("/ops/incidents")).json.items[0].id;
  assert.equal(own, id, "opaque ids are a pure function of the GodHome id");
  for (const m of ["down", "boom", "stale", "bad"] as const) {
    mode = m;
    const r = await x.get(`/ops/incidents/${own}`);
    assert.equal(r.status, 503, m);
    assert.equal(r.json.error.code, "unavailable", m);
    assert.ok(!/tok-SECRET/.test(JSON.stringify(r.json)));
  }
  mode = "ok";
  assert.equal((await x.srv.call("GET", `/v1/ops/incidents/${own}`)).status, 401);
  x.db.prepare("UPDATE control_devices SET caps = 'ops:write' WHERE id = ?").run(x.deviceId);
  assert.equal((await x.get(`/ops/incidents/${own}`)).status, 403);
  await x.srv.close();
});

// ---- T2.2: X7 to X10, audit, idempotency, limits --------------------------------------------------------------

const auditRows = (db: any) => db.prepare("SELECT * FROM control_ops_audit ORDER BY id").all() as any[];
type Setup = Awaited<ReturnType<typeof setup>>;
/** The first listed open incident that matches, with its opaque id. */
async function pick(t: Setup, want: (i: any) => boolean = () => true) {
  const r = await t.get("/ops/incidents?limit=100");
  const hit = r.json.items.find(want);
  assert.ok(hit, "fixture has a matching incident");
  return hit as any;
}
const notCritical = (i: any) => i.severity !== "critical";
const critical = (i: any) => i.severity === "critical";

test("X7: ack answers {incident} with acked:true and unack, keeps the open counts and adds one audit row", async () => {
  const t = await setupAll();
  const inc = await pick(t);
  const before = (await t.get("/ops/incidents?limit=100")).json.counts;
  const r = await t.post(`/ops/incidents/${inc.id}/ack`);
  assert.equal(r.status, 200);
  assert.equal(r.json.reachable, true);
  assert.equal(r.json.incident.id, inc.id);
  assert.equal(r.json.incident.acked, true);
  assert.equal(r.json.incident.actions[0], "unack");
  const after = (await t.get("/ops/incidents?limit=100")).json;
  assert.deepEqual(after.counts, { ...before, acked: 1 });
  assert.equal(after.items.length, before.open);
  const rows = auditRows(t.db);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].device_id, rows[0].device_name, rows[0].action, rows[0].subject, rows[0].result, rows[0].params], [t.deviceId, "t", "ack", inc.id, "ok", "{}"]);
  assert.ok(rows[0].addr.length > 0 && rows[0].dur_ms >= 0 && rows[0].at === NOW);
  await t.srv.close();
});

test("X8: mute takes 60, 240, 1440, 10080; the incident leaves the open list and counts and shows in state=muted with mutedUntil", async () => {
  for (const minutes of [60, 240, 1440, 10080]) {
    const t = await setupAll();
    const inc = await pick(t, notCritical);
    const before = (await t.get("/ops/incidents?limit=100")).json.counts;
    const r = await t.post(`/ops/incidents/${inc.id}/mute`, { minutes });
    assert.equal(r.status, 200, String(minutes));
    assert.equal(r.json.incident.mutedUntil, new Date(NOW + minutes * 60_000).toISOString());
    assert.deepEqual(r.json.incident.actions.slice(0, 2), ["unmute", "resolve"]);
    const open = (await t.get("/ops/incidents?limit=100")).json;
    assert.equal(open.counts.open, before.open - 1);
    assert.equal(open.counts.muted, 1);
    assert.ok(!open.items.some((i: any) => i.id === inc.id));
    const muted = (await t.get("/ops/incidents?state=muted&limit=100")).json;
    assert.deepEqual(muted.items.map((i: any) => i.id), [inc.id]);
    assert.equal(JSON.parse(auditRows(t.db)[0].params).minutes, minutes);
    await t.srv.close();
  }
});

test("X8: bad minutes are 400 (not 60/240/1440/10080, a string, missing, critical with 1440 or 10080) and reach neither GodHome nor the audit", async () => {
  const t = await setupAll();
  const warn = await pick(t, notCritical);
  const crit = await pick(t, critical);
  const calls = t.calls.length;
  for (const body of [{}, { minutes: 0 }, { minutes: 30 }, { minutes: "60" }, { minutes: 61 }, { minutes: -60 }, { minutes: 60.5 }, { minutes: null }, { minutes: [60] }, { minutes: 1e9 }]) {
    const r = await t.post(`/ops/incidents/${warn.id}/mute`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error.code, "bad_request");
  }
  assert.equal(t.calls.length, calls);
  for (const minutes of [1440, 10080]) {
    const r = await t.post(`/ops/incidents/${crit.id}/mute`, { minutes });
    assert.equal(r.status, 400, `critical ${minutes}`);
  }
  assert.equal(auditRows(t.db).length, 0);
  for (const minutes of [60, 240]) assert.equal((await t.post(`/ops/incidents/${crit.id}/mute`, { minutes })).status, 200, `critical ${minutes}`);
  await t.srv.close();
});

test("X9 and X10: resolve moves the incident to state=resolved with a reopen action; reopen restores it and clears ack and mute", async () => {
  const t = await setupAll();
  const inc = await pick(t);
  const before = (await t.get("/ops/incidents?limit=100")).json.counts;
  const r = await t.post(`/ops/incidents/${inc.id}/resolve`);
  assert.equal(r.status, 200);
  assert.equal(r.json.incident.state, "resolved");
  assert.deepEqual(r.json.incident.actions, ["reopen"]);
  const open = (await t.get("/ops/incidents?limit=100")).json;
  assert.equal(open.counts.open, before.open - 1);
  assert.equal(open.counts.resolved, before.resolved + 1);
  assert.equal((await t.get(`/ops/incidents/${inc.id}`)).json.state, "resolved");
  assert.equal((await t.post(`/ops/incidents/${inc.id}/ack`)).status, 409, "a hidden resolved incident cannot be acked");
  const back = await t.post(`/ops/incidents/${inc.id}/reopen`);
  assert.equal(back.status, 200);
  assert.equal(back.json.incident.state, "open");
  assert.deepEqual((await t.get("/ops/incidents?limit=100")).json.counts, before);
  // ack, mute, then reopen clears both
  await t.post(`/ops/incidents/${inc.id}/ack`);
  await t.post(`/ops/incidents/${inc.id}/mute`, { minutes: 60 });
  const clean = await t.post(`/ops/incidents/${inc.id}/reopen`);
  assert.deepEqual([clean.json.incident.acked, clean.json.incident.mutedUntil], [false, undefined]);
  assert.deepEqual(auditRows(t.db).map((x) => `${x.action}:${x.result}`), ["resolve:ok", "ack:conflict", "reopen:ok", "ack:ok", "mute:ok", "reopen:ok"]);
  await t.srv.close();
});

test("X7 to X10: a device without ops:write gets 403, no bearer 401; neither reaches GodHome or the audit", async () => {
  const t = await setupAll();
  const inc = await pick(t);
  const calls = t.calls.length;
  t.db.prepare("UPDATE control_devices SET caps = 'ops:read' WHERE id = ?").run(t.deviceId);
  for (const a of ["ack", "mute", "resolve", "reopen"]) {
    const r = await t.post(`/ops/incidents/${inc.id}/${a}`, { minutes: 60 });
    assert.equal(r.status, 403, a);
    assert.equal(r.json.error.code, "forbidden");
    assert.equal((await t.srv.call("POST", `/v1/ops/incidents/${inc.id}/${a}`, {})).status, 401, a);
  }
  assert.equal(t.calls.length, calls);
  assert.equal(auditRows(t.db).length, 0);
  await t.srv.close();
});

test("X7 to X10: a bad id is 400, an id never issued 404, an issued id that left GodHome 404; GodHome down is 503 unavailable", async () => {
  const t = await setupAll();
  for (const a of ["ack", "mute", "resolve", "reopen"]) {
    assert.equal((await t.post(`/ops/incidents/check:site:1/${a}`, { minutes: 60 })).status, 400, a);
    assert.equal((await t.post(`/ops/incidents/i_ffffffffffff/${a}`, { minutes: 60 })).status, 404, a);
  }
  assert.equal(auditRows(t.db).length, 0);
  await t.srv.close();
  let gone = false;
  const g = await setup(async (w) => { if (gone) { const s = summary(w); s.incidents.items = []; return ok(w, { data: s }); } return ok(w); });
  const inc = (await g.get("/ops/incidents?limit=100")).json.items[0];
  gone = true;
  assert.equal((await g.post(`/ops/incidents/${inc.id}/ack`)).status, 404);
  assert.equal(auditRows(g.db)[0].result, "not_found");
  await g.srv.close();
  let down = false;
  const d = await setup(async (w) => (down ? { reachable: false, data: null, fetchedAt: 0 } : ok(w)));
  const id = (await d.get("/ops/incidents?limit=100")).json.items[0].id;
  down = true;
  const r = await d.post(`/ops/incidents/${id}/ack`);
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, "unavailable");
  assert.equal(auditRows(d.db)[0].result, "unavailable");
  await d.srv.close();
});

test("X7: resolve on a GodHome-resolved incident and ack on it are 409 conflict", async () => {
  const t = await setupAll();
  const r = (await t.get("/ops/incidents?state=resolved&limit=5")).json.items[0];
  assert.ok(r);
  for (const a of ["ack", "resolve"]) assert.equal((await t.post(`/ops/incidents/${r.id}/${a}`)).status, 409, a);
  assert.equal((await t.post(`/ops/incidents/${r.id}/mute`, { minutes: 60 })).status, 409);
  assert.equal((await t.post(`/ops/incidents/${r.id}/reopen`)).status, 200, "reopen is a harmless no-op");
  await t.srv.close();
});

test("Idempotency-Key: a replay returns the stored body and status, writes no second audit row and does not reach GodHome again", async () => {
  const t = await setupAll();
  const inc = await pick(t);
  const first = await t.post(`/ops/incidents/${inc.id}/mute`, { minutes: 240 }, { "idempotency-key": "k-1" });
  assert.equal(first.status, 200);
  const calls = t.calls.length;
  const again = await t.post(`/ops/incidents/${inc.id}/mute`, { minutes: 240 }, { "idempotency-key": "k-1" });
  assert.equal(again.status, 200);
  assert.deepEqual(again.json, first.json);
  assert.equal(t.calls.length, calls);
  assert.equal(auditRows(t.db).length, 1);
  assert.equal(auditRows(t.db)[0].idem_key, "k-1");
  // the same key on another action is its own request
  assert.equal((await t.post(`/ops/incidents/${inc.id}/ack`, {}, { "idempotency-key": "k-1" })).status, 200);
  assert.equal(auditRows(t.db).length, 2);
  // the same key and action for another incident is refused, not replayed
  const other = await pick(t, (i) => i.id !== inc.id && notCritical(i));
  const clash = await t.post(`/ops/incidents/${other.id}/mute`, { minutes: 240 }, { "idempotency-key": "k-1" });
  assert.equal(clash.status, 409);
  assert.equal(clash.json.error.code, "conflict");
  // a malformed key is 400
  for (const key of ["", "x".repeat(129), "has space", "a/b"]) {
    assert.equal((await t.post(`/ops/incidents/${inc.id}/ack`, {}, { "idempotency-key": key })).status, 400, JSON.stringify(key));
  }
  await t.srv.close();
});

test("a failed write is not stored under its Idempotency-Key: the retry can succeed", async () => {
  let down = true;
  const t = await setup(async (w) => (down ? { reachable: false, data: null, fetchedAt: 0 } : ok(w)));
  down = false;
  const inc = (await t.get("/ops/incidents?limit=100")).json.items[0];
  down = true;
  assert.equal((await t.post(`/ops/incidents/${inc.id}/ack`, {}, { "idempotency-key": "k-2" })).status, 503);
  down = false;
  assert.equal((await t.post(`/ops/incidents/${inc.id}/ack`, {}, { "idempotency-key": "k-2" })).status, 200);
  assert.deepEqual(auditRows(t.db).map((r) => [r.result, r.idem_key]), [["unavailable", null], ["ok", "k-2"]]);
  await t.srv.close();
});

test("writes are limited to 30 a minute per device: the 31st is 429 rate_limited with Retry-After; reads are not counted", async () => {
  const t = await setupAll();
  const inc = await pick(t);
  for (let n = 0; n < 30; n++) assert.equal((await t.post(`/ops/incidents/${inc.id}/ack`)).status, 200, `write ${n + 1}`);
  const r = await t.post(`/ops/incidents/${inc.id}/ack`);
  assert.equal(r.status, 429);
  assert.equal(r.json.error.code, "rate_limited");
  assert.ok(Number(r.headers["retry-after"]) >= 1);
  assert.equal((await t.get("/ops/incidents")).status, 200);
  assert.equal(auditRows(t.db).length, 30);
  await t.srv.close();
});

test("the audit row holds no token, GodHome id or request header", async () => {
  const t = await setupAll();
  const inc = await pick(t);
  await t.post(`/ops/incidents/${inc.id}/mute`, { minutes: 60 }, { "idempotency-key": "k-3" });
  const dump = JSON.stringify(auditRows(t.db));
  assert.ok(!dump.includes(t.auth.authorization.slice(7)), "device token");
  assert.ok(!dump.includes("Bearer"));
  assert.ok(!/check:|review:|agent:|deploy:/.test(dump), "raw GodHome id");
  await t.srv.close();
});

// ---- T2.3: X11 fix task ---------------------------------------------------------------------------------------

type Proposed = { project: any; msg: any; engine: any };
/** A fake TasksDeps that records every proposal. `missions` are the projects with a mission config. */
function fakeTasks(missions: string[], over: { propose?: () => Promise<string | null> } = {}) {
  const proposed: Proposed[] = [];
  const tasks = {
    getProject: (name: string) => (missions.includes(name) ? ({ name, location: "server", path: "/srv/" + name } as any) : undefined),
    propose: async (project: any, msg: any, engine: any) => {
      proposed.push({ project, msg, engine });
      return over.propose ? over.propose() : `m${proposed.length}`;
    },
  };
  const taskProjects = () => missions.map((name) => ({ name, engine: "claude" as const }));
  return { proposed, opsExtra: { tasks, taskProjects } as Partial<OpsDeps> };
}
/** An open incident for project "tokyo" whose title and extra fields carry things that must not reach a prompt. */
const leaky = (over: Record<string, unknown> = {}) => ({
  id: "check:unit:1792170025000", kind: "check", title: "unit: chkrootkit failed at /usr/lib/modules/6.8.0/.build-id/aa/bb and /tmp", subtitle: "check unit, 0 flaps",
  severity: "warning", state: "open", project: "tokyo", check: "unit", firstAt: "2026-10-16T08:10:00.000Z", lastAt: "2026-10-16T08:40:00.000Z",
  durationMs: 1_800_000, flaps: 0, flapping: false, count: 3, output: "SECRET LOG LINE sk-abcdefghijklmnopqrstuvwxyz", cwd: "/root/secret-project", ...over,
});
const leakySummary = (items: any[]) => ({ incidents: { items, counts: { open: items.length, critical: 0, warning: items.length, notice: 0, resolved: 0 }, mttr: null } });
const leakyApp = (missions: string[], items: any[] = [leaky()], over: Parameters<typeof fakeTasks>[1] = {}) => {
  const ft = fakeTasks(missions, over);
  return setup(async (w) => ok(w, { data: leakySummary(items) }), {}, ft.opsExtra).then((t) => ({ ...t, proposed: ft.proposed }));
};
const firstId = async (t: Setup) => (await t.get("/ops/incidents?limit=100")).json.items[0] as any;

test("X11: proposes a mission exactly like POST /tasks and answers {offerId, project}; the prompt has the title, project, kind and duration and no path, no output", async () => {
  const t = await leakyApp(["tokyo"]);
  const inc = await firstId(t);
  assert.ok(inc.actions.includes("fixTask"));
  const r = await t.post(`/ops/incidents/${inc.id}/fix-task`, { note: "check the timer too" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { fetchedAt: "2026-10-16T08:59:57.000Z", reachable: true, offerId: "m1", project: "tokyo" });
  assert.equal(t.proposed.length, 1);
  const p = t.proposed[0];
  assert.equal(p.project.name, "tokyo");
  assert.equal(p.engine, undefined);
  assert.equal(p.msg.sender_name, "owner (control app)");
  assert.equal(p.msg.jid, "control-app");
  const prompt: string = p.msg.content;
  for (const want of ["unit: chkrootkit failed at", "Project: tokyo", "Kind: check", "Open for: 30 min", "check the timer too"]) assert.ok(prompt.includes(want), want);
  assert.ok(!/(^|[^\w:/.~-])\/[\w.~-]/.test(prompt), `no absolute path in: ${prompt}`);
  for (const bad of ["SECRET LOG LINE", "sk-abc", "/root", "/usr", "/tmp"]) assert.ok(!prompt.includes(bad), bad);
  const rows = auditRows(t.db);
  assert.deepEqual([rows.length, rows[0].action, rows[0].subject, rows[0].result], [1, "fix-task", inc.id, "ok"]);
  await t.srv.close();
});

test("X11: fixTask is in actions[] only for a project in taskProjects(); a read-only device and a resolved incident get none", async () => {
  const items = [leaky(), leaky({ id: "check:unit:1792170026000", project: "server", lastAt: "2026-10-16T08:30:00.000Z" })];
  const t = await leakyApp(["tokyo"], items);
  const list = (await t.get("/ops/incidents?limit=100")).json.items as any[];
  assert.deepEqual(list.find((i) => i.project === "tokyo").actions, ["ack", "mute", "resolve", "fixTask"]);
  assert.deepEqual(list.find((i) => i.project === "server").actions, ["ack", "mute", "resolve"]);
  const tokyo = list.find((i) => i.project === "tokyo");
  await t.post(`/ops/incidents/${tokyo.id}/mute`, { minutes: 60 });
  assert.deepEqual((await t.get(`/ops/incidents/${tokyo.id}`)).json.actions, ["unmute", "resolve", "fixTask"]);
  await t.post(`/ops/incidents/${tokyo.id}/resolve`);
  assert.deepEqual((await t.get(`/ops/incidents/${tokyo.id}`)).json.actions, ["reopen"]);
  t.db.prepare("UPDATE control_devices SET caps = 'ops:read' WHERE id = ?").run(t.deviceId);
  assert.ok((await t.get("/ops/incidents?limit=100")).json.items.every((i: any) => i.actions.length === 0));
  await t.srv.close();
});

test("X11: a project without mission config is 404 not_found and no offer is created (not in taskProjects, no getProject, propose null)", async () => {
  const t = await leakyApp(["other"]);
  const inc = await firstId(t);
  const r = await t.post(`/ops/incidents/${inc.id}/fix-task`);
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, "not_found");
  assert.equal(t.proposed.length, 0);
  assert.equal(auditRows(t.db)[0].result, "not_found");
  await t.srv.close();
  const none = await leakyApp(["tokyo"], [leaky()], { propose: async () => null });
  const id = (await firstId(none)).id;
  assert.equal((await none.post(`/ops/incidents/${id}/fix-task`)).status, 404);
  assert.equal(none.proposed.length, 1, "asked once, the backend said no");
  await none.srv.close();
  const bare = await setup(async (w) => ok(w, { data: leakySummary([leaky()]) }));
  const bid = (await firstId(bare)).id;
  assert.equal((await bare.post(`/ops/incidents/${bid}/fix-task`)).status, 404, "no tasks wiring at all");
  await bare.srv.close();
});

test("X11: note must be a string of at most 500 characters (400 otherwise); it is scrubbed and redacted in the prompt and in the audit params", async () => {
  const t = await leakyApp(["tokyo"]);
  const inc = await firstId(t);
  for (const note of [501, "x".repeat(501), {}, ["a"], true]) assert.equal((await t.post(`/ops/incidents/${inc.id}/fix-task`, { note })).status, 400, JSON.stringify(note).slice(0, 20));
  assert.equal(t.proposed.length, 0);
  assert.equal(auditRows(t.db).length, 0);
  const note = "look at /var/log/syslog and /etc/cron.d/x with Bearer abcdef0123456789abcdef0123456789";
  assert.equal((await t.post(`/ops/incidents/${inc.id}/fix-task`, { note })).status, 200);
  const prompt: string = t.proposed[0].msg.content;
  assert.ok(!prompt.includes("/var") && !prompt.includes("/etc") && !prompt.includes("abcdef0123456789"));
  const params = auditRows(t.db)[0].params;
  assert.ok(!params.includes("abcdef0123456789") && !params.includes("/var/log"), params);
  assert.equal((await t.post(`/ops/incidents/${inc.id}/fix-task`, { note: "x".repeat(500) })).status, 200, "500 is allowed");
  assert.equal((await t.post(`/ops/incidents/${inc.id}/fix-task`, {})).status, 200, "no note is allowed");
  await t.srv.close();
});

test("X11: a replayed Idempotency-Key returns the stored body and proposes once; a resolved incident is 409; GodHome down is 503; no write cap is 403", async () => {
  const t = await leakyApp(["tokyo"]);
  const inc = await firstId(t);
  const a = await t.post(`/ops/incidents/${inc.id}/fix-task`, {}, { "idempotency-key": "fx-1" });
  const b = await t.post(`/ops/incidents/${inc.id}/fix-task`, {}, { "idempotency-key": "fx-1" });
  assert.deepEqual(b.json, a.json);
  assert.equal(t.proposed.length, 1);
  assert.equal(auditRows(t.db).length, 1);
  await t.post(`/ops/incidents/${inc.id}/resolve`);
  const c = await t.post(`/ops/incidents/${inc.id}/fix-task`);
  assert.equal(c.status, 409);
  assert.equal(t.proposed.length, 1);
  t.db.prepare("UPDATE control_devices SET caps = 'ops:read' WHERE id = ?").run(t.deviceId);
  assert.equal((await t.post(`/ops/incidents/${inc.id}/fix-task`)).status, 403);
  await t.srv.close();
  let down = false;
  const ft = fakeTasks(["tokyo"]);
  const d = await setup(async (w) => (down ? { reachable: false, data: null, fetchedAt: 0 } : ok(w, { data: leakySummary([leaky()]) })), {}, ft.opsExtra);
  const id = (await firstId(d)).id;
  down = true;
  assert.equal((await d.post(`/ops/incidents/${id}/fix-task`)).status, 503);
  assert.equal(ft.proposed.length, 0);
  await d.srv.close();
});

// ---- T2.4: X6 history and X17 audit -----------------------------------------------------------------------------

test("X6: history lists the ok actions on that incident newest first as {at, action, device}; a refused attempt and other incidents are not in it", async () => {
  const t = await setupAll();
  const inc = await pick(t);
  assert.deepEqual((await t.get(`/ops/incidents/${inc.id}`)).json.history, []);
  let clock = 0;
  const bump = () => t.db.prepare("UPDATE control_ops_audit SET at = at + ? WHERE id = (SELECT MAX(id) FROM control_ops_audit)").run(++clock * 1000);
  await t.post(`/ops/incidents/${inc.id}/ack`); bump();
  await t.post(`/ops/incidents/${inc.id}/mute`, { minutes: 60 }); bump();
  await t.post(`/ops/incidents/${inc.id}/resolve`); bump();
  assert.equal((await t.post(`/ops/incidents/${inc.id}/ack`)).status, 409);
  await t.post(`/ops/incidents/${inc.id}/reopen`); bump();
  const other = await pick(t, (i) => i.id !== inc.id);
  await t.post(`/ops/incidents/${other.id}/ack`);
  const h = (await t.get(`/ops/incidents/${inc.id}`)).json.history;
  assert.deepEqual(h.map((e: any) => e.action), ["reopen", "resolve", "mute", "ack"]);
  assert.deepEqual(Object.keys(h[0]).sort(), ["action", "at", "device"]);
  assert.equal(h[0].device, "t");
  assert.equal(h[0].at, new Date(NOW + 4000).toISOString());
  assert.ok(h[0].at > h[3].at);
  await t.srv.close();
});

test("X17: the last 100 rows newest first as {at, device, action, subject, result}; no addr, no params; limit 1 to 100", async () => {
  const t = await setupAll();
  const inc = await pick(t);
  await t.post(`/ops/incidents/${inc.id}/mute`, { minutes: 60 });
  await t.post(`/ops/incidents/${inc.id}/resolve`);
  assert.equal((await t.post(`/ops/incidents/${inc.id}/ack`)).status, 409);
  const r = await t.get("/ops/audit");
  assert.equal(r.status, 200);
  assert.equal(r.json.reachable, true);
  assert.equal(r.json.fetchedAt, "2026-10-16T09:00:00.000Z");
  assert.deepEqual(r.json.entries.map((e: any) => [e.action, e.result]), [["incident.ack", "conflict"], ["incident.resolve", "ok"], ["incident.mute", "ok"]]);
  assert.deepEqual(r.json.entries[0], { at: "2026-10-16T09:00:00.000Z", device: "t", action: "incident.ack", subject: inc.id, result: "conflict" });
  const dump = JSON.stringify(r.json);
  assert.ok(!dump.includes("127.0.0.1") && !dump.includes("minutes") && !dump.includes('"addr"') && !dump.includes('"params"'), dump);
  const ins = t.db.prepare("INSERT INTO control_ops_audit (at, device_id, device_name, addr, action, subject, params, result, detail, dur_ms) VALUES (?, 'd_x', 'x', 'a', 'ack', 's', '{}', 'ok', '', 1)");
  for (let n = 0; n < 120; n++) ins.run(NOW + n);
  assert.equal((await t.get("/ops/audit")).json.entries.length, 100);
  assert.equal((await t.get("/ops/audit?limit=100")).json.entries.length, 100);
  assert.equal((await t.get("/ops/audit?limit=5")).json.entries.length, 5);
  assert.equal((await t.get("/ops/audit?limit=1")).json.entries.length, 1);
  for (const q of ["limit=0", "limit=101", "limit=abc", "limit=-1", "limit=2.5", "limit=", "limit=5&limit=6", "limit=1e2"]) {
    const x = await t.get(`/ops/audit?${q}`);
    assert.equal(x.status, 400, q);
    assert.equal(x.json.error.code, "bad_request");
  }
  await t.srv.close();
});

test("X17: needs ops:read (403), a bearer (401); a device with only ops:read can read it; it does not touch GodHome", async () => {
  const t = await setupAll();
  const calls = t.calls.length;
  t.db.prepare("UPDATE control_devices SET caps = 'ops:read' WHERE id = ?").run(t.deviceId);
  assert.equal((await t.get("/ops/audit")).status, 200);
  t.db.prepare("UPDATE control_devices SET caps = 'ops:write' WHERE id = ?").run(t.deviceId);
  assert.equal((await t.get("/ops/audit")).status, 403);
  assert.equal((await t.srv.call("GET", "/v1/ops/audit")).status, 401);
  assert.equal(t.calls.length, calls);
  await t.srv.close();
});

// ---- T3.3: X14 engine run stop ---------------------------------------------------------------------------------

type Stop = { status: "stopped" } | { status: "not_running" } | { status: "unreachable" };
async function stopSetup(reply: (id: string) => Stop | Promise<Stop>) {
  const stops: string[] = [];
  const t = await setupAll({ stopRun: async (id: string) => { stops.push(id); return reply(id); } } as any);
  return { ...t, stops };
}

test("X14: a stopped run answers {ok, status:stopped}, calls stopRun once with the id, and leaves one audit row", async () => {
  const t = await stopSetup(() => ({ status: "stopped" }));
  const r = await t.post("/ops/engine-runs/tr_01/stop");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { fetchedAt: "2026-10-16T09:00:00.000Z", reachable: true, ok: true, status: "stopped" });
  assert.deepEqual(t.stops, ["tr_01"]);
  const rows = auditRows(t.db);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].device_id, rows[0].action, rows[0].subject, rows[0].result, rows[0].params], [t.deviceId, "engine.stop", "tr_01", "ok", "{}"]);
  assert.ok(rows[0].addr.length > 0 && rows[0].at === NOW);
  assert.deepEqual((await t.get("/ops/audit")).json.entries.map((e: any) => [e.action, e.subject, e.result]), [["engine.stop", "tr_01", "ok"]]);
  await t.srv.close();
});

test("X14: ops:write is required (403, 401 without a bearer) and nothing reaches GodHome or the audit", async () => {
  const t = await stopSetup(() => ({ status: "stopped" }));
  t.db.prepare("UPDATE control_devices SET caps = 'ops:read' WHERE id = ?").run(t.deviceId);
  const r = await t.post("/ops/engine-runs/tr_01/stop");
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, "forbidden");
  assert.equal((await t.srv.call("POST", "/v1/ops/engine-runs/tr_01/stop", {})).status, 401);
  assert.deepEqual(t.stops, []);
  assert.equal(auditRows(t.db).length, 0);
  await t.srv.close();
});

test("X14: the id is checked before any call: a bad id is 400 with no GodHome call and no audit row", async () => {
  const t = await stopSetup(() => ({ status: "stopped" }));
  for (const id of ["a%20b", "x".repeat(65), "..", ".", "a%2fb", "run%3Fx", "a;b"]) {
    const r = await t.post(`/ops/engine-runs/${id}/stop`);
    assert.equal(r.status, 400, id);
    assert.equal(r.json.error.code, "bad_request", id);
  }
  assert.deepEqual(t.stops, []);
  assert.equal(auditRows(t.db).length, 0);
  await t.srv.close();
});

test("X14: GodHome {ok:false} (unknown or finished run) is 409 conflict and audited", async () => {
  const t = await stopSetup(() => ({ status: "not_running" }));
  const r = await t.post("/ops/engine-runs/tr_01/stop");
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, "conflict");
  assert.deepEqual(auditRows(t.db).map((x) => [x.action, x.subject, x.result]), [["engine.stop", "tr_01", "conflict"]]);
  await t.srv.close();
});

test("X14: GodHome unreachable, throwing or without stopRun is 503 unavailable, audited, and the body holds no detail", async () => {
  for (const reply of [() => ({ status: "unreachable" }) as Stop, () => { throw new Error("connect ECONNREFUSED Bearer tok-SECRET-1"); }]) {
    const t = await stopSetup(reply);
    const r = await t.post("/ops/engine-runs/tr_01/stop");
    assert.equal(r.status, 503);
    assert.equal(r.json.error.code, "unavailable");
    assert.ok(!/SECRET|ECONN/.test(JSON.stringify(r.json)));
    assert.deepEqual(auditRows(t.db).map((x) => x.result), ["unavailable"]);
    await t.srv.close();
  }
  const none = await setupAll();
  assert.equal((await none.post("/ops/engine-runs/tr_01/stop")).status, 503);
  await none.srv.close();
});

test("X14 counts against the 30 writes a minute", async () => {
  const t = await stopSetup(() => ({ status: "stopped" }));
  for (let n = 0; n < 30; n++) assert.equal((await t.post("/ops/engine-runs/tr_01/stop")).status, 200, `write ${n + 1}`);
  assert.equal((await t.post("/ops/engine-runs/tr_01/stop")).status, 429);
  await t.srv.close();
});
