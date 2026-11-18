import "./test-db-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as db from "./db";
import { draftWAReply, threadForDraft } from "./whatsapp-ai";

// Not initDatabase(): it cannot bootstrap an empty file (see transcripts.test.ts). The drafter
// only reads whatsapp_messages, so the test creates that one table with the live columns.
require("better-sqlite3")(process.env.TOKYO_DB_PATH).exec(`
  CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, jid TEXT NOT NULL, sender TEXT, sender_name TEXT, content TEXT,
    message_type TEXT, from_me INTEGER DEFAULT 0, is_group INTEGER DEFAULT 0,
    replied INTEGER DEFAULT 0, reply_content TEXT, timestamp INTEGER, created_at TEXT,
    media_path TEXT, transcription TEXT, duration_seconds REAL, wa_msg_id TEXT, quoted_msg_id TEXT
  )
`);

// The WhatsApp drafter used to see only the newest message, so it re-asked what the person had
// already said (owner, 2026-10-17). It now gets the recent thread, auto-replies included.

const lines = (thread: string) => thread.split("\n").map((l) => JSON.parse(l));

test("the thread shows both sides oldest first, auto-replies included, without the message being answered", () => {
  const thread = threadForDraft([
    { content: "عندي وكالة ديال الإشهار", from_me: 0, timestamp: 3, reply_content: null },
    { content: "سلام", from_me: 0, timestamp: 1, reply_content: "وعليكم السلام، شنو النشاط ديالك؟" },
    { content: "شنو بغيتي؟", from_me: 1, timestamp: 2 },
  ], "عندي وكالة ديال الإشهار");

  assert.deepEqual(lines(thread), [
    { from: "them", text: "سلام" },
    { from: "The owner", text: "وعليكم السلام، شنو النشاط ديالك؟" },
    { from: "The owner", text: "شنو بغيتي؟" },
  ]);
});

test("a long thread keeps the newest lines", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ content: `msg ${i} ${"x".repeat(200)}`, from_me: i % 2, timestamp: i }));
  const kept = lines(threadForDraft(rows, "new", 1000));

  assert.ok(kept.length < 30);
  assert.match(kept[kept.length - 1].text, /^msg 29 /);
});

test("an empty thread is an empty string", () => {
  assert.equal(threadForDraft([], "سلام"), "");
});

test("draftWAReply gives the model the thread and the never-re-ask rule", async () => {
  const jid = "212600000999@s.whatsapp.net";
  db.saveWAMessage({ jid, sender: jid, sender_name: "Sara", content: "سميتي سارة وعندي محل ديال الحلويات", timestamp: 1000, wa_msg_id: "t-1" });
  db.saveWAMessage({ jid, sender: "me", content: "مرحبا سارة", from_me: true, timestamp: 1001, wa_msg_id: "t-2" });
  db.saveWAMessage({ jid, sender: jid, sender_name: "Sara", content: "شحال الثمن؟", timestamp: 1002, wa_msg_id: "t-3" });

  let seen: { system: string; user: string } | undefined;
  const draft = await draftWAReply(jid, "شحال الثمن؟", "Sara", "client", {
    ai: async (system, messages) => {
      seen = { system, user: messages[0].content };
      return "\"غادي نشوف ونرد عليك\"";
    },
  });

  assert.equal(draft, "غادي نشوف ونرد عليك");
  assert.ok(seen);
  assert.match(seen.user, /سميتي سارة وعندي محل ديال الحلويات/);
  assert.equal(seen.user.split("شحال الثمن؟").length - 1, 1, "the message being answered appears once");
  assert.match(seen.system, /NEVER ask again/);
});
