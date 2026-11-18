import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { controlApp } from "../test-app";
import { OpsStore } from "../ops-store";
import { GhIds } from "../gh/ids";
import { buildAgents } from "./wire";
import { mapLiveAgents, LIVE_STATUSES } from "./live";
import type { OpsResult } from "../ops-godhome";
import type { Cap } from "../store";

const FIX = path.join(__dirname, "..", "..", "..", "test-fixtures", "gh", "herdr_agents.json");
const sample = JSON.parse(fs.readFileSync(FIX, "utf8")).body;
const NOW = Date.parse("2026-10-17T13:07:00Z");

test("maps the T0.5 fixture to {id, label, project, status, lastAt}", () => {
  const ids = new GhIds(new Database(":memory:"));
  const out = mapLiveAgents(sample, ids, NOW);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { id: out[0]!.id, label: "Sample", project: "Sample w", status: "working", lastAt: "2026-10-17T13:06:32.498Z" });
  assert.match(out[0]!.id, /^g_[0-9a-f]{12}$/);
});

test("key set: no cwd, pane path, title or any herdr id, whatever the input carries", () => {
  const ids = new GhIds(new Database(":memory:"));
  const raw = {
    agents: [{
      name: "/root/work/secret-app/agent-1", kind: "claude", status: "idle", ready: true, workspaceId: "ws-private-77", workspaceLabel: "/srv/missions/acme",
      tabId: "tab-private-5", paneId: "pane-private-9", cwd: "/root/work/secret-app", title: "Editing /root/work/secret-app/src/db.ts with token sk-abcdefghijklmnopqrstuvwxyz",
    }],
    fetchedAt: "2026-10-17T13:06:32.498Z",
  };
  const out = mapLiveAgents(raw, ids, NOW);
  assert.deepEqual(Object.keys(out[0]!).sort(), ["id", "label", "lastAt", "project", "status"]);
  const text = JSON.stringify(out);
  for (const leak of ["/root", "/srv", "secret-app", "ws-private", "tab-private", "pane-private", "Editing", "sk-"]) assert.ok(!text.includes(leak), leak);
});

test("status enum is frozen: working, idle, blocked, done, unknown; anything else reads unknown", () => {
  assert.deepEqual([...LIVE_STATUSES], ["working", "idle", "blocked", "done", "unknown"]);
  const ids = new GhIds(new Database(":memory:"));
  const mk = (status: unknown) => mapLiveAgents({ agents: [{ name: "a", status }], fetchedAt: "2026-10-17T13:00:00Z" }, ids, NOW)[0]!.status;
  for (const s of LIVE_STATUSES) assert.equal(mk(s), s);
  for (const s of ["WORKING", "running", "", 7, null, undefined, { x: 1 }]) assert.equal(mk(s), "unknown", String(s));
});

test("label is clamped to 80, project to 60; an agent without a workspace label has no project; lastAt falls back to now", () => {
  const ids = new GhIds(new Database(":memory:"));
  const [a] = mapLiveAgents({ agents: [{ name: "n".repeat(200), status: "idle", workspaceLabel: "w".repeat(200) }] }, ids, NOW);
  assert.equal(a!.label.length, 80);
  assert.equal(a!.project!.length, 60);
  assert.equal(a!.lastAt, new Date(NOW).toISOString());
  const [b] = mapLiveAgents({ agents: [{ name: "b", status: "idle" }] }, ids, NOW);
  assert.equal("project" in b!, false);
});

test("rows without a name, or not objects, are skipped; a body without agents is an empty list", () => {
  const ids = new GhIds(new Database(":memory:"));
  assert.deepEqual(mapLiveAgents({ agents: [null, 4, "x", {}, { name: "" }, { name: 7 }] }, ids, NOW), []);
  assert.deepEqual(mapLiveAgents({}, ids, NOW), []);
  assert.deepEqual(mapLiveAgents("<html>", ids, NOW), []);
});

test("ids are stable across two fetches and across a restart (same db)", () => {
  const db = new Database(":memory:");
  const first = mapLiveAgents(sample, new GhIds(db), NOW);
  const second = mapLiveAgents(sample, new GhIds(db), NOW + 60_000);
  assert.equal(first[0]!.id, second[0]!.id);
});

// --- the route (G3) ---

const godhome = { summary: async () => ({ reachable: true, data: {}, fetchedAt: 0 }), runs: async () => ({ reachable: true, data: [], fetchedAt: 0 }), run: async () => ({ reachable: true, data: {}, fetchedAt: 0 }), graph: async () => ({ reachable: true, data: {}, fetchedAt: 0 }) };

async function app(herdr: () => Promise<OpsResult>, caps: Cap[] = ["ops:read", "agents:start"]) {
  const db = new Database(":memory:");
  const ops = new OpsStore(db);
  const agents = buildAgents({
    ops, runs: { listRuns: () => [], insertRun: () => {}, deleteRun: () => {} }, projects: () => [], isReportOnly: () => false,
    macOnline: async () => true, startRun: async () => ({ ok: true }), ids: new GhIds(db), herdrAgents: herdr, now: () => NOW,
    client: { postAgentPrompt: async () => ({ status: "unreachable" as const }) },
  });
  const t = await controlApp({ ops: { godhome, store: ops, kinds: agents.kinds } as any, agents }, db);
  t.store.setCaps(t.store.listDevices()[0]!.id, caps);
  return t;
}

test("G3: needs agents:start; 200 {agents, reachable:true} with the mapped list", async () => {
  const no = await app(async () => ({ reachable: true, data: sample, fetchedAt: NOW }), ["ops:read"]);
  assert.equal((await no.get("/agents/live")).status, 403);
  await no.close();
  const t = await app(async () => ({ reachable: true, data: sample, fetchedAt: NOW }));
  const r = await t.get("/agents/live");
  assert.equal(r.status, 200);
  assert.equal(r.json.reachable, true);
  assert.deepEqual(r.json.agents.map((a: any) => [a.label, a.project, a.status]), [["Sample", "Sample w", "working"]]);
  await t.close();
});

test("G3: GodHome unreachable, throwing or malformed is 200 reachable:false with an empty list and no error text", async () => {
  for (const herdr of [
    async () => ({ reachable: false, data: null, fetchedAt: 0 }),
    async () => { throw new Error("connect ECONNREFUSED Bearer tk_leak"); },
    async () => ({ reachable: true, data: null, fetchedAt: NOW }),
  ] as (() => Promise<OpsResult>)[]) {
    const t = await app(herdr);
    const r = await t.get("/agents/live");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { agents: [], reachable: false });
    await t.close();
  }
});

test("G3: stale data past the reachable window still lists the last agents but says reachable:false", async () => {
  const t = await app(async () => ({ reachable: false, data: sample, fetchedAt: NOW - 600_000 }));
  const r = await t.get("/agents/live");
  assert.equal(r.json.reachable, false);
  assert.equal(r.json.agents.length, 1);
  await t.close();
});
