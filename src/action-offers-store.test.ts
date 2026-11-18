import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { ActionOffers, ACTION_OFFER_TTL_MS } from "./action-offers";
import { ActionOfferStore, SKIP_KEEP_MS } from "./action-offers-store";

const NOW = Date.parse("2026-10-09T09:00:00Z");
const base = { project: "tokyo", chatId: 1, title: "t", body: "b", now: NOW };
const DAY = 24 * 60 * 60 * 1000;

function open() {
  const db = new Database(":memory:");
  const store = new ActionOfferStore(db);
  return { db, store };
}

test("create, take and supersede are persisted and reload after a restart", () => {
  const { store } = open();
  const s1 = new ActionOffers({ store });
  const a = s1.create({ ...base, now: NOW }).offer;
  const b = s1.create({ ...base, now: NOW + 1 }).offer; // supersedes a
  s1.take(b.id, "run", "telegram", NOW + 2);
  const c = s1.create({ ...base, project: "godhome", now: NOW + 3 }).offer;
  s1.setTelegramMessageId(c.id, 777);

  const s2 = new ActionOffers({ store, loadNow: NOW + 10 }); // "restart": new instance, same DB
  assert.equal(s2.get(a.id, NOW + 10)!.state, "superseded");
  const b2 = s2.get(b.id, NOW + 10)!;
  assert.deepEqual([b2.state, b2.answeredButton, b2.channel, b2.answeredAt], ["answered", "run", "telegram", NOW + 2]);
  const c2 = s2.get(c.id, NOW + 10)!;
  assert.deepEqual([c2.state, c2.telegramMessageId, c2.buttons.map((x) => x.id)], ["pending", 777, ["run", "report", "skip"]]);
  assert.equal(s2.take(b.id, "skip", "terminal", NOW + 11).status, "already", "exactly-once survives a restart");
});

test("expired offers are not reloaded and prune deletes them from the table", () => {
  const { db, store } = open();
  const s1 = new ActionOffers({ store });
  const old = s1.create({ ...base, project: "old", now: NOW }).offer;
  const fresh = s1.create({ ...base, project: "fresh", now: NOW + ACTION_OFFER_TTL_MS }).offer;
  const later = NOW + ACTION_OFFER_TTL_MS + 5;
  const s2 = new ActionOffers({ store, loadNow: later });
  assert.equal(s2.get(old.id, later), undefined);
  assert.ok(s2.get(fresh.id, later));
  s2.prune(later);
  const ids = (db.prepare("SELECT id FROM action_offers").all() as { id: string }[]).map((r) => r.id);
  assert.deepEqual(ids, [fresh.id]);
});

test("recentSkips counts skip answers per project inside the window and survives prune", () => {
  const { store } = open();
  const s = new ActionOffers({ store });
  const a = s.create({ ...base, project: "tokyo", now: NOW }).offer;
  s.take(a.id, "skip", "telegram", NOW + 1000);
  const b = s.create({ ...base, project: "godhome", now: NOW }).offer;
  s.take(b.id, "run", "telegram", NOW + 1000);
  assert.equal(store.recentSkips("tokyo", NOW), 1);
  assert.equal(store.recentSkips("tokyo", NOW + 2000), 0, "answered before the window");
  assert.equal(store.recentSkips("godhome", NOW), 0, "run is not a skip");
  // 3 days later the 24 h TTL has long passed, but the skip is still remembered for the cooldown.
  s.prune(NOW + 3 * DAY);
  assert.equal(store.recentSkips("tokyo", NOW), 1);
  // after SKIP_KEEP_MS it is deleted.
  s.prune(NOW + 1000 + SKIP_KEEP_MS + 1);
  assert.equal(store.recentSkips("tokyo", NOW), 0);
});

test("the table is created by the module (CREATE TABLE IF NOT EXISTS, safe twice)", () => {
  const db = new Database(":memory:");
  new ActionOfferStore(db);
  new ActionOfferStore(db);
  const t = db.prepare("SELECT name FROM sqlite_master WHERE name='action_offers'").all();
  assert.equal(t.length, 1);
});

test("a signal offer survives a restart and an old table without the column is migrated", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE action_offers (id TEXT PRIMARY KEY, project TEXT NOT NULL, chat_id INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
    buttons TEXT NOT NULL, from_label TEXT, state TEXT NOT NULL, answered_button TEXT, channel TEXT, created_at INTEGER NOT NULL, answered_at INTEGER, telegram_message_id INTEGER)`);
  const store = new ActionOfferStore(db);
  const s1 = new ActionOffers({ store });
  const sig = { namespace: "oncall", workflowId: "inc-1", map: { approve: "approve" } };
  const o = s1.create({ ...base, buttons: [{ id: "approve", label: "Deploy fix" }], signal: sig }).offer;
  const s2 = new ActionOffers({ store, loadNow: NOW + 10 });
  assert.deepEqual(s2.get(o.id, NOW + 10)!.signal, sig);
  assert.equal(s2.findBySignal("oncall", "inc-1", NOW + 10)!.id, o.id);
  assert.equal(s2.findBySignal("oncall", "inc-2", NOW + 10), undefined);
});
