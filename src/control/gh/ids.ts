import crypto from "crypto";
import type { Database } from "better-sqlite3";

const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");
const MAX_SALT = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const GH_ID_KEEP_MS = 30 * DAY_MS;
/** A seen id is refreshed at most this often, so a 10 s poll does not write every time. */
const TOUCH_EVERY_MS = 60 * 60 * 1000;

export const GH_ID = /^g_[0-9a-f]{12}$/;

/**
 * Opaque ids for GodHome things whose own ids carry names, paths or `:` (agents, terminals, triggers, cards, launches; spec 012 plan
 * section 1): `g_` + the first 12 hex of sha256(kind + source id), remembered in `control_gh_ids` so it never changes and can be
 * resolved back server-side. The phone never sends a name. A prefix held by another source is rehashed with a salt, as for incidents.
 */
export class GhIds {
  /** `hash` is injectable so a test can force a prefix collision. */
  constructor(private readonly db: Database, private readonly hash: (s: string) => string = sha256) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS control_gh_ids (
        opaque_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER,
        UNIQUE (kind, source_id)
      );
    `);
  }

  opaque(kind: string, sourceId: string, now: number): string {
    const find = this.db.prepare("SELECT opaque_id, first_seen, last_seen FROM control_gh_ids WHERE kind = ? AND source_id = ?");
    const known = find.get(kind, sourceId) as { opaque_id: string; first_seen: number; last_seen: number | null } | undefined;
    if (known) {
      if (now - (known.last_seen ?? known.first_seen) >= TOUCH_EVERY_MS) this.db.prepare("UPDATE control_gh_ids SET last_seen = ? WHERE opaque_id = ?").run(now, known.opaque_id);
      return known.opaque_id;
    }
    const insert = this.db.prepare("INSERT OR IGNORE INTO control_gh_ids (opaque_id, kind, source_id, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)");
    for (let salt = 0; salt < MAX_SALT; salt++) {
      const id = `g_${this.hash(kind + (salt === 0 ? sourceId : `${sourceId}#${salt}`)).slice(0, 12)}`;
      if (insert.run(id, kind, sourceId, now, now).changes === 1) return id;
      const raced = find.get(kind, sourceId) as { opaque_id: string } | undefined;
      if (raced) return raced.opaque_id;
    }
    throw new Error("no free gh id");
  }

  /** The source id behind an opaque id of this kind, or null. */
  resolve(kind: string, opaqueId: string): string | null {
    if (!GH_ID.test(opaqueId)) return null;
    const row = this.db.prepare("SELECT source_id FROM control_gh_ids WHERE kind = ? AND opaque_id = ?").get(kind, opaqueId) as { source_id: string } | undefined;
    return row?.source_id ?? null;
  }

  /** Drops ids not seen for 30 days; an id is a pure hash of its source, so one that comes back is identical. Returns how many went. */
  prune(now: number): number {
    return this.db.prepare("DELETE FROM control_gh_ids WHERE COALESCE(last_seen, first_seen) < ?").run(now - GH_ID_KEEP_MS).changes;
  }
}
