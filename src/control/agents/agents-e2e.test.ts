import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { controlApp } from "../test-app";
import { OpsStore } from "../ops-store";
import { GhIds } from "../gh/ids";
import { prepareToken } from "../actions/tokens";
import { buildAgents } from "./wire";
import { macReach } from "./targets";
import type { Cap } from "../store";

const godhome = { summary: async () => ({ reachable: true, data: {}, fetchedAt: 0 }), runs: async () => ({ reachable: true, data: [], fetchedAt: 0 }), run: async () => ({ reachable: true, data: {}, fetchedAt: 0 }), graph: async () => ({ reachable: true, data: {}, fetchedAt: 0 }) };
const PROMPT = "Please add a CSV export to the invoices page and keep the tests green.";

async function setup(opts: { mac?: boolean; start?: (a: any) => Promise<any>; caps?: Cap[] } = {}) {
  const db = new Database(":memory:");
  const ops = new OpsStore(db);
  const spy: string[] = [];
  const argv: string[][] = [];
  let runStore: any;
  const startCalls: any[] = [];
  const agents = buildAgents({
    ops,
    runs: { listRuns: (f) => runStore.listRuns(f), insertRun: (r) => runStore.insertRun(r), deleteRun: (id) => runStore.deleteRun(id) },
    projects: () => [{ name: "alpha", location: "server" }, { name: "bravo", location: "laptop" }, { name: "cust", location: "server" }],
    isReportOnly: (n) => n === "cust",
    ids: new GhIds(db),
    client: { postAgentPrompt: async () => ({ status: "unreachable" as const }) },
    herdrAgents: async () => ({ reachable: false, data: null, fetchedAt: 0 }),
    macOnline: macReach(async (file, args) => { argv.push([file, ...args]); return { code: opts.mac === false ? 255 : 0, stdout: "", stderr: "", timedOut: false }; }, () => 0),
    startRun: opts.start ?? (async (a) => { spy.push(runStore.getRun(a.runId) ? "row-before-start" : "NO-ROW"); startCalls.push(a); return { ok: true }; }),
  });
  const t = await controlApp({ ops: { godhome, store: ops, kinds: agents.kinds } as any, agents }, db);
  runStore = t.store;
  const dev = t.store.listDevices()[0]!;
  t.store.setCaps(dev.id, opts.caps ?? ["ops:read", "agents:start"]);
  const prepare = (body: unknown) => t.post("/agents/runs", body);
  const confirm = (id: string, key = "key-1") => t.srv.call("POST", `/control-api/v1/ops/actions/${id}/confirm`, {}, { ...t.auth, "idempotency-key": key });
  const audits = () => db.prepare("SELECT action, subject, params, result, detail, response FROM control_ops_audit ORDER BY id").all() as any[];
  return { ...t, db, ops, dev, spy, argv, startCalls, prepare, confirm, audits };
}

test("G1 and G2 need agents:start (403); G1 lists startable projects", async () => {
  const none = await setup({ caps: ["ops:read"] });
  assert.equal((await none.get("/agents/targets")).status, 403);
  assert.equal((await none.prepare({ project: "alpha", prompt: PROMPT })).status, 403);
  await none.close();
  const t = await setup();
  const r = await t.get("/agents/targets");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.projects.map((p: any) => [p.name, p.host, p.macOnline]), [["alpha", "server", undefined], ["bravo", "mac", true]]);
  await t.close();
});

test("G2: prompt 1..4000, project name, variant and report-only are checked before anything is stored", async () => {
  const t = await setup();
  for (const body of [{}, { project: "alpha" }, { project: "alpha", prompt: "" }, { project: "alpha", prompt: "   " }, { project: "alpha", prompt: 5 },
    { project: "alpha", prompt: "x".repeat(4001) }, { project: "../x", prompt: PROMPT }, { project: "alpha", prompt: PROMPT, variant: "other" }]) {
    const r = await t.prepare(body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(r.json.error.code, "bad_request");
  }
  assert.equal((await t.prepare({ project: "alpha", prompt: "x".repeat(4000) })).status, 200);
  for (const project of ["cust", "nope"]) {
    const r = await t.prepare({ project, prompt: PROMPT });
    assert.equal(r.status, 404, project);
    assert.equal(r.json.error.code, "not_found");
  }
  assert.equal((await t.db.prepare("SELECT COUNT(*) AS n FROM control_runs").get() as any).n, 0);
  await t.close();
});

test("prepare then confirm: the queued row exists before the runner is asked, the reply carries runId", async () => {
  const t = await setup();
  const p = await t.prepare({ project: "alpha", prompt: PROMPT });
  assert.equal(p.status, 200);
  assert.deepEqual(Object.keys(p.json).sort(), ["actionId", "expiresAt", "host", "project", "queued"]);
  assert.deepEqual([p.json.project, p.json.host, p.json.queued], ["alpha", "server", false]);
  assert.equal((await t.db.prepare("SELECT COUNT(*) AS n FROM control_runs").get() as any).n, 0, "prepare starts nothing");
  const c = await t.confirm(p.json.actionId);
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.match(c.json.runId, /^[0-9a-f]{8}$/);
  assert.equal(c.json.state, "running");
  assert.deepEqual(t.spy, ["row-before-start"]);
  assert.deepEqual(t.startCalls, [{ project: "alpha", prompt: PROMPT, variant: "kb-dev", runId: c.json.runId }]);
  const row = t.store.getRun(c.json.runId)!;
  assert.deepEqual([row.status, row.source, row.host, row.project], ["queued", "tokyo", "server", "alpha"]);
  assert.equal(row.promptPreview, PROMPT.slice(0, 200));
  await t.close();
});

test("a replayed Idempotency-Key returns the same runId and starts nothing again", async () => {
  const t = await setup();
  const p = await t.prepare({ project: "alpha", prompt: PROMPT });
  const first = await t.confirm(p.json.actionId, "same");
  const again = await t.confirm(p.json.actionId, "same");
  assert.deepEqual(again.json, first.json);
  assert.equal(t.startCalls.length, 1);
  const third = await t.confirm(p.json.actionId, "other");
  assert.equal(third.status, 409, "a new key on a spent token");
  await t.close();
});

test("Mac offline: prepare says queued, confirm answers queued, the row stays queued", async () => {
  const t = await setup({ mac: false });
  const p = await t.prepare({ project: "bravo", prompt: PROMPT });
  assert.deepEqual([p.json.host, p.json.queued], ["mac", true]);
  const c = await t.confirm(p.json.actionId);
  assert.equal(c.status, 200);
  assert.equal(c.json.state, "queued");
  const row = t.store.getRun(c.json.runId)!;
  assert.deepEqual([row.status, row.host], ["queued", "mac"]);
  await t.close();
});

test("Mac online: a Mac project answers running", async () => {
  const t = await setup({ mac: true });
  const p = await t.prepare({ project: "bravo", prompt: PROMPT });
  assert.equal(p.json.queued, false);
  assert.equal((await t.confirm(p.json.actionId)).json.state, "running");
  await t.close();
});

test("duplicate guard: the same project and first 200 chars while queued or running is 409 with the run id, at prepare and at confirm", async () => {
  const t = await setup();
  const early = await t.prepare({ project: "alpha", prompt: PROMPT });
  const late = await t.prepare({ project: "alpha", prompt: PROMPT });
  assert.equal(late.status, 200, "nothing runs yet");
  const first = await t.confirm(early.json.actionId, "a");
  const dup = await t.prepare({ project: "alpha", prompt: PROMPT });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, "conflict");
  assert.equal(dup.json.runId, first.json.runId);
  const atConfirm = await t.confirm(late.json.actionId, "b");
  assert.equal(atConfirm.status, 409);
  assert.equal(atConfirm.json.runId, first.json.runId);
  assert.equal(t.ops.getActionToken(late.json.actionId)!.usedAt, null);
  assert.equal(t.startCalls.length, 1);
  // a finished run no longer blocks, nor does another project or another first 200 chars
  t.store.updateRun(first.json.runId, { status: "succeeded" });
  assert.equal((await t.prepare({ project: "alpha", prompt: PROMPT })).status, 200);
  assert.equal((await t.prepare({ project: "bravo", prompt: PROMPT })).status, 200);
  await t.close();
});

test("an expired or unknown token starts nothing", async () => {
  const t = await setup();
  const old = prepareToken(t.ops, { kind: "agent_run", deviceId: t.dev.id, subject: "alpha", targetId: "alpha", payload: { project: "alpha", prompt: PROMPT, variant: "kb-dev" }, now: Date.now() - 300_000 });
  assert.equal((await t.confirm(old.actionId)).status, 409);
  assert.equal((await t.confirm("act_00000000beef")).status, 404);
  assert.equal(t.startCalls.length, 0);
  await t.close();
});

test("rate limits: 6 starts per 10 minutes per device and 20 per day overall answer 429 with Retry-After", async () => {
  const t = await setup();
  for (let i = 0; i < 6; i++) {
    const p = await t.prepare({ project: "alpha", prompt: `${PROMPT} #${i}` });
    assert.equal((await t.confirm(p.json.actionId, `k${i}`)).status, 200, String(i));
  }
  const seventh = await t.prepare({ project: "alpha", prompt: `${PROMPT} #7` });
  const limited = await t.confirm(seventh.json.actionId, "k7");
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.code, "rate_limited");
  assert.ok(Number(limited.headers["retry-after"]) >= 1);
  assert.equal(t.ops.getActionToken(seventh.json.actionId)!.usedAt, null);
  assert.equal(t.startCalls.length, 6);
  await t.close();

  const g = await setup();
  for (let i = 0; i < 20; i++) {
    const tok = prepareToken(g.ops, { kind: "agent_run", deviceId: `d_${i.toString(16).padStart(8, "0")}`, subject: "alpha", targetId: "alpha", now: Date.now() });
    g.ops.consumeRestartToken(tok.actionId, Date.now() - 1000);
  }
  const p = await g.prepare({ project: "alpha", prompt: PROMPT });
  assert.equal((await g.confirm(p.json.actionId)).status, 429);
  assert.equal(g.startCalls.length, 0);
  await g.close();
});

test("the runner failing leaves no row: 503 for unavailable, 404 for a project that vanished", async () => {
  const down = await setup({ start: async () => ({ ok: false, kind: "unavailable", message: "telegram bot not ready" }) });
  const p = await down.prepare({ project: "alpha", prompt: PROMPT });
  const c = await down.confirm(p.json.actionId);
  assert.equal(c.status, 503);
  assert.equal(c.json.error.code, "unavailable");
  assert.equal((down.db.prepare("SELECT COUNT(*) AS n FROM control_runs").get() as any).n, 0);
  await down.close();
  const gone = await setup({ start: async () => ({ ok: false, kind: "not_found", message: "No such project" }) });
  const q = await gone.prepare({ project: "alpha", prompt: PROMPT });
  assert.equal((await gone.confirm(q.json.actionId)).status, 404);
  await gone.close();
});

test("the full prompt is in no audit row, no reply, no argv, and its payload row is gone after use", async () => {
  const t = await setup();
  const p = await t.prepare({ project: "alpha", prompt: PROMPT });
  const c = await t.confirm(p.json.actionId);
  assert.ok(!JSON.stringify([p.json, c.json]).includes(PROMPT));
  const rows = t.audits();
  assert.deepEqual(rows.map((r) => `${r.action}:${r.result}`), ["agent.run.prepare:ok", "agent.run.confirm:ok"]);
  assert.ok(!JSON.stringify(rows).includes(PROMPT));
  assert.ok(!JSON.stringify(rows).includes("green."), "not even a fragment past 60 chars");
  for (const r of rows) {
    const params = JSON.parse(r.params);
    assert.equal(params.len, PROMPT.length);
    assert.match(params.sha256, /^[0-9a-f]{64}$/);
    assert.ok(params.preview.length <= 60);
  }
  assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM control_action_payloads").get() as any).n, 0);
  const mac = await t.prepare({ project: "bravo", prompt: PROMPT });
  await t.confirm(mac.json.actionId, "key-mac");
  assert.ok(t.argv.length >= 1, "the Mac probe ran");
  assert.ok(!JSON.stringify(t.argv).includes("invoices"), "the prompt is in no argv");
  await t.close();
});
