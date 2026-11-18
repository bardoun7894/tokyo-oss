import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { controlApp } from "../test-app";
import { OpsStore } from "../ops-store";
import type { Cap } from "../store";
import { GhIds } from "./ids";
import { ghKinds, type GhDeps } from "./index";
import { ghRoutes } from "./index";
import { assertWithinExample, fakeGh } from "./test-support";

const NOW = Date.parse("2026-10-17T13:00:00Z");
const godhome = { summary: async () => ({ reachable: true, data: {}, fetchedAt: 0 }), runs: async () => ({ reachable: true, data: [], fetchedAt: 0 }), run: async () => ({ reachable: true, data: {}, fetchedAt: 0 }), graph: async () => ({ reachable: true, data: {}, fetchedAt: 0 }) };

const PLAYBOOK = {
  scope: "global", pendingPath: "/root/.pi/playbook/pending.md", approvedPath: "/root/.pi/playbook/approved.md",
  pending: [{ id: "L-001", runId: "r1", graph: "build", drafted: "2026-10-17T12:00:00.000Z", flagged: "risky", text: "Run the gate before review. See /root/app/docs/x.md. " + "word ".repeat(200) }],
  approved: [{ id: "L-000", graph: "build", drafted: "2026-10-16T12:00:00.000Z", approved: "2026-10-16T13:00:00.000Z", text: "Keep diffs small." }],
};
const TRIGGERS = { triggers: [
  { id: "t-1", graph: "nightly-check", kind: "cron", enabled: true, cron: "0 3 * * *", input: "secret prompt", watchPath: "/root/w", maxRuns: 10, maxCalls: 100, runs: 4, calls: 12, lastFiredAt: 1_792_238_400_000, lastError: "boom /root/x/y", lastRunId: "r9" },
  { id: "t-2", graph: "watch", kind: "file", enabled: false, watchPath: "/root/in/box", maxRuns: 3, maxCalls: 30, runs: 0, calls: 0 },
  { id: "t-3", graph: "poll", kind: "continuous", enabled: true, everySec: 90, maxRuns: 3, maxCalls: 30, runs: 1, calls: 1 },
  { id: "t-4", graph: "reflect", kind: "reflection", enabled: true, everyRuns: 5, maxRuns: 3, maxCalls: 30, runs: 0, calls: 0 },
] };

async function setup(caps: Cap[] = ["ops:read", "ops:write", "ops:run"]) {
  const db = new Database(":memory:");
  const ops = new OpsStore(db);
  const gh = fakeGh(() => NOW);
  gh.bodies.playbook = PLAYBOOK;
  gh.bodies.triggers = TRIGGERS;
  const deps: GhDeps = { client: gh, ids: new GhIds(db), ops, allowlist: () => [], now: () => Date.now() };
  const t = await controlApp({ gh: deps, ops: { godhome, store: ops, kinds: ghKinds(deps) } as any }, db);
  t.store.setCaps(t.store.listDevices()[0]!.id, caps);
  const audits = () => db.prepare("SELECT action, subject, result FROM control_ops_audit ORDER BY id").all() as { action: string; subject: string; result: string }[];
  const confirm = (actionId: string, key = "k-" + actionId) => t.srv.call("POST", `/control-api/v1/ops/actions/${actionId}/confirm`, {}, { ...t.auth, "idempotency-key": key });
  const del = (p: string) => t.srv.call("DELETE", "/control-api/v1" + p, undefined, t.auth);
  const loopId = async (graph: string) => ((await t.get("/ops/gh/loops")).json.loops as any[]).find((l) => l.graph === graph).id as string;
  const lessonId = async (n = 0) => (await t.get("/ops/gh/playbook")).json.pending[n].id as string;
  return { ...t, gh, deps, db, ops, audits, confirm, del, loopId, lessonId };
}

test("T5.4 K15, K18, K19, K21 map to exactly the contract example's fields", async () => {
  const t = await setup(["ops:read"]);
  for (const [code, path] of [["K15", "/ops/gh/playbook"], ["K18", "/ops/gh/graphs"], ["K19", "/ops/gh/graphs/build"], ["K21", "/ops/gh/loops"]] as const) {
    const r = await t.get(path);
    assert.equal(r.status, 200, code);
    assert.equal(r.json.reachable, true, code);
    assertWithinExample(code, r.json, ["approved[]", "approved[].id", "approved[].graph", "approved[].drafted", "approved[].approved", "approved[].text", "loops[].schedule"]);
  }
  await t.close();
});

test("T5.4 playbook: lesson id, graph, times and clamped scrubbed text; no file paths, run ids or scope", async () => {
  const t = await setup(["ops:read"]);
  const p = (await t.get("/ops/gh/playbook")).json;
  assert.deepEqual(Object.keys(p.pending[0]).sort(), ["drafted", "flagged", "graph", "id", "text"]);
  assert.deepEqual(Object.keys(p.approved[0]).sort(), ["approved", "drafted", "graph", "id", "text"]);
  assert.ok(p.pending[0].text.length <= 600);
  assert.ok(!/\/root\/|pendingPath|approvedPath|runId|scope/.test(JSON.stringify(p)), JSON.stringify(p));
  assert.match(p.pending[0].id, /^g_[0-9a-f]{12}$/);
  assert.equal((await t.get("/ops/gh/playbook")).json.pending[0].id, p.pending[0].id);
  await t.close();
});

test("T5.4 graphs: detail has nodes, edges and role refs but no prompt, system or output description", async () => {
  const t = await setup(["ops:read"]);
  const g = (await t.get("/ops/gh/graphs/build")).json;
  const dump = JSON.stringify(g);
  assert.ok(!/"prompt"|"system"/.test(dump), dump);
  assert.deepEqual(Object.keys(g.graph.nodes[0]).sort(), ["id", "kind", "model", "outputType", "tools", "x", "y"]);
  assert.deepEqual(Object.keys(g.graph.edges[0]).sort(), ["from", "to"]);
  assert.equal((await t.get("/ops/gh/graphs/a%20b")).status, 400);
  assert.equal(t.gh.reads.at(-1)!.key, "graph", "the bad name never became a second request");
  t.gh.bodies.graph = null;
  const missing = await t.get("/ops/gh/graphs/nope");
  assert.deepEqual([missing.status, missing.json.error.code], [404, "not_found"]);
  await t.close();
});

test("T5.4 loops: opaque id, graph, kind, enabled, one schedule string, brakes and counts; no input, path or error text", async () => {
  const t = await setup(["ops:read"]);
  const l = (await t.get("/ops/gh/loops")).json.loops as any[];
  assert.deepEqual(l.map((x) => x.schedule), ["0 3 * * *", undefined, "every 90 s", "every 5 runs"]);
  assert.deepEqual(Object.keys(l[0]).sort(), ["calls", "enabled", "graph", "id", "kind", "lastFiredAt", "maxCalls", "maxRuns", "runs", "schedule"]);
  assert.equal(l[0].lastFiredAt, new Date(1_792_238_400_000).toISOString());
  assert.ok(!/secret prompt|\/root\/|boom|r9|input|watchPath|lastError/.test(JSON.stringify(l)));
  assert.ok(l.every((x) => /^g_[0-9a-f]{12}$/.test(x.id)));
  await t.close();
});

test("T5.4 K16 approve and K17 reject: ops:write, the lesson id resolved server-side, audited", async () => {
  const ro = await setup(["ops:read"]);
  assert.equal((await ro.post("/ops/gh/playbook/g_000000000000/approve")).status, 403);
  await ro.close();
  const t = await setup();
  const id = await t.lessonId();
  assert.equal((await t.post("/ops/gh/playbook/nope/approve")).status, 400);
  assert.equal((await t.post("/ops/gh/playbook/g_000000000000/approve")).status, 404);
  assert.equal(t.gh.writes.length, 0);
  assert.deepEqual((await t.post(`/ops/gh/playbook/${id}/approve`)).json, { ok: true });
  assert.deepEqual(t.gh.writes.at(-1), { key: "lessonApprove", args: { seg: ["L-001"] } });
  t.gh.writeResult = () => ({ status: "ok", json: { ok: false } });
  assert.equal((await t.post(`/ops/gh/playbook/${id}/reject`)).status, 404, "GodHome says it is not there");
  t.gh.writeResult = () => ({ status: "ok", json: { ok: true } });
  assert.deepEqual((await t.post(`/ops/gh/playbook/${id}/reject`)).json, { ok: true });
  assert.deepEqual(t.gh.writes.at(-1), { key: "lessonReject", args: { seg: ["L-001"] } });
  assert.deepEqual(t.audits().map((a) => [a.action, a.subject, a.result]), [["gh.K16", "nope", "bad_request"], ["gh.K16", "g_000000000000", "not_found"], ["gh.K16", id, "ok"], ["gh.K17", id, "not_found"], ["gh.K17", id, "ok"]]);
  await t.close();
});

test("T5.4 K20 prepare: ops:run, a plain graph name, the graph must exist; nothing is sent to GodHome until the confirm", async () => {
  const w = await setup(["ops:read", "ops:write"]);
  assert.equal((await w.post("/ops/gh/graphs/build/run")).status, 403);
  await w.close();
  const t = await setup();
  assert.equal((await t.post("/ops/gh/graphs/a%20b/run")).status, 400);
  t.gh.bodies.graph = null;
  assert.equal((await t.post("/ops/gh/graphs/nope/run")).status, 404, "GodHome has no such graph");
  delete t.gh.bodies.graph;
  t.gh.down = true;
  assert.equal((await t.post("/ops/gh/graphs/build/run")).status, 503, "no reply at all is unavailable");
  t.gh.down = false;
  const r = await t.post("/ops/gh/graphs/build/run");
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ["actionId", "expiresAt", "kind", "label"]);
  assert.equal(r.json.kind, "gh_graph_run");
  assert.equal(r.json.label, "build");
  assert.match(r.json.actionId, /^act_[0-9a-f]{12}$/);
  assert.deepEqual(t.gh.writes, []);
  assert.deepEqual(t.audits().map((a) => [a.action, a.result]).at(-1), ["gh.K20", "ok"]);
  await t.close();
});

test("T5.4 K20 confirm (X16): runs the graph once, replays under the same key, needs ops:run, and 3 runs per 10 min per device count graphs and loops together", async () => {
  const t = await setup();
  const prep = async (graph: string) => (await t.post(`/ops/gh/graphs/${graph}/run`)).json.actionId as string;
  t.gh.writeResult = (key) => ({ status: "ok", json: key === "graphRun" ? { ok: true, runId: "run-7", scope: "global" } : { ok: true, trigger: {} } });
  const a = await prep("build");
  const c1 = await t.confirm(a);
  assert.deepEqual([c1.status, c1.json], [200, { ok: true, runId: "run-7" }]);
  assert.deepEqual(t.gh.writes.at(-1), { key: "graphRun", args: { seg: ["build"] } });
  const again = await t.confirm(a);
  assert.deepEqual(again.json, c1.json);
  assert.equal(t.gh.writes.filter((w) => w.key === "graphRun").length, 1);
  assert.equal((await t.confirm(a, "other-key")).status, 409, "a spent token");
  const f = await t.post(`/ops/gh/loops/${await t.loopId("nightly-check")}/fire`);
  assert.equal((await t.confirm(f.json.actionId)).status, 200);
  assert.equal((await t.confirm(await prep("build"))).status, 200);
  const fourth = await t.confirm(await prep("build"));
  assert.equal(fourth.status, 429);
  assert.equal(fourth.json.error.code, "rate_limited");
  assert.equal(t.gh.writes.length, 3);
  assert.deepEqual(t.audits().map((x) => x.action).filter((x) => x.endsWith(".confirm")), ["gh.K20.confirm", "gh.K20.confirm", "gh.K22.confirm", "gh.K20.confirm", "gh.K20.confirm"]);
  await t.close();
  const ro = await setup(["ops:read", "ops:write"]);
  assert.equal((await ro.confirm("act_000000000000")).status, 403);
  await ro.close();
});

test("T5.4 K20 confirm: the graph is looked up again at confirm; GodHome down is 503 and the token stays usable", async () => {
  const t = await setup();
  const id = (await t.post("/ops/gh/graphs/build/run")).json.actionId as string;
  t.gh.down = true;
  const down = await t.confirm(id);
  assert.deepEqual([down.status, down.json.error.code], [503, "unavailable"]);
  t.gh.down = false;
  assert.equal((await t.confirm(id, "k2")).status, 200);
  await t.close();
});

test("T5.4 K22 fire: the loop is resolved from its opaque id at prepare and confirm; a gone loop is 404", async () => {
  const t = await setup();
  assert.equal((await t.post("/ops/gh/loops/nope/fire")).status, 400);
  assert.equal((await t.post("/ops/gh/loops/g_000000000000/fire")).status, 404);
  const id = await t.loopId("nightly-check");
  const p = await t.post(`/ops/gh/loops/${id}/fire`);
  assert.deepEqual([p.status, p.json.kind, p.json.label], [200, "gh_trigger_fire", "nightly-check"]);
  assert.deepEqual(t.gh.writes, []);
  t.gh.bodies.triggers = { triggers: [] };
  const gone = await t.confirm(p.json.actionId);
  assert.deepEqual([gone.status, gone.json.error.code], [404, "not_found"]);
  t.gh.bodies.triggers = TRIGGERS;
  const ok = await t.confirm(p.json.actionId, "k-2");
  assert.equal(ok.status, 200);
  assert.deepEqual(t.gh.writes, [{ key: "triggerFire", args: { seg: ["t-1"] } }]);
  await t.close();
});

test("T5.4 K23 reset and K24 delete: ops:write, resolved server-side, audited; an {ok:false} from GodHome is 404", async () => {
  const t = await setup(["ops:read", "ops:write"]);
  const id = await t.loopId("nightly-check");
  assert.deepEqual((await t.post(`/ops/gh/loops/${id}/reset`)).json, { ok: true });
  assert.deepEqual(t.gh.writes.at(-1), { key: "triggerReset", args: { seg: ["t-1"] } });
  assert.deepEqual((await t.del(`/ops/gh/loops/${id}`)).json, { ok: true });
  assert.deepEqual(t.gh.writes.at(-1), { key: "triggerDelete", args: { seg: ["t-1"] } });
  t.gh.writeResult = () => ({ status: "ok", json: { ok: false } });
  assert.equal((await t.del(`/ops/gh/loops/${id}`)).status, 404);
  assert.equal((await t.post("/ops/gh/loops/g_000000000000/reset")).status, 404);
  assert.equal((await t.del("/ops/gh/loops/nope")).status, 400);
  assert.deepEqual(t.audits().map((a) => a.action), ["gh.K23", "gh.K24", "gh.K24", "gh.K23", "gh.K24"]);
  await t.close();
  const ro = await setup(["ops:read"]);
  assert.equal((await ro.post("/ops/gh/loops/g_000000000000/reset")).status, 403);
  assert.equal((await ro.del("/ops/gh/loops/g_000000000000")).status, 403);
  await ro.close();
});

test("T5.4 GodHome down: reads are 200 with reachable:false, writes 503", async () => {
  const t = await setup();
  t.gh.down = true;
  for (const p of ["/ops/gh/playbook", "/ops/gh/graphs", "/ops/gh/graphs/build", "/ops/gh/loops"]) {
    const r = await t.get(p);
    assert.deepEqual([p, r.status, r.json.reachable], [p, 200, false]);
  }
  t.gh.down = false;
  const id = await t.lessonId();
  t.gh.down = true;
  assert.equal((await t.post(`/ops/gh/playbook/${id}/approve`)).status, 503);
  await t.close();
});

test("T5.4 the module exports no way to the GodHome graph or trigger edit routes", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const src = readFileSync(__dirname + "/engine.ts", "utf8");
  assert.ok(!/"\/graphs"|generate|compile|upsert|projectsRefresh|quota/.test(src));
  void ghRoutes;
});
