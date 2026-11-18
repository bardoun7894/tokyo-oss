import crypto from "crypto";
import type { Database } from "better-sqlite3";

const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");
const MAX_SALT = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const AUDIT_KEEP_MS = 180 * DAY_MS;
export const ID_KEEP_MS = 30 * DAY_MS;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

/** One incident's manual state. `state` is derived on write: resolved, else acked, else open. */
export interface StateRow {
  opaqueId: string;
  sourceId: string;
  kind: string;
  state: "open" | "acked" | "resolved";
  ackedAt: number | null;
  resolvedAt: number | null;
  /** The incident's `lastAt` when it was resolved by hand; a later `lastAt` reopens it. */
  resolvedLastAt: number | null;
  byDevice: string;
  updatedAt: number;
}

/** One write to audit. `params` is JSON that has already been through redact(); `response` is the JSON body an idempotent replay returns. */
export interface AuditEntry {
  at: number; deviceId: string; deviceName: string; addr: string; action: string; subject: string;
  params: string; result: string; detail: string; durMs: number; idemKey?: string | null; response?: string | null;
}

/** A read of the whole overlay at one instant: state rows by GodHome id, active mutes (until > now) by mute key. */
export interface Overlay {
  states: Map<string, StateRow>;
  mutes: Map<string, number>;
}

interface StateDbRow {
  opaque_id: string; source_id: string; kind: string; state: StateRow["state"]; acked_at: number | null; resolved_at: number | null;
  resolved_last_at: number | null; by_device: string; updated_at: number;
}

const toState = (r: StateDbRow): StateRow => ({
  opaqueId: r.opaque_id, sourceId: r.source_id, kind: r.kind, state: r.state, ackedAt: r.acked_at, resolvedAt: r.resolved_at,
  resolvedLastAt: r.resolved_last_at, byDevice: r.by_device, updatedAt: r.updated_at,
});

/**
 * Tokyo's own state for the ops routes, in the same db as `ControlStore`: the opaque id map (FR5: GodHome
 * incident ids contain `:` and `|`, the phone only ever sees `i_<12 hex>`), the incident overlay (ack, mute,
 * manual resolve; spec section 6) and the write audit. Writes take `now` so a test controls the clock.
 */
export class OpsStore {
  private lastPrune = 0;

  /** `hash` is injectable so a test can force a prefix collision. */
  constructor(private readonly db: Database, private readonly hash: (s: string) => string = sha256) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS control_incident_ids (
        opaque_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL UNIQUE,
        first_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS control_incident_state (
        opaque_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open','acked','resolved')),
        acked_at INTEGER,
        resolved_at INTEGER,
        resolved_last_at INTEGER,
        by_device TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS control_incident_mutes (
        key TEXT PRIMARY KEY,
        until INTEGER NOT NULL,
        by_device TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS control_ops_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        addr TEXT NOT NULL,
        action TEXT NOT NULL,
        subject TEXT NOT NULL,
        params TEXT NOT NULL DEFAULT '{}',
        result TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        dur_ms INTEGER NOT NULL DEFAULT 0,
        idem_key TEXT,
        response TEXT,
        UNIQUE (action, idem_key)
      );
      CREATE INDEX IF NOT EXISTS idx_control_ops_audit_at ON control_ops_audit(at);
      CREATE TABLE IF NOT EXISTS control_restart_tokens (
        action_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        incident_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        used_at INTEGER
      );
    `);
    // T2.1 created the audit table without `response`; no release carried that, but a dev db may.
    const cols = db.prepare("PRAGMA table_info(control_ops_audit)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "response")) db.exec("ALTER TABLE control_ops_audit ADD COLUMN response TEXT");
    // Spec 012 T2.1: the token table carries every fingerprint action, not only restarts. A 003 row reads as kind 'restart'.
    const tcols = db.prepare("PRAGMA table_info(control_restart_tokens)").all() as { name: string }[];
    if (!tcols.some((c) => c.name === "kind")) db.exec("ALTER TABLE control_restart_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'restart'");
    if (!tcols.some((c) => c.name === "subject")) db.exec("ALTER TABLE control_restart_tokens ADD COLUMN subject TEXT");
    if (!tcols.some((c) => c.name === "payload_hash")) db.exec("ALTER TABLE control_restart_tokens ADD COLUMN payload_hash TEXT");
    db.exec(`
      CREATE TABLE IF NOT EXISTS control_action_payloads (
        action_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  // --- overlay ---

  /** Flags one incident as acknowledged. Resolve fields are kept: they still decide whether the incident is hidden or reopened. */
  ack(opaqueId: string, sourceId: string, kind: string, device: string, now: number): void {
    this.maybePrune(now);
    this.db.prepare(`
      INSERT INTO control_incident_state (opaque_id, source_id, kind, state, acked_at, by_device, updated_at)
      VALUES (?, ?, ?, 'acked', ?, ?, ?)
      ON CONFLICT(opaque_id) DO UPDATE SET
        state = 'acked', acked_at = excluded.acked_at, by_device = excluded.by_device, updated_at = excluded.updated_at
    `).run(opaqueId, sourceId, kind, now, device, now);
  }

  /** Manual close. `lastAt` is the incident's `lastAt` now; a later one (a new alert event) reopens it. Clears the ack. */
  resolve(opaqueId: string, sourceId: string, kind: string, lastAt: number, device: string, now: number): void {
    this.maybePrune(now);
    this.db.prepare(`
      INSERT INTO control_incident_state (opaque_id, source_id, kind, state, resolved_at, resolved_last_at, by_device, updated_at)
      VALUES (?, ?, ?, 'resolved', ?, ?, ?, ?)
      ON CONFLICT(opaque_id) DO UPDATE SET
        state = 'resolved', acked_at = NULL, resolved_at = excluded.resolved_at, resolved_last_at = excluded.resolved_last_at,
        by_device = excluded.by_device, updated_at = excluded.updated_at
    `).run(opaqueId, sourceId, kind, now, lastAt, device, now);
  }

  /** Drops ack and resolve for one incident (the state half of reopen). True when there was a row. */
  clearState(opaqueId: string): boolean {
    return this.db.prepare("DELETE FROM control_incident_state WHERE opaque_id = ?").run(opaqueId).changes > 0;
  }

  /** Mutes a key until `until` (epoch ms), replacing an earlier mute on it. */
  mute(key: string, until: number, device: string, now: number): void {
    this.maybePrune(now);
    this.db.prepare(`
      INSERT INTO control_incident_mutes (key, until, by_device, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET until = excluded.until, by_device = excluded.by_device, created_at = excluded.created_at
    `).run(key, until, device, now);
  }

  unmute(key: string): boolean {
    return this.db.prepare("DELETE FROM control_incident_mutes WHERE key = ?").run(key).changes > 0;
  }

  /** Every state row (keyed by GodHome id) and every mute still running at `now` (`until` is exclusive). */
  overlay(now: number): Overlay {
    const states = new Map<string, StateRow>();
    for (const r of this.db.prepare("SELECT * FROM control_incident_state").all() as StateDbRow[]) states.set(r.source_id, toState(r));
    const mutes = new Map<string, number>();
    for (const r of this.db.prepare("SELECT key, until FROM control_incident_mutes WHERE until > ?").all(now) as { key: string; until: number }[]) mutes.set(r.key, r.until);
    return { states, mutes };
  }

  // --- audit and idempotency ---

  /**
   * Appends one audit row. With an `idemKey` the row is also the stored result of that (action, key): a second
   * insert for the same pair writes nothing and returns false, so a retry can never act twice.
   */
  audit(e: AuditEntry): boolean {
    this.maybePrune(e.at);
    const r = this.db.prepare(`
      INSERT OR IGNORE INTO control_ops_audit (at, device_id, device_name, addr, action, subject, params, result, detail, dur_ms, idem_key, response)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.at, e.deviceId, e.deviceName, e.addr, e.action, e.subject, e.params, e.result, e.detail, e.durMs, e.idemKey ?? null, e.response ?? null);
    return r.changes === 1;
  }

  /** The stored request behind an (action, Idempotency-Key) pair, or null. */
  findIdem(action: string, key: string): { deviceId: string; subject: string; response: string | null } | null {
    const row = this.db.prepare("SELECT device_id, subject, response FROM control_ops_audit WHERE action = ? AND idem_key = ?").get(action, key) as
      { device_id: string; subject: string; response: string | null } | undefined;
    return row ? { deviceId: row.device_id, subject: row.subject, response: row.response } : null;
  }

  /** The actions that took effect on one incident (`result = 'ok'`), newest first. */
  history(subject: string, limit: number): { at: number; action: string; device: string }[] {
    const rows = this.db.prepare("SELECT at, action, device_name FROM control_ops_audit WHERE subject = ? AND result = 'ok' ORDER BY id DESC LIMIT ?").all(subject, limit) as
      { at: number; action: string; device_name: string }[];
    return rows.map((r) => ({ at: r.at, action: r.action, device: r.device_name }));
  }

  /** The newest audit rows of every result, without the remote address, the parameters or the detail. */
  recent(limit: number): { at: number; device: string; action: string; subject: string; result: string }[] {
    const rows = this.db.prepare("SELECT at, device_name, action, subject, result FROM control_ops_audit ORDER BY id DESC LIMIT ?").all(limit) as
      { at: number; device_name: string; action: string; subject: string; result: string }[];
    return rows.map((r) => ({ at: r.at, device: r.device_name, action: r.action, subject: r.subject, result: r.result }));
  }

  // --- retention ---

  /**
   * Audit rows older than 180 days; mutes that ended more than 30 days ago; ids first seen more than 30 days
   * ago that no overlay row needs (an id is a pure hash of its source, so a pruned one comes back identical).
   */
  prune(now: number): { audit: number; mutes: number; ids: number } {
    this.lastPrune = now;
    const audit = this.db.prepare("DELETE FROM control_ops_audit WHERE at < ?").run(now - AUDIT_KEEP_MS).changes;
    const mutes = this.db.prepare("DELETE FROM control_incident_mutes WHERE until < ?").run(now - ID_KEEP_MS).changes;
    const ids = this.db.prepare("DELETE FROM control_incident_ids WHERE first_seen < ? AND opaque_id NOT IN (SELECT opaque_id FROM control_incident_state)").run(now - ID_KEEP_MS).changes;
    this.db.prepare("DELETE FROM control_restart_tokens WHERE created_at < ?").run(now - DAY_MS);
    this.db.prepare("DELETE FROM control_action_payloads WHERE expires_at < ?").run(now);
    return { audit, mutes, ids };
  }

  /** Writes call this, so retention needs no timer: at most one prune an hour. */
  private maybePrune(now: number): void {
    if (now - this.lastPrune >= PRUNE_EVERY_MS) this.prune(now);
  }

  // --- restart tokens (spec section 7: two steps, single use, bound to device and target) ---

  createRestartToken(t: { actionId: string; deviceId: string; targetId: string; incidentId: string; expiresAt: number }, now: number): void {
    this.maybePrune(now);
    this.db.prepare("INSERT INTO control_restart_tokens (action_id, device_id, target_id, incident_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(t.actionId, t.deviceId, t.targetId, t.incidentId, t.expiresAt, now);
  }

  getRestartToken(actionId: string): { actionId: string; deviceId: string; targetId: string; incidentId: string; expiresAt: number; createdAt: number; usedAt: number | null } | undefined {
    const r = this.db.prepare("SELECT * FROM control_restart_tokens WHERE action_id = ?").get(actionId) as
      { action_id: string; device_id: string; target_id: string; incident_id: string; expires_at: number; created_at: number; used_at: number | null } | undefined;
    return r && { actionId: r.action_id, deviceId: r.device_id, targetId: r.target_id, incidentId: r.incident_id, expiresAt: r.expires_at, createdAt: r.created_at, usedAt: r.used_at };
  }

  /** True for exactly one caller: the UPDATE only matches an unused token, so two concurrent confirms cannot both run. */
  consumeRestartToken(actionId: string, now: number): boolean {
    return this.db.prepare("UPDATE control_restart_tokens SET used_at = ? WHERE action_id = ? AND used_at IS NULL AND expires_at > ?").run(now, actionId, now).changes === 1;
  }

  /** When restarts were consumed since `since`, oldest first. Other kinds of action do not count against the restart window. */
  restartUses(since: number): number[] {
    return this.kindUses("restart", since);
  }

  /** When tokens of one kind were consumed since `since`, oldest first; `deviceId` narrows it to one device. */
  kindUses(kind: string, since: number, deviceId?: string): number[] {
    const rows = (deviceId === undefined
      ? this.db.prepare("SELECT used_at FROM control_restart_tokens WHERE kind = ? AND used_at >= ? ORDER BY used_at").all(kind, since)
      : this.db.prepare("SELECT used_at FROM control_restart_tokens WHERE kind = ? AND used_at >= ? AND device_id = ? ORDER BY used_at").all(kind, since, deviceId)) as { used_at: number }[];
    return rows.map((r) => r.used_at);
  }

  lastRestartAt(targetId: string): number | null {
    const r = this.db.prepare("SELECT MAX(used_at) AS m FROM control_restart_tokens WHERE kind = 'restart' AND target_id = ?").get(targetId) as { m: number | null };
    return r.m;
  }

  // --- generalised action tokens (spec 012 D9): every fingerprint action, one table ---

  /** A token of any kind; the optional payload is stored apart and bound to the token by its sha256. */
  createActionToken(t: { actionId: string; kind: string; deviceId: string; subject: string; targetId: string; incidentId?: string; expiresAt: number; payload?: string }, now: number): void {
    this.maybePrune(now);
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO control_restart_tokens (action_id, device_id, target_id, incident_id, expires_at, created_at, kind, subject, payload_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(t.actionId, t.deviceId, t.targetId, t.incidentId ?? "", t.expiresAt, now, t.kind, t.subject, t.payload === undefined ? null : sha256(t.payload));
      if (t.payload !== undefined) this.db.prepare("INSERT INTO control_action_payloads (action_id, payload, expires_at) VALUES (?, ?, ?)").run(t.actionId, t.payload, t.expiresAt);
    })();
  }

  getActionToken(actionId: string): { actionId: string; kind: string; deviceId: string; subject: string | null; targetId: string; incidentId: string; expiresAt: number; createdAt: number; usedAt: number | null; payloadHash: string | null } | undefined {
    const r = this.db.prepare("SELECT * FROM control_restart_tokens WHERE action_id = ?").get(actionId) as
      { action_id: string; kind: string; device_id: string; subject: string | null; target_id: string; incident_id: string; expires_at: number; created_at: number; used_at: number | null; payload_hash: string | null } | undefined;
    return r && { actionId: r.action_id, kind: r.kind, deviceId: r.device_id, subject: r.subject, targetId: r.target_id, incidentId: r.incident_id, expiresAt: r.expires_at, createdAt: r.created_at, usedAt: r.used_at, payloadHash: r.payload_hash };
  }

  /** Reads the payload without deleting it (the confirm checks look at it before the token is spent). */
  peekPayload(actionId: string): string | null {
    const row = this.db.prepare("SELECT payload FROM control_action_payloads WHERE action_id = ?").get(actionId) as { payload: string } | undefined;
    return row?.payload ?? null;
  }

  /** Reads and deletes the payload of one action in one step, so it can be used once. */
  takePayload(actionId: string): string | null {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT payload FROM control_action_payloads WHERE action_id = ?").get(actionId) as { payload: string } | undefined;
      if (!row) return null;
      this.db.prepare("DELETE FROM control_action_payloads WHERE action_id = ?").run(actionId);
      return row.payload;
    })();
  }

  // --- opaque ids ---

  /**
   * The opaque id of a GodHome incident id: `i_` + first 12 hex of sha256, remembered so it never changes.
   * A prefix already held by another source is rehashed with a salt until it is free, so every id keeps the
   * 12-hex shape the app validates. Safe to call twice for one source in a row.
   */
  opaqueId(sourceId: string, now: number): string {
    const find = this.db.prepare("SELECT opaque_id FROM control_incident_ids WHERE source_id = ?");
    const insert = this.db.prepare("INSERT OR IGNORE INTO control_incident_ids (opaque_id, source_id, first_seen) VALUES (?, ?, ?)");
    const known = find.get(sourceId) as { opaque_id: string } | undefined;
    if (known) return known.opaque_id;
    for (let salt = 0; salt < MAX_SALT; salt++) {
      const id = `i_${this.hash(salt === 0 ? sourceId : `${sourceId}#${salt}`).slice(0, 12)}`;
      if (insert.run(id, sourceId, now).changes === 1) return id;
      const raced = find.get(sourceId) as { opaque_id: string } | undefined;
      if (raced) return raced.opaque_id;
    }
    throw new Error("no free incident id");
  }

  /** The GodHome id behind an opaque id this store issued, else null. */
  sourceId(opaqueId: string): string | null {
    const row = this.db.prepare("SELECT source_id FROM control_incident_ids WHERE opaque_id = ?").get(opaqueId) as { source_id: string } | undefined;
    return row?.source_id ?? null;
  }
}
