import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { controlApp } from "../test-app";
import { OpsStore } from "../ops-store";
import type { Cap } from "../store";
import { GhIds } from "./ids";
import type { GhDeps } from "./index";
import { assertWithinExample, fakeGh, fixture } from "./test-support";

const MODELS = {
  counts: { total: 4, yours: 1, free: 2, paid: 2 },
  yours: [{ id: "anthropic/claude-sonnet", name: "Sonnet", provider: "anthropic", enabled: true, free: false, reasoning: true, context: 200000, providerKnown: true, cost: { input: 3, output: 15 }, keyEnv: "ANTHROPIC_API_KEY", sources: ["/root/.pi/models.json"], piEquivalent: "x" }],
  free: [{ id: "opencode/big-free", provider: "opencode", enabled: false, free: true, providerKnown: true, cost: {} }, { id: "anthropic/claude-sonnet", provider: "anthropic", enabled: true, free: false, cost: {} }],
  paid: [{ id: "openrouter/some-model", name: "Some", provider: "openrouter", enabled: false, free: false, cost: { input: 1, output: 2 } }],
};
const HEALTH = { models: { "anthropic/claude-sonnet": { ok: true, ms: 800, status: "ok", detail: "Bearer sk-x" }, "opencode/big-free": { ok: false, ms: 5000, status: "timeout" } } };
const QUOTA = { providers: [{ id: "anthropic", label: "Anthropic", state: "ok", used: 40, headline: "40% used", detail: "d", note: "n", source: "/root/x", keyFound: true }] };
const COSTS = { jev: { today: 0.1, d7: 1, d30: 3, url: "http://x" }, openrouter: { daily: 0.5, weekly: 2, monthly: 9, key: "sk-or-zzz" }, prReview: [{ repo: "org/secret-repo", pr: 7 }] };

async function setup(caps: Cap[] = ["ops:read", "ops:write"]) {
  const db = new Database(":memory:");
  const ops = new OpsStore(db);
  const gh = fakeGh();
  gh.bodies.models = MODELS;
  gh.bodies.modelsHealth = HEALTH;
  gh.bodies.quota = QUOTA;
  gh.bodies.costs = COSTS;
  const deps: GhDeps = { client: gh, ids: new GhIds(db), ops, allowlist: () => [], now: () => Date.now() };
  const t = await controlApp({ gh: deps }, db);
  t.store.setCaps(t.store.listDevices()[0]!.id, caps);
  const audits = () => db.prepare("SELECT action, subject, params, result FROM control_ops_audit ORDER BY id").all() as { action: string; subject: string; params: string; result: string }[];
  return { ...t, gh, deps, audits };
}

test("T5.6 K31, K33, K34 map to exactly the contract example's fields", async () => {
  const t = await setup(["ops:read"]);
  t.gh.bodies.models = fixture("models");
  t.gh.bodies.modelsHealth = fixture("models_health");
  t.gh.bodies.quota = fixture("quota");
  t.gh.bodies.costs = fixture("costs");
  const k31 = await t.get("/ops/gh/models");
  assert.equal(k31.status, 200);
  // The example shows the health of the first two models only; the keys of that map are model ids.
  const norm = (j: any) => ({ ...j, health: Object.fromEntries(Object.entries(j.health ?? {}).slice(0, 1).map(([, v]) => ["key", v])) });
  assertWithinExample("K31", norm(k31.json), ["health.key", "health.key.ok", "health.key.ms", "health.key.status"]);
  for (const [code, path] of [["K33", "/ops/gh/roles"], ["K34", "/ops/gh/skills"]] as const) {
    const r = await t.get(path);
    assert.equal(r.status, 200, code);
    assertWithinExample(code, r.json);
  }
  await t.close();
});

test("T5.6 models: catalogue rows, health, cached quota and costs; no key names, sources, paths, urls, secrets or repo rows", async () => {
  const t = await setup(["ops:read"]);
  const m = (await t.get("/ops/gh/models")).json;
  assert.deepEqual(m.counts, MODELS.counts);
  assert.deepEqual(m.models.map((x: any) => x.id), ["anthropic/claude-sonnet", "opencode/big-free", "openrouter/some-model"], "yours first, then free, then paid, each model once");
  assert.deepEqual(m.models[0], { id: "anthropic/claude-sonnet", name: "Sonnet", provider: "anthropic", enabled: true, free: false, reasoning: true, context: 200000, providerKnown: true, cost: { inPrice: 3, outPrice: 15 } });
  assert.deepEqual(m.health, { "anthropic/claude-sonnet": { ok: true, ms: 800, status: "ok" }, "opencode/big-free": { ok: false, ms: 5000, status: "timeout" } });
  assert.deepEqual(m.quota, [{ id: "anthropic", label: "Anthropic", state: "ok", used: 40, headline: "40% used" }]);
  assert.deepEqual(m.costs, { jev: { today: 0.1, d7: 1, d30: 3 }, openrouter: { daily: 0.5, weekly: 2, monthly: 9 } });
  assert.ok(!/ANTHROPIC_API_KEY|\/root\/|sk-|Bearer|http|secret-repo|prReview|keyFound|piEquivalent/.test(JSON.stringify(m)), JSON.stringify(m));
  assert.deepEqual(t.gh.reads.map((r) => [r.key, r.fresh]), [["models", false], ["modelsHealth", false], ["quota", false], ["costs", false]]);
  await t.close();
});

test("T5.6 the catalogue is capped to a phone-sized list", async () => {
  const t = await setup(["ops:read"]);
  t.gh.bodies.models = { counts: { total: 900 }, yours: [], free: Array.from({ length: 400 }, (_, i) => ({ id: `p/m${i}`, provider: "p", enabled: false, free: true, cost: {} })), paid: [] };
  const m = (await t.get("/ops/gh/models")).json;
  assert.ok(m.models.length <= 200, String(m.models.length));
  assert.equal(m.counts.total, 900);
  await t.close();
});

test("T5.6 K32: ops:write, {enabled} boolean, and the id must be in the current catalogue; one GodHome write, audited", async () => {
  const ro = await setup(["ops:read"]);
  assert.equal((await ro.post("/ops/gh/models/opencode%2Fbig-free/enabled", { enabled: true })).status, 403);
  await ro.close();
  const t = await setup();
  const url = (id: string) => `/ops/gh/models/${encodeURIComponent(id)}/enabled`;
  for (const body of [{}, { enabled: "yes" }, { enabled: 1 }, { enabled: null }]) assert.equal((await t.post(url("opencode/big-free"), body)).status, 400, JSON.stringify(body));
  for (const id of ["not-in-catalogue/x", "no-slash", "../etc", "a b/c", "x".repeat(300)]) {
    const r = await t.post(url(id), { enabled: true });
    assert.ok([400, 404].includes(r.status), `${id}: ${r.status}`);
  }
  assert.equal(t.gh.writes.length, 0);
  const ok = await t.post(url("opencode/big-free"), { enabled: true });
  assert.deepEqual([ok.status, ok.json], [200, { ok: true }]);
  assert.deepEqual(t.gh.writes, [{ key: "modelEnabled", args: { body: { id: "opencode/big-free", enabled: true } } }]);
  // Behind nginx (proxy_pass with a URI) the %2F arrives decoded as a slash: the raw form must work too.
  assert.equal((await t.post("/ops/gh/models/opencode/big-free/enabled", { enabled: false })).status, 200);
  assert.deepEqual(t.gh.writes.at(-1), { key: "modelEnabled", args: { body: { id: "opencode/big-free", enabled: false } } });
  assert.equal((await t.post("/ops/gh/models/opencode/big-free/extra/enabled", { enabled: false })).status, 404, "three segments are not in the catalogue");
  assert.deepEqual(t.audits().find((a) => a.result === "ok"), { action: "gh.K32", subject: "opencode/big-free", params: JSON.stringify({ enabled: true }), result: "ok" });
  t.gh.down = true;
  assert.equal((await t.post(url("opencode/big-free"), { enabled: false })).status, 503);
  await t.close();
});

test("T5.6 roles and skills carry names and labels only: no prompt, system, node or description text", async () => {
  const t = await setup(["ops:read"]);
  t.gh.bodies.roles = { roles: [{ id: "reviewer", label: "Reviewer", model: "m", specialty: "reviews", thinking: "high", builtin: true, gate: true, tools: ["read", "grep"], statuses: ["PASS", "FAIL"], system: "S", prompt: "You are the reviewer. Read /root/secret", node: { prompt: "P" } }] };
  const roles = (await t.get("/ops/gh/roles")).json.roles;
  assert.deepEqual(roles, [{ id: "reviewer", label: "Reviewer", model: "m", specialty: "reviews", thinking: "high", builtin: true, gate: true, tools: ["read", "grep"], statuses: ["PASS", "FAIL"] }]);
  t.gh.bodies.skills = { skills: [{ name: "kb-query", description: "D", prompt: "P" }] };
  t.gh.bodies.skillsGraph = { tiers: ["local", "plugin"], nodes: [{ name: "kb-query", description: "D", tier: "local", in: 1, out: 2 }], edges: [{ from: "a", to: "b" }] };
  const s = (await t.get("/ops/gh/skills")).json;
  assert.deepEqual(s.skills, [{ name: "kb-query" }]);
  assert.deepEqual(s.graph, { tiers: ["local", "plugin"], nodes: [{ name: "kb-query", tier: "local", in: 1, out: 2 }] });
  assert.ok(!/"D"|"P"|prompt|system/.test(JSON.stringify([roles, s])));
  await t.close();
});

test("T5.6 there is no probe route and no fresh quota; GodHome down gives reachable:false and empty lists", async () => {
  const t = await setup();
  for (const p of ["/ops/gh/models/probe", "/ops/gh/quota", "/ops/gh/models/refresh"]) {
    const r = await t.post(p);
    assert.notEqual(r.status, 200, p);
  }
  assert.equal(((await t.get("/ops/gh/models?fresh=1")).json.reachable), true);
  assert.ok(t.gh.reads.every((r) => !r.fresh), "fresh is never asked for");
  t.gh.down = true;
  for (const p of ["/ops/gh/models", "/ops/gh/roles", "/ops/gh/skills"]) {
    const r = await t.get(p);
    assert.deepEqual([p, r.status, r.json.reachable], [p, 200, false]);
  }
  assert.deepEqual((await t.get("/ops/gh/models")).json.models, []);
  await t.close();
});

test("T5.6 reads need ops:read", async () => {
  const t = await setup([]);
  for (const p of ["/ops/gh/models", "/ops/gh/roles", "/ops/gh/skills"]) assert.equal((await t.get(p)).status, 403, p);
  await t.close();
});
