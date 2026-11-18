import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { controlApp } from "../test-app";
import { OpsStore } from "../ops-store";
import { GhIds } from "../gh/ids";
import { GhClient } from "../gh/client";
import { buildAgents } from "./wire";
import type { Cap } from "../store";

const godhome = { summary: async () => ({ reachable: true, data: {}, fetchedAt: 0 }), runs: async () => ({ reachable: true, data: [], fetchedAt: 0 }), run: async () => ({ reachable: true, data: {}, fetchedAt: 0 }), graph: async () => ({ reachable: true, data: {}, fetchedAt: 0 }) };
const TEXT = "Please rerun the failing invoices test and tell me the result when it is done.";
const NOW = Date.parse("2026-10-17T13:00:00Z");

const list = (...names: string[]) => ({ reachable: true, fetchedAt: NOW, data: { agents: names.map((name) => ({ name, status: "idle", workspaceLabel: "ws", cwd: "/root/x/y", title: "t" })), fetchedAt: "2026-10-17T13:00:00.000Z" } });

async function setup(opts: { caps?: Cap[]; post?: (url: string, init: any) => Promise<any> } = {}) {
  const db = new Database(":memory:");
  const ops = new OpsStore(db);
  const state: { agents: () => any } = { agents: () => list("Sample") };
  const freshArgs: boolean[] = [];
  const posts: { url: string; method: string; body: any }[] = [];
  const client = new GhClient({
    url: "http://gh.test/api/godhome", token: () => "tok",
    fetch: (async (url: string, init: any) => {
      posts.push({ url, method: init.method, body: JSON.parse(init.body) });
      return opts.post ? opts.post(url, init) : { status: 200, json: async () => ({ ok: true }) };
    }) as any,
  });
  const agents = buildAgents({
    ops, runs: { listRuns: () => [], insertRun: () => {}, deleteRun: () => {} }, projects: () => [], isReportOnly: () => false,
    macOnline: async () => true, startRun: async () => ({ ok: true }), ids: new GhIds(db), client, now: () => Date.now(),
    herdrAgents: async (fresh?: boolean) => { freshArgs.push(fresh === true); const v = state.agents(); if (v instanceof Error) throw v; return v; },
  });
  const t = await controlApp({ ops: { godhome, store: ops, kinds: agents.kinds } as any, agents }, db);
  t.store.setCaps(t.store.listDevices()[0]!.id, opts.caps ?? ["ops:read", "agents:start"]);
  const live = async () => (await t.get("/agents/live")).json.agents as { id: string; label: string }[];
  const prepare = (id: string, body: unknown = { text: TEXT }) => t.post(`/agents/live/${id}/prompt`, body);
  const confirm = (actionId: string, key = "key-1") => t.srv.call("POST", `/control-api/v1/ops/actions/${actionId}/confirm`, {}, { ...t.auth, "idempotency-key": key });
  const audits = () => db.prepare("SELECT action, params, result, detail, response FROM control_ops_audit ORDER BY id").all() as any[];
  return { ...t, db, ops, state, freshArgs, posts, live, prepare, confirm, audits };
}

test("G4 needs agents:start; the id shape and the text are checked before anything else", async () => {
  const no = await setup({ caps: ["ops:read"] });
  assert.equal((await no.prepare("g_0123456789ab")).status, 403);
  await no.close();
  const t = await setup();
  const [a] = await t.live();
  assert.equal((await t.prepare("not-an-id")).status, 400);
  for (const body of [{}, { text: "" }, { text: "  \n " }, { text: 4 }, { text: "x".repeat(2001) }]) {
    const r = await t.prepare(a!.id, body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 40));
    assert.equal(r.json.error.code, "bad_request");
  }
  assert.equal((await t.prepare(a!.id, { text: "x".repeat(2000) })).status, 200);
  assert.deepEqual(t.posts, []);
  await t.close();
});

test("G4 prepare: unknown id and an agent that is gone are 404; GodHome down is 503", async () => {
  const t = await setup();
  assert.equal((await t.prepare("g_0123456789ab")).status, 404);
  const [a] = await t.live();
  t.state.agents = () => list("Other");
  const gone = await t.prepare(a!.id);
  assert.equal(gone.status, 404);
  assert.equal(gone.json.error.code, "not_found");
  t.state.agents = () => ({ reachable: false, data: null, fetchedAt: 0 });
  const down = await t.prepare(a!.id);
  assert.equal(down.status, 503);
  assert.equal(down.json.error.code, "unavailable");
  t.state.agents = () => new Error("ECONNREFUSED Bearer tk_leak");
  const thrown = await t.prepare(a!.id);
  assert.equal(thrown.status, 503);
  assert.ok(!JSON.stringify(thrown.json).includes("tk_leak"));
  assert.deepEqual(t.posts, []);
  await t.close();
});

test("prepare then confirm: GodHome gets exactly one POST at /herdr/agents/<resolved name>/prompt with the text", async () => {
  const t = await setup();
  const [a] = await t.live();
  const p = await t.prepare(a!.id);
  assert.equal(p.status, 200);
  assert.deepEqual(Object.keys(p.json).sort(), ["actionId", "expiresAt", "label"]);
  assert.equal(p.json.label, "Sample");
  assert.deepEqual(t.posts, [], "prepare sends nothing");
  const c = await t.confirm(p.json.actionId);
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.deepEqual(c.json, { ok: true });
  assert.deepEqual(t.posts, [{ url: "http://gh.test/api/godhome/herdr/agents/Sample/prompt", method: "POST", body: { text: TEXT } }]);
  await t.close();
});

test("the agent is re-resolved from a fresh list at confirm: gone is 404, a repeated label is 409, and nothing is sent", async () => {
  const t = await setup();
  const [a] = await t.live();
  const p = await t.prepare(a!.id);
  t.freshArgs.length = 0;
  t.state.agents = () => list("Other");
  const gone = await t.confirm(p.json.actionId, "k-gone");
  assert.equal(gone.status, 404);
  t.state.agents = () => list("Sample", "Sample");
  const twice = await t.confirm(p.json.actionId, "k-twice");
  assert.equal(twice.status, 409);
  assert.equal(twice.json.error.code, "conflict");
  assert.ok(t.freshArgs.length >= 2 && t.freshArgs.every(Boolean), "confirm reads GodHome uncached");
  assert.deepEqual(t.posts, []);
  assert.equal(t.ops.getActionToken(p.json.actionId)!.usedAt, null, "a refusal leaves the token usable");
  t.state.agents = () => list("Sample");
  assert.equal((await t.confirm(p.json.actionId, "k-ok")).status, 200);
  assert.equal(t.posts.length, 1);
  await t.close();
});

test("GodHome down at confirm is 503 and sends nothing; a failing prompt POST is 503 too", async () => {
  const t = await setup();
  const [a] = await t.live();
  const p = await t.prepare(a!.id);
  t.state.agents = () => ({ reachable: false, data: null, fetchedAt: 0 });
  const down = await t.confirm(p.json.actionId, "k1");
  assert.equal(down.status, 503);
  assert.equal(down.json.error.code, "unavailable");
  assert.deepEqual(t.posts, []);
  await t.close();

  const bad = await setup({ post: async () => ({ status: 502, json: async () => ({}) }) });
  const [b] = await bad.live();
  const q = await bad.prepare(b!.id);
  const r = await bad.confirm(q.json.actionId);
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, "unavailable");
  assert.equal(bad.audits().at(-1).result, "unavailable");
  await bad.close();
});

test("a replayed Idempotency-Key returns the stored reply and prompts once", async () => {
  const t = await setup();
  const [a] = await t.live();
  const p = await t.prepare(a!.id);
  const first = await t.confirm(p.json.actionId, "same");
  const again = await t.confirm(p.json.actionId, "same");
  assert.deepEqual(again.json, first.json);
  assert.equal(t.posts.length, 1);
  await t.close();
});

test("a name with a slash is sent as one encoded path segment", async () => {
  const t = await setup();
  t.state.agents = () => list("w1/2");
  const [a] = await t.live();
  const p = await t.prepare(a!.id);
  await t.confirm(p.json.actionId);
  assert.equal(t.posts[0]!.url, "http://gh.test/api/godhome/herdr/agents/w1%2F2/prompt");
  await t.close();
});

test("10 prompts per 10 minutes per device: the 11th is 429 with Retry-After", async () => {
  const t = await setup();
  const [a] = await t.live();
  for (let i = 0; i < 10; i++) {
    const p = await t.prepare(a!.id, { text: `${TEXT} ${i}` });
    assert.equal((await t.confirm(p.json.actionId, `k${i}`)).status, 200, String(i));
  }
  const p = await t.prepare(a!.id, { text: `${TEXT} 11` });
  const r = await t.confirm(p.json.actionId, "k11");
  assert.equal(r.status, 429);
  assert.equal(r.json.error.code, "rate_limited");
  assert.ok(Number(r.headers["retry-after"]) >= 1);
  assert.equal(t.posts.length, 10);
  await t.close();
});

test("audit as T2.2: length, sha256 and a 60-char preview; the text is in no audit row, reply or leftover payload", async () => {
  const t = await setup();
  const [a] = await t.live();
  const p = await t.prepare(a!.id);
  const c = await t.confirm(p.json.actionId);
  const rows = t.audits();
  assert.deepEqual(rows.map((r) => `${r.action}:${r.result}`), ["agent.prompt.prepare:ok", "agent.prompt.confirm:ok"]);
  assert.ok(!JSON.stringify([rows, p.json, c.json]).includes(TEXT));
  assert.ok(!JSON.stringify(rows).includes("it is done."), "nothing past the 60-char preview");
  for (const r of rows) {
    const params = JSON.parse(r.params);
    assert.equal(params.len, TEXT.length);
    assert.match(params.sha256, /^[0-9a-f]{64}$/);
    assert.ok(params.preview.length <= 60);
  }
  assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM control_action_payloads").get() as any).n, 0);
  await t.close();
});
