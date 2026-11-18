import type { Database } from "better-sqlite3";
import { DEPLOY_OFFER_TTL_MS, type DeployOfferBacking, type StoredDeployOffer } from "./deploy-offers";

// SQLite backing for DeployOffers. The table is created here, not in db.ts (D2).
// Offers older than the TTL are not loaded and are deleted by prune().

export type { StoredDeployOffer };

interface Row {
  id: string; project: string; chat_id: number; created_at: number; summary: string | null; from_label: string | null;
  state: string; channel: string | null; answered_at: number | null; telegram_message_id: number | null; run_id: string | null; sha: string | null;
}

export class DeployOfferStore implements DeployOfferBacking {
  constructor(private db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS deploy_offers (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        chat_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        summary TEXT,
        from_label TEXT,
        state TEXT NOT NULL,
        channel TEXT,
        answered_at INTEGER,
        telegram_message_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_deploy_offers_created ON deploy_offers(created_at);
    `);
    const cols = db.prepare("PRAGMA table_info(deploy_offers)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "run_id")) db.exec("ALTER TABLE deploy_offers ADD COLUMN run_id TEXT");
    if (!cols.some((c) => c.name === "sha")) db.exec("ALTER TABLE deploy_offers ADD COLUMN sha TEXT");
  }

  save(o: StoredDeployOffer): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO deploy_offers
         (id, project, chat_id, created_at, summary, from_label, state, channel, answered_at, telegram_message_id, run_id, sha)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(o.id, o.project, o.chatId, o.createdAt, o.summary ?? null, o.from ?? null, o.state, o.channel ?? null, o.answeredAt ?? null, o.telegramMessageId ?? null, o.runId ?? null, o.sha ?? null);
  }

  /** Offers created at or after `since`. */
  loadAll(since: number): StoredDeployOffer[] {
    const rows = this.db.prepare("SELECT * FROM deploy_offers WHERE created_at >= ?").all(since) as Row[];
    return rows.map((r) => ({
      id: r.id,
      project: r.project,
      chatId: r.chat_id,
      createdAt: r.created_at,
      ...(r.summary !== null ? { summary: r.summary } : {}),
      ...(r.from_label !== null ? { from: r.from_label } : {}),
      state: r.state as StoredDeployOffer["state"],
      ...(r.channel !== null ? { channel: r.channel } : {}),
      ...(r.answered_at !== null ? { answeredAt: r.answered_at } : {}),
      ...(r.telegram_message_id !== null ? { telegramMessageId: r.telegram_message_id } : {}),
      ...(r.run_id !== null ? { runId: r.run_id } : {}),
      ...(r.sha !== null ? { sha: r.sha } : {}),
    }));
  }

  /** Delete offers past the TTL. */
  prune(now: number): void {
    this.db.prepare("DELETE FROM deploy_offers WHERE created_at < ?").run(now - DEPLOY_OFFER_TTL_MS);
  }
}
