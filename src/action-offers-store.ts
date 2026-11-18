import type { Database } from "better-sqlite3";
import { ACTION_OFFER_TTL_MS, type ActionOffer, type ActionOfferBacking } from "./action-offers";

// SQLite backing for ActionOffers. The table is created here, not in db.ts (D2).
// Skipped offers outlive the 24 h TTL: the daily sweep needs them for its skip cooldown.

export const SKIP_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

interface Row {
  id: string; project: string; chat_id: number; title: string; body: string; buttons: string;
  from_label: string | null; state: string; answered_button: string | null; channel: string | null;
  created_at: number; answered_at: number | null; telegram_message_id: number | null; signal: string | null;
}

export class ActionOfferStore implements ActionOfferBacking {
  constructor(private db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS action_offers (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        chat_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        buttons TEXT NOT NULL,
        from_label TEXT,
        state TEXT NOT NULL,
        answered_button TEXT,
        channel TEXT,
        created_at INTEGER NOT NULL,
        answered_at INTEGER,
        telegram_message_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_action_offers_project ON action_offers(project, created_at);
    `);
    const cols = db.prepare("PRAGMA table_info(action_offers)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "signal")) db.exec("ALTER TABLE action_offers ADD COLUMN signal TEXT");
  }

  save(o: ActionOffer): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO action_offers
         (id, project, chat_id, title, body, buttons, from_label, state, answered_button, channel, created_at, answered_at, telegram_message_id, signal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        o.id, o.project, o.chatId, o.title, o.body, JSON.stringify(o.buttons), o.from ?? null, o.state,
        o.answeredButton ?? null, o.channel ?? null, o.createdAt, o.answeredAt ?? null, o.telegramMessageId ?? null, o.signal ? JSON.stringify(o.signal) : null,
      );
  }

  /** Offers created at or after `since`. */
  loadAll(since: number): ActionOffer[] {
    const rows = this.db.prepare("SELECT * FROM action_offers WHERE created_at >= ?").all(since) as Row[];
    return rows.map((r) => ({
      id: r.id,
      project: r.project,
      chatId: r.chat_id,
      title: r.title,
      body: r.body,
      buttons: JSON.parse(r.buttons),
      from: r.from_label ?? undefined,
      state: r.state as ActionOffer["state"],
      answeredButton: r.answered_button ?? undefined,
      channel: r.channel ?? undefined,
      createdAt: r.created_at,
      answeredAt: r.answered_at ?? undefined,
      telegramMessageId: r.telegram_message_id ?? undefined,
      ...(r.signal ? { signal: JSON.parse(r.signal) } : {}),
    }));
  }

  /** Delete offers past the TTL, except skip answers, which stay SKIP_KEEP_MS for the cooldown. */
  prune(now: number): void {
    this.db
      .prepare(
        `DELETE FROM action_offers WHERE created_at < ?
         AND NOT (COALESCE(answered_button, '') = 'skip' AND COALESCE(answered_at, 0) >= ?)`,
      )
      .run(now - ACTION_OFFER_TTL_MS, now - SKIP_KEEP_MS);
  }

  /** How many times `project`'s card was skipped at or after `sinceMs` (epoch ms). */
  recentSkips(project: string, sinceMs: number): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM action_offers WHERE project = ? AND answered_button = 'skip' AND answered_at >= ?")
      .get(project, sinceMs) as { n: number };
    return r.n;
  }
}

let shared: ActionOfferStore | undefined;
/** The store on the live database (lazy, so importing this module opens nothing). */
export function defaultActionOfferStore(): ActionOfferStore {
  if (!shared) shared = new ActionOfferStore(require("./db").default);
  return shared;
}
