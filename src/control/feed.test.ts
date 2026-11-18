import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { FeedStore, MAX_ROWS, RETENTION_MS, buttonLabels, classify, plainText, telegramFeedRecorder } from "./feed";
import { controlApp } from "./test-app";

const OWNER = "1111";
const T0 = Date.parse("2026-10-16T09:00:00Z");

function store(clock = { t: T0 }) {
  return { feed: new FeedStore(new Database(":memory:"), () => clock.t), clock };
}

test("classify: incident, deploy, approval (buttons), error, run, money, info", () => {
  assert.equal(classify("🚨 incident on appstudio: 502", false), "incident");
  assert.equal(classify("Deploy it? tokyo", true), "deploy");
  assert.equal(classify("Run this mission?", true), "approval");
  assert.equal(classify("Build failed: exit 1", false), "error");
  assert.equal(classify("Mission 4f2a finished", false), "run");
  assert.equal(classify("Sale 120 DH", false), "money");
  assert.equal(classify("Good morning", false), "info");
});

test("the recorder keeps owner-chat sends with button labels only, redacted, and skips other chats and methods", () => {
  const { feed } = store();
  const rec = telegramFeedRecorder(() => feed, OWNER);
  rec("sendMessage", { chat_id: Number(OWNER), text: "Deploy it? API_TOKEN=abc123", reply_markup: { inline_keyboard: [[{ text: "🚀 Deploy", callback_data: "deploy_yes:1" }, { text: "Not now", callback_data: "deploy_no:1" }]] } }, { message_id: 7 });
  rec("sendMessage", { chat_id: "999", text: "someone else" }, { message_id: 8 });
  rec("getUpdates", { chat_id: OWNER }, []);
  rec("answerCallbackQuery", { chat_id: OWNER, text: "ok" }, true);
  rec("sendPhoto", { chat_id: OWNER, caption: "chart" }, { message_id: 9 });
  const items = feed.list({ limit: 10 });
  assert.equal(items.length, 2);
  const deploy = items.find((i) => i.kind === "deploy")!;
  assert.equal(deploy.text, "Deploy it? API_TOKEN=[redacted]");
  assert.deepEqual(deploy.buttons, ["🚀 Deploy", "Not now"]);
  assert.ok(!JSON.stringify(items).includes("deploy_yes"), "callback data never stored");
  assert.ok(items.some((i) => i.text === "[photo] chart"));
});

test("an edit replaces the text of its entry instead of adding one", () => {
  const { feed } = store();
  const rec = telegramFeedRecorder(() => feed, OWNER);
  rec("sendMessage", { chat_id: OWNER, text: "Run mission?", reply_markup: { inline_keyboard: [[{ text: "✅ Run" }]] } }, { message_id: 42 });
  rec("editMessageText", { chat_id: OWNER, message_id: 42, text: "Run mission? -- approved" }, true);
  const items = feed.list({ limit: 10 });
  assert.equal(items.length, 1);
  assert.equal(items[0].text, "Run mission? -- approved");
  assert.equal(items[0].edited, true);
  assert.deepEqual(items[0].buttons, [], "Telegram drops the keyboard of an edit without markup");
});

test("removing the keyboard after an answer keeps the text and clears the buttons", () => {
  const { feed } = store();
  const rec = telegramFeedRecorder(() => feed, OWNER);
  rec("sendMessage", { chat_id: OWNER, text: "Approve mission?", reply_markup: { inline_keyboard: [[{ text: "Approve" }, { text: "Skip" }]] } }, { message_id: 5 });
  rec("editMessageReplyMarkup", { chat_id: OWNER, message_id: 5, reply_markup: undefined }, true);
  const [i] = feed.list({ limit: 10 });
  assert.equal(i.text, "Approve mission?");
  assert.deepEqual(i.buttons, []);
  assert.equal(i.edited, true);
});

test("plainText drops the marks of parse_mode and keeps the words", () => {
  assert.equal(plainText("*Deploy* _tokyo_ `npm test` ok", "Markdown"), "Deploy tokyo npm test ok");
  assert.equal(plainText("see [the run](https://x.dev/r/1) and my\\_var", "Markdown"), "see the run and my_var");
  assert.equal(plainText("```ts\nconst a_b = 1\n```", "Markdown"), "const a_b = 1\n");
  assert.equal(plainText("`snake_case_name` stays", "Markdown"), "snake_case_name stays");
  assert.equal(plainText("*bold* \\. ~gone~ ||spoiler||", "MarkdownV2"), "bold . gone spoiler");
  assert.equal(plainText("<b>Down</b> &lt;api&gt; &amp; db", "HTML"), "Down <api> & db");
  assert.equal(plainText("*not touched*", undefined), "*not touched*");
});

test("the recorder stores Markdown sends and edits as plain text", () => {
  const { feed } = store();
  const rec = telegramFeedRecorder(() => feed, OWNER);
  rec("sendMessage", { chat_id: OWNER, text: "*Mission* `fix_login` finished", parse_mode: "Markdown" }, { message_id: 3 });
  rec("sendPhoto", { chat_id: OWNER, caption: "_chart_", parse_mode: "Markdown" }, { message_id: 4 });
  rec("editMessageText", { chat_id: OWNER, message_id: 3, text: "*Mission* done", parse_mode: "Markdown" }, true);
  const texts = feed.list({ limit: 10 }).map((i) => i.text).sort();
  assert.deepEqual(texts, ["Mission done", "[photo] chart"]);
});

test("the recorder never throws, even when the store does", () => {
  const rec = telegramFeedRecorder(() => { throw Error("db locked"); }, OWNER);
  assert.doesNotThrow(() => rec("sendMessage", { chat_id: OWNER, text: "x" }, { message_id: 1 }));
  const off = telegramFeedRecorder(() => null, undefined);
  assert.doesNotThrow(() => off("sendMessage", { chat_id: OWNER, text: "x" }, {}));
});

test("button labels: grammy keyboard objects, junk and a cap of 8", () => {
  assert.deepEqual(buttonLabels(undefined), []);
  assert.deepEqual(buttonLabels({ inline_keyboard: "x" }), []);
  const many = { inline_keyboard: [Array.from({ length: 12 }, (_, i) => ({ text: `b${i}` }))] };
  assert.equal(buttonLabels(many).length, 8);
});

test("prune drops rows past the retention and past MAX_ROWS", () => {
  const { feed, clock } = store();
  feed.add({ source: "tokyo", text: "old" });
  clock.t += RETENTION_MS + 1;
  feed.add({ source: "tokyo", text: "new" });
  feed.prune();
  assert.deepEqual(feed.list({ limit: 10 }).map((i) => i.text), ["new"]);
  assert.ok(MAX_ROWS >= 1000);
});

test("GET /feed pages newest first, filters by kind and rejects a bad kind", async () => {
  const { feed, clock } = store();
  for (let i = 0; i < 35; i++) { clock.t += 1000; feed.add({ source: "tokyo", text: `note ${i}`, kind: i % 5 === 0 ? "error" : "info" }); }
  const app = await controlApp({ feed });
  const first = await app.get("/feed");
  assert.equal(first.status, 200);
  assert.equal(first.json.items.length, 30);
  assert.equal(first.json.items[0].text, "note 34");
  assert.match(first.json.items[0].at, /^2026-10-16T/);
  assert.ok(first.json.next);
  const second = await app.get(`/feed?before=${encodeURIComponent(first.json.next)}`);
  assert.equal(second.json.items.length, 5);
  assert.equal(second.json.next, null);
  const errors = await app.get("/feed?kind=error");
  assert.equal(errors.json.items.length, 7);
  assert.ok(errors.json.items.every((i: any) => i.kind === "error"));
  assert.equal((await app.get("/feed?kind=nope")).status, 400);
  await app.close();
});

test("GET /feed needs the device token", async () => {
  const { feed } = store();
  const app = await controlApp({ feed });
  const r = await app.srv.call("GET", "/control-api/v1/feed");
  assert.equal(r.status, 401);
  await app.close();
});
