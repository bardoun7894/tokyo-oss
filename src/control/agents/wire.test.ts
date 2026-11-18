import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { controlApp } from "../test-app";
import { OpsStore } from "../ops-store";
import { TriageStore } from "../../finish-apps/triage-store";
import { wireAgents } from "./wire";
import { listTargets } from "./targets";
import type { Cap } from "../store";

const PROMPT = "Please add a CSV export to the invoices page and keep the tests green.";
const godhome = { herdrAgents: async () => ({ reachable: false, data: null, fetchedAt: 0 }) };
const client = { postAgentPrompt: async () => ({ status: "unreachable" as const }) };

async function setup(seed: (t: TriageStore) => void, after: (db: Database.Database) => void = () => {}) {
  const db = new Database(":memory:");
  const ops = new OpsStore(db);
  const started: any[] = [];
  const triage = new TriageStore(db);
  seed(triage);
  const agents = wireAgents(db, ops, godhome, client, () => ({
    controlOfferBackends: () => ({ createOffer: async () => { started.push("offer"); return { ok: true }; }, answerAction: async () => ({ ok: true }) }),
  }) as any);
  const t = await controlApp({ ops: { godhome: {} as any, store: ops, kinds: agents.kinds } as any, agents }, db);
  const dev = t.store.listDevices()[0]!;
  t.store.setCaps(dev.id, ["ops:read", "agents:start"] as Cap[]);
  after(db);
  return { ...t, db, agents, started };
}

test("F1: a triage snapshot that cannot be read is fail closed: G1 and G2 answer 503", async () => {
  const t = await setup(() => {}, (db) => db.exec("DROP TABLE triage_snapshots"));
  const g1 = await t.get("/agents/targets");
  assert.equal(g1.status, 503);
  assert.equal(g1.json.error.code, "unavailable");
  const g2 = await t.post("/agents/runs", { project: "lab", prompt: PROMPT });
  assert.equal(g2.status, 503);
  assert.equal(g2.json.error.code, "unavailable");
  await t.close();
});

test("F1: a project missing from the triage snapshot is not startable (G1 omits it, G2 404)", async () => {
  const t = await setup((s) => s.upsert("2026-10-01", "lab", { name: "lab", completeness: 50 }, [], []));
  const names = (await listTargets(t.agents.targets)).map((p) => p.name);
  assert.ok(!names.includes("shopdemo"), "shopdemo is not in the snapshot");
  assert.ok(names.includes("lab"));
  const g2 = await t.post("/agents/runs", { project: "shopdemo", prompt: PROMPT });
  assert.equal(g2.status, 404);
  await t.close();
});

test("F1: an empty snapshot (no sweep yet) starts nothing", async () => {
  const t = await setup(() => {});
  assert.deepEqual(await listTargets(t.agents.targets), []);
  assert.equal((await t.post("/agents/runs", { project: "lab", prompt: PROMPT })).status, 404);
  await t.close();
});

test("F1: a normal non-customer project in the snapshot still starts; a customer one does not", async () => {
  const t = await setup((s) => {
    s.upsert("2026-10-01", "lab", { name: "lab", completeness: 50 }, [], []);
    s.upsert("2026-10-01", "shopdemo", { name: "shopdemo", customer: true }, [], []);
  });
  const names = (await listTargets(t.agents.targets)).map((p) => p.name);
  assert.ok(names.includes("lab"));
  assert.ok(!names.includes("shopdemo"));
  assert.equal((await t.post("/agents/runs", { project: "lab", prompt: PROMPT })).status, 200);
  assert.equal((await t.post("/agents/runs", { project: "shopdemo", prompt: PROMPT })).status, 404);
  await t.close();
});

test("F1: the triage snapshot breaks between prepare and confirm: X16 answers 503, the run is not started", async () => {
  const t = await setup((s) => s.upsert("2026-10-01", "lab", { name: "lab", completeness: 50 }, [], []));
  const p = await t.post("/agents/runs", { project: "lab", prompt: PROMPT });
  assert.equal(p.status, 200);
  t.db.exec("DROP TABLE triage_snapshots");
  const c = await t.srv.call("POST", `/control-api/v1/ops/actions/${p.json.actionId}/confirm`, {}, { ...t.auth, "idempotency-key": "k-1" });
  assert.equal(c.status, 503, JSON.stringify(c.json));
  assert.deepEqual(t.started, []);
  await t.close();
});
