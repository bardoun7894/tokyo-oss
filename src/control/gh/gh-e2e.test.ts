import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { controlApp } from "../test-app";
import { OpsStore } from "../ops-store";
import { CAPS, type Cap } from "../store";
import { GhIds } from "./ids";
import { ghKinds, type GhDeps } from "./index";
import { wireGh } from "./wire";
import { example, fakeGh } from "./test-support";

// Every K route (K1..K36) through the real Control router with a fake GodHome (spec 012 T5.8).

const godhome = { summary: async () => ({ reachable: true, data: {}, fetchedAt: 0 }), runs: async () => ({ reachable: true, data: [], fetchedAt: 0 }), run: async () => ({ reachable: true, data: {}, fetchedAt: 0 }), graph: async () => ({ reachable: true, data: {}, fetchedAt: 0 }) };
const ROUTES: { id: string; method: string; path: string; cap: string }[] = JSON.parse(readFileSync(__dirname + "/../../../specs/012-full-control/contract-examples-gh.json", "utf8")).routes.filter((r: any) => /^K\d+$/.test(r.id));

const PLAYBOOK = { pending: [{ id: "L-001", graph: "build", drafted: "2026-10-17T12:00:00.000Z", text: "Run the gate." }], approved: [] };
const TRIGGERS = { triggers: [{ id: "t-1", graph: "nightly-check", kind: "cron", enabled: true, cron: "0 3 * * *", maxRuns: 10, maxCalls: 100, runs: 4, calls: 12 }] };
const INBOX = { items: [{ kind: "failed-run", title: "nightly-check", at: "2026-10-17T12:00:00.000Z", runId: "run-0123" }] };
const FACTORY = { stages: ["plan", "build"], adws: ["auto"], repos: [{ name: "api" }], kanban: { backlog: [{ file: "a.md", title: "A" }], doing: [] } };
const LAUNCHES = { launches: [{ key: "L-one", runId: "run-1", started: 1, exited: null, adopted: false }] };
const SESSIONS = { sessions: [{ name: "kb-dev-x", windows: 1, attached: false, backend: "tmux", panes: [] }] };
const MODELS = { counts: { total: 1 }, yours: [], free: [{ id: "opencode/big-free", provider: "opencode", enabled: false, free: true, cost: {} }], paid: [] };

async function setup(caps: readonly Cap[] = CAPS) {
  const db = new Database(":memory:");
  const ops = new OpsStore(db);
  const gh = fakeGh();
  Object.assign(gh.bodies, { playbook: PLAYBOOK, triggers: TRIGGERS, inbox: INBOX, factory: FACTORY, factoryLaunches: LAUNCHES, tmuxSessions: SESSIONS, models: MODELS });
  const deps: GhDeps = wireGh(db, ops, gh, () => [], undefined);
  const t = await controlApp({ gh: deps, ops: { godhome, store: ops, kinds: ghKinds(deps) } as any }, db);
  t.store.setCaps(t.store.listDevices()[0]!.id, caps);
  const audits = () => db.prepare("SELECT action, result FROM control_ops_audit ORDER BY id").all() as { action: string; result: string }[];
  const del = (p: string) => t.srv.call("DELETE", "/control-api/v1" + p, undefined, t.auth);
  const call = (method: string, p: string, body: unknown = {}) => (method === "GET" ? t.get(p) : method === "DELETE" ? del(p) : t.post(p, body));
  return { ...t, gh, deps, db, audits, call };
}

/** The ids the write routes take, read from the lists the phone would read them from. */
async function ids(t: Awaited<ReturnType<typeof setup>>) {
  const loop = (await t.get("/ops/gh/loops")).json.loops[0].id as string;
  const lesson = (await t.get("/ops/gh/playbook")).json.pending[0].id as string;
  const inbox = (await t.get("/ops/gh/inbox")).json.items[0].id as string;
  const f = (await t.get("/ops/gh/factory")).json;
  const term = (await t.get("/ops/gh/terminals")).json.sessions[0].id as string;
  return { loop, lesson, inbox, launch: f.launches[0].id as string, card: f.cards[0].id as string, to: f.columns[1].id as string, term };
}

const SUB = (path: string, x: Awaited<ReturnType<typeof ids>> | null): string => path
  .replace("/playbook/:id", `/playbook/${x?.lesson ?? "g_000000000000"}`).replace("/loops/:id", `/loops/${x?.loop ?? "g_000000000000"}`)
  .replace("/inbox/:id", `/inbox/${x?.inbox ?? "g_000000000000"}`).replace("/launches/:id", `/launches/${x?.launch ?? "g_000000000000"}`)
  .replace("/cards/:id", `/cards/${x?.card ?? "g_000000000000"}`).replace("/terminals/:id", `/terminals/${x?.term ?? "g_000000000000"}`)
  .replace("/graphs/:name", "/graphs/build").replace("/runs/:id", "/runs/run-1").replace("/models/:id", "/models/opencode%2Fbig-free");

test("T5.8 the contract lists K1..K36, and every one of them is mounted (none falls through to the router's 404)", async () => {
  assert.equal(ROUTES.length, 36);
  const t = await setup();
  for (const r of ROUTES) {
    const res = await t.call(r.method, SUB(r.path, null), r.method === "POST" ? { enabled: true, to: "g_000000000000", ticket: "t", repo: "api" } : {});
    assert.ok(!(res.status === 404 && res.json?.error?.message === "Not found"), `${r.id} ${r.method} ${r.path} is not mounted`);
    assert.notEqual(res.status, 501, r.id);
    assert.notEqual(res.status, 500, r.id);
  }
  await t.close();
});

test("T5.8 reads: all 20 GET routes answer 200 with reachable:true, and 200 with reachable:false when GodHome is down", async () => {
  const gets = ROUTES.filter((r) => r.method === "GET");
  assert.equal(gets.length, 20);
  const t = await setup();
  const x = await ids(t);
  for (const r of gets) {
    const up = await t.get(SUB(r.path, x));
    assert.deepEqual([r.id, up.status, up.json.reachable], [r.id, 200, true]);
  }
  t.gh.down = true;
  for (const r of gets) {
    const down = await t.get(SUB(r.path, x));
    assert.deepEqual([r.id, down.status, down.json.reachable], [r.id, 200, false]);
  }
  await t.close();
});

test("T5.8 writes: every write and prepare route is 503 when GodHome is down, and each of the 16 answered 200 and left a gh.K audit row when it was up", async () => {
  const writes = ROUTES.filter((r) => r.method !== "GET");
  assert.equal(writes.length, 16);
  const t = await setup();
  const x = await ids(t);
  const body = (id: string) => (id === "K28" ? { to: x.to } : id === "K32" ? { enabled: true } : id === "K30" ? { ticket: "Add a check", repo: "api" } : {});
  // Down first (nothing is spent: a refresh route's limit counts requests, so it is checked once up and once down on a fresh app).
  t.gh.down = true;
  for (const r of writes.filter((w) => !["K5", "K7", "K11"].includes(w.id))) {
    const res = await t.call(r.method, SUB(r.path, x), body(r.id));
    assert.deepEqual([r.id, res.status], [r.id, 503]);
  }
  t.gh.down = false;
  for (const r of writes) {
    const res = await t.call(r.method, SUB(r.path, x), body(r.id));
    assert.deepEqual([r.id, res.status], [r.id, 200]);
  }
  const rows = t.audits();
  for (const r of writes) assert.ok(rows.some((a) => a.action === `gh.${r.id}` && a.result === "ok"), `${r.id} has an ok audit row`);
  const down = await setup();
  down.gh.down = true;
  for (const id of ["/ops/gh/network/refresh", "/ops/gh/endpoints/refresh", "/ops/gh/control/sites/refresh"]) assert.equal((await down.post(id)).status, 503, id);
  await down.close();
  await t.close();
});

test("T5.8 capabilities: ops:read alone reaches the 20 reads and none of the 16 writes (403 before anything runs)", async () => {
  const t = await setup(["ops:read"]);
  for (const r of ROUTES) {
    const res = await t.call(r.method, SUB(r.path, null), {});
    if (r.method === "GET") assert.equal(res.status, 200, r.id);
    else assert.deepEqual([r.id, res.status], [r.id, 403]);
  }
  assert.deepEqual(t.gh.writes, []);
  assert.deepEqual(t.audits(), []);
  await t.close();
});

test("T5.8 the cap of every route is the contract's: write 403s name the cap the route needs", async () => {
  const t = await setup(["ops:read"]);
  for (const r of ROUTES.filter((x) => x.method !== "GET")) {
    const res = await t.call(r.method, SUB(r.path, null), {});
    assert.match(res.json.error.message, new RegExp(r.cap.replace(":", ":")), r.id);
  }
  await t.close();
});

test("T5.8 the four fingerprint kinds are registered with the caps of the contract, and production wiring hands them to X16", () => {
  const db = new Database(":memory:");
  const kinds = ghKinds(wireGh(db, new OpsStore(db), fakeGh(), () => [], undefined));
  assert.deepEqual(kinds.map((k) => [k.name, k.cap, k.confirmAction]), [
    ["gh_graph_run", "ops:run", "gh.K20.confirm"], ["gh_trigger_fire", "ops:run", "gh.K22.confirm"],
    ["gh_factory_run", "ops:run", "gh.K30.confirm"], ["terminal_kill", "ops:service", "gh.K36.confirm"],
  ]);
  const src = readFileSync(__dirname + "/../wiring.ts", "utf8");
  assert.match(src, /kinds: \[\.\.\.agents\.kinds, \.\.\.ghKinds\(gh\)\]/);
  assert.match(src, /gh,\n/);
});

test("T5.8 no reply of the fake GodHome area carries a path, a host address or a credential", async () => {
  const t = await setup();
  const x = await ids(t);
  const FORBIDDEN = [/\/home\//, /\/root\//, /\/var\//, /\/usr\//, /\/srv\//, /sk-/, /tk_/, /Bearer/, /cwd/, /"output"/, /"input"/, /\b\d{1,3}(?:\.\d{1,3}){3}\b/, /\.ts\.net|sslip\.io|localhost/];
  for (const r of ROUTES.filter((q) => q.method === "GET")) {
    const text = JSON.stringify((await t.get(SUB(r.path, x))).json);
    for (const re of FORBIDDEN) assert.ok(!re.test(text), `${r.id} matches ${re}`);
  }
  await t.close();
});

test("T5.8 the example file and the routes agree: each K example has a method, a path and a cap", () => {
  for (const r of ROUTES) {
    assert.match(r.path, /^\/ops\/gh\//, r.id);
    assert.ok(["GET", "POST", "DELETE"].includes(r.method), r.id);
    assert.ok((CAPS as readonly string[]).includes(r.cap), r.id);
  }
  assert.ok(example("K1"));
  void GhIds;
});
