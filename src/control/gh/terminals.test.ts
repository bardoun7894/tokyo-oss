import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { controlApp } from "../test-app";
import { OpsStore } from "../ops-store";
import type { Cap } from "../store";
import { GhIds } from "./ids";
import { ghKinds, type GhDeps } from "./index";
import { assertWithinExample, fakeGh, fixture } from "./test-support";

const godhome = { summary: async () => ({ reachable: true, data: {}, fetchedAt: 0 }), runs: async () => ({ reachable: true, data: [], fetchedAt: 0 }), run: async () => ({ reachable: true, data: {}, fetchedAt: 0 }), graph: async () => ({ reachable: true, data: {}, fetchedAt: 0 }) };
const NOW = Date.parse("2026-10-17T13:00:00Z");

const SESSIONS = { sessions: [
  { name: "kb-dev-tokyo", windows: 2, attached: true, backend: "tmux", created: String(Math.floor(NOW / 1000) - 3600), activity: "1", panes: [{ id: "%1", session: "kb-dev-tokyo", command: "claude --token sk-x", cwd: "/root/tokyo", pid: 5, active: true, width: 80, height: 24 }] },
  { name: "/root/work/herdr-ws", windows: 1, attached: false, backend: "herdr", created: "not a time", panes: [] },
  { name: "plain", windows: 1, attached: false, panes: [{ id: "%2", cwd: "/root/x/y" }, { id: "%3" }] },
] };

async function setup(caps: Cap[] = ["ops:read", "ops:service"]) {
  const db = new Database(":memory:");
  const ops = new OpsStore(db);
  const gh = fakeGh();
  gh.bodies.tmuxSessions = SESSIONS;
  const deps: GhDeps = { client: gh, ids: new GhIds(db), ops, allowlist: () => [], now: () => NOW };
  const t = await controlApp({ gh: deps, ops: { godhome, store: ops, kinds: ghKinds(deps), now: () => NOW } as any, now: () => NOW } as any, db);
  t.store.setCaps(t.store.listDevices()[0]!.id, caps);
  const audits = () => db.prepare("SELECT action, subject, params, result FROM control_ops_audit ORDER BY id").all() as { action: string; subject: string; params: string; result: string }[];
  const confirm = (actionId: string, key = "k-" + actionId) => t.srv.call("POST", `/control-api/v1/ops/actions/${actionId}/confirm`, {}, { ...t.auth, "idempotency-key": key });
  const sessions = async () => (await t.get("/ops/gh/terminals")).json.sessions as any[];
  return { ...t, gh, deps, db, audits, confirm, sessions };
}

test("T5.7 K35 maps to exactly the contract example's fields", async () => {
  const t = await setup();
  t.gh.bodies.tmuxSessions = fixture("tmux_sessions");
  const r = await t.get("/ops/gh/terminals");
  assert.equal(r.status, 200);
  assertWithinExample("K35", r.json, ["sessions[].ageS"]);
  await t.close();
});

test("T5.7 the list has opaque id, base name, kind, age, attached, windows and a pane count: no output, cwd, command, pid or pane ids", async () => {
  const t = await setup(["ops:read"]);
  const s = await t.sessions();
  assert.deepEqual(s.map((x) => x.name), ["kb-dev-tokyo", "herdr-ws", "plain"]);
  assert.deepEqual(s.map((x) => x.kind), ["tmux", "herdr", undefined]);
  assert.deepEqual(s.map((x) => x.ageS), [3600, undefined, undefined]);
  assert.deepEqual(s.map((x) => [x.attached, x.windows, x.panes]), [[true, 2, 1], [false, 1, 0], [false, 1, 2]]);
  assert.ok(s.every((x) => /^g_[0-9a-f]{12}$/.test(x.id)));
  const dump = JSON.stringify(s);
  assert.ok(!/cwd|command|sk-x|\/root\/|"pid"|%1|activity|width/.test(dump), dump);
  assert.deepEqual((await t.sessions()).map((x) => x.id), s.map((x) => x.id), "stable ids");
  await t.close();
});

test("T5.7 K36 prepare: ops:service, an id Tokyo issued, a session that exists now; nothing is sent to GodHome", async () => {
  const no = await setup(["ops:read", "ops:write", "ops:run"]);
  assert.equal((await no.post("/ops/gh/terminals/g_000000000000/kill")).status, 403);
  await no.close();
  const t = await setup();
  const [first] = await t.sessions();
  assert.equal((await t.post("/ops/gh/terminals/nope/kill")).status, 400);
  assert.equal((await t.post("/ops/gh/terminals/g_000000000000/kill")).status, 404);
  const ok = await t.post(`/ops/gh/terminals/${first!.id}/kill`);
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.json).sort(), ["actionId", "expiresAt", "kind", "label"]);
  assert.deepEqual([ok.json.kind, ok.json.label], ["terminal_kill", "kb-dev-tokyo"]);
  assert.deepEqual(t.gh.writes, []);
  t.gh.bodies.tmuxSessions = { sessions: [] };
  assert.equal((await t.post(`/ops/gh/terminals/${first!.id}/kill`)).status, 404, "the session is gone");
  t.gh.down = true;
  assert.equal((await t.post(`/ops/gh/terminals/${first!.id}/kill`)).status, 503);
  assert.deepEqual(t.audits().map((a) => [a.action, a.result]), [["gh.K36", "bad_request"], ["gh.K36", "not_found"], ["gh.K36", "ok"], ["gh.K36", "not_found"], ["gh.K36", "unavailable"]]);
  await t.close();
});

test("T5.7 K36 confirm (X16): the session name is resolved server-side against a fresh list, then one kill; replay does not kill twice", async () => {
  const t = await setup();
  const [first] = await t.sessions();
  const id = (await t.post(`/ops/gh/terminals/${first!.id}/kill`)).json.actionId as string;
  const reads = t.gh.reads.length;
  const c1 = await t.confirm(id);
  assert.deepEqual([c1.status, c1.json], [200, { ok: true }]);
  assert.deepEqual(t.gh.reads.slice(reads).map((r) => [r.key, r.fresh]), [["tmuxSessions", true]]);
  assert.deepEqual(t.gh.writes, [{ key: "terminalKill", args: { seg: ["kb-dev-tokyo"] } }]);
  assert.deepEqual((await t.confirm(id)).json, c1.json);
  assert.equal(t.gh.writes.length, 1);
  assert.equal((await t.confirm(id, "other")).status, 409, "a spent token");
  assert.deepEqual(t.audits().find((a) => a.action === "gh.K36.confirm"), { action: "gh.K36.confirm", subject: id, params: JSON.stringify({ session: first!.id }), result: "ok" });
  await t.close();
});

test("T5.7 K36 confirm: a session that is gone is 404, GodHome down is 503 with the token intact, {ok:false} is 404, ops:service is needed", async () => {
  const t = await setup();
  const [first] = await t.sessions();
  const id = (await t.post(`/ops/gh/terminals/${first!.id}/kill`)).json.actionId as string;
  t.gh.bodies.tmuxSessions = { sessions: [] };
  assert.deepEqual([(await t.confirm(id)).status], [404]);
  t.gh.bodies.tmuxSessions = SESSIONS;
  t.gh.down = true;
  assert.equal((await t.confirm(id, "k2")).status, 503);
  t.gh.down = false;
  t.gh.writeResult = () => ({ status: "ok", json: { ok: false } });
  assert.equal((await t.confirm(id, "k3")).status, 404);
  await t.close();
  const ro = await setup(["ops:read", "ops:write"]);
  assert.equal((await ro.confirm("act_000000000000")).status, 403);
  await ro.close();
});

test("T5.7 the module has exactly one write path (kill) and no tmux send, key or output string anywhere", () => {
  for (const f of ["terminals.ts", "../actions/kinds/terminal_kill.ts"]) {
    const src = readFileSync(__dirname + "/" + f, "utf8");
    assert.ok(!/tmux\/(send|key|output|resize|interrupt)|sendKeys|send-keys/.test(src), f);
    assert.ok(!/write\(\s*"(?!terminalKill)/.test(src), f);
  }
  const all = ["terminals.ts", "../actions/kinds/terminal_kill.ts"].map((f) => readFileSync(__dirname + "/" + f, "utf8")).join("\n");
  assert.equal((all.match(/\.write\(/g) ?? []).length, 1);
  assert.equal((all.match(/"terminalKill"/g) ?? []).length, 1);
});

test("T5.7 GodHome down: the list is 200 with reachable:false; reads need ops:read", async () => {
  const t = await setup();
  t.gh.down = true;
  const r = await t.get("/ops/gh/terminals");
  assert.deepEqual([r.status, r.json.reachable, r.json.sessions], [200, false, []]);
  await t.close();
  const none = await setup([]);
  assert.equal((await none.get("/ops/gh/terminals")).status, 403);
  await none.close();
});

test("F4 K36: tokyo-run-* and the sessions Tokyo depends on are refused with 403 forbidden at prepare and at confirm; nothing is killed", async () => {
  const t = await setup();
  t.gh.bodies.tmuxSessions = { sessions: [
    { name: "tokyo-run-1a2b3c4d", backend: "herdr", windows: 1, panes: [] },
    { name: "/root/ws/tokyo-run-9f", backend: "herdr", windows: 1, panes: [] },
    { name: "tokyo", backend: "tmux", windows: 1, panes: [] },
    { name: "kb-dev-tokyo", backend: "tmux", windows: 1, panes: [] },
  ] };
  const list = await t.sessions();
  const id = (name: string) => list.find((s) => s.name === name)!.id as string;
  for (const name of ["tokyo-run-1a2b3c4d", "tokyo-run-9f", "tokyo"]) {
    const r = await t.post(`/ops/gh/terminals/${id(name)}/kill`);
    assert.equal(r.status, 403, name);
    assert.equal(r.json.error.code, "forbidden", name);
  }
  // A token prepared while the name was ordinary cannot kill it once the same id names a protected session.
  const ok = await t.post(`/ops/gh/terminals/${id("kb-dev-tokyo")}/kill`);
  assert.equal(ok.status, 200);
  t.gh.bodies.tmuxSessions = { sessions: [{ name: "kb-dev-tokyo", backend: "tmux", windows: 1, panes: [] }] };
  assert.equal((await t.confirm(ok.json.actionId)).status, 200);
  assert.deepEqual(t.gh.writes.map((w) => w.args), [{ seg: ["kb-dev-tokyo"] }]);
  await t.close();
});

test("F4 K36 confirm: a protected name is refused 403 before the kill even if prepare let it through", async () => {
  const t = await setup();
  t.gh.bodies.tmuxSessions = { sessions: [{ name: "tokyo-run-1a2b3c4d", backend: "herdr", windows: 1, panes: [] }] };
  const [s] = await t.sessions();
  // Prepare directly through the token store, as an older build (before the guard) would have.
  const { prepareToken } = await import("../actions/tokens");
  const p = prepareToken(t.deps.ops, { kind: "terminal_kill", deviceId: t.store.listDevices()[0]!.id, subject: s.id, targetId: s.id, now: NOW });
  const c = await t.confirm(p.actionId);
  assert.equal(c.status, 403);
  assert.equal(c.json.error.code, "forbidden");
  assert.equal(t.gh.writes.length, 0);
  await t.close();
});
