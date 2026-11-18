import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Scratch db so ../db never opens life.db.
process.env.TOKYO_DB_PATH = path.join(os.tmpdir(), `tokyo-reminders-${process.pid}.db`);
process.env.TELEGRAM_BOT_TOKEN = "123:telegramBOTtoken";
process.env.TELEGRAM_USER_ID = "42";

import Database from "better-sqlite3";
import { ControlStore } from "../store";
import { pushReminder, reminderId, reminderLabel, reminderSection, reminderSink, setReminderSink, type ReminderEvent, type ReminderKind } from "./reminders";
import { buildPayload } from "./format";
import { PushStore } from "./store";
import { localToday } from "../../utils";

const realFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = realFetch;
  setReminderSink(null);
  for (const s of ["", "-wal", "-shm"]) try { fs.unlinkSync(process.env.TOKYO_DB_PATH! + s); } catch { /* absent */ }
});
test.afterEach(() => setReminderSink(null));

const NOW = Date.parse("2026-10-17T12:00:00Z");

function sinkSetup(opts: { enabled?: boolean } = {}) {
  const db = new Database(":memory:");
  const control = new ControlStore(db);
  const store = new PushStore(db);
  const device = (name: string, reminders = true) => {
    const d = control.createDevice({ name, tokenHash: "h-" + name, now: NOW });
    store.register(d.id, "up" + name.padEnd(10, "x"), undefined, NOW);
    store.setPrefs(d.id, { ...store.getPrefs(d.id), reminders }, NOW);
    return d;
  };
  const sink = reminderSink({ store, enabled: () => opts.enabled ?? true, format: () => "up", now: () => NOW });
  const rows = () => (db.prepare("SELECT device_id, event_key, type, payload FROM control_push_outbox ORDER BY id").all() as { device_id: string; event_key: string; type: string; payload: string }[]);
  return { db, store, device, sink, rows };
}

test("reminderId is r_ + 12 hex of kind:ref:date, stable, and different per kind, ref and day", () => {
  const id = reminderId("prayer", "Fajr", "2026-10-17");
  assert.match(id, /^r_[0-9a-f]{12}$/);
  assert.equal(id, reminderId("prayer", "Fajr", "2026-10-17"));
  assert.notEqual(id, reminderId("prayer", "Fajr", "2026-10-18"));
  assert.notEqual(id, reminderId("prayer", "Dhuhr", "2026-10-17"));
  assert.notEqual(id, reminderId("adhkar", "Fajr", "2026-10-17"));
});

test("labels come from a fixed template per kind plus the name; amounts and message text have no way in", () => {
  assert.equal(reminderLabel("obligation-ahead", "Rent"), "Rent due soon");
  assert.equal(reminderLabel("obligation-due", "Rent"), "Rent due today");
  assert.equal(reminderLabel("obligation-overdue", "Rent"), "Rent overdue");
  assert.equal(reminderLabel("prayer", "Fajr"), "Fajr prayer");
  assert.equal(reminderLabel("adhkar", "Morning"), "Morning adhkar");
  assert.equal(reminderLabel("journal", "Asr"), "Asr journal");
  assert.equal(reminderLabel("deen", "Jumu'ah"), "Jumu'ah reminder");
  assert.equal(reminderLabel("learning", ""), "Learning nudge");
  assert.equal(reminderLabel("obligation-due", "Rent/Loan"), "Rent-Loan due today", "a slash would trip the path gate");
});

test("pushReminder hands the sink one keyed reminder event for today and never throws", () => {
  const got: ReminderEvent[] = [];
  setReminderSink((r) => { got.push(r); });
  pushReminder("prayer", "Fajr", "Fajr");
  assert.equal(got.length, 1);
  const date = localToday();
  assert.equal(got[0].key, `reminder:prayer:Fajr:${date}`);
  assert.deepEqual(got[0].event, { type: "reminder", id: reminderId("prayer", "Fajr", date), title: "Reminder: Fajr prayer", section: "deen" });
  setReminderSink(() => { throw new Error("boom"); });
  assert.doesNotThrow(() => pushReminder("prayer", "Fajr", "Fajr"));
  setReminderSink(async () => { throw new Error("async boom"); });
  assert.doesNotThrow(() => pushReminder("prayer", "Fajr", "Fajr"));
  setReminderSink(null);
  assert.doesNotThrow(() => pushReminder("prayer", "Fajr", "Fajr"), "no sink is fine");
});

test("the sink queues one reminder per registered device with reminders on, once per key", () => {
  const s = sinkSetup();
  const a = s.device("a");
  s.device("quiet", false);
  const ev: ReminderEvent = { key: "reminder:prayer:Fajr:2026-10-17", date: "2026-10-17", event: { type: "reminder", id: reminderId("prayer", "Fajr", "2026-10-17"), title: "Reminder: Fajr prayer", section: "deen" } };
  s.sink(ev);
  s.sink(ev);
  const rows = s.rows();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].device_id, rows[0].event_key, rows[0].type], [a.id, ev.key, "reminder"]);
  assert.deepEqual(JSON.parse(rows[0].payload), { v: 1, t: "reminder", id: ev.event.id, p: "deen", title: "Reminder: Fajr prayer" });
});

test("reminderSection maps each kind to the Life section the app opens, and the payload gate passes it", () => {
  const expected: Record<ReminderKind, string> = {
    "obligation-ahead": "finance", "obligation-due": "finance", "obligation-overdue": "finance",
    prayer: "deen", adhkar: "deen", deen: "deen", journal: "journal", learning: "today",
  };
  for (const [kind, section] of Object.entries(expected)) {
    assert.equal(reminderSection(kind as ReminderKind), section, kind);
    const got: ReminderEvent[] = [];
    setReminderSink((r) => { got.push(r); });
    pushReminder(kind as ReminderKind, "ref", "Name");
    assert.equal(got[0].event.section, section, kind);
    const built = buildPayload({ ...got[0].event });
    assert.ok(built.ok, kind);
    assert.equal((built as { payload: { p?: string } }).payload.p, section, kind);
  }
});

test("a reminder is dropped when push is off or the gate refuses its label", () => {
  const off = sinkSetup({ enabled: false });
  off.device("a");
  off.sink({ key: "k", date: "2026-10-17", event: { type: "reminder", id: "r_0123456789ab", title: "Reminder: x" } });
  assert.equal(off.rows().length, 0);
  const on = sinkSetup();
  on.device("a");
  on.sink({ key: "k1", date: "2026-10-17", event: { type: "reminder", id: "r_0123456789ab", title: "Reminder: call +971 50 123 4567" } });
  on.sink({ key: "k2", date: "2026-10-17", event: { type: "reminder", id: "r_0123456789ac", title: "Reminder: tk_abc123 due today" } });
  assert.equal(on.rows().length, 0);
});

function obligations() {
  const db = require("../../db") as typeof import("../../db");
  const { sendDueReminders } = require("../../obligation-reminders") as typeof import("../../obligation-reminders");
  return { db, sendDueReminders };
}
const telegram: { url: string; body: any }[] = [];
function mockTelegram() {
  telegram.length = 0;
  globalThis.fetch = (async (url: string, init: any) => { telegram.push({ url: String(url), body: JSON.parse(init.body) }); return new Response("{}"); }) as typeof fetch;
}

test("sendDueReminders still sends the Telegram message, unchanged, when push throws", async () => {
  const { db, sendDueReminders } = obligations();
  db.addObligation({ name: "Rent", kind: "bill", amount: 4500, currency: "DH", dueDay: 17 });
  mockTelegram();
  setReminderSink(() => { throw new Error("push is down"); });
  const sent = await sendDueReminders("2026-10-17");
  assert.equal(sent.length, 1);
  assert.equal(telegram.length, 1, "the Telegram send happened");
  assert.match(telegram[0].url, /api\.telegram\.org\/bot.*\/sendMessage$/);
  assert.match(telegram[0].body.text, /Rent.*4[.,\s]?500 DH/s, "the Telegram text still carries the amount");
});

test("each obligation stage is offered to push once, by name only: ahead, due, overdue", async () => {
  const { db, sendDueReminders } = obligations();
  db.addObligation({ name: "Internet", kind: "bill", amount: 299, currency: "DH", dueDay: 19 });
  db.addObligation({ name: "Water", kind: "bill", amount: 120, currency: "DH", dueDay: 14 });
  db.addObligation({ name: "Gym", kind: "bill", amount: 77, currency: "DH", dueDay: 17 });
  mockTelegram();
  const got: ReminderEvent[] = [];
  setReminderSink((r) => { got.push(r); });
  await sendDueReminders("2026-11-17");
  const titles = got.map((g) => g.event.title).sort();
  assert.ok(titles.includes("Reminder: Internet due soon"), titles.join("|"));
  assert.ok(titles.includes("Reminder: Gym due today"), titles.join("|"));
  assert.ok(titles.includes("Reminder: Water overdue"), titles.join("|"));
  assert.ok(got.every((g) => /^r_[0-9a-f]{12}$/.test(g.event.id)));
  assert.ok(!JSON.stringify(got).match(/299|120|77|DH/), "no amounts");
  assert.equal(telegram.length, 1);
  const again = got.length;
  await sendDueReminders("2026-11-17");
  assert.equal(got.length, again, "a second run claims nothing, so push hears nothing twice");
});

test("every Telegram reminder send site calls pushReminder (scheduler 6, proactive 1) and imports it from the push module", () => {
  const read = (f: string) => fs.readFileSync(path.join(__dirname, "..", "..", f), "utf8");
  const calls = (src: string) => (src.match(/\bpushReminder\(/g) ?? []).length;
  assert.equal(calls(read("scheduler.ts")), 6);
  assert.equal(calls(read("proactive.ts")), 1);
  assert.equal(calls(read("obligation-reminders.ts")), 1);
  for (const f of ["scheduler.ts", "proactive.ts", "obligation-reminders.ts"]) assert.match(read(f), /import \{ pushReminder \} from "\.\/control\/push\/reminders";/, f);
});
