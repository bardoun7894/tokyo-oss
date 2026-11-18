import crypto from "crypto";
import type { Database } from "better-sqlite3";

// SQLite backing for the Control API. Tables are created here, not in db.ts (D2).

export const DEVICE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const RUN_KEEP_MS = 90 * 24 * 60 * 60 * 1000;

export const CAPS = ["ops:read", "ops:write", "ops:service", "life:read", "life:write", "agents:start", "ops:run"] as const;
export type Cap = (typeof CAPS)[number];
/** What a device holds when nobody granted anything: the column default and the value an old row migrates to. */
export const DEFAULT_CAPS = "ops:read,ops:write";

export interface Device {
  id: string; name: string; createdAt: number; lastSeenAt: number; expiresAt: number; fcmToken: string | null;
  caps: Cap[];
}

export interface ControlRun {
  id: string; project: string;
  source: "tokyo" | "jdelegate" | "herdr" | "server-agent";
  status: "queued" | "running" | "succeeded" | "failed" | "stopped";
  model: string | null; harness: string | null; worker: string | null; tier: string | null;
  promptPreview: string; startedAt: number; endedAt: number | null; exitCode: number | null;
  host: "mac" | "server"; offerId: string | null;
  /** herdr workspace label, used by Stop (`hsess kill`). Never exposed. */
  workspace: string | null;
}

export interface RunFilter { project?: string; status?: string; before?: number; since?: number; limit?: number }

interface DeviceRow { id: string; name: string; created_at: number; last_seen_at: number; expires_at: number; fcm_token: string | null; caps: string }
interface RunRow {
  id: string; project: string; source: string; status: string; model: string | null; harness: string | null;
  worker: string | null; tier: string | null; prompt_preview: string; started_at: number; ended_at: number | null;
  exit_code: number | null; host: string; offer_id: string | null; workspace: string | null;
}

const parseCaps = (v: string | null | undefined): Cap[] => CAPS.filter((c) => (v ?? DEFAULT_CAPS).split(",").includes(c));

const toDevice = (r: DeviceRow): Device => ({
  id: r.id, name: r.name, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at, fcmToken: r.fcm_token,
  caps: parseCaps(r.caps),
});

const toRun = (r: RunRow): ControlRun => ({
  id: r.id, project: r.project, source: r.source as ControlRun["source"], status: r.status as ControlRun["status"],
  model: r.model, harness: r.harness, worker: r.worker, tier: r.tier, promptPreview: r.prompt_preview,
  startedAt: r.started_at, endedAt: r.ended_at, exitCode: r.exit_code, host: r.host as ControlRun["host"],
  offerId: r.offer_id, workspace: r.workspace,
});

const RUN_COLUMNS: Record<keyof Omit<ControlRun, "id">, string> = {
  project: "project", source: "source", status: "status", model: "model", harness: "harness", worker: "worker",
  tier: "tier", promptPreview: "prompt_preview", startedAt: "started_at", endedAt: "ended_at", exitCode: "exit_code",
  host: "host", offerId: "offer_id", workspace: "workspace",
};

export class ControlStore {
  constructor(private db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS control_devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        fcm_token TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS control_runs (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        model TEXT,
        harness TEXT,
        worker TEXT,
        tier TEXT,
        prompt_preview TEXT NOT NULL DEFAULT '',
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        exit_code INTEGER,
        host TEXT NOT NULL,
        offer_id TEXT,
        workspace TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_control_runs_started ON control_runs(started_at);
      CREATE INDEX IF NOT EXISTS idx_control_runs_project ON control_runs(project, started_at);
    `);
    const deviceCols = db.prepare("PRAGMA table_info(control_devices)").all() as { name: string }[];
    if (!deviceCols.some((c) => c.name === "caps")) {
      db.exec(`ALTER TABLE control_devices ADD COLUMN caps TEXT NOT NULL DEFAULT '${DEFAULT_CAPS}'`);
    }
  }

  // --- devices ---

  createDevice(a: { name: string; tokenHash: string; now: number }): Device {
    const id = "d_" + crypto.randomBytes(4).toString("hex");
    const expiresAt = a.now + DEVICE_TTL_MS;
    this.db
      .prepare("INSERT INTO control_devices (id, name, token_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, a.name, a.tokenHash, a.now, a.now, expiresAt);
    return { id, name: a.name, createdAt: a.now, lastSeenAt: a.now, expiresAt, fcmToken: null, caps: parseCaps(DEFAULT_CAPS) };
  }

  /** The device for a token hash, or undefined when unknown or expired (an expired row is dropped). */
  findByTokenHash(hash: string, now: number): Device | undefined {
    const row = this.db.prepare("SELECT * FROM control_devices WHERE token_hash = ?").get(hash) as DeviceRow | undefined;
    if (!row) return undefined;
    if (now > row.expires_at) {
      this.db.prepare("DELETE FROM control_devices WHERE id = ?").run(row.id);
      return undefined;
    }
    return toDevice(row);
  }

  /** Records activity and slides the expiry. */
  touch(id: string, now: number): void {
    this.db.prepare("UPDATE control_devices SET last_seen_at = ?, expires_at = ? WHERE id = ?").run(now, now + DEVICE_TTL_MS, id);
  }

  listDevices(): Device[] {
    return (this.db.prepare("SELECT * FROM control_devices ORDER BY created_at, id").all() as DeviceRow[]).map(toDevice);
  }

  revoke(id: string): boolean {
    return this.db.prepare("DELETE FROM control_devices WHERE id = ?").run(id).changes > 0;
  }

  /** Revokes every device, except `exceptId` when given. Returns how many were removed. */
  revokeAll(exceptId?: string): number {
    if (exceptId) return this.db.prepare("DELETE FROM control_devices WHERE id <> ?").run(exceptId).changes;
    return this.db.prepare("DELETE FROM control_devices").run().changes;
  }

  /** Replaces a device's capabilities (stored in canonical order). False when the device does not exist. */
  setCaps(id: string, caps: readonly Cap[]): boolean {
    const value = CAPS.filter((c) => caps.includes(c)).join(",");
    return this.db.prepare("UPDATE control_devices SET caps = ? WHERE id = ?").run(value, id).changes > 0;
  }

  setFcmToken(id: string, token: string | null): void {
    this.db.prepare("UPDATE control_devices SET fcm_token = ? WHERE id = ?").run(token, id);
  }

  pushTokens(): string[] {
    return (this.db.prepare("SELECT fcm_token FROM control_devices WHERE fcm_token IS NOT NULL ORDER BY created_at").all() as { fcm_token: string }[])
      .map((r) => r.fcm_token);
  }

  // --- runs ---

  insertRun(r: ControlRun): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO control_runs
         (id, project, source, status, model, harness, worker, tier, prompt_preview, started_at, ended_at, exit_code, host, offer_id, workspace)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.project, r.source, r.status, r.model, r.harness, r.worker, r.tier, r.promptPreview, r.startedAt, r.endedAt, r.exitCode, r.host, r.offerId, r.workspace);
  }

  updateRun(id: string, patch: Partial<Omit<ControlRun, "id">>): void {
    const keys = (Object.keys(patch) as (keyof typeof RUN_COLUMNS)[]).filter((k) => k in RUN_COLUMNS);
    if (keys.length === 0) return;
    const sql = `UPDATE control_runs SET ${keys.map((k) => `${RUN_COLUMNS[k]} = ?`).join(", ")} WHERE id = ?`;
    this.db.prepare(sql).run(...keys.map((k) => patch[k] ?? null), id);
  }

  deleteRun(id: string): void {
    this.db.prepare("DELETE FROM control_runs WHERE id = ?").run(id);
  }

  getRun(id: string): ControlRun | undefined {
    const row = this.db.prepare("SELECT * FROM control_runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  /** Newest first by start time. `since` matches runs started or ended at or after it. */
  listRuns(f: RunFilter): ControlRun[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.project) { where.push("project = ?"); args.push(f.project); }
    if (f.status) { where.push("status = ?"); args.push(f.status); }
    if (f.before !== undefined) { where.push("started_at < ?"); args.push(f.before); }
    if (f.since !== undefined) { where.push("(started_at >= ? OR ended_at >= ?)"); args.push(f.since, f.since); }
    // 101 so a caller can fetch one extra row to know whether another page exists.
    const limit = Math.min(Math.max(f.limit ?? 20, 1), 101);
    const sql = `SELECT * FROM control_runs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY started_at DESC, id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, limit) as RunRow[]).map(toRun);
  }

  countRuns(status: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM control_runs WHERE status = ?").get(status) as { n: number }).n;
  }

  countFailedSince(since: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM control_runs WHERE status = 'failed' AND ended_at >= ?").get(since) as { n: number }).n;
  }

  /** Drops expired devices and finished runs older than RUN_KEEP_MS. */
  prune(now: number): { devices: number; runs: number } {
    const devices = this.db.prepare("DELETE FROM control_devices WHERE expires_at < ?").run(now).changes;
    const runs = this.db
      .prepare("DELETE FROM control_runs WHERE status NOT IN ('queued', 'running') AND COALESCE(ended_at, started_at) < ?")
      .run(now - RUN_KEEP_MS).changes;
    return { devices, runs };
  }
}
