import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { ControlStore, type ControlRun } from "../store";
import { Dispatcher } from "./dispatcher";
import { Publisher, type FetchLike, type NtfyConfig } from "./publisher";
import { deploysSource, offersSource, type OfferSourceDeps } from "./sources";
import { PushStore } from "./store";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const TOKEN = "tk_dispatcherTOKEN0123456789abcdef";
const BASE = "https://ntfy.203-0-113-10.sslip.io";

interface World { actions: any[]; deploys: any[]; missions: any[]; runs: Map<string, ControlRun>; clock: { t: number } }

const action = (id: string, project: string, state = "pending", createdAt = NOW): any => ({ id, project, chatId: 1, title: "t", body: "b", buttons: [], state, createdAt });
const deploy = (id: string, project: string, over: any = {}): any => ({ id, project: { name: project }, chatId: 1, createdAt: NOW, state: "pending", ...over });
const mission = (id: string, project: string, state = "proposed"): any => ({ id, project, prompt: "p", sender: "s", state, answered_by: null, answered_at: null, created_at: NOW, updated_at: NOW, expires_at: NOW + 3600_000 });
const run = (id: string, offerId: string, status: ControlRun["status"]): ControlRun => ({
  id, project: "demo-site", source: "tokyo", status, model: null, harness: null, worker: null, tier: null, promptPreview: "", startedAt: NOW, endedAt: NOW, exitCode: 0,
  host: "server", offerId, workspace: null,
});

function setup(opts: { config?: NtfyConfig | null; db?: Database.Database; world?: World } = {}) {
  const db = opts.db ?? new Database(":memory:");
  const control = new ControlStore(db);
  const store = new PushStore(db);
  const world: World = opts.world ?? { actions: [], deploys: [], missions: [], runs: new Map(), clock: { t: NOW } };
  const sent: { url: string; body: string; device?: string }[] = [];
  const fetch: FetchLike = async (url, init) => { sent.push({ url, body: String(init.body) }); return { status: 200 }; };
  const config = opts.config === undefined ? ({ baseUrl: BASE, publishToken: TOKEN, format: "up" } as NtfyConfig) : opts.config;
  const publisher = new Publisher({ store, config: () => config, fetch, now: () => world.clock.t, log: () => {}, retryDelayMs: 0 });
  const deps: OfferSourceDeps = {
    offers: { now: () => world.clock.t, listActions: () => world.actions, listDeploys: () => world.deploys, listMissions: () => world.missions },
    getRun: (id) => world.runs.get(id),
  };
  const logs: string[] = [];
  const mk = () => new Dispatcher({ store, publisher, sources: [offersSource(deps), deploysSource(deps)], now: () => world.clock.t, format: () => config?.format ?? "up", log: (m) => logs.push(m) });
  const device = (name: string, topic: string, prefs?: Partial<{ approvals: boolean; deploys: boolean }>) => {
    const d = control.createDevice({ name, tokenHash: "h-" + name, now: NOW });
    store.register(d.id, topic, undefined, NOW);
    if (prefs) store.setPrefs(d.id, { ...store.getPrefs(d.id), ...prefs }, NOW);
    return d;
  };
  const bodies = () => sent.map((s) => JSON.parse(s.body));
  return { db, control, store, world, sent, bodies, mk, device, logs, publisher };
}

test("the first pass seeds silently: offers already pending when Tokyo starts push nothing", async () => {
  const s = setup();
  s.device("a", "upAaaaaaaaaa");
  s.world.actions.push(action("aaaa0001", "demo-site"));
  s.world.deploys.push(deploy("bbbb0001", "demo-site"));
  s.world.missions.push(mission("cccc0001", "demo-site"));
  const d = s.mk();
  await d.tick();
  assert.equal(s.sent.length, 0);
  await d.tick();
  assert.equal(s.sent.length, 0, "and stays quiet");
});

test("a new pending action, deploy or mission offer yields one approval.new per registered device with approvals on", async () => {
  const s = setup();
  const a = s.device("a", "upAaaaaaaaaa");
  const b = s.device("b", "upBbbbbbbbbb");
  s.device("off", "upCcccccccccc", { approvals: false });
  const d = s.mk();
  await d.tick(); // seed
  s.world.actions.push(action("aaaa0001", "demo-site"));
  s.world.deploys.push(deploy("bbbb0001", "demo-app"));
  s.world.missions.push(mission("cccc0001", "demo-site"));
  await d.tick();
  assert.equal(s.sent.length, 6, "3 offers x 2 devices");
  const perDevice = (t: string) => s.sent.filter((x) => x.url === `http://127.0.0.1:2586/${t}?up=1`).length;
  assert.deepEqual([perDevice("upAaaaaaaaaa"), perDevice("upBbbbbbbbbb"), perDevice("upCcccccccccc")], [3, 3, 0]);
  const ids = s.bodies().map((p) => `${p.t}:${p.id}:${p.p}`).sort();
  assert.deepEqual(ids, ["approval.new:aaaa0001:demo-site", "approval.new:aaaa0001:demo-site", "approval.new:bbbb0001:demo-app", "approval.new:bbbb0001:demo-app", "approval.new:cccc0001:demo-site", "approval.new:cccc0001:demo-site"]);
  assert.ok(s.bodies().every((p) => p.v === 1 && /^[0-9a-f]{8}$/.test(p.id) && p.title.startsWith("Approval needed: ")));
  await d.tick();
  assert.equal(s.sent.length, 6, "a second tick sends nothing twice");
  assert.ok(a.id && b.id);
});

test("an expired, answered or superseded offer is not new; a device registered later gets no history", async () => {
  const s = setup();
  s.device("a", "upAaaaaaaaaa");
  const d = s.mk();
  await d.tick();
  s.world.actions.push(action("aaaa0001", "p", "answered"), action("aaaa0002", "p", "superseded"), action("aaaa0003", "p", "pending", NOW - 3 * 24 * 3600_000));
  await d.tick();
  assert.equal(s.sent.length, 0);
});

test("a deploy offer reaching succeeded, failed or skipped yields one deploy.result; pending and running do not", async () => {
  const s = setup();
  s.device("a", "upAaaaaaaaaa");
  s.world.deploys.push(deploy("d0000001", "demo-site"), deploy("d0000002", "demo-site"), deploy("d0000003", "demo-site"), deploy("d0000004", "demo-site"));
  const d = s.mk();
  await d.tick(); // seed: all pending
  s.world.deploys[0] = deploy("d0000001", "demo-site", { state: "approved", answeredAt: NOW, runId: "r0000001", channel: "app" });
  s.world.runs.set("r0000001", run("r0000001", "d0000001", "running"));
  s.world.deploys[1] = deploy("d0000002", "demo-site", { state: "approved", answeredAt: NOW, runId: "r0000002", channel: "app" });
  s.world.runs.set("r0000002", run("r0000002", "d0000002", "succeeded"));
  s.world.deploys[2] = deploy("d0000003", "demo-site", { state: "declined", answeredAt: NOW, channel: "app" });
  await d.tick();
  const results = s.bodies().filter((p) => p.t === "deploy.result").map((p) => `${p.id}:${p.o}`).sort();
  assert.deepEqual(results, ["d0000002:succeeded", "d0000003:skipped"]);
  s.world.runs.set("r0000001", run("r0000001", "d0000001", "failed"));
  s.world.deploys[3] = deploy("d0000004", "demo-site", { state: "approved", answeredAt: NOW, runId: "r0000004", channel: "app" });
  s.world.runs.set("r0000004", run("r0000004", "d0000004", "stopped"));
  await d.tick();
  const more = s.bodies().filter((p) => p.t === "deploy.result").map((p) => `${p.id}:${p.o}`).sort();
  assert.deepEqual(more, ["d0000001:failed", "d0000002:succeeded", "d0000003:skipped", "d0000004:failed"]);
  await d.tick();
  assert.equal(s.bodies().filter((p) => p.t === "deploy.result").length, 4, "once each");
  assert.ok(s.bodies().filter((p) => p.t === "deploy.result").every((p) => p.title.startsWith("Deploy ") && p.p === "demo-site"));
});

test("a device with deploys off gets no deploy.result and one with approvals off no approval.new", async () => {
  const s = setup();
  s.device("noDeploys", "upAaaaaaaaaa", { deploys: false });
  s.device("noApprovals", "upBbbbbbbbbb", { approvals: false });
  s.world.deploys.push(deploy("d0000001", "demo-site"));
  const d = s.mk();
  await d.tick();
  s.world.deploys[0] = deploy("d0000001", "demo-site", { state: "declined", answeredAt: NOW });
  s.world.actions.push(action("aaaa0001", "demo-site"));
  await d.tick();
  const byTopic = s.sent.map((x) => `${x.url.split("/")[3].split("?")[0]}:${JSON.parse(x.body).t}`).sort();
  assert.deepEqual(byTopic, ["upAaaaaaaaaa:approval.new", "upBbbbbbbbbb:deploy.result"]);
});

test("a Tokyo restart (a new dispatcher over the same db) sends nothing twice, and still sends what appeared while it was down", async () => {
  const db = new Database(":memory:");
  const world: World = { actions: [], deploys: [], missions: [], runs: new Map(), clock: { t: NOW } };
  const s1 = setup({ db, world });
  s1.device("a", "upAaaaaaaaaa");
  const d1 = s1.mk();
  await d1.tick(); // seed
  world.actions.push(action("aaaa0001", "demo-site"));
  await d1.tick();
  assert.equal(s1.sent.length, 1);
  // restart: nothing new
  const s2 = setup({ db, world });
  await s2.mk().tick();
  assert.equal(s2.sent.length, 0, "the offer already pushed is not sent again");
  // restart again with an offer created during the downtime
  world.actions.push(action("aaaa0002", "demo-site"));
  const s3 = setup({ db, world });
  await s3.mk().tick();
  assert.deepEqual(s3.bodies().map((p) => p.id), ["aaaa0002"], "exactly once, not swallowed by a re-seed");
  const s4 = setup({ db, world });
  await s4.mk().tick();
  assert.equal(s4.sent.length, 0);
});

test("the outbox unique key also stops a double enqueue when the seen mark was lost", async () => {
  const s = setup();
  const a = s.device("a", "upAaaaaaaaaa");
  const d = s.mk();
  await d.tick();
  s.world.actions.push(action("aaaa0001", "demo-site"));
  await d.tick();
  s.db.prepare("DELETE FROM control_push_seen WHERE key <> '__seeded__'").run();
  await d.tick();
  assert.equal(s.sent.length, 1);
  assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM control_push_outbox WHERE device_id = ?").get(a.id) as { n: number }).n, 1);
});

test("with push off (no config) nothing is queued or sent", async () => {
  const s = setup({ config: null });
  s.device("a", "upAaaaaaaaaa");
  const d = s.mk();
  await d.tick();
  s.world.actions.push(action("aaaa0001", "demo-site"));
  await d.tick();
  assert.equal(s.sent.length, 0);
  assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM control_push_outbox").get() as { n: number }).n, 0);
});

test("a source that throws is logged by name once and does not stop the others", async () => {
  const s = setup();
  s.device("a", "upAaaaaaaaaa");
  const d = new Dispatcher({
    store: s.store, publisher: s.publisher, now: () => NOW, format: () => "up", log: (m) => s.logs.push(m),
    sources: [{ name: "broken", read: () => { throw new Error("boom with tk_SECRETSECRET"); } }, offersSource({ offers: { now: () => NOW, listActions: () => s.world.actions, listDeploys: () => [], listMissions: () => [] }, getRun: () => undefined })],
  });
  await d.tick();
  s.world.actions.push(action("aaaa0001", "demo-site"));
  await d.tick();
  await d.tick();
  assert.equal(s.sent.length, 1);
  assert.equal(s.logs.filter((l) => l.includes("broken")).length, 1, "once per outage");
  assert.ok(s.logs.every((l) => !l.includes("SECRET")), "the error text is not logged");
});

test("a payload the gate refuses is counted, not sent, and not retried", async () => {
  const s = setup();
  s.device("a", "upAaaaaaaaaa");
  const d = s.mk();
  await d.tick();
  s.world.actions.push(action("aaaa0001", "tk_leaky"), action("aaaa0002", "fine"));
  await d.tick();
  await d.tick();
  assert.deepEqual(s.bodies().map((p) => p.id), ["aaaa0002"]);
  assert.equal(d.stats.gateRejected, 1);
});

test("start schedules ticks on the injected interval and stop clears it", () => {
  const s = setup();
  const calls: { ms: number; cleared: boolean }[] = [];
  const d = new Dispatcher({
    store: s.store, publisher: s.publisher, sources: [], now: () => NOW, format: () => "up", log: () => {},
    timers: { set: (_fn, ms) => { calls.push({ ms, cleared: false }); return calls.length - 1; }, clear: (h) => { calls[h as number].cleared = true; } },
  });
  d.start(1234);
  d.start(1234);
  assert.deepEqual(calls, [{ ms: 1234, cleared: false }], "a second start is a no-op");
  d.stop();
  assert.equal(calls[0].cleared, true);
});

test("overlapping ticks do not run twice at once", async () => {
  const s = setup();
  s.device("a", "upAaaaaaaaaa");
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const d = new Dispatcher({
    store: s.store, publisher: s.publisher, now: () => NOW, format: () => "up", log: () => {},
    sources: [{ name: "slow", read: async () => { reads += 1; await gate; return []; } }],
  });
  const first = d.tick();
  const second = d.tick();
  release();
  await Promise.all([first, second]);
  assert.equal(reads, 1);
});
