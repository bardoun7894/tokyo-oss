import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import Database from "better-sqlite3";
import { OpsStore } from "../ops-store";
import { prepareToken, ACTION_ID, TOKEN_TTL_MS } from "./tokens";

const NOW = Date.parse("2026-10-17T10:00:00Z");
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const cols = (db: Database.Database, t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

test("schema: kind, subject and payload_hash on the token table, control_action_payloads exists", () => {
  const db = new Database(":memory:");
  new OpsStore(db);
  for (const c of ["kind", "subject", "payload_hash"]) assert.ok(cols(db, "control_restart_tokens").includes(c), c);
  assert.deepEqual(cols(db, "control_action_payloads"), ["action_id", "payload", "expires_at"]);
});

test("schema: a 003 token table without the new columns is upgraded in place, rows read as kind restart", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE control_restart_tokens (action_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, target_id TEXT NOT NULL,
    incident_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, used_at INTEGER)`);
  db.prepare("INSERT INTO control_restart_tokens VALUES ('act_000000000001','d_1','web','i_1',?,?,NULL)").run(NOW + 1000, NOW);
  const store = new OpsStore(db);
  new OpsStore(db); // a second open must not fail on the existing columns
  const t = store.getActionToken("act_000000000001")!;
  assert.equal(t.kind, "restart");
  assert.equal(t.subject, null);
  assert.equal(t.payloadHash, null);
});

test("prepareToken: act_ id, 120 s expiry, kind and subject stored, no payload row without a payload", () => {
  const db = new Database(":memory:");
  const store = new OpsStore(db);
  const t = prepareToken(store, { kind: "agent_run", deviceId: "d_1", subject: "proj", targetId: "proj", now: NOW });
  assert.match(t.actionId, ACTION_ID);
  assert.equal(t.expiresAt, NOW + TOKEN_TTL_MS);
  assert.equal(TOKEN_TTL_MS, 120_000);
  const row = store.getActionToken(t.actionId)!;
  assert.deepEqual([row.kind, row.subject, row.deviceId, row.targetId, row.payloadHash, row.usedAt], ["agent_run", "proj", "d_1", "proj", null, null]);
  assert.equal(store.takePayload(t.actionId), null);
});

test("prepareToken: the payload is kept apart from the token and bound to it by its sha256", () => {
  const db = new Database(":memory:");
  const store = new OpsStore(db);
  const payload = { project: "p", prompt: "do the thing" };
  const t = prepareToken(store, { kind: "agent_run", deviceId: "d_1", subject: "p", targetId: "p", payload, now: NOW });
  const row = store.getActionToken(t.actionId)!;
  assert.equal(row.payloadHash, sha(JSON.stringify(payload)));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM control_action_payloads").get() as any).n, 1);
  assert.equal(store.takePayload(t.actionId), JSON.stringify(payload));
});

test("takePayload deletes on use: a second read finds nothing", () => {
  const db = new Database(":memory:");
  const store = new OpsStore(db);
  const t = prepareToken(store, { kind: "agent_prompt", deviceId: "d_1", subject: "g_1", targetId: "g_1", payload: { text: "hi" }, now: NOW });
  assert.ok(store.takePayload(t.actionId));
  assert.equal(store.takePayload(t.actionId), null);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM control_action_payloads").get() as any).n, 0);
});

test("prune removes payloads at expiry and keeps live ones", () => {
  const db = new Database(":memory:");
  const store = new OpsStore(db);
  const old = prepareToken(store, { kind: "agent_run", deviceId: "d_1", subject: "a", targetId: "a", payload: { n: 1 }, now: NOW });
  const live = prepareToken(store, { kind: "agent_run", deviceId: "d_1", subject: "b", targetId: "b", payload: { n: 2 }, now: NOW + 100_000 });
  store.prune(NOW + TOKEN_TTL_MS + 1);
  assert.equal(store.takePayload(old.actionId), null);
  assert.ok(store.takePayload(live.actionId));
});

test("restartUses and lastRestartAt count restart tokens only", () => {
  const db = new Database(":memory:");
  const store = new OpsStore(db);
  const a = prepareToken(store, { kind: "agent_run", deviceId: "d_1", subject: "p", targetId: "web", now: NOW });
  const r = prepareToken(store, { kind: "restart", deviceId: "d_1", subject: "web", targetId: "web", incidentId: "i_1", now: NOW });
  store.consumeRestartToken(a.actionId, NOW + 1);
  assert.deepEqual(store.restartUses(0), []);
  assert.equal(store.lastRestartAt("web"), null);
  store.consumeRestartToken(r.actionId, NOW + 2);
  assert.deepEqual(store.restartUses(0), [NOW + 2]);
  assert.equal(store.lastRestartAt("web"), NOW + 2);
});
