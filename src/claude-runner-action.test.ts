import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// claude-runner imports db.ts, which opens its file at load time: point it at a scratch file.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokyo-runner-action-"));
process.env.TOKYO_DB_PATH = path.join(dir, "life.db");
process.env.TELEGRAM_USER_ID = "42";

let runner: typeof import("./claude-runner");
const handlers: { re: RegExp; fn: (ctx: any) => Promise<void> }[] = [];
const sent: any[] = [];
const bot: any = {
  callbackQuery: (re: RegExp, fn: any) => handlers.push({ re, fn }),
  api: {
    sendMessage: async (chatId: number, text: string, o?: any) => {
      sent.push({ chatId, text, markup: o?.reply_markup?.inline_keyboard });
      return { message_id: sent.length };
    },
    editMessageText: async () => true,
  },
};

before(async () => {
  // WhatsApp is not under test and drags in half the app (and, in a clean checkout, a module that
  // lives only in the live tree): replace it with an empty stand-in before claude-runner loads it.
  const waPath = require.resolve("./whatsapp");
  require.cache[waPath] = { id: waPath, filename: waPath, loaded: true, exports: { sendWhatsAppMessage: async () => {} } } as any;
  runner =await import("./claude-runner");
  // registerClaudeRunner also starts the 60 s drain timer; unref it so the test process can exit.
  const realSetInterval = global.setInterval;
  global.setInterval = ((fn: any, ms: any) => realSetInterval(fn, ms).unref()) as any;
  runner.registerClaudeRunner(bot);
  global.setInterval = realSetInterval;
});

function ctxFor(data: string, re: RegExp) {
  const out = { answered: [] as string[], edited: [] as string[] };
  return {
    out,
    ctx: {
      match: data.match(re),
      answerCallbackQuery: async (o: any) => { out.answered.push(o?.text); },
      editMessageText: async (t: string) => { out.edited.push(t); },
    },
  };
}

test("the act: callback regex routes to answerActionOffer and only matches the card format", async () => {
  const h = handlers.find((x) => x.re.source.startsWith("^act:"));
  assert.ok(h, "an act: handler is registered");
  assert.equal(h!.re.source, "^act:([0-9a-f]{8}):([a-z0-9_-]{1,16})$");
  assert.equal(h!.re.test("act:deadbeef:run"), true);
  for (const bad of ["act:DEADBEEF:run", "act:deadbeef:RUN", "act:deadbeef:", "act:dead:run", "act:deadbeef:run:x", "claude_deploy:deadbeef"]) {
    assert.equal(h!.re.test(bad), false, bad);
  }

  const offered = await runner.offerActionFromSession({ project: "crmdemo", title: "CRM", body: "b" });
  assert.equal(offered.ok, true);
  const id = offered.ok ? offered.id : "";
  assert.equal(sent.at(-1).markup[0][0].callback_data, `act:${id}:run`);

  // "skip" has no prompt, so no run is started by this test.
  const data = `act:${id}:skip`;
  const { out, ctx } = ctxFor(data, h!.re);
  await h!.fn(ctx);
  assert.match(out.answered[0], /Skip/);
  assert.equal(runner.actionOfferStatus(id)!.state, "answered");
  assert.equal(runner.actionOfferStatus(id)!.channel, "telegram");

  const again = ctxFor(data, h!.re);
  await h!.fn(again.ctx);
  assert.match(again.out.answered[0], /already answered/);
});

test("claude_deploy handlers are unchanged and still registered", () => {
  const sources = handlers.map((x) => x.re.source);
  assert.ok(sources.includes("^claude_(deploy|nodeploy):(\\S+)$"));
  for (const s of ["^claude_yes:(\\S+)$", "^claude_no:(\\S+)$", "^claude_tc:(\\S+)$", "^claude_yes_reply:(\\S+)$"]) {
    assert.ok(sources.includes(s), s);
  }
});

test("a run flagged noDeployOffer does not offer a deploy; a normal one does", async () => {
  const before = sent.length;
  const project = { name: "crmdemo", location: "server", path: "/root/crmdemo" } as any;
  await runner.offerDeployAfterRun(bot, { project, chatId: 42, prompt: "do the next step", noDeployOffer: true } as any);
  assert.equal(sent.length, before, "no card");
  await runner.offerDeployAfterRun(bot, { project, chatId: 42, prompt: "do the next step" } as any);
  assert.equal(sent.length, before + 1);
  assert.match(sent.at(-1).text, /Deploy it\?/);
});

test("typed yes still answers only deploy and run cards, never an action card", async () => {
  const o = await runner.offerActionFromSession({ project: "crmdemo", title: "CRM2", body: "" });
  assert.equal(o.ok, true);
  const ids = [runner.latestPendingRun(42)?.id, runner.latestDeployOffer(42)?.id];
  assert.ok(!ids.includes(o.ok ? o.id : "x"));
});
