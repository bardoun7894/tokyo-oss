import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { CAPS, ControlStore, DEVICE_TTL_MS } from "./store";

const NOW = Date.parse("2026-10-09T09:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function open() {
  const db = new Database(":memory:");
  return { db, store: new ControlStore(db) };
}

const run = (id: string, over: Record<string, unknown> = {}) => ({
  id, project: "tokyo", source: "tokyo" as const, status: "running" as const, model: null, harness: null,
  worker: null, tier: null, promptPreview: "p", startedAt: NOW, endedAt: null, exitCode: null,
  host: "server" as const, offerId: null, workspace: null, ...over,
});

test("device: only the hash is stored, lookup by hash, sliding expiry", () => {
  const { db, store } = open();
  const d = store.createDevice({ name: "Pixel", tokenHash: "h1", now: NOW });
  assert.match(d.id, /^d_[0-9a-f]{8}$/);
  assert.equal(d.expiresAt, NOW + DEVICE_TTL_MS);
  const cols = (db.prepare("PRAGMA table_info(control_devices)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes("token_hash") && !cols.includes("token"), "only the hash column exists");
  assert.equal((db.prepare("SELECT token_hash FROM control_devices").get() as any).token_hash, "h1");
  assert.equal(store.findByTokenHash("nope", NOW), undefined);
  assert.equal(store.findByTokenHash("h1", NOW + DAY)!.id, d.id);
  store.touch(d.id, NOW + 80 * DAY);
  assert.equal(store.findByTokenHash("h1", NOW + 100 * DAY)!.id, d.id, "touch slid the expiry");
  assert.equal(store.listDevices()[0].lastSeenAt, NOW + 80 * DAY);
});

test("device: expired token is not found and the row is dropped", () => {
  const { store } = open();
  store.createDevice({ name: "a", tokenHash: "h", now: NOW });
  assert.equal(store.findByTokenHash("h", NOW + DEVICE_TTL_MS + 1), undefined);
  assert.equal(store.listDevices().length, 0);
});

test("device: revoke one, revoke all (optionally keeping one)", () => {
  const { store } = open();
  const a = store.createDevice({ name: "a", tokenHash: "ha", now: NOW });
  const b = store.createDevice({ name: "b", tokenHash: "hb", now: NOW });
  const c = store.createDevice({ name: "c", tokenHash: "hc", now: NOW });
  assert.equal(store.revoke(a.id), true);
  assert.equal(store.revoke(a.id), false);
  assert.equal(store.revokeAll(b.id), 1);
  assert.deepEqual(store.listDevices().map((d) => d.id), [b.id]);
  assert.equal(store.revokeAll(), 1);
  assert.equal(store.listDevices().length, 0);
  void c;
});

test("device: set, replace and clear the FCM token", () => {
  const { store } = open();
  const d = store.createDevice({ name: "a", tokenHash: "ha", now: NOW });
  assert.equal(store.listDevices()[0].fcmToken, null);
  store.setFcmToken(d.id, "tok1");
  store.setFcmToken(d.id, "tok2");
  assert.equal(store.listDevices()[0].fcmToken, "tok2");
  assert.deepEqual(store.pushTokens(), ["tok2"]);
  store.setFcmToken(d.id, null);
  assert.equal(store.listDevices()[0].fcmToken, null);
  assert.deepEqual(store.pushTokens(), []);
});

test("runs: insert, update, get, filters and newest-first paging", () => {
  const { store } = open();
  store.insertRun(run("aaaaaaa1", { startedAt: NOW, workspace: "ws-1", model: "claude-sonnet-5-5", harness: "claude", worker: "w", tier: "medium", host: "mac", source: "jdelegate" }));
  store.insertRun(run("aaaaaaa2", { project: "godhome", startedAt: NOW + 1000, status: "queued" }));
  store.insertRun(run("aaaaaaa3", { startedAt: NOW + 2000 }));
  store.updateRun("aaaaaaa1", { status: "succeeded", endedAt: NOW + 500, exitCode: 0 });
  const r1 = store.getRun("aaaaaaa1")!;
  assert.deepEqual([r1.status, r1.endedAt, r1.exitCode, r1.workspace, r1.model, r1.harness, r1.worker, r1.tier, r1.source, r1.host],
    ["succeeded", NOW + 500, 0, "ws-1", "claude-sonnet-5-5", "claude", "w", "medium", "jdelegate", "mac"]);
  assert.equal(store.getRun("zzzzzzzz"), undefined);
  assert.deepEqual(store.listRuns({}).map((r) => r.id), ["aaaaaaa3", "aaaaaaa2", "aaaaaaa1"]);
  assert.deepEqual(store.listRuns({ project: "godhome" }).map((r) => r.id), ["aaaaaaa2"]);
  assert.deepEqual(store.listRuns({ status: "queued" }).map((r) => r.id), ["aaaaaaa2"]);
  assert.deepEqual(store.listRuns({ before: NOW + 2000 }).map((r) => r.id), ["aaaaaaa2", "aaaaaaa1"]);
  assert.deepEqual(store.listRuns({ limit: 1 }).map((r) => r.id), ["aaaaaaa3"]);
  // since matches started or ended at or after
  assert.deepEqual(store.listRuns({ since: NOW + 1500 }).map((r) => r.id), ["aaaaaaa3"]);
  assert.deepEqual(store.listRuns({ since: NOW + 400 }).map((r) => r.id), ["aaaaaaa3", "aaaaaaa2", "aaaaaaa1"]);
});

test("runs: counts for the badge", () => {
  const { store } = open();
  store.insertRun(run("bbbbbbb1"));
  store.insertRun(run("bbbbbbb2", { status: "failed", endedAt: NOW + 10 }));
  store.insertRun(run("bbbbbbb3", { status: "failed", endedAt: NOW - 2 * DAY }));
  assert.equal(store.countRuns("running"), 1);
  assert.equal(store.countFailedSince(NOW - DAY), 1);
});

test("prune drops expired devices and old finished runs, keeps running ones", () => {
  const { store } = open();
  store.createDevice({ name: "old", tokenHash: "h", now: NOW - 200 * DAY });
  store.createDevice({ name: "new", tokenHash: "h2", now: NOW });
  store.insertRun(run("ccccccc1", { status: "succeeded", startedAt: NOW - 100 * DAY, endedAt: NOW - 100 * DAY }));
  store.insertRun(run("ccccccc2", { startedAt: NOW - 100 * DAY }));
  store.insertRun(run("ccccccc3", { status: "succeeded", startedAt: NOW, endedAt: NOW }));
  const n = store.prune(NOW);
  assert.equal(n.devices, 1);
  assert.equal(n.runs, 1);
  assert.deepEqual(store.listDevices().map((d) => d.name), ["new"]);
  assert.deepEqual(store.listRuns({}).map((r) => r.id).sort(), ["ccccccc2", "ccccccc3"]);
});

test("caps: a new device reads ops:read,ops:write; an old table without the column migrates and keeps its devices", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE control_devices (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, fcm_token TEXT,
    created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);`);
  db.prepare("INSERT INTO control_devices VALUES ('d_00000001','old','hold',NULL,?,?,?)").run(NOW, NOW, NOW + DEVICE_TTL_MS);
  const store = new ControlStore(db);
  const cols = (db.prepare("PRAGMA table_info(control_devices)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes("caps"));
  assert.deepEqual(store.listDevices()[0].caps, ["ops:read", "ops:write"]);
  assert.deepEqual(store.findByTokenHash("hold", NOW)!.caps, ["ops:read", "ops:write"]);
  new ControlStore(db); // second open on the migrated table is a no-op
  const d = store.createDevice({ name: "new", tokenHash: "hnew", now: NOW });
  assert.deepEqual(d.caps, ["ops:read", "ops:write"]);
  assert.deepEqual(store.findByTokenHash("hnew", NOW)!.caps, ["ops:read", "ops:write"]);
});

test("caps: unknown names in the column are ignored, ops:service is kept", () => {
  const { db, store } = open();
  const d = store.createDevice({ name: "a", tokenHash: "ha", now: NOW });
  db.prepare("UPDATE control_devices SET caps = ? WHERE id = ?").run("ops:read,bogus,ops:service", d.id);
  assert.deepEqual(store.listDevices()[0].caps, ["ops:read", "ops:service"]);
});

test("caps: the four spec 012 caps exist, new devices still default to ops:read,ops:write, and each can be stored", () => {
  const { store } = open();
  assert.deepEqual([...CAPS], ["ops:read", "ops:write", "ops:service", "life:read", "life:write", "agents:start", "ops:run"]);
  const d = store.createDevice({ name: "a", tokenHash: "ha", now: NOW });
  assert.deepEqual(d.caps, ["ops:read", "ops:write"]);
  assert.ok(store.setCaps(d.id, ["ops:run", "life:write", "ops:read", "agents:start", "life:read"]));
  assert.deepEqual(store.listDevices()[0].caps, ["ops:read", "life:read", "life:write", "agents:start", "ops:run"], "canonical order");
});

test("caps: parseCaps keeps unknown names out of the new caps too", () => {
  const { db, store } = open();
  const d = store.createDevice({ name: "a", tokenHash: "ha", now: NOW });
  db.prepare("UPDATE control_devices SET caps = ? WHERE id = ?").run("ops:read,life:admin,life:read,agents:stop,ops:run,*", d.id);
  assert.deepEqual(store.listDevices()[0].caps, ["ops:read", "life:read", "ops:run"]);
});
