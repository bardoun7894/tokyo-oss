import type { Database } from "better-sqlite3";
import { ControlStore } from "../store";

// SQLite backing for push (plan section 4). Tables are created here, like the control tables in store.ts.

export const OUTBOX_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const SEEN_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const SEEDED_KEY = "__seeded__";

export type PushError = "unreachable" | "rejected";
export type IncidentLevel = "off" | "critical" | "warning";
export interface NotifyPrefs { approvals: boolean; runs: boolean; deploys: boolean; reminders: boolean; incidents: IncidentLevel }
export const DEFAULT_PREFS: NotifyPrefs = { approvals: true, runs: true, deploys: true, reminders: true, incidents: "critical" };

export interface PushEndpoint {
  deviceId: string; topic: string; p256dh: string | null; auth: string | null; registeredAt: number;
  lastSentAt: number | null; lastError: PushError | null; failCount: number;
}
export interface OutboxRow {
  id: number; deviceId: string; eventKey: string; type: string; payload: string; createdAt: number;
  sentAt: number | null; attempts: number; status: "pending" | "sent" | "failed";
}

interface EndpointRow {
  device_id: string; topic: string; p256dh: string | null; auth: string | null; registered_at: number;
  last_sent_at: number | null; last_error: string | null; fail_count: number;
}
interface PrefsRow { approvals: number; runs: number; deploys: number; reminders: number; incidents: string }
interface OutboxDbRow {
  id: number; device_id: string; event_key: string; type: string; payload: string; created_at: number;
  sent_at: number | null; attempts: number; status: string;
}

const toEndpoint = (r: EndpointRow): PushEndpoint => ({
  deviceId: r.device_id, topic: r.topic, p256dh: r.p256dh, auth: r.auth, registeredAt: r.registered_at,
  lastSentAt: r.last_sent_at, lastError: r.last_error === "unreachable" || r.last_error === "rejected" ? r.last_error : null, failCount: r.fail_count,
});
const toOutbox = (r: OutboxDbRow): OutboxRow => ({
  id: r.id, deviceId: r.device_id, eventKey: r.event_key, type: r.type, payload: r.payload, createdAt: r.created_at,
  sentAt: r.sent_at, attempts: r.attempts, status: r.status as OutboxRow["status"],
});

export class PushStore {
  constructor(private readonly db: Database) {
    new ControlStore(db); // the trigger below needs control_devices
    db.exec(`
      CREATE TABLE IF NOT EXISTS control_push_endpoints (
        device_id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        p256dh TEXT,
        auth TEXT,
        registered_at INTEGER NOT NULL,
        last_sent_at INTEGER,
        last_error TEXT,
        fail_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS control_push_prefs (
        device_id TEXT PRIMARY KEY,
        approvals INTEGER NOT NULL,
        runs INTEGER NOT NULL,
        deploys INTEGER NOT NULL,
        reminders INTEGER NOT NULL,
        incidents TEXT NOT NULL CHECK (incidents IN ('off','critical','warning')),
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS control_push_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        event_key TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        UNIQUE(device_id, event_key)
      );
      CREATE TABLE IF NOT EXISTS control_push_seen (
        source TEXT NOT NULL,
        key TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        PRIMARY KEY (source, key)
      );
      -- One place covers DELETE /devices/:id, revokeAll (password change) and expiry pruning.
      CREATE TRIGGER IF NOT EXISTS control_push_device_gone AFTER DELETE ON control_devices
      BEGIN
        DELETE FROM control_push_endpoints WHERE device_id = OLD.id;
        DELETE FROM control_push_prefs WHERE device_id = OLD.id;
        DELETE FROM control_push_outbox WHERE device_id = OLD.id;
      END;
    `);
  }

  // --- endpoints (P1, P2, P6) ---

  register(deviceId: string, topic: string, keys: { p256dh: string; auth: string } | undefined, now: number): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO control_push_endpoints (device_id, topic, p256dh, auth, registered_at, last_sent_at, last_error, fail_count)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, 0)
    `).run(deviceId, topic, keys?.p256dh ?? null, keys?.auth ?? null, now);
  }

  clear(deviceId: string): boolean {
    return this.db.prepare("DELETE FROM control_push_endpoints WHERE device_id = ?").run(deviceId).changes > 0;
  }

  get(deviceId: string): PushEndpoint | undefined {
    const r = this.db.prepare("SELECT * FROM control_push_endpoints WHERE device_id = ?").get(deviceId) as EndpointRow | undefined;
    return r ? toEndpoint(r) : undefined;
  }

  list(): PushEndpoint[] {
    return (this.db.prepare("SELECT * FROM control_push_endpoints ORDER BY registered_at, device_id").all() as EndpointRow[]).map(toEndpoint);
  }

  recordSent(deviceId: string, now: number): void {
    this.db.prepare("UPDATE control_push_endpoints SET last_sent_at = ?, last_error = NULL, fail_count = 0 WHERE device_id = ?").run(now, deviceId);
  }

  recordFailure(deviceId: string, error: PushError, _now: number): void {
    this.db.prepare("UPDATE control_push_endpoints SET last_error = ?, fail_count = fail_count + 1 WHERE device_id = ?").run(error, deviceId);
  }

  // --- notify preferences (P3, P4) ---

  getPrefs(deviceId: string): NotifyPrefs {
    const r = this.db.prepare("SELECT approvals, runs, deploys, reminders, incidents FROM control_push_prefs WHERE device_id = ?").get(deviceId) as PrefsRow | undefined;
    if (!r) return { ...DEFAULT_PREFS };
    return { approvals: !!r.approvals, runs: !!r.runs, deploys: !!r.deploys, reminders: !!r.reminders, incidents: r.incidents as IncidentLevel };
  }

  setPrefs(deviceId: string, p: NotifyPrefs, now: number): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO control_push_prefs (device_id, approvals, runs, deploys, reminders, incidents, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(deviceId, +p.approvals, +p.runs, +p.deploys, +p.reminders, p.incidents, now);
  }

  // --- outbox ---

  /** False when this (device, event key) was queued before, whatever became of it. */
  enqueue(deviceId: string, eventKey: string, type: string, payload: string, now: number): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO control_push_outbox (device_id, event_key, type, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(deviceId, eventKey, type, payload, now).changes === 1;
  }

  /** How many outbox rows of one type a device has (the test push counts its own ids from this). */
  countOfType(deviceId: string, type: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM control_push_outbox WHERE device_id = ? AND type = ?").get(deviceId, type) as { n: number }).n;
  }

  /** Rows still to send, oldest first. */
  pending(limit: number): OutboxRow[] {
    return (this.db.prepare("SELECT * FROM control_push_outbox WHERE status = 'pending' ORDER BY id LIMIT ?").all(limit) as OutboxDbRow[]).map(toOutbox);
  }

  markSent(id: number, now: number, attempts = 1): void {
    this.db.prepare("UPDATE control_push_outbox SET status = 'sent', sent_at = ?, attempts = attempts + ? WHERE id = ?").run(now, attempts, id);
  }

  markFailed(id: number, attempts: number, now: number): void {
    this.db.prepare("UPDATE control_push_outbox SET status = 'failed', sent_at = ?, attempts = attempts + ? WHERE id = ?").run(now, attempts, id);
  }

  // --- seen keys ---

  /** True the first time a (source, key) is seen. */
  markSeen(source: string, key: string, now: number): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO control_push_seen (source, key, first_seen) VALUES (?, ?, ?)").run(source, key, now).changes === 1;
  }

  hasSeen(source: string, key: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM control_push_seen WHERE source = ? AND key = ?").get(source, key);
  }

  /** A new dispatcher seeds silently only for a source that never was seeded; the sentinel key outlives the 30 day prune. */
  markSeeded(source: string, now: number): void {
    this.markSeen(source, SEEDED_KEY, now);
  }

  sourceSeeded(source: string): boolean {
    return this.hasSeen(source, SEEDED_KEY);
  }

  /** Drops finished outbox rows after 7 days and seen keys after 30; pending rows stay. */
  prune(now: number): { outbox: number; seen: number } {
    const outbox = this.db.prepare("DELETE FROM control_push_outbox WHERE status <> 'pending' AND created_at < ?").run(now - OUTBOX_KEEP_MS).changes;
    const seen = this.db.prepare("DELETE FROM control_push_seen WHERE first_seen < ? AND key <> ?").run(now - SEEN_KEEP_MS, SEEDED_KEY).changes;
    return { outbox, seen };
  }
}
