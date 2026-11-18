import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

// claude-runner imports db.ts, which opens its file at load time: point it at a scratch file, seeded with a laptop_queue
// table and row as they were before the control link columns existed (the migration case).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokyo-runner-queue-"));
process.env.TOKYO_DB_PATH = path.join(dir, "life.db");
process.env.TELEGRAM_USER_ID = "42";
{
  const old = new Database(process.env.TOKYO_DB_PATH);
  old.exec(`
    CREATE TABLE laptop_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, prompt TEXT NOT NULL, reason TEXT, chat_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT ('pending'), started_at INTEGER, finished_at INTEGER, output TEXT
    );
    INSERT INTO laptop_queue (project, prompt, reason, chat_id, created_at, status) VALUES ('up', 'old row prompt', 'old', 42, 1, 'pending');
  `);
  old.close();
}

let runner: typeof import("./claude-runner");
let dbmod: typeof import("./db");
const sent: any[] = [];
const bot: any = {
  callbackQuery: () => {},
  api: {
    sendMessage: async (chatId: number, text: string, o?: any) => { sent.push({ chatId, text, markup: o?.reply_markup?.inline_keyboard }); return { message_id: sent.length }; },
    editMessageText: async () => true,
  },
};

before(async () => {
  const waPath = require.resolve("./whatsapp");
  require.cache[waPath] = { id: waPath, filename: waPath, loaded: true, exports: { sendWhatsAppMessage: async () => {} } } as any;
  dbmod = await import("./db");
  // initDatabase() cannot bootstrap a scratch file; the queue's own migration is what is under test.
  (await import("./laptop-open")).ensureLaptopQueue(dbmod.default);
  runner = await import("./claude-runner");
  // registerClaudeRunner sets runnerBot and starts the 60 s drain timer; unref it so the test process can exit.
  const realSetInterval = global.setInterval;
  global.setInterval = ((fn: any, ms: any) => realSetInterval(fn, ms).unref()) as any;
  runner.registerClaudeRunner(bot);
  global.setInterval = realSetInterval;
});

type RunArgs = Parameters<typeof import("./claude-runner").runnerHooks.run>;

test("an old queue row without the link columns is migrated and still drains", async () => {
  const cols = (dbmod.default.prepare("PRAGMA table_info(laptop_queue)").all() as any[]).map((c) => c.name);
  assert.ok(cols.includes("control_run_id") && cols.includes("offer_id"), "additive columns exist after load");
  const calls: RunArgs[] = [];
  runner.runnerHooks.reach = async () => true;
  runner.runnerHooks.run = (async (...a: RunArgs) => { calls.push(a); return { ok: true, output: "ok" }; }) as any;
  await runner.drainOnce(bot);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![3], "old row prompt");
  assert.equal(calls[0]![8], undefined, "no control run id for an old row");
  assert.equal(calls[0]![9], undefined, "no offer id for an old row");
  const row = dbmod.default.prepare("SELECT status, control_run_id, offer_id FROM laptop_queue WHERE id = 1").get() as any;
  assert.deepEqual(row, { status: "done", control_run_id: null, offer_id: null });
});

test("a deploy approved while the Mac is offline keeps its run row: queued, then the same id running, then succeeded; X12 follows it", async () => {
  const { ControlStore } = await import("./control/store");
  const { recordRunStarted, recordRunFinished } = await import("./control/runs");
  const { deployProgress, DEPLOY_START_TIMEOUT_MS } = await import("./control/ops-deploy");
  const store = new ControlStore(dbmod.default);

  runner.runnerHooks.reach = async () => false;
  const offered = await runner.offerDeployFromSession("up", "ship it", "test");
  assert.equal(offered.ok, true);
  const offerId = offered.ok ? offered.id : "";
  const answer = await runner.answerDeployOfferDetailed(offerId, "deploy", "app");
  assert.equal(answer.status, "applied");
  for (let i = 0; i < 50 && !dbmod.default.prepare("SELECT 1 FROM laptop_queue WHERE offer_id = ?").get(offerId); i++) await new Promise((r) => setTimeout(r, 10));

  const offer = runner.deployOfferStatus(offerId);
  assert.equal(offer?.state, "approved");
  assert.match(offer?.runId ?? "", /^[0-9a-f]{8}$/, "status names the run the approval started");
  const q = dbmod.default.prepare("SELECT * FROM laptop_queue WHERE offer_id = ?").get(offerId) as any;
  assert.ok(q, "the approval was queued for the Mac");
  assert.equal(q.status, "pending");
  const runId = q.control_run_id as string;
  assert.match(runId, /^[0-9a-f]{8}$/, "the queue row carries the control run id");
  assert.equal(store.getRun(runId)?.status, "queued");
  assert.equal(store.getRun(runId)?.offerId, offerId);
  assert.equal(dbmod.laptopTaskOpenForRun(runId), true);
  assert.equal(dbmod.laptopTaskOpenForRun("ffffffff"), false);

  // Past the start timeout the run is still waiting for the Mac, so X12 must not say `expired`.
  const o = { id: offerId, project: { name: "up" }, chatId: 42, createdAt: Date.now(), state: "approved", channel: "app", answeredAt: Date.now() - DEPLOY_START_TIMEOUT_MS - 1, runId } as any;
  const later = Date.now();
  assert.equal(deployProgress(o, store.getRun(runId), later).outcome, "expired", "without a queue row the old rule applies");
  assert.equal(deployProgress(o, store.getRun(runId), later, true).outcome, "pending", "a laptop queue row for the run is still waiting");

  // The Mac is back: the drainer starts the run under the same id and offer.
  const seen: { runId?: string; offerId?: string; runningStatus?: string } = {};
  runner.runnerHooks.reach = async () => true;
  runner.runnerHooks.run = (async (_b: any, _c: number, project: any, prompt: string, _l: string, _w: any, _r: boolean, _v: any, controlRunId?: string, oid?: string) => {
    seen.runId = controlRunId; seen.offerId = oid;
    recordRunStarted(store, { id: controlRunId!, project: project.name, host: "mac", prompt, model: "m", tier: null, label: "ws", now: Date.now(), offerId: oid });
    seen.runningStatus = store.getRun(controlRunId!)?.status;
    assert.equal(deployProgress(o, store.getRun(controlRunId!), later, true).outcome, "running");
    recordRunFinished(store, controlRunId!, { ok: true, exitCode: 0, now: Date.now() });
    return { ok: true, output: "deployed" };
  }) as any;
  await runner.drainOnce(bot);
  assert.deepEqual(seen, { runId, offerId, runningStatus: "running" });
  assert.equal(store.getRun(runId)?.status, "succeeded", "the same row, not a new unlinked one");
  assert.equal(store.getRun(runId)?.offerId, offerId);
  assert.equal(deployProgress(o, store.getRun(runId), later).outcome, "succeeded");
  assert.equal(dbmod.laptopTaskOpenForRun(runId), false, "a finished queue row no longer holds the run open");
  const total = (dbmod.default.prepare("SELECT COUNT(*) AS n FROM control_runs").get() as any).n;
  assert.equal(total, 1, "no second run row was created");
});

test("a remote deploy pins the sha at ask time, and skips as already live when the host HEAD is that sha", async () => {
  const SHA = "5a1d80f28d70cf8bce647d35f2c2f9308b31837d";
  let ran = 0;
  runner.runnerHooks.resolveSha = async () => SHA;
  runner.runnerHooks.liveHead = async () => SHA;
  runner.runnerHooks.reach = async () => { ran++; return false; };
  runner.runnerHooks.run = (async () => { ran++; return { ok: true, output: "" }; }) as any;
  const offered = await runner.offerDeployFromSession("acme-site", "ship it", "test");
  assert.equal(offered.ok, true);
  const id = offered.ok ? offered.id : "";
  assert.equal(runner.deployOfferStatus(id)?.sha, SHA, "main was resolved when the offer was made");
  sent.length = 0;
  const ans = await runner.answerDeployOfferDetailed(id, "deploy", "terminal");
  assert.equal(ans.status, "applied");
  assert.match(ans.status === "applied" ? ans.reply : "", /already live/i);
  assert.equal(ran, 0, "nothing was started");
  assert.equal(runner.deployOfferStatus(id)?.runId, undefined);
  assert.ok(sent.some((m) => /already live/i.test(m.text) && m.text.includes("5a1d80f2")), "reported on Telegram");

  // An explicit sha wins over main, and is not resolved again.
  runner.runnerHooks.resolveSha = async () => { throw new Error("must not resolve"); };
  const o2 = await runner.offerDeployFromSession("acme-site", "x", "test", "abcdef1234567");
  assert.equal(o2.ok && runner.deployOfferStatus(o2.id)?.sha, "abcdef1234567");
});

test("a remote offer is refused when its sha cannot be pinned, from a session and after a Tokyo run", async () => {
  runner.runnerHooks.resolveSha = async () => undefined;
  sent.length = 0;
  const r = await runner.offerDeployFromSession("acme-site", "x", "test");
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /pin|sha/i);
  assert.equal(sent.filter((m) => /Deploy it\?/.test(m.text)).length, 0, "no card without a sha");
  runner.runnerHooks.resolveSha = async () => { throw new Error("ssh down"); };
  assert.equal((await runner.offerDeployFromSession("acme-site", "x", "test")).ok, false);

  const { getProject } = await import("./project-registry");
  const pend: any = { project: getProject("acme-site"), prompt: "do work", reason: "t", chatId: 42, createdAt: Date.now(), variant: "kb-dev" };
  await runner.offerDeployAfterRun(bot, pend);
  assert.equal(sent.filter((m) => /Deploy it\?/.test(m.text)).length, 0, "no card after a run either");
  assert.ok(sent.some((m) => /sha/i.test(m.text) && /acme-site/.test(m.text)), "the owner is told why");
});

test("an offer made after a Tokyo run pins the sha the same way", async () => {
  const SHA = "5a1d80f28d70cf8bce647d35f2c2f9308b31837d";
  runner.runnerHooks.resolveSha = async () => SHA;
  sent.length = 0;
  const { getProject } = await import("./project-registry");
  const pend: any = { project: getProject("acme-site"), prompt: "do work", reason: "t", chatId: 42, createdAt: Date.now(), variant: "kb-dev" };
  await runner.offerDeployAfterRun(bot, pend);
  const card = sent.find((m) => /Deploy it\?/.test(m.text));
  assert.ok(card, "card sent");
  const id = String(card.markup[0][0].callback_data).split(":")[1]!;
  assert.equal(runner.deployOfferStatus(id)?.sha, SHA);
});
