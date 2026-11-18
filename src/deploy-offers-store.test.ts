import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { DeployOfferStore, type StoredDeployOffer } from "./deploy-offers-store";
import { DEPLOY_OFFER_TTL_MS } from "./deploy-offers";

const NOW = Date.parse("2026-10-16T09:00:00Z");
const row = (o: Partial<StoredDeployOffer> = {}): StoredDeployOffer => ({ id: "a1b2c3d4", project: "godhome", chatId: 7, createdAt: NOW, state: "pending", ...o });

test("save and loadAll round-trip every field, and save replaces by id", () => {
  const store = new DeployOfferStore(new Database(":memory:"));
  store.save(row({ summary: "herdr", from: "mac", telegramMessageId: 55 }));
  store.save(row({ id: "b2c3d4e5", createdAt: NOW + 1, state: "approved", channel: "telegram", answeredAt: NOW + 2 }));
  const all = store.loadAll(NOW - 1).sort((a, b) => a.createdAt - b.createdAt);
  assert.deepEqual(all[0], row({ summary: "herdr", from: "mac", telegramMessageId: 55 }));
  assert.deepEqual(all[1], row({ id: "b2c3d4e5", createdAt: NOW + 1, state: "approved", channel: "telegram", answeredAt: NOW + 2 }));
  store.save(row({ state: "declined", channel: "terminal", answeredAt: NOW + 9, summary: "herdr", from: "mac", telegramMessageId: 55 }));
  const again = store.loadAll(NOW - 1);
  assert.equal(again.length, 2);
  assert.equal(again.find((o) => o.id === "a1b2c3d4")!.state, "declined");
});

test("loadAll skips rows older than `since`; prune deletes rows past the TTL", () => {
  const db = new Database(":memory:");
  const store = new DeployOfferStore(db);
  store.save(row({ id: "00000001", createdAt: NOW - DEPLOY_OFFER_TTL_MS - 1 }));
  store.save(row({ id: "00000002", createdAt: NOW }));
  assert.deepEqual(store.loadAll(NOW - DEPLOY_OFFER_TTL_MS).map((o) => o.id), ["00000002"]);
  store.prune(NOW);
  assert.deepEqual((db.prepare("SELECT id FROM deploy_offers").all() as { id: string }[]).map((r) => r.id), ["00000002"]);
});

test("opening the store twice on one db keeps the rows", () => {
  const db = new Database(":memory:");
  new DeployOfferStore(db).save(row());
  assert.equal(new DeployOfferStore(db).loadAll(0).length, 1);
});

test("T3.1: run_id round-trips, and a table made by T3.0 (no run_id column) is migrated with its rows kept", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE deploy_offers (id TEXT PRIMARY KEY, project TEXT NOT NULL, chat_id INTEGER NOT NULL, created_at INTEGER NOT NULL,
    summary TEXT, from_label TEXT, state TEXT NOT NULL, channel TEXT, answered_at INTEGER, telegram_message_id INTEGER)`);
  db.prepare("INSERT INTO deploy_offers (id, project, chat_id, created_at, state) VALUES ('00000009', 'godhome', 1, ?, 'pending')").run(NOW);
  const store = new DeployOfferStore(db);
  assert.deepEqual(store.loadAll(0), [{ id: "00000009", project: "godhome", chatId: 1, createdAt: NOW, state: "pending" }]);
  store.save(row({ state: "approved", channel: "app", answeredAt: NOW + 1, runId: "0a1b2c3d" }));
  assert.equal(store.loadAll(0).find((o) => o.id === "a1b2c3d4")!.runId, "0a1b2c3d");
  assert.equal(new DeployOfferStore(db).loadAll(0).length, 2, "opening twice does not fail on the added column");
});

test("the pinned sha survives a save and load", () => {
  const store = new DeployOfferStore(new Database(":memory:"));
  store.save(row({ sha: "5a1d80f28d70cf8bce647d35f2c2f9308b31837d" }));
  assert.equal(store.loadAll(NOW - 1)[0]!.sha, "5a1d80f28d70cf8bce647d35f2c2f9308b31837d");
});
