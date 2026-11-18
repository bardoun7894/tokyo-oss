import { test } from "node:test";
import assert from "node:assert/strict";
import type { HerdrHost } from "../herdr-run";
import { recordRunFailedToStart, recordRunFinished, recordRunQueued, recordRunStarted } from "./runs";
import { ControlStore } from "./store";
import { controlApp } from "./test-app";
import Database from "better-sqlite3";

const T0 = Date.parse("2026-10-09T09:00:00Z");
const ID = "0a1b2c3d";
const line = (o: unknown) => JSON.stringify(o) + "\n";
const INIT = line({ type: "system", subtype: "init", model: "claude-sonnet-5-5" });
const TEXT = line({ type: "assistant", message: { content: [{ type: "text", text: "Reading the spec" }] } });
const TOOL = line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } });
const RESULT = line({ type: "result", result: "Done. Fixed and committed.", is_error: false });

const run = (id: string, over: Record<string, unknown> = {}) => ({
  id, project: "tokyo", source: "tokyo" as const, status: "running" as const, model: null, harness: "claude", worker: null, tier: null,
  promptPreview: "p", startedAt: T0, endedAt: null, exitCode: null, host: "server" as const, offerId: null, workspace: `tokyo-run-${id}`, ...over,
});

// An in-memory herdr host; `files[id]` is the run.jsonl content, `exits[id]` the exit_code.
function fakeHost(files: Record<string, string>, exits: Record<string, string> = {}) {
  const stopped: string[] = [];
  let reads = 0;
  const host: HerdrHost = {
    dir: (id) => `/x/${id}`,
    prepare: async () => {}, start: async () => {},
    read: async (id, f) => (f === "exit_code" ? exits[id] ?? null : files[id] ?? null),
    readFrom: async (id, offset, maxBytes) => {
      reads++;
      const buf = Buffer.from(files[id] ?? "").subarray(offset, offset + maxBytes);
      const nl = buf.lastIndexOf(0x0a);
      const used = nl + 1;
      return { text: buf.subarray(0, used).toString(), offset: offset + used };
    },
    size: async (id) => (id in files ? Buffer.byteLength(files[id]) : null),
    stop: async (label) => { stopped.push(label); },
  };
  return { host, stopped, files, exits, reads: () => reads };
}

async function setup(files: Record<string, string> = {}, exits: Record<string, string> = {}, over: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {}) {
  const f = fakeHost(files, exits);
  const clock = { t: T0 };
  const app = await controlApp({
    now: () => clock.t,
    runs: { hostFor: () => f.host, now: over.now ?? (() => clock.t), sleep: over.sleep ?? (async (ms) => { clock.t += ms; }) },
  });
  return { ...app, f, clock };
}

// --- recording ---

test("start then finish record queued → running → succeeded with every field", () => {
  const store = new ControlStore(new Database(":memory:"));
  store.insertRun(run(ID, { status: "queued", workspace: null, model: null }));
  recordRunStarted(store, { id: ID, project: "tokyo", host: "server", prompt: "do it", model: "claude-opus-5-5", tier: "hard", label: `tokyo-run-${ID}`, now: T0 + 5 });
  let r = store.getRun(ID)!;
  assert.deepEqual([r.status, r.model, r.harness, r.worker, r.tier, r.workspace, r.source, r.host], ["running", "claude-opus-5-5", "claude", `tokyo-run-${ID}`, "hard", `tokyo-run-${ID}`, "tokyo", "server"]);
  recordRunFinished(store, ID, { ok: true, exitCode: 0, model: "claude-sonnet-5-5", now: T0 + 99 });
  r = store.getRun(ID)!;
  assert.deepEqual([r.status, r.exitCode, r.endedAt, r.model], ["succeeded", 0, T0 + 99, "claude-sonnet-5-5"]);
});

test("start inserts a row when none exists, and a failed run is recorded failed with a null exit code", () => {
  const store = new ControlStore(new Database(":memory:"));
  recordRunStarted(store, { id: ID, project: "up", host: "mac", prompt: "x".repeat(500), model: "m", tier: null, label: "w", now: T0 });
  assert.equal(store.getRun(ID)!.promptPreview.length, 200);
  assert.equal(store.getRun(ID)!.tier, null);
  recordRunFinished(store, ID, { ok: false, exitCode: null, now: T0 + 1 });
  const r = store.getRun(ID)!;
  assert.deepEqual([r.status, r.exitCode, r.model], ["failed", null, "m"]);
});

test("T3.1: a deploy run carries its offer id, on insert and when it adopts a queued row; other runs keep offer_id as is", () => {
  const store = new ControlStore(new Database(":memory:"));
  recordRunStarted(store, { id: ID, project: "tokyo", host: "server", prompt: "deploy", model: "m", tier: null, label: "w", now: T0, offerId: "a1b2c3d4" });
  assert.equal(store.getRun(ID)!.offerId, "a1b2c3d4");
  const queued = "0a1b2c3e";
  store.insertRun(run(queued, { status: "queued", workspace: null }));
  recordRunStarted(store, { id: queued, project: "tokyo", host: "server", prompt: "deploy", model: "m", tier: null, label: "w", now: T0, offerId: "b2c3d4e5" });
  assert.equal(store.getRun(queued)!.offerId, "b2c3d4e5");
  const spec = "0a1b2c3f";
  store.insertRun(run(spec, { status: "queued", workspace: null, offerId: "c3d4e5f6" }));
  recordRunStarted(store, { id: spec, project: "tokyo", host: "server", prompt: "x", model: "m", tier: null, label: "w", now: T0 });
  assert.equal(store.getRun(spec)!.offerId, "c3d4e5f6", "a write-spec run keeps the offer it was queued with");
  const plain = "0a1b2c40";
  recordRunStarted(store, { id: plain, project: "tokyo", host: "server", prompt: "x", model: "m", tier: null, label: "w", now: T0 });
  assert.equal(store.getRun(plain)!.offerId, null);
});

test("a run Tokyo marked stopped is not overwritten when the herdr poll later ends", () => {
  const store = new ControlStore(new Database(":memory:"));
  store.insertRun(run(ID, { status: "stopped", endedAt: T0 + 5 }));
  recordRunFinished(store, ID, { ok: false, exitCode: null, now: T0 + 50 });
  assert.deepEqual([store.getRun(ID)!.status, store.getRun(ID)!.endedAt], ["stopped", T0 + 5]);
});

test("a run that never started is marked failed", () => {
  const store = new ControlStore(new Database(":memory:"));
  store.insertRun(run(ID, { status: "queued", workspace: null }));
  recordRunFailedToStart(store, ID, T0 + 7);
  assert.deepEqual([store.getRun(ID)!.status, store.getRun(ID)!.endedAt], ["failed", T0 + 7]);
  recordRunFailedToStart(store, "ffffffff", T0); // unknown id: no-op
});

test("recordRunQueued writes a queued row with its offer; start adopts it; a failed herdr start closes it as failed", () => {
  const store = new ControlStore(new Database(":memory:"));
  recordRunQueued(store, { id: ID, project: "tokyo", host: "server", prompt: "Deploy /root/secret/x now", now: T0, offerId: "a1b2c3d4" });
  const q = store.getRun(ID)!;
  assert.deepEqual([q.status, q.offerId, q.workspace, q.worker, q.endedAt, q.host, q.source], ["queued", "a1b2c3d4", null, null, null, "server", "tokyo"]);
  recordRunQueued(store, { id: ID, project: "tokyo", host: "mac", prompt: "again", now: T0 + 9, offerId: "ffffffff" });
  assert.deepEqual([store.getRun(ID)!.offerId, store.getRun(ID)!.host], ["a1b2c3d4", "server"], "a second call never overwrites the row");
  recordRunStarted(store, { id: ID, project: "tokyo", host: "server", prompt: "x", model: "m", tier: null, label: "w", now: T0 + 5, offerId: "a1b2c3d4" });
  assert.deepEqual([store.getRun(ID)!.status, store.getRun(ID)!.workspace, store.getRun(ID)!.offerId], ["running", "w", "a1b2c3d4"]);
  const failed = "0a1b2c40";
  recordRunQueued(store, { id: failed, project: "tokyo", host: "mac", prompt: "x", now: T0, offerId: "a1b2c3d5" });
  recordRunFinished(store, failed, { ok: false, exitCode: null, now: T0 + 3 });
  assert.deepEqual([store.getRun(failed)!.status, store.getRun(failed)!.endedAt, store.getRun(failed)!.offerId], ["failed", T0 + 3, "a1b2c3d5"]);
});

// --- list and detail ---

test("GET /runs filters by project, status, limit, before and since, newest first", async () => {
  const s = await setup();
  s.store.insertRun(run("aaaaaaa1", { project: "a", status: "succeeded", startedAt: T0, endedAt: T0 + 1 }));
  s.store.insertRun(run("aaaaaaa2", { project: "b", status: "failed", startedAt: T0 + 1000, endedAt: T0 + 2000 }));
  s.store.insertRun(run("aaaaaaa3", { project: "a", status: "running", startedAt: T0 + 2000 }));
  const ids = async (q: string) => (await s.get("/runs" + q)).json.runs.map((x: any) => x.id);
  assert.deepEqual(await ids(""), ["aaaaaaa3", "aaaaaaa2", "aaaaaaa1"]);
  assert.deepEqual(await ids("?project=a"), ["aaaaaaa3", "aaaaaaa1"]);
  assert.deepEqual(await ids("?status=failed"), ["aaaaaaa2"]);
  assert.deepEqual(await ids("?limit=1"), ["aaaaaaa3"]);
  assert.deepEqual(await ids(`?before=${new Date(T0 + 2000).toISOString()}`), ["aaaaaaa2", "aaaaaaa1"]);
  assert.deepEqual(await ids(`?since=${new Date(T0 + 1500).toISOString()}`), ["aaaaaaa3", "aaaaaaa2"]);
  assert.equal((await s.get("/runs?status=nope")).status, 400);
  await s.close();
});

test("GET /runs/:id returns the run, 404 for unknown or malformed ids; workspace is not exposed", async () => {
  const s = await setup();
  s.store.insertRun(run(ID, { model: "claude-sonnet-5-5", tier: "medium", worker: "w1" }));
  const r = await s.get(`/runs/${ID}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.id, ID);
  assert.equal(r.json.model, "claude-sonnet-5-5");
  assert.equal(r.json.status, "running");
  assert.equal("workspace" in r.json, false);
  assert.equal((await s.get("/runs/ffffffff")).status, 404);
  assert.equal((await s.get("/runs/..%2Fx")).status, 404);
  await s.close();
});

// --- T3.5: actions[] on run rows (spec section 5) ---

const WATCHED = {
  id: "8f403b3a", project: "shop", source: "server-agent", status: "running", model: null, harness: null, worker: "dpi", tier: null,
  promptPreview: "INC-1", startedAt: T0 + 10, endedAt: null, exitCode: null, host: "server", offerId: null,
};
async function setupWithMonitor(rows: Record<string, unknown>[]) {
  const f = fakeHost({});
  const monitor = { refresh: async () => {}, listRuns: () => rows, getRun: (id: string) => rows.find((r) => r.id === id), listOffers: () => [] } as any;
  const app = await controlApp({ now: () => T0, runs: { hostFor: () => f.host, now: () => T0 }, monitor });
  return app;
}
/** The actions of one run, from the list and from the detail route; the two must agree. */
async function actionsOf(s: { get: (p: string) => Promise<any> }, id: string): Promise<string[]> {
  const detail = (await s.get(`/runs/${id}`)).json.actions;
  const row = (await s.get("/runs?limit=100")).json.runs.find((x: any) => x.id === id);
  assert.deepEqual(row.actions, detail, `list and detail agree for ${id}`);
  return detail;
}

test("T3.5: S1 rows with a workspace get stop while running and log always; queued rows and finished rows lose what does not apply", async () => {
  const s = await setup();
  s.store.insertRun(run("aaaaaaa1"));
  s.store.insertRun(run("aaaaaaa2", { status: "succeeded", endedAt: T0 + 5, exitCode: 0 }));
  s.store.insertRun(run("aaaaaaa3", { status: "failed", endedAt: T0 + 5, exitCode: 1 }));
  s.store.insertRun(run("aaaaaaa4", { status: "stopped", endedAt: T0 + 5 }));
  s.store.insertRun(run("aaaaaaa5", { status: "queued", workspace: null }));
  assert.deepEqual(await actionsOf(s, "aaaaaaa1"), ["stop", "log"]);
  for (const id of ["aaaaaaa2", "aaaaaaa3", "aaaaaaa4"]) assert.deepEqual(await actionsOf(s, id), ["log"], id);
  assert.deepEqual(await actionsOf(s, "aaaaaaa5"), []);
  await s.close();
});

test("T3.5: S2 rows without a workspace (herdr, server-agent, jdelegate) have neither stop nor log; with a workspace they follow S1", async () => {
  const s = await setup();
  for (const [i, source] of (["herdr", "server-agent", "jdelegate"] as const).entries()) {
    s.store.insertRun(run(`bbbbbbb${i}`, { source, workspace: null }));
    s.store.insertRun(run(`ccccccc${i}`, { source, workspace: `herdr-${i}` }));
    assert.deepEqual(await actionsOf(s, `bbbbbbb${i}`), [], source);
    assert.deepEqual(await actionsOf(s, `ccccccc${i}`), ["stop", "log"], source);
  }
  await s.close();
});

test("T3.5: monitor runs (S3) are stoppable while running and have a log; a finished one only the log", async () => {
  const s = await setupWithMonitor([WATCHED, { ...WATCHED, id: "8f403b3b", status: "succeeded", endedAt: T0 + 20, exitCode: 0 }]);
  assert.deepEqual(await actionsOf(s, "8f403b3a"), ["stop", "log"]);
  assert.deepEqual(await actionsOf(s, "8f403b3b"), ["log"]);
  await s.close();
});

test("T3.5: no row ever gets retry (X13 was dropped), write-spec runs with an offer included; old fields are unchanged and workspace stays hidden", async () => {
  const s = await setup();
  s.store.insertRun(run("ddddddd1", { offerId: "a1b2c3d4" }));
  s.store.insertRun(run("ddddddd2", { status: "failed", endedAt: T0 + 5, exitCode: 1 }));
  const rows = (await s.get("/runs")).json.runs;
  assert.ok(rows.length >= 2);
  for (const x of rows) assert.ok(!x.actions.includes("retry"), x.id);
  const one = (await s.get("/runs/ddddddd1")).json;
  assert.deepEqual(Object.keys(one).sort(), ["actions", "endedAt", "exitCode", "harness", "host", "id", "model", "offerId", "project", "promptPreview", "source", "startedAt", "status", "tier", "worker"]);
  assert.equal(one.offerId, "a1b2c3d4");
  assert.equal("workspace" in one, false);
  await s.close();
});

// --- log ---

test("log parses stream-json into redacted events and advances the cursor", async () => {
  const secret = line({ type: "assistant", message: { content: [{ type: "text", text: "token ANTHROPIC_AUTH_TOKEN=abc123 in /home/tokyo-agent/x" }] } });
  const files = { [ID]: INIT + TEXT + TOOL + secret + RESULT };
  const s = await setup(files, { [ID]: "0" });
  s.store.insertRun(run(ID));
  const r = await s.get(`/runs/${ID}/log`);
  assert.equal(r.status, 200);
  const kinds = r.json.events.map((e: any) => e.kind);
  assert.deepEqual(kinds, ["system", "assistant", "tool", "assistant", "result"]);
  assert.equal(r.json.events[2].tool, "Bash");
  assert.match(r.json.events[2].text, /npm test/);
  assert.equal(r.json.events[1].tool, null);
  assert.doesNotMatch(JSON.stringify(r.json), /abc123|tokyo-agent/);
  assert.equal(r.json.cursor, String(Buffer.byteLength(files[ID])));
  assert.equal(r.json.status, "running");
  // second page: nothing new, exit_code exists, file drained
  const again = await s.get(`/runs/${ID}/log?after=${r.json.cursor}`);
  assert.deepEqual(again.json.events, []);
  assert.equal(again.json.cursor, r.json.cursor);
  assert.equal(again.json.done, true);
  await s.close();
});

test("log: after omitted starts at the last 64 KB and drops the partial first line", async () => {
  const filler = line({ type: "assistant", message: { content: [{ type: "text", text: "old ".repeat(30) }] } });
  const old = filler.repeat(1000); // ~130 KB
  const files = { [ID]: old + RESULT };
  const s = await setup(files);
  s.store.insertRun(run(ID));
  const r = await s.get(`/runs/${ID}/log?q=Done`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.events.map((e: any) => e.kind), ["result"]);
  const all = await s.get(`/runs/${ID}/log`);
  assert.ok(all.json.events.length > 100 && all.json.events.length <= 200);
  assert.ok(all.json.events.length < 1001);
  await s.close();
});

test("log: q filters events case-insensitively but the cursor still advances; max 200 events per response", async () => {
  const many = line({ type: "assistant", message: { content: [{ type: "text", text: "x" }] } }).repeat(250);
  const s = await setup({ [ID]: many + RESULT });
  s.store.insertRun(run(ID));
  const first = await s.get(`/runs/${ID}/log?after=0`);
  assert.equal(first.json.events.length, 200);
  const second = await s.get(`/runs/${ID}/log?after=${first.json.cursor}`);
  assert.equal(second.json.events.length, 51);
  assert.equal(second.json.cursor, String(Buffer.byteLength(many + RESULT)));
  const q = await s.get(`/runs/${ID}/log?after=0&q=DONE.%20fixed`);
  assert.deepEqual(q.json.events.map((e: any) => e.kind), ["result"]);
  await s.close();
});

test("log: bad cursor, wait or q is 400; unknown run is 404", async () => {
  const s = await setup({ [ID]: INIT });
  s.store.insertRun(run(ID));
  for (const q of ["after=-1", "after=abc", "after=1.5", "wait=26", "wait=-1", "wait=x", `q=${"a".repeat(201)}`]) {
    assert.equal((await s.get(`/runs/${ID}/log?${q}`)).status, 400, q);
  }
  assert.equal((await s.get("/runs/ffffffff/log")).status, 404);
  await s.close();
});

test("log wait: times out with events [] and the same cursor (fake clock), returns early when data arrives", async () => {
  const files: Record<string, string> = { [ID]: INIT };
  const clock = { t: T0 };
  let sleeps = 0;
  const s = await setup(files, {}, { now: () => clock.t, sleep: async (ms) => { sleeps++; clock.t += ms; if (sleeps === 3 && files.arrive) files[ID] += TEXT; } });
  s.store.insertRun(run(ID));
  const cursor = String(Buffer.byteLength(INIT));
  const timeout = await s.get(`/runs/${ID}/log?after=${cursor}&wait=6`);
  assert.deepEqual(timeout.json.events, []);
  assert.equal(timeout.json.cursor, cursor);
  assert.equal(timeout.json.done, false);
  assert.equal(sleeps, 3);
  assert.equal(clock.t - T0, 6000);

  files.arrive = "1"; // sets the flag the fake sleep checks; not a run file
  sleeps = 0;
  const early = await s.get(`/runs/${ID}/log?after=${cursor}&wait=25`);
  assert.equal(early.json.events.length, 1);
  assert.equal(early.json.events[0].kind, "assistant");
  assert.equal(sleeps, 3);
  await s.close();
});

test("log: a finished run without exit_code (stopped) is done once drained; a run with no log yet is empty, not an error", async () => {
  const s = await setup({ [ID]: INIT });
  s.store.insertRun(run(ID, { status: "stopped", endedAt: T0 + 1 }));
  const cur = String(Buffer.byteLength(INIT));
  const r = await s.get(`/runs/${ID}/log?after=${cur}`);
  assert.deepEqual([r.json.events, r.json.done, r.json.status], [[], true, "stopped"]);
  s.store.insertRun(run("bbbbbbb1"));
  const none = await s.get("/runs/bbbbbbb1/log");
  assert.deepEqual([none.status, none.json.events, none.json.cursor, none.json.done], [200, [], "0", false]);
  s.store.insertRun(run("jd-run-not-hex", { source: "jdelegate", status: "succeeded", endedAt: T0 + 1 }));
  const jd = await s.get("/runs/jd-run-not-hex/log");
  assert.deepEqual([jd.status, jd.json.events, jd.json.done], [200, [], true]);
  await s.close();
});

// --- stop ---

test("stop on a running run closes the workspace and marks it stopped even without exit_code", async () => {
  const s = await setup({ [ID]: INIT });
  s.store.insertRun(run(ID));
  const r = await s.post(`/runs/${ID}/stop`);
  assert.deepEqual([r.status, r.json], [200, { ok: true, status: "stopped" }]);
  assert.deepEqual(s.f.stopped, [`tokyo-run-${ID}`]);
  const row = s.store.getRun(ID)!;
  assert.deepEqual([row.status, row.endedAt], ["stopped", T0]);
  assert.equal((await s.get(`/runs/${ID}`)).json.status, "stopped");
  assert.equal((await s.get("/counts")).json.runningRuns, 0);
  await s.close();
});

test("stop on a finished or queued run is 409 conflict and closes nothing; unknown is 404", async () => {
  const s = await setup();
  s.store.insertRun(run(ID, { status: "succeeded", endedAt: T0 + 1 }));
  s.store.insertRun(run("bbbbbbb1", { status: "queued", workspace: null }));
  for (const id of [ID, "bbbbbbb1"]) {
    const r = await s.post(`/runs/${id}/stop`);
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, "conflict");
  }
  assert.equal((await s.post("/runs/ffffffff/stop")).status, 404);
  assert.deepEqual(s.f.stopped, []);
  await s.close();
});

test("stop: a run without a workspace is 409, and a failing kill leaves the row running (503)", async () => {
  const s = await setup();
  s.store.insertRun(run(ID, { workspace: null }));
  assert.equal((await s.post(`/runs/${ID}/stop`)).status, 409);
  s.store.insertRun(run("bbbbbbb1"));
  s.f.host.stop = async () => { throw new Error("hsess kill: gone"); };
  const r = await s.post("/runs/bbbbbbb1/stop");
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, "unavailable");
  assert.doesNotMatch(JSON.stringify(r.json), /hsess/);
  assert.equal(s.store.getRun("bbbbbbb1")!.status, "running");
  await s.close();
});

test("run routes need a device token", async () => {
  const s = await setup();
  for (const [m, p] of [["GET", `/runs/${ID}`], ["GET", `/runs/${ID}/log`], ["POST", `/runs/${ID}/stop`]] as const) {
    assert.equal((await s.srv.call(m, `/control-api/v1${p}`, m === "POST" ? {} : undefined)).status, 401);
  }
  await s.close();
});
