import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { controlApp } from "../test-app";
import { OpsStore } from "../ops-store";
import { prepareToken } from "./tokens";
import type { ActionKind } from "./confirm";
import type { Cap } from "../store";
import { TOKEN_TTL_MS } from "./tokens";

const godhome = { summary: async () => ({ reachable: true, data: {}, fetchedAt: 0 }), runs: async () => ({ reachable: true, data: [], fetchedAt: 0 }), run: async () => ({ reachable: true, data: {}, fetchedAt: 0 }), graph: async () => ({ reachable: true, data: {}, fetchedAt: 0 }) };

function kind(name: string, cap: Cap, over: Partial<ActionKind> = {}, calls: any[] = []): ActionKind {
  return {
    name, cap, confirmAction: `${name}.confirm`,
    check: () => null,
    run: async (ctx) => { calls.push({ kind: name, payload: ctx.payload, subject: ctx.token.subject }); return { ok: true, result: "ok", detail: "", body: { ok: true, n: calls.length } }; },
    ...over,
  };
}

async function setup(kinds: ActionKind[], caps?: Cap[]) {
  const db = new Database(":memory:");
  const ops = new OpsStore(db);
  const t = await controlApp({ ops: { godhome, store: ops, kinds } as any }, db);
  const dev = t.store.listDevices()[0]!;
  if (caps) t.store.setCaps(dev.id, caps);
  const confirm = (id: string, key: string | null = "k1", auth = t.auth) =>
    t.srv.call("POST", `/control-api/v1/ops/actions/${id}/confirm`, {}, { ...auth, ...(key ? { "idempotency-key": key } : {}) });
  const prep = (k: string, over: Record<string, unknown> = {}) =>
    prepareToken(ops, { kind: k, deviceId: dev.id, subject: "subj", targetId: "tgt", now: Date.now(), ...over } as any);
  const audit = () => (db.prepare("SELECT action, subject, result FROM control_ops_audit ORDER BY id").all() as any[]).map((r) => `${r.action}:${r.result}`);
  return { ...t, db, ops, dev, confirm, prep, audit };
}

test("the confirm route is mounted from kinds alone, without a restart allowlist", async () => {
  const calls: any[] = [];
  const t = await setup([kind("a", "agents:start", {}, calls)], ["ops:read", "agents:start"]);
  const p = t.prep("a");
  const r = await t.confirm(p.actionId);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json, { ok: true, n: 1 });
  assert.equal(calls.length, 1);
  assert.deepEqual(t.audit(), ["a.confirm:ok"]);
  await t.close();
});

test("a token of kind A cannot be confirmed by a device lacking A's cap: 403, nothing runs, the token stays usable", async () => {
  const calls: any[] = [];
  const t = await setup([kind("a", "agents:start", {}, calls), kind("b", "ops:run", {}, calls)], ["ops:read", "ops:run"]);
  const p = t.prep("a");
  const r = await t.confirm(p.actionId);
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, "forbidden");
  assert.equal(calls.length, 0);
  assert.equal(t.ops.getActionToken(p.actionId)!.usedAt, null);
  t.store.setCaps(t.dev.id, ["ops:read", "agents:start"]);
  assert.equal((await t.confirm(p.actionId, "k2")).status, 200);
  await t.close();
});

test("a device holding none of the confirmable caps gets 403 even for an unknown action", async () => {
  const t = await setup([kind("a", "agents:start")], ["ops:read"]);
  assert.equal((await t.confirm("act_00000000ffff")).status, 403);
  await t.close();
});

test("an unknown kind is 409 and runs nothing", async () => {
  const calls: any[] = [];
  const t = await setup([kind("a", "agents:start", {}, calls)], ["agents:start"]);
  const p = t.prep("zzz");
  const r = await t.confirm(p.actionId);
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, "conflict");
  assert.equal(calls.length, 0);
  await t.close();
});

test("the payload reaches run, is deleted on use and the token is single use", async () => {
  const calls: any[] = [];
  const t = await setup([kind("a", "agents:start", {}, calls)], ["agents:start"]);
  const p = t.prep("a", { payload: { prompt: "hello" } });
  assert.equal((await t.confirm(p.actionId)).status, 200);
  assert.deepEqual(calls[0].payload, { prompt: "hello" });
  assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM control_action_payloads").get() as any).n, 0);
  const again = await t.confirm(p.actionId, "k-other");
  assert.equal(again.status, 409);
  assert.equal(calls.length, 1);
  await t.close();
});

test("a payload that no longer matches its hash runs nothing", async () => {
  const calls: any[] = [];
  const t = await setup([kind("a", "agents:start", {}, calls)], ["agents:start"]);
  const p = t.prep("a", { payload: { prompt: "hello" } });
  t.db.prepare("UPDATE control_action_payloads SET payload = ? WHERE action_id = ?").run(JSON.stringify({ prompt: "evil" }), p.actionId);
  const r = await t.confirm(p.actionId);
  assert.equal(r.status, 409);
  assert.equal(calls.length, 0);
  await t.close();
});

test("a replayed Idempotency-Key returns the stored result of its kind; a key reused for another action is 409", async () => {
  const calls: any[] = [];
  const t = await setup([kind("a", "agents:start", {}, calls), kind("b", "agents:start", {}, calls)], ["agents:start"]);
  const pa = t.prep("a");
  const pb = t.prep("b");
  const first = await t.confirm(pa.actionId, "same");
  assert.equal(first.status, 200);
  const replay = await t.confirm(pa.actionId, "same");
  assert.deepEqual(replay.json, first.json);
  assert.equal(calls.length, 1);
  const other = await t.confirm(pb.actionId, "same");
  assert.equal(other.status, 409, "a key stored for kind a does not confirm another action");
  const own = await t.confirm(pb.actionId, "other-key");
  assert.equal(own.status, 200);
  const keyB = await t.confirm(pb.actionId, "other-key");
  assert.deepEqual(keyB.json, own.json);
  assert.equal(calls.length, 2);
  await t.close();
});

test("expired, other device's, bad id and missing key", async () => {
  const t = await setup([kind("a", "agents:start")], ["agents:start"]);
  const stale = t.prep("a", { now: Date.now() - 200_000 });
  const r = await t.confirm(stale.actionId);
  assert.equal(r.status, 409);
  assert.match(r.json.error.message, /expired/);
  const foreign = prepareToken(t.ops, { kind: "a", deviceId: "d_ffffffff", subject: "s", targetId: "t", now: Date.now() });
  assert.equal((await t.confirm(foreign.actionId)).status, 404);
  assert.equal((await t.confirm("act_nothex")).status, 400);
  assert.equal((await t.confirm(t.prep("a").actionId, null)).status, 400);
  await t.close();
});

test("F2: a token that expires while the awaited check runs is not consumed and nothing runs", async () => {
  const calls: any[] = [];
  const slow = kind("a", "agents:start", { check: () => new Promise((r) => setTimeout(() => r(null), 300)) }, calls);
  const t = await setup([slow], ["agents:start"]);
  const p = t.prep("a", { now: Date.now() - (TOKEN_TTL_MS - 100) }); // still valid when the confirm starts, gone 100 ms later
  const r = await t.confirm(p.actionId);
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(calls.length, 0);
  assert.equal(t.ops.getActionToken(p.actionId)!.usedAt, null);
  await t.close();
});

test("a refusal from check is returned with Retry-After and does not consume the token", async () => {
  const calls: any[] = [];
  let limited = true;
  const t = await setup([kind("a", "agents:start", { check: () => (limited ? { status: 429, code: "rate_limited", message: "slow down", retryAfterSec: 42 } : null) }, calls)], ["agents:start"]);
  const p = t.prep("a");
  const r = await t.confirm(p.actionId);
  assert.equal(r.status, 429);
  assert.equal(r.headers["retry-after"], "42");
  assert.equal(t.ops.getActionToken(p.actionId)!.usedAt, null);
  limited = false;
  assert.equal((await t.confirm(p.actionId, "k2")).status, 200);
  assert.deepEqual(t.audit(), ["a.confirm:rate_limited", "a.confirm:ok"]);
  await t.close();
});

test("a failing run is audited as failed and its body stored for replay", async () => {
  const t = await setup([kind("a", "agents:start", { run: async () => ({ ok: false, result: "failed", detail: "boom", body: { ok: false } }) })], ["agents:start"]);
  const p = t.prep("a");
  const r = await t.confirm(p.actionId, "kf");
  assert.deepEqual(r.json, { ok: false });
  assert.deepEqual(t.audit(), ["a.confirm:failed"]);
  assert.deepEqual((await t.confirm(p.actionId, "kf")).json, { ok: false });
  await t.close();
});
