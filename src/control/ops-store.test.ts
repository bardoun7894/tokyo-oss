import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import Database from "better-sqlite3";
import { OpsStore } from "./ops-store";

const NOW = Date.parse("2026-10-16T09:00:00Z");
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const open = () => {
  const db = new Database(":memory:");
  return { db, store: new OpsStore(db) };
};

const SOURCE_IDS = ["check:site:1792170025000", "review:dev-stack|2", "agent:live:final-perf", "deploy:lab|tokyo-69b8e370"];

test("opaque id: i_ plus 12 hex of sha256(sourceId), no ':' or '|', stable across calls and across a new store on the same db", () => {
  const { db, store } = open();
  for (const src of SOURCE_IDS) {
    const id = store.opaqueId(src, NOW);
    assert.match(id, /^i_[0-9a-f]{12}$/);
    assert.equal(id, `i_${sha(src).slice(0, 12)}`);
    assert.ok(!id.includes(":") && !id.includes("|"));
    assert.equal(store.opaqueId(src, NOW + 1000), id, "second fetch");
    assert.equal(store.sourceId(id), src, "maps back");
  }
  const again = new OpsStore(db);
  assert.equal(again.opaqueId(SOURCE_IDS[0], NOW), `i_${sha(SOURCE_IDS[0]).slice(0, 12)}`);
  assert.equal(again.sourceId(`i_${sha(SOURCE_IDS[1]).slice(0, 12)}`), SOURCE_IDS[1]);
});

test("opaque id: unknown or malformed ids map to null; the first_seen of a source is not moved by later calls", () => {
  const { db, store } = open();
  assert.equal(store.sourceId("i_000000000000"), null);
  assert.equal(store.sourceId("check:site:1"), null);
  assert.equal(store.sourceId(""), null);
  const id = store.opaqueId("review:invoices|2", NOW);
  store.opaqueId("review:invoices|2", NOW + 99_000);
  const row = db.prepare("SELECT * FROM control_incident_ids WHERE opaque_id = ?").get(id) as any;
  assert.deepEqual(row, { opaque_id: id, source_id: "review:invoices|2", first_seen: NOW });
});

test("opaque id: a repeated source id in one pass does not throw and yields one row", () => {
  const { db, store } = open();
  const a = store.opaqueId("check:docker:1", NOW);
  const b = store.opaqueId("check:docker:1", NOW);
  assert.equal(a, b);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM control_incident_ids").get() as any).n, 1);
});

test("opaque id: a prefix collision between two sources salts the newcomer; both keep a 12-hex id and map back", () => {
  const db = new Database(":memory:");
  const clash = (s: string) => (s.startsWith("salted") || s === "A" || s === "B" ? "ab".repeat(32).slice(0, 64) : sha(s));
  const store = new OpsStore(db, clash);
  const a = store.opaqueId("A", NOW);
  const b = store.opaqueId("B", NOW);
  assert.match(a, /^i_[0-9a-f]{12}$/);
  assert.match(b, /^i_[0-9a-f]{12}$/);
  assert.equal(a, "i_abababababab");
  assert.notEqual(a, b);
  assert.equal(store.sourceId(a), "A");
  assert.equal(store.sourceId(b), "B");
  assert.equal(store.opaqueId("B", NOW + 1), b, "the salted id is remembered, not recomputed");
  assert.equal(store.opaqueId("A", NOW + 1), a);
});

test("store: creates the id, overlay and audit tables, the id table with the planned columns, and is idempotent", () => {
  const { db } = open();
  new OpsStore(db);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'control_%'").all() as any[]).map((t) => t.name);
  assert.deepEqual(tables, ["control_incident_ids", "control_incident_state", "control_incident_mutes", "control_ops_audit", "control_restart_tokens", "control_action_payloads"]);
  const cols = (db.prepare("PRAGMA table_info(control_incident_ids)").all() as any[]).map((c) => c.name);
  assert.deepEqual(cols, ["opaque_id", "source_id", "first_seen"]);
});

// ---- T2.1: overlay and audit tables -------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const D = "d_aaaaaaaa";

test("overlay: ack, resolve and mute are stored, read back by GodHome id and by mute key, and survive a new store on the same db", () => {
  const { db, store } = open();
  const a = store.opaqueId("check:site:1", NOW);
  const r = store.opaqueId("review:dev-stack|2", NOW);
  store.ack(a, "check:site:1", "check", D, NOW);
  store.resolve(r, "review:dev-stack|2", "review", NOW - 5000, D, NOW + 1000);
  store.mute("check:docker:crmdemo-backend-1", NOW + 60 * 60_000, D, NOW);
  const ov = new OpsStore(db).overlay(NOW + 2000);
  assert.equal(ov.states.get("check:site:1")?.ackedAt, NOW);
  assert.equal(ov.states.get("check:site:1")?.state, "acked");
  const res = ov.states.get("review:dev-stack|2")!;
  assert.deepEqual([res.state, res.resolvedAt, res.resolvedLastAt, res.byDevice], ["resolved", NOW + 1000, NOW - 5000, D]);
  assert.equal(ov.mutes.get("check:docker:crmdemo-backend-1"), NOW + 60 * 60_000);
});

test("overlay: a mute past its until is not returned; a second mute on the key replaces the first; unmute removes it", () => {
  const { store } = open();
  store.mute("k", NOW + 1000, D, NOW);
  assert.equal(store.overlay(NOW + 999).mutes.get("k"), NOW + 1000);
  assert.equal(store.overlay(NOW + 1000).mutes.has("k"), false, "until is exclusive");
  store.mute("k", NOW + 5000, D, NOW + 10);
  assert.equal(store.overlay(NOW + 2000).mutes.get("k"), NOW + 5000);
  assert.equal(store.unmute("k"), true);
  assert.equal(store.unmute("k"), false);
  assert.equal(store.overlay(NOW).mutes.size, 0);
});

test("overlay: resolve clears the ack, ack on a reopened row keeps resolved_last_at, clearState removes the row", () => {
  const { store } = open();
  const id = store.opaqueId("check:site:1", NOW);
  store.ack(id, "check:site:1", "check", D, NOW);
  store.resolve(id, "check:site:1", "check", NOW, D, NOW + 1);
  const resolved = store.overlay(NOW + 2).states.get("check:site:1")!;
  assert.equal(resolved.ackedAt, null);
  assert.equal(resolved.state, "resolved");
  store.ack(id, "check:site:1", "check", D, NOW + 3);
  const acked = store.overlay(NOW + 4).states.get("check:site:1")!;
  assert.equal(acked.resolvedLastAt, NOW, "kept so the reopen flag survives");
  assert.equal(acked.state, "acked");
  assert.equal(store.clearState(id), true);
  assert.equal(store.clearState(id), false);
  assert.equal(store.overlay(NOW + 5).states.size, 0);
});

test("audit table exists with UNIQUE(action, idem_key); two rows with no key are allowed, two with the same key are not", () => {
  const { db } = open();
  const ins = db.prepare("INSERT INTO control_ops_audit (at, device_id, device_name, addr, action, subject, params, result, detail, dur_ms, idem_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  ins.run(NOW, D, "t", "1.1.1.1", "ack", "i_000000000001", "{}", "ok", "", 1, null);
  ins.run(NOW, D, "t", "1.1.1.1", "ack", "i_000000000001", "{}", "ok", "", 1, null);
  ins.run(NOW, D, "t", "1.1.1.1", "ack", "i_000000000001", "{}", "ok", "", 1, "k1");
  assert.throws(() => ins.run(NOW, D, "t", "1.1.1.1", "ack", "i_000000000001", "{}", "ok", "", 1, "k1"), /UNIQUE/);
  ins.run(NOW, D, "t", "1.1.1.1", "mute", "i_000000000001", "{}", "ok", "", 1, "k1");
});

test("prune: audit rows older than 180 days, expired mutes older than 30 days and ids older than 30 days without an overlay row go; the rest stays", () => {
  const { db, store } = open();
  const ins = db.prepare("INSERT INTO control_ops_audit (at, device_id, device_name, addr, action, subject, params, result, detail, dur_ms) VALUES (?, ?, 't', 'a', 'ack', 's', '{}', 'ok', '', 1)");
  ins.run(NOW - 181 * DAY, D);
  ins.run(NOW - 179 * DAY, D);
  const rawMute = db.prepare("INSERT INTO control_incident_mutes (key, until, by_device, created_at) VALUES (?, ?, ?, ?)");
  rawMute.run("old", NOW - 31 * DAY, D, NOW - 40 * DAY);
  rawMute.run("recent-expired", NOW - 2 * DAY, D, NOW - 3 * DAY);
  rawMute.run("active", NOW + DAY, D, NOW);
  const oldId = store.opaqueId("old:1", NOW - 40 * DAY);
  const keptByState = store.opaqueId("old:2", NOW - 40 * DAY);
  store.ack(keptByState, "old:2", "check", D, NOW - 40 * DAY);
  const fresh = store.opaqueId("fresh:1", NOW - DAY);
  const out = store.prune(NOW);
  assert.deepEqual(out, { audit: 1, mutes: 1, ids: 1 });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM control_ops_audit").get() as any).n, 1);
  assert.equal(store.sourceId(oldId), null);
  assert.equal(store.sourceId(keptByState), "old:2");
  assert.equal(store.sourceId(fresh), "fresh:1");
  assert.deepEqual([...store.overlay(NOW - 60 * DAY).mutes.keys()].sort(), ["active", "recent-expired"]);
});

test("audit(): a second row for the same (action, idemKey) writes nothing and returns false; findIdem returns the first; rows without a key never clash", () => {
  const { store } = open();
  const e = { at: NOW, deviceId: D, deviceName: "t", addr: "1.1.1.1", action: "ack", subject: "i_000000000001", params: "{}", result: "ok", detail: "", durMs: 1 };
  assert.equal(store.audit({ ...e, idemKey: "k", response: '{"a":1}' }), true);
  assert.equal(store.audit({ ...e, idemKey: "k", response: '{"a":2}' }), false);
  assert.deepEqual(store.findIdem("ack", "k"), { deviceId: D, subject: "i_000000000001", response: '{"a":1}' });
  assert.equal(store.findIdem("mute", "k"), null);
  assert.equal(store.audit(e), true);
  assert.equal(store.audit(e), true);
});

// ---- T2.4: history and recent ---------------------------------------------------------------------------------

const entry = (over: Record<string, unknown> = {}) => ({
  at: NOW, deviceId: D, deviceName: "pixel", addr: "10.0.0.7", action: "ack", subject: "i_000000000001", params: '{"minutes":60}', result: "ok", detail: "", durMs: 1, ...over,
});

test("history(): the ok actions on one subject, newest first, with the device name; other subjects, failed attempts and extra rows are left out", () => {
  const { store } = open();
  store.audit(entry({ at: NOW, action: "ack" }));
  store.audit(entry({ at: NOW + 1000, action: "mute" }));
  store.audit(entry({ at: NOW + 2000, action: "resolve", result: "conflict" }));
  store.audit(entry({ at: NOW + 3000, action: "reopen", deviceName: "tablet" }));
  store.audit(entry({ at: NOW + 4000, action: "ack", subject: "i_000000000002" }));
  assert.deepEqual(store.history("i_000000000001", 10), [
    { at: NOW + 3000, action: "reopen", device: "tablet" },
    { at: NOW + 1000, action: "mute", device: "pixel" },
    { at: NOW, action: "ack", device: "pixel" },
  ]);
  assert.equal(store.history("i_000000000001", 2).length, 2);
  assert.deepEqual(store.history("i_00000000ffff", 10), []);
});

test("recent(): newest first by insertion, at most `limit`, every result kept, and neither addr nor params in the rows", () => {
  const { store } = open();
  for (let n = 0; n < 7; n++) store.audit(entry({ at: NOW + n, action: `a${n}`, result: n === 3 ? "conflict" : "ok" }));
  const rows = store.recent(5);
  assert.deepEqual(rows.map((r) => r.action), ["a6", "a5", "a4", "a3", "a2"]);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["action", "at", "device", "result", "subject"]);
  assert.equal(rows[3].result, "conflict");
  assert.ok(!JSON.stringify(rows).includes("10.0.0.7") && !JSON.stringify(rows).includes("minutes"));
});

test("restart tokens: created once, consumed once, counted by use time, per target, and pruned after a day", () => {
  const { db, store } = open();
  const tok = { actionId: "a_000000000000000000000001", deviceId: D, targetId: "pg", incidentId: "i_000000000001", expiresAt: NOW + 120_000 };
  store.createRestartToken(tok, NOW);
  assert.deepEqual(store.getRestartToken(tok.actionId), { ...tok, createdAt: NOW, usedAt: null });
  assert.equal(store.getRestartToken("a_ffffffffffffffffffffffff"), undefined);
  assert.equal(store.consumeRestartToken(tok.actionId, NOW + 5), true);
  assert.equal(store.consumeRestartToken(tok.actionId, NOW + 6), false, "single use");
  assert.equal(store.getRestartToken(tok.actionId)!.usedAt, NOW + 5);
  store.createRestartToken({ ...tok, actionId: "a_000000000000000000000002", targetId: "web" }, NOW);
  store.consumeRestartToken("a_000000000000000000000002", NOW + 50);
  store.createRestartToken({ ...tok, actionId: "a_000000000000000000000003" }, NOW); // never used
  assert.deepEqual(store.restartUses(NOW), [NOW + 5, NOW + 50], "use times, oldest first");
  assert.deepEqual(store.restartUses(NOW + 6), [NOW + 50]);
  assert.equal(store.lastRestartAt("pg"), NOW + 5);
  assert.equal(store.lastRestartAt("web"), NOW + 50);
  assert.equal(store.lastRestartAt("none"), null);
  store.prune(NOW + 2 * DAY);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM control_restart_tokens").get() as any).n, 0, "tokens older than a day go");
});
