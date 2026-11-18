import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { ControlStore } from "../store";
import { PushStore } from "./store";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function open() {
  const db = new Database(":memory:");
  const control = new ControlStore(db);
  const push = new PushStore(db);
  const dev = (name: string) => control.createDevice({ name, tokenHash: "h-" + name, now: NOW });
  return { db, control, push, dev };
}
const count = (db: Database.Database, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test("register stores only the topic (never the URL), the keys when given, and replaces on a second call", () => {
  const { db, push, dev } = open();
  const d = dev("a");
  push.register(d.id, "upAb12Cd34Ef56Gh", { p256dh: "BKey", auth: "authKey" }, NOW);
  const row = push.get(d.id)!;
  assert.deepEqual([row.deviceId, row.topic, row.p256dh, row.auth, row.registeredAt, row.lastSentAt, row.lastError], [d.id, "upAb12Cd34Ef56Gh", "BKey", "authKey", NOW, null, null]);
  assert.ok(!JSON.stringify(db.prepare("SELECT * FROM control_push_endpoints").all()).includes("https://"));
  push.register(d.id, "upZz99Yy88Xx77Ww", undefined, NOW + 1);
  assert.deepEqual([push.get(d.id)!.topic, push.get(d.id)!.p256dh, count(db, "control_push_endpoints")], ["upZz99Yy88Xx77Ww", null, 1]);
});

test("clear removes the registration (P2); a device without one answers false", () => {
  const { push, dev } = open();
  const d = dev("a");
  push.register(d.id, "upAb12Cd34Ef56Gh", undefined, NOW);
  assert.equal(push.clear(d.id), true);
  assert.equal(push.get(d.id), undefined);
  assert.equal(push.clear(d.id), false);
});

test("DELETE /devices/:id (store.revoke), revokeAll and expiry pruning also clear endpoint, prefs and outbox", () => {
  const { db, control, push, dev } = open();
  const a = dev("a"), b = dev("b"), c = dev("c");
  for (const d of [a, b, c]) {
    push.register(d.id, "up" + d.id.slice(2).padEnd(8, "x"), undefined, NOW);
    push.setPrefs(d.id, { approvals: false, runs: true, deploys: true, reminders: true, incidents: "off" }, NOW);
    push.enqueue(d.id, "offer:1", "approval.new", "{}", NOW);
  }
  assert.equal(control.revoke(a.id), true);
  for (const t of ["control_push_endpoints", "control_push_prefs", "control_push_outbox"]) assert.equal(count(db, t), 2, t);
  assert.equal(push.get(a.id), undefined);
  control.revokeAll(c.id);
  for (const t of ["control_push_endpoints", "control_push_prefs", "control_push_outbox"]) assert.equal(count(db, t), 1, t);
  db.prepare("UPDATE control_devices SET expires_at = ? WHERE id = ?").run(NOW - 1, c.id);
  control.prune(NOW);
  for (const t of ["control_push_endpoints", "control_push_prefs", "control_push_outbox"]) assert.equal(count(db, t), 0, t);
});

test("recordSent and recordFailure feed P6: last_sent_at, last_error and the fail count", () => {
  const { push, dev } = open();
  const d = dev("a");
  push.register(d.id, "upAb12Cd34Ef56Gh", undefined, NOW);
  push.recordFailure(d.id, "unreachable", NOW + 1);
  push.recordFailure(d.id, "rejected", NOW + 2);
  assert.deepEqual([push.get(d.id)!.lastError, push.get(d.id)!.failCount, push.get(d.id)!.lastSentAt], ["rejected", 2, null]);
  push.recordSent(d.id, NOW + 3);
  assert.deepEqual([push.get(d.id)!.lastError, push.get(d.id)!.failCount, push.get(d.id)!.lastSentAt], [null, 0, NOW + 3]);
});

test("prefs default to approvals, runs, deploys, reminders on and incidents critical; setPrefs replaces them", () => {
  const { push, dev } = open();
  const d = dev("a");
  assert.deepEqual(push.getPrefs(d.id), { approvals: true, runs: true, deploys: true, reminders: true, incidents: "critical" });
  push.setPrefs(d.id, { approvals: false, runs: true, deploys: false, reminders: true, incidents: "warning" }, NOW);
  assert.deepEqual(push.getPrefs(d.id), { approvals: false, runs: true, deploys: false, reminders: true, incidents: "warning" });
});

test("the outbox is unique per (device, event key); pending rows come oldest first; sent and failed leave the queue", () => {
  const { push, dev } = open();
  const d = dev("a");
  assert.equal(push.enqueue(d.id, "offer:1", "approval.new", '{"n":1}', NOW), true);
  assert.equal(push.enqueue(d.id, "offer:1", "approval.new", '{"n":1}', NOW + 5), false, "same key twice");
  assert.equal(push.enqueue(d.id, "offer:2", "approval.new", '{"n":2}', NOW + 1), true);
  const batch = push.pending(10);
  assert.deepEqual(batch.map((r) => [r.eventKey, r.status, r.attempts]), [["offer:1", "pending", 0], ["offer:2", "pending", 0]]);
  push.markSent(batch[0].id, NOW + 9);
  push.markFailed(batch[1].id, 2, NOW + 9);
  assert.deepEqual(push.pending(10), []);
  assert.equal(push.enqueue(d.id, "offer:1", "approval.new", "{}", NOW + 20), false, "a sent key is never re-queued");
});

test("seen keys: markSeen is once per (source, key); markSeeded marks a source seeded and survives pruning", () => {
  const { push } = open();
  assert.equal(push.sourceSeeded("offers"), false);
  push.markSeen("offers", "a0", NOW);
  assert.equal(push.sourceSeeded("offers"), false, "a key alone is not a seed");
  push.markSeeded("offers", NOW);
  assert.equal(push.sourceSeeded("offers"), true);
  assert.equal(push.markSeen("offers", "a1", NOW), true);
  assert.equal(push.markSeen("offers", "a1", NOW + 1), false);
  assert.equal(push.hasSeen("offers", "a1"), true);
  assert.equal(push.hasSeen("runs", "a1"), false);
  assert.equal(push.sourceSeeded("offers"), true);
});

test("prune drops sent/failed outbox rows after 7 days and seen keys after 30 days, never pending rows", () => {
  const { db, push, dev } = open();
  const d = dev("a");
  push.enqueue(d.id, "k:old-sent", "test", "{}", NOW - 8 * DAY);
  push.enqueue(d.id, "k:old-pending", "test", "{}", NOW - 8 * DAY);
  push.enqueue(d.id, "k:new-sent", "test", "{}", NOW - DAY);
  const rows = db.prepare("SELECT id, event_key FROM control_push_outbox").all() as { id: number; event_key: string }[];
  for (const r of rows) if (r.event_key.endsWith("sent")) push.markSent(r.id, NOW - 8 * DAY);
  push.markSeeded("offers", NOW - 31 * DAY);
  push.markSeen("offers", "old", NOW - 31 * DAY);
  push.markSeen("offers", "new", NOW - DAY);
  push.prune(NOW);
  assert.deepEqual((db.prepare("SELECT event_key FROM control_push_outbox ORDER BY id").all() as { event_key: string }[]).map((r) => r.event_key), ["k:old-pending", "k:new-sent"]);
  assert.deepEqual([push.hasSeen("offers", "old"), push.hasSeen("offers", "new"), push.sourceSeeded("offers")], [false, true, true]);
});
