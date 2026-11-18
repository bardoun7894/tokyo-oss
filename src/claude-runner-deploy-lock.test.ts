import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// claude-runner imports db.ts, which opens its file at load time: point it at a scratch file.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokyo-runner-deploylock-"));
process.env.TOKYO_DB_PATH = path.join(dir, "life.db");
process.env.TELEGRAM_USER_ID = "42";

let runner: typeof import("./claude-runner");
const sent: string[] = [];
const bot: any = {
  callbackQuery: () => {},
  api: {
    sendMessage: async (_c: number, text: string) => { sent.push(text); return { message_id: sent.length }; },
    editMessageText: async () => true,
  },
};

before(async () => {
  const waPath = require.resolve("./whatsapp");
  require.cache[waPath] = { id: waPath, filename: waPath, loaded: true, exports: { sendWhatsAppMessage: async () => {} } } as any;
  const dbmod = await import("./db");
  (await import("./laptop-open")).ensureLaptopQueue(dbmod.default);
  runner = await import("./claude-runner");
  const realSetInterval = global.setInterval;
  global.setInterval = ((fn: any, ms: any) => realSetInterval(fn, ms).unref()) as any;
  runner.registerClaudeRunner(bot);
  global.setInterval = realSetInterval;
});

const tick = () => new Promise((r) => setTimeout(r, 20));

/** Every run the hook starts waits on a gate the test opens; `started` is the order they began in. */
function gatedRuns() {
  const started: { project: string; runId?: string }[] = [];
  const gates: (() => void)[] = [];
  runner.runnerHooks.reach = async () => true;
  runner.runnerHooks.run = (async (_b: any, _c: number, project: any, _p: string, _l: string, _w: any, _r: boolean, _v: any, runId?: string) => {
    started.push({ project: project.name, runId });
    await new Promise<void>((res) => gates.push(res));
    return { ok: true, output: "deployed" };
  }) as any;
  return { started, release: (i: number) => gates[i]!() };
}

async function approve(project: string) {
  const offered = await runner.offerDeployFromSession(project, "ship it", "test");
  assert.equal(offered.ok, true);
  const id = offered.ok ? offered.id : "";
  const a = await runner.answerDeployOfferDetailed(id, "deploy", "app");
  assert.equal(a.status, "applied");
  return a.status === "applied" ? { reply: a.reply, runId: a.offer.runId! } : assert.fail("not applied");
}

test("second_deploy_same_project_waits", async () => {
  const g = gatedRuns();
  const first = await approve("up");
  await tick();
  assert.deepEqual(g.started.map((s) => s.runId), [first.runId], "the first deploy runs at once");
  assert.doesNotMatch(first.reply, /queued behind/);

  const second = await approve("up");
  await tick();
  assert.equal(g.started.length, 1, "the second deploy does not start while the first runs");
  assert.match(second.reply, new RegExp(`queued behind run ${first.runId}`));

  const third = await approve("up");
  await tick();
  assert.equal(g.started.length, 1);
  assert.match(third.reply, new RegExp(`queued behind run ${second.runId}`));

  g.release(0);
  await tick();
  assert.deepEqual(g.started.map((s) => s.runId), [first.runId, second.runId], "the second starts when the first ends");
  g.release(1);
  await tick();
  assert.deepEqual(g.started.map((s) => s.runId), [first.runId, second.runId, third.runId]);
  g.release(2);
  await tick();

  const after = await approve("up");
  await tick();
  assert.doesNotMatch(after.reply, /queued behind/, "nothing is left held once the runs end");
  g.release(3);
  await tick();
});

test("deploy_other_project_not_blocked", async () => {
  const g = gatedRuns();
  const a = await approve("up");
  await tick();
  const b = await approve("clinic");
  await tick();
  assert.deepEqual(g.started.map((s) => s.runId).sort(), [a.runId, b.runId].sort(), "both projects deploy at once");
  assert.doesNotMatch(b.reply, /queued behind/);
  g.release(0); g.release(1);
  await tick();
});

test("edudemo-erp offers need a valid pinned sha, and record it", async () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  for (const bad of [undefined, "main", "abc", `${SHA}; rm -rf /`]) {
    const r = await runner.offerDeployFromSession("edudemo-erp", "ship it", "test", bad);
    assert.equal(r.ok, false, String(bad));
  }
  const o = await runner.offerDeployFromSession("edudemo-erp", "ship it", "test", SHA);
  assert.equal(o.ok, true);
  const id = o.ok ? o.id : "";
  assert.equal(runner.deployOfferStatus(id)?.sha, SHA);
});
