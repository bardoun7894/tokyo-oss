import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { ControlStore, type ControlRun } from "../store";
import { OpsStore } from "../ops-store";
import { Dispatcher } from "./dispatcher";
import { Publisher, type FetchLike } from "./publisher";
import { incidentsSource, runsSource } from "./sources";
import { PushStore, type NotifyPrefs } from "./store";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const BASE = "https://ntfy.203-0-113-10.sslip.io";

const run = (id: string, status: ControlRun["status"], project = "demo-site"): ControlRun => ({
  id, project, source: "tokyo", status, model: null, harness: null, worker: null, tier: null, promptPreview: "", startedAt: NOW - 1000, endedAt: status === "running" || status === "queued" ? null : NOW,
  exitCode: null, host: "server", offerId: null, workspace: null,
});
const incident = (id: string, over: Record<string, unknown> = {}) => ({
  id, kind: "check", title: `docker: ${id}`, subtitle: "", severity: "critical", state: "open", project: "demo-site",
  firstAt: "2026-10-17T11:00:00.000Z", lastAt: "2026-10-17T11:30:00.000Z", ...over,
});

function setup() {
  const db = new Database(":memory:");
  const control = new ControlStore(db);
  const store = new PushStore(db);
  const ops = new OpsStore(db);
  const state = { runs: [] as ControlRun[], items: [] as any[], reachable: true, stopped: new Map<string, string>() };
  const sent: any[] = [];
  const fetch: FetchLike = async (url, init) => { sent.push({ topic: url.split("/")[3].split("?")[0], payload: JSON.parse(String(init.body)) }); return { status: 200 }; };
  const logs: string[] = [];
  const publisher = new Publisher({ store, config: () => ({ baseUrl: BASE, publishToken: "tk_x0123456789", format: "up" }), fetch, now: () => NOW, log: () => {}, retryDelayMs: 0 });
  const sources = [
    runsSource({ listRuns: () => state.runs, stoppedBy: (id) => state.stopped.get(id) }),
    incidentsSource({ godhome: { summary: async () => ({ reachable: state.reachable, data: state.reachable ? { incidents: { items: state.items } } : null }) }, ops, now: () => NOW }),
  ];
  const dispatcher = new Dispatcher({ store, publisher, sources, now: () => NOW, format: () => "up", log: (m) => logs.push(m) });
  const device = (name: string, prefs: Partial<NotifyPrefs> = {}) => {
    const d = control.createDevice({ name, tokenHash: "h-" + name, now: NOW });
    store.register(d.id, "up" + name.padEnd(10, "x"), undefined, NOW);
    store.setPrefs(d.id, { ...store.getPrefs(d.id), ...prefs }, NOW);
    return d;
  };
  const topicOf = (d: { name: string }) => "up" + d.name.padEnd(10, "x");
  return { db, ops, state, sent, logs, dispatcher, device, topicOf };
}

test("a run turning succeeded is run.finished; failed and stopped are run.failed; running and queued are silent", async () => {
  const s = setup();
  s.device("a");
  s.state.runs = [run("11111111", "running"), run("22222222", "queued")];
  await s.dispatcher.tick(); // seed
  s.state.runs = [run("11111111", "succeeded"), run("22222222", "failed", "demo-app"), run("33333333", "stopped"), run("44444444", "running")];
  await s.dispatcher.tick();
  const got = s.sent.map((x) => x.payload).map((p) => `${p.t}:${p.id}:${p.o}:${p.p}`).sort();
  assert.deepEqual(got, ["run.failed:22222222:failed:demo-app", "run.failed:33333333:stopped:demo-site", "run.finished:11111111:succeeded:demo-site"]);
  await s.dispatcher.tick();
  assert.equal(s.sent.length, 3, "once each");
  assert.ok(s.sent.every((x) => /^(Run finished|Run failed|Run stopped): /.test(x.payload.title)));
});

test("a run stopped from the app does not push to the device that stopped it, only to the others", async () => {
  const s = setup();
  const a = s.device("a");
  const b = s.device("b");
  await s.dispatcher.tick();
  s.state.runs = [run("33333333", "stopped")];
  s.state.stopped.set("33333333", a.id);
  await s.dispatcher.tick();
  assert.deepEqual(s.sent.map((x) => x.topic), [s.topicOf(b)]);
});

test("a device with runs off gets no run events", async () => {
  const s = setup();
  s.device("quiet", { runs: false });
  await s.dispatcher.tick();
  s.state.runs = [run("11111111", "failed")];
  await s.dispatcher.tick();
  assert.equal(s.sent.length, 0);
});

test("incident levels: Critical sends criticals only, Critical + Warning sends both, Off sends nothing", async () => {
  const s = setup();
  const crit = s.device("crit", { incidents: "critical" });
  const warn = s.device("warn", { incidents: "warning" });
  s.device("off", { incidents: "off" });
  await s.dispatcher.tick();
  s.state.items = [incident("check:docker:a:1", { severity: "critical" }), incident("check:docker:b:1", { severity: "warning" }), incident("check:docker:c:1", { severity: "notice" })];
  await s.dispatcher.tick();
  const byTopic = (t: string) => s.sent.filter((x) => x.topic === t).map((x) => x.payload.s).sort();
  assert.deepEqual(byTopic(s.topicOf(crit)), ["critical"]);
  assert.deepEqual(byTopic(s.topicOf(warn)), ["critical", "warning"]);
  assert.equal(s.sent.length, 3);
  assert.ok(s.sent.every((x) => x.payload.t === "incident.new" && /^i_[0-9a-f]{12}$/.test(x.payload.id) && x.payload.title.startsWith("Incident: ")));
});

test("acked, muted and manually resolved incidents never push; agent incidents and notices neither", async () => {
  const s = setup();
  s.device("a", { incidents: "warning" });
  await s.dispatcher.tick();
  const ids = ["check:docker:acked:1", "check:docker:muted:1", "check:docker:resolved:1", "check:docker:live:1"];
  const opaque = Object.fromEntries(ids.map((id) => [id, s.ops.opaqueId(id, NOW)]));
  s.ops.ack(opaque[ids[0]], ids[0], "check", "d_00000001", NOW);
  s.ops.mute(`check:docker:${ids[1]}`, NOW + 3600_000, "d_00000001", NOW);
  s.ops.resolve(opaque[ids[2]], ids[2], "check", Date.parse("2026-10-17T11:30:00.000Z"), "d_00000001", NOW);
  s.state.items = [...ids.map((id) => incident(id)), incident("agent:x:1", { kind: "agent" })];
  await s.dispatcher.tick();
  assert.deepEqual(s.sent.map((x) => x.payload.id), [opaque[ids[3]]]);
});

test("the same open episode never pushes twice, a later lastAt included; a new episode does", async () => {
  const s = setup();
  s.device("a");
  await s.dispatcher.tick();
  s.state.items = [incident("check:docker:a:100")];
  await s.dispatcher.tick();
  s.state.items = [incident("check:docker:a:100", { lastAt: "2026-10-17T11:59:00.000Z", count: 9 })];
  await s.dispatcher.tick();
  assert.equal(s.sent.length, 1);
  s.state.items = [incident("check:docker:a:200", { firstAt: "2026-10-17T11:45:00.000Z" })];
  await s.dispatcher.tick();
  assert.equal(s.sent.length, 2);
});

test("incident text is scrubbed: a path in the title does not reach the payload", async () => {
  const s = setup();
  s.device("a");
  await s.dispatcher.tick();
  s.state.items = [incident("check:disk:a:1", { title: "disk: /var/lib/docker/overlay2 at 95%" })];
  await s.dispatcher.tick();
  assert.equal(s.sent.length, 1);
  assert.ok(!JSON.stringify(s.sent[0].payload).includes("/var"));
});

test("GodHome unreachable: no incident events, one log line for the whole outage, and no seeding from the outage", async () => {
  const s = setup();
  s.device("a");
  s.state.reachable = false;
  s.state.items = [incident("check:docker:a:1")];
  for (let i = 0; i < 5; i++) await s.dispatcher.tick();
  assert.equal(s.sent.length, 0);
  assert.equal(s.logs.filter((l) => l.includes("incidents")).length, 1);
  // GodHome returns with an incident that was already open: the first good read seeds it silently
  s.state.reachable = true;
  await s.dispatcher.tick();
  assert.equal(s.sent.length, 0);
  s.state.items.push(incident("check:docker:b:2", { firstAt: "2026-10-17T11:50:00.000Z" }));
  await s.dispatcher.tick();
  assert.equal(s.sent.length, 1);
  // a second outage logs once more
  s.state.reachable = false;
  await s.dispatcher.tick(); await s.dispatcher.tick();
  assert.equal(s.logs.filter((l) => l.includes("incidents")).length, 2);
});
