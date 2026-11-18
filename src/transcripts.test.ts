import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Point db.ts at a scratch file BEFORE importing it — it opens the database at
// module load, so the env var has to be set first.
const dir = mkdtempSync(join(tmpdir(), "tokyo-tr-"));
process.env.TOKYO_DB_PATH = join(dir, "test.db");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require("./db") as typeof import("./db");

const BASE = 1789750000;

before(() => {
  // Not initDatabase(): it throws "no such table: main.promises" against an empty file,
  // so the full schema cannot bootstrap itself. These queries only touch one table, so
  // the test creates just that one, mirroring the live columns it reads.
  const raw = require("better-sqlite3")(process.env.TOKYO_DB_PATH);
  raw.exec(`
    CREATE TABLE whatsapp_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      message_type TEXT DEFAULT 'text',
      from_me INTEGER DEFAULT 0,
      is_group INTEGER DEFAULT 0,
      replied INTEGER DEFAULT 0,
      reply_content TEXT,
      timestamp INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      media_path TEXT,
      transcription TEXT,
      duration_seconds REAL
    )
  `);
  const rows: [number, string, string | null, number, number, number, string | null][] = [
    // id, jid, sender_name, from_me, is_group, ts, transcription
    [1, "111@lid", "Said", 0, 0, BASE + 10, "صافي غادي نبداو الخدمة"],
    [2, "222@lid", "Mona", 0, 1, BASE + 20, "التقرير بتاع الـ SPC ناقص"],
    [3, "111@lid", "Said", 1, 0, BASE + 30, null],           // never transcribed
    [4, "333@lid", null, 0, 0, BASE + 40, "   "],            // whitespace only
    [5, "444@lid", "Karim", 1, 0, BASE + 50, "هاكا نطوروا الشغل"],
  ];
  const ins = raw.prepare(
    "INSERT INTO whatsapp_messages (id, jid, sender_name, from_me, is_group, timestamp, transcription, message_type) " +
    "VALUES (?,?,?,?,?,?,?,'audio')",
  );
  for (const r of rows) ins.run(...r);
  // A text message must never show up in a transcript list.
  raw.prepare(
    "INSERT INTO whatsapp_messages (id, jid, sender_name, from_me, is_group, timestamp, transcription, message_type) " +
    "VALUES (6,'555@lid','Ali',0,0,?,'not a voice note','text')",
  ).run(BASE + 60);
  raw.close();
});

after(() => rmSync(dir, { recursive: true, force: true }));

test("returns only audio rows that actually have a transcript", () => {
  const rows = db.getTranscripts(50, 0);
  assert.deepEqual(rows.map((r) => r.id), [5, 2, 1], "newest first, no NULL/blank/text rows");
});

test("blank-but-not-null transcripts are excluded, not rendered as empty rows", () => {
  assert.equal(db.getTranscripts(50, 0).some((r) => r.id === 4), false);
});

test("counts agree with the rows returned", () => {
  assert.equal(db.countTranscripts(), 3);
});

test("pending counts the untranscribed audio, including the whitespace-only one", () => {
  assert.equal(db.countUntranscribedAudio(), 2); // ids 3 and 4
});

test("search matches transcript text", () => {
  const rows = db.getTranscripts(50, 0, "SPC");
  assert.deepEqual(rows.map((r) => r.id), [2]);
  assert.equal(db.countTranscripts("SPC"), 1);
});

test("search matches Arabic text", () => {
  assert.deepEqual(db.getTranscripts(50, 0, "نطوروا").map((r) => r.id), [5]);
});

test("search matches sender name", () => {
  assert.deepEqual(db.getTranscripts(50, 0, "Said").map((r) => r.id), [1]);
});

test("a sender name that is NULL does not break the search", () => {
  assert.doesNotThrow(() => db.getTranscripts(50, 0, "anything"));
});

test("paging does not drop or repeat rows", () => {
  const first = db.getTranscripts(2, 0).map((r) => r.id);
  const second = db.getTranscripts(2, 2).map((r) => r.id);
  assert.deepEqual(first, [5, 2]);
  assert.deepEqual(second, [1]);
  assert.equal(new Set([...first, ...second]).size, 3);
});

test("a search term with a SQL wildcard is treated as text, not as a pattern", () => {
  // "%" would match everything if it were interpolated into the LIKE pattern raw.
  assert.equal(db.countTranscripts("%"), 0);
});
