import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { controlApp } from "../test-app";
import { OpsStore } from "../ops-store";
import type { Cap } from "../store";
import { GH_WRITES } from "./client";
import { GhIds } from "./ids";
import { ghKinds, type GhDeps } from "./index";
import { assertWithinExample, fakeGh, fixture } from "./test-support";

const godhome = { summary: async () => ({ reachable: true, data: {}, fetchedAt: 0 }), runs: async () => ({ reachable: true, data: [], fetchedAt: 0 }), run: async () => ({ reachable: true, data: {}, fetchedAt: 0 }), graph: async () => ({ reachable: true, data: {}, fetchedAt: 0 }) };

const FACTORY = {
  ok: true, root: "/root/factory",
  stages: ["auto", "plan", "build", "gate", "review", "fusion_plan", "fusion_review"], adws: ["auto", "sssf", "plan_build_test", "quick_build"],
  repos: [{ name: "demo-site", path: "/root/demo-site" }, { name: "api", path: "/root/api" }],
  kanban: {
    backlog: [{ file: "ticket-a.md", title: "Add a health check", repo: "/root/demo-site" }, { file: "ticket-b.md", title: "Fix /root/x/y bug sk-live-abcdefghijklmnop", repo: "/root/api" }],
    doing: [],
    done: [{ file: "ticket-c.md", title: "Old", repo: "/root/api" }],
  },
};
const LAUNCHES = { launches: [{ key: "L-one", pid: 99, started: 1_792_238_400_000, output: "secret output /root/x", runId: "run-1", exited: null, adopted: false }] };

async function setup(caps: Cap[] = ["ops:read", "ops:write", "ops:run"]) {
  const db = new Database(":memory:");
  const ops = new OpsStore(db);
  const gh = fakeGh();
  gh.bodies.factory = FACTORY;
  gh.bodies.factoryLaunches = LAUNCHES;
  const deps: GhDeps = { client: gh, ids: new GhIds(db), ops, allowlist: () => [], now: () => Date.now() };
  const t = await controlApp({ gh: deps, ops: { godhome, store: ops, kinds: ghKinds(deps) } as any }, db);
  t.store.setCaps(t.store.listDevices()[0]!.id, caps);
  const audits = () => db.prepare("SELECT action, subject, params, result FROM control_ops_audit ORDER BY id").all() as { action: string; subject: string; params: string; result: string }[];
  const confirm = (actionId: string, key = "k-" + actionId) => t.srv.call("POST", `/control-api/v1/ops/actions/${actionId}/confirm`, {}, { ...t.auth, "idempotency-key": key });
  const del = (p: string) => t.srv.call("DELETE", "/control-api/v1" + p, undefined, t.auth);
  const board = async () => (await t.get("/ops/gh/factory")).json;
  return { ...t, gh, deps, db, audits, confirm, del, board };
}

test("T5.5 K25 and K26 map to exactly the contract example's fields", async () => {
  const t = await setup(["ops:read"]);
  t.gh.bodies.factory = fixture("factory");
  t.gh.bodies.factoryLaunches = fixture("factory_launches");
  const k25 = await t.get("/ops/gh/factory");
  assert.equal(k25.status, 200);
  assertWithinExample("K25", k25.json);
  const k26 = await t.get("/ops/gh/factory/runs/run-1");
  assert.equal(k26.status, 200);
  assertWithinExample("K26", k26.json, ["roster[]", "roster[].name", "roster[].model"]);
  await t.close();
});

test("T5.5 factory: repo names, workflows, stages, runs, launches and cards with opaque ids; no paths, file or column names, output or pids", async () => {
  const t = await setup(["ops:read"]);
  const b = await t.board();
  assert.deepEqual(b.repos, [{ name: "demo-site" }, { name: "api" }]);
  assert.deepEqual(b.cards.map((c: any) => c.title), ["Add a health check", "Fix ... bug [redacted]", "Old"]);
  assert.ok(b.cards.every((c: any) => /^g_[0-9a-f]{12}$/.test(c.id) && /^g_[0-9a-f]{12}$/.test(c.column)));
  assert.equal(new Set(b.cards.map((c: any) => c.id)).size, 3);
  assert.deepEqual(b.columns.map((c: any) => c.count), [2, 0, 1]);
  assert.equal(b.cards[0].column, b.columns[0].id);
  assert.match(b.launches[0].id, /^g_[0-9a-f]{12}$/);
  assert.deepEqual(Object.keys(b.launches[0]).sort(), ["adopted", "id", "runId", "started"]);
  const dump = JSON.stringify(b);
  assert.ok(!/ticket-|backlog|doing|done"|\/root\/|secret output|"pid"|L-one|sk-live/.test(dump), dump);
  assert.deepEqual((await t.board()).cards.map((c: any) => c.id), b.cards.map((c: any) => c.id), "stable ids");
  await t.close();
});

test("T5.5 run detail: id, status, ticket, stage states, roster and timeline; no output, plan, review, diff, baseline, gate or file names", async () => {
  const t = await setup(["ops:read"]);
  t.gh.bodies.factoryRun = {
    id: "run-1", at: 1, running: false, ok: true, verdictPass: true, gate: "G", ticket: "Do the thing /root/app",
    stageStates: [{ stage: "plan", kind: "agent", state: "done", ok: true, ms: 5, summary: "S".repeat(10) + " /root/a/b", output: "BIG OUTPUT", findings: ["f"] }],
    diffStat: "3 files", plan: "# plan", review: "r", baseline: "abc", planMarkdown: "x", writeGlobs: ["/root/**"],
    roster: [{ name: "builder", model: "m", prompt: "P" }],
    envelopeTimeline: [{ phase: "plan", file: "whatsapp-media/x.md", status: "ok", approved: true, passed: true, summary: "ok" }],
  };
  const r = (await t.get("/ops/gh/factory/runs/run-1")).json;
  assert.deepEqual(Object.keys(r).sort(), ["fetchedAt", "id", "reachable", "roster", "running", "stageStates", "ticket", "timeline", "verdictPass"]);
  assert.deepEqual(Object.keys(r.stageStates[0]).sort(), ["kind", "ms", "ok", "stage", "state", "summary"]);
  assert.ok(!/BIG OUTPUT|# plan|3 files|baseline|writeGlobs|whatsapp-media|\/root\/|"prompt"|findings/.test(JSON.stringify(r)), JSON.stringify(r));
  assert.deepEqual(t.gh.reads.at(-1), { key: "factoryRun", params: { name: "run-1" }, fresh: false });
  assert.equal((await t.get("/ops/gh/factory/runs/a%20b")).status, 400);
  t.gh.bodies.factoryRun = null;
  assert.deepEqual([(await t.get("/ops/gh/factory/runs/run-9")).status], [404]);
  await t.close();
});

test("T5.5 K27 stop a launch and K29 delete a card: ops:write, opaque ids resolved server-side, audited; {ok:false} is 404", async () => {
  const ro = await setup(["ops:read"]);
  assert.equal((await ro.post("/ops/gh/factory/launches/g_000000000000/stop")).status, 403);
  assert.equal((await ro.del("/ops/gh/factory/cards/g_000000000000")).status, 403);
  await ro.close();
  const t = await setup();
  const b = await t.board();
  assert.equal((await t.post("/ops/gh/factory/launches/nope/stop")).status, 400);
  assert.equal((await t.post("/ops/gh/factory/launches/g_000000000000/stop")).status, 404);
  assert.deepEqual((await t.post(`/ops/gh/factory/launches/${b.launches[0].id}/stop`)).json, { ok: true });
  assert.deepEqual(t.gh.writes.at(-1), { key: "launchStop", args: { seg: ["L-one"] } });
  assert.deepEqual((await t.del(`/ops/gh/factory/cards/${b.cards[0].id}`)).json, { ok: true });
  assert.deepEqual(t.gh.writes.at(-1), { key: "cardDelete", args: { seg: ["backlog", "ticket-a.md"] } });
  t.gh.writeResult = () => ({ status: "ok", json: { ok: false } });
  assert.equal((await t.del(`/ops/gh/factory/cards/${b.cards[0].id}`)).status, 404);
  assert.equal((await t.del("/ops/gh/factory/cards/nope")).status, 400);
  assert.deepEqual(t.audits().map((a) => [a.action, a.result]), [["gh.K27", "bad_request"], ["gh.K27", "not_found"], ["gh.K27", "ok"], ["gh.K29", "ok"], ["gh.K29", "not_found"], ["gh.K29", "bad_request"]]);
  await t.close();
});

test("T5.5 K28 move a card: {to} is an opaque column id from K25; the names are resolved here", async () => {
  const t = await setup();
  const b = await t.board();
  const card = b.cards[0].id;
  const doing = b.columns[1].id;
  for (const body of [{}, { to: 5 }, { to: "doing" }, { to: "nope" }]) assert.equal((await t.post(`/ops/gh/factory/cards/${card}/move`, body)).status, 400, JSON.stringify(body));
  assert.equal((await t.post(`/ops/gh/factory/cards/${card}/move`, { to: "g_000000000000" })).status, 404);
  assert.equal((await t.post("/ops/gh/factory/cards/g_000000000000/move", { to: doing })).status, 404);
  assert.equal(t.gh.writes.length, 0);
  assert.deepEqual((await t.post(`/ops/gh/factory/cards/${card}/move`, { to: doing })).json, { ok: true });
  assert.deepEqual(t.gh.writes, [{ key: "cardMove", args: { seg: ["backlog", "ticket-a.md"], body: { to: "doing" } } }]);
  const ro = await setup(["ops:read"]);
  assert.equal((await ro.post("/ops/gh/factory/cards/g_000000000000/move", { to: "g_000000000000" })).status, 403);
  await ro.close();
  await t.close();
});

test("T5.5 K30 prepare: ops:run, ticket 1..2000, a repo K25 returned, known stages and workflow; unknown keys and merge:true are dropped", async () => {
  const w = await setup(["ops:read", "ops:write"]);
  assert.equal((await w.post("/ops/gh/factory/run", { ticket: "t", repo: "api" })).status, 403);
  await w.close();
  const t = await setup();
  for (const body of [{}, { ticket: "", repo: "api" }, { ticket: "   ", repo: "api" }, { ticket: "x".repeat(2001), repo: "api" }, { ticket: "t" }, { ticket: "t", repo: 5 }, { ticket: "t", repo: "api", stages: "plan,bogus" }, { ticket: "t", repo: "api", stages: 5 }, { ticket: "t", repo: "api", adw: "evil" }]) {
    const r = await t.post("/ops/gh/factory/run", body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await t.post("/ops/gh/factory/run", { ticket: "t", repo: "not-a-repo" })).status, 404);
  const ok = await t.post("/ops/gh/factory/run", { ticket: "Add a health check", repo: "demo-site", stages: "plan,build,gate", adw: "auto", merge: true, architect: "x" });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.json.kind, ok.json.label], ["gh_factory_run", "demo-site"]);
  assert.deepEqual(Object.keys(ok.json).sort(), ["actionId", "expiresAt", "kind", "label"]);
  assert.deepEqual(t.gh.writes, [], "nothing reaches GodHome at prepare");
  const row = t.db.prepare("SELECT payload FROM control_action_payloads WHERE action_id = ?").get(ok.json.actionId) as { payload: string };
  assert.deepEqual(JSON.parse(row.payload), { ticket: "Add a health check", repo: "demo-site", stages: "plan,build,gate", adw: "auto" });
  await t.close();
});

test("T5.5 K30 confirm: one GodHome run with the allowlisted body and merge false; the audit row keeps no ticket text; 3 runs per 10 min", async () => {
  const t = await setup();
  t.gh.writeResult = () => ({ status: "ok", json: { ok: true, runId: "run-42", launchKey: "L-9" } });
  const prep = async (ticket = "Fix it with sk-live-abcdefghijklmnop please") => (await t.post("/ops/gh/factory/run", { ticket, repo: "api", merge: true })).json.actionId as string;
  const id = await prep();
  const c1 = await t.confirm(id);
  assert.deepEqual([c1.status, c1.json], [200, { ok: true, runId: "run-42" }]);
  const sent = t.gh.writes.at(-1)!;
  assert.equal(sent.key, "factoryRun");
  assert.deepEqual(sent.args.body, { ticket: "Fix it with sk-live-abcdefghijklmnop please", repo: "api" });
  assert.equal((GH_WRITES.factoryRun.body(sent.args.body) as any).merge, false);
  assert.deepEqual((await t.confirm(id)).json, c1.json, "replay");
  assert.equal(t.gh.writes.length, 1);
  const audit = t.audits().find((a) => a.action === "gh.K30.confirm")!;
  assert.ok(!/sk-live/.test(audit.params), audit.params);
  assert.deepEqual([JSON.parse(audit.params).repo, JSON.parse(audit.params).len], ["api", "Fix it with sk-live-abcdefghijklmnop please".length]);
  assert.equal((await t.confirm(await prep("two"))).status, 200);
  assert.equal((await t.confirm(await prep("three"))).status, 200);
  const fourth = await t.confirm(await prep("four"));
  assert.deepEqual([fourth.status, fourth.json.error.code], [429, "rate_limited"]);
  assert.equal(t.gh.writes.length, 3);
  await t.close();
});

test("T5.5 K30 confirm: the repo is looked up again; GodHome down is 503 with the token intact; GodHome refusing is 409", async () => {
  const t = await setup();
  const id = (await t.post("/ops/gh/factory/run", { ticket: "t", repo: "api" })).json.actionId as string;
  t.gh.bodies.factory = { ...FACTORY, repos: [{ name: "demo-site" }] };
  const gone = await t.confirm(id);
  assert.deepEqual([gone.status, gone.json.error.code], [404, "not_found"]);
  t.gh.bodies.factory = FACTORY;
  t.gh.down = true;
  assert.equal((await t.confirm(id, "k2")).status, 503);
  t.gh.down = false;
  t.gh.writeResult = () => ({ status: "rejected" });
  const refused = await t.confirm(id, "k3");
  assert.deepEqual([refused.status, refused.json.error.code], [409, "conflict"]);
  await t.close();
});

test("T5.5 GodHome down: reads are 200 with reachable:false and empty lists, writes 503", async () => {
  const t = await setup();
  const b = await t.board();
  t.gh.down = true;
  const d = await t.get("/ops/gh/factory");
  assert.deepEqual([d.status, d.json.reachable, d.json.cards, d.json.runs], [200, false, [], []]);
  assert.equal((await t.get("/ops/gh/factory/runs/run-1")).json.reachable, false);
  assert.equal((await t.post(`/ops/gh/factory/launches/${b.launches[0].id}/stop`)).status, 503);
  assert.equal((await t.post("/ops/gh/factory/run", { ticket: "t", repo: "api" })).status, 503);
  await t.close();
});

test("T5.5 reads need ops:read; the module has no new-card route and never asks for the projects refresh", async () => {
  const t = await setup([]);
  assert.equal((await t.get("/ops/gh/factory")).status, 403);
  assert.equal((await t.get("/ops/gh/factory/runs/run-1")).status, 403);
  await t.close();
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(__dirname + "/factory.ts", "utf8");
  assert.ok(!/projectsRefresh|kanban"|createCard|\/factory\/kanban\b(?!\/)/.test(src));
});
