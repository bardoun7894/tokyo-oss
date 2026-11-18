/**
 * Tokyo social publisher — persistence.
 *
 * Tokens, per-platform switches and job history all live in life.db so a
 * restart mid-upload leaves an auditable trail instead of a silent gap.
 */

import db from "../db";
import { PLATFORMS, type Platform, type Preset, type JobStatus, type TargetStatus } from "./types";

/**
 * Scheduling arrived after the first shares had already run, and the status
 * CHECK constraint has no room for 'scheduled'. SQLite cannot widen a CHECK in
 * place, so rebuild the table and copy the rows across — once.
 *
 * The new table is built under a temporary name and renamed only after the old
 * one is gone, so social_job_targets' reference is never rewritten to point at
 * a renamed original.
 */
function migrateJobsForScheduling(): void {
  const cols = db.prepare(`PRAGMA table_info(social_jobs)`).all() as Array<{ name: string }>;
  if (!cols.length || cols.some((c) => c.name === "scheduled_at")) return;

  // Dropping the old table would trip social_job_targets' FK, and the RENAME
  // would rewrite that FK to chase the renamed table. Both are suspended for
  // the swap and restored right after.
  const fkWasOn = (db.pragma("foreign_keys", { simple: true }) as number) === 1;
  if (fkWasOn) db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  db.exec(`
    DROP TABLE IF EXISTS social_jobs_new;
    CREATE TABLE social_jobs_new (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      preset       TEXT NOT NULL CHECK(preset IN ('short','video')),
      title        TEXT,
      caption      TEXT,
      media_path   TEXT NOT NULL,
      duration_sec REAL,
      width        INTEGER,
      height       INTEGER,
      size_bytes   INTEGER,
      privacy      TEXT DEFAULT 'public',
      source       TEXT DEFAULT 'telegram',
      status       TEXT DEFAULT 'draft' CHECK(status IN ('draft','scheduled','running','done','failed','cancelled')),
      scheduled_at INTEGER,
      chat_id      INTEGER,
      created_at   TEXT DEFAULT (datetime('now')),
      finished_at  TEXT
    );
    INSERT INTO social_jobs_new
      (id, preset, title, caption, media_path, duration_sec, width, height, size_bytes, privacy, source, status, created_at, finished_at)
    SELECT
       id, preset, title, caption, media_path, duration_sec, width, height, size_bytes, privacy, source, status, created_at, finished_at
    FROM social_jobs;
    DROP TABLE social_jobs;
    ALTER TABLE social_jobs_new RENAME TO social_jobs;
  `);
  db.pragma("legacy_alter_table = OFF");
  if (fkWasOn) db.pragma("foreign_keys = ON");
  console.log("[social] migrated social_jobs for scheduling");
}

export function initSocialTables(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS social_accounts (
      platform      TEXT PRIMARY KEY,
      access_token  TEXT,
      refresh_token TEXT,
      expires_at    TEXT,
      account_id    TEXT,
      account_kind  TEXT DEFAULT 'personal' CHECK(account_kind IN ('personal','business')),
      label         TEXT,
      meta          TEXT,
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS social_switches (
      platform TEXT NOT NULL,
      preset   TEXT NOT NULL,
      enabled  INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (platform, preset)
    );

    CREATE TABLE IF NOT EXISTS social_jobs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      preset       TEXT NOT NULL CHECK(preset IN ('short','video')),
      title        TEXT,
      caption      TEXT,
      media_path   TEXT NOT NULL,
      duration_sec REAL,
      width        INTEGER,
      height       INTEGER,
      size_bytes   INTEGER,
      privacy      TEXT DEFAULT 'public',
      source       TEXT DEFAULT 'telegram',
      status       TEXT DEFAULT 'draft' CHECK(status IN ('draft','scheduled','running','done','failed','cancelled')),
      scheduled_at INTEGER,
      chat_id      INTEGER,
      created_at   TEXT DEFAULT (datetime('now')),
      finished_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS social_job_targets (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id    INTEGER NOT NULL REFERENCES social_jobs(id),
      platform  TEXT NOT NULL,
      status    TEXT DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed','skipped')),
      remote_id TEXT,
      url       TEXT,
      error     TEXT,
      warning   TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(job_id, platform)
    );

    CREATE INDEX IF NOT EXISTS idx_social_targets_job ON social_job_targets(job_id);
  `);

  migrateJobsForScheduling();

  // Every platform defaults to ON for both presets; the switch panel flips them.
  const seed = db.prepare(
    `INSERT OR IGNORE INTO social_switches (platform, preset, enabled) VALUES (?, ?, 1)`
  );
  for (const p of PLATFORMS) {
    seed.run(p, "short");
    seed.run(p, "video");
  }

  // A job left 'running' by a restart can never finish — surface it as failed.
  db.prepare(
    `UPDATE social_jobs SET status = 'failed', finished_at = datetime('now') WHERE status = 'running'`
  ).run();
  db.prepare(
    `UPDATE social_job_targets SET status = 'failed', error = 'interrupted by restart'
     WHERE status IN ('pending','running') AND job_id IN (SELECT id FROM social_jobs WHERE status = 'failed')`
  ).run();
}

// --- Accounts ---

export interface SocialAccount {
  platform: Platform;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
  account_id: string | null;
  account_kind: "personal" | "business";
  label: string | null;
  meta: string | null;
}

export function getAccount(platform: Platform): SocialAccount | undefined {
  return db.prepare(`SELECT * FROM social_accounts WHERE platform = ?`).get(platform) as
    | SocialAccount
    | undefined;
}

export function saveAccount(platform: Platform, patch: Partial<SocialAccount>): void {
  const current = getAccount(platform);
  const next = { ...current, ...patch };
  db.prepare(
    `INSERT INTO social_accounts (platform, access_token, refresh_token, expires_at, account_id, account_kind, label, meta, updated_at)
     VALUES (@platform, @access_token, @refresh_token, @expires_at, @account_id, @account_kind, @label, @meta, datetime('now'))
     ON CONFLICT(platform) DO UPDATE SET
       access_token  = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at    = excluded.expires_at,
       account_id    = excluded.account_id,
       account_kind  = excluded.account_kind,
       label         = excluded.label,
       meta          = excluded.meta,
       updated_at    = datetime('now')`
  ).run({
    platform,
    access_token: next.access_token ?? null,
    refresh_token: next.refresh_token ?? null,
    expires_at: next.expires_at ?? null,
    account_id: next.account_id ?? null,
    account_kind: next.account_kind ?? "personal",
    label: next.label ?? null,
    meta: next.meta ?? null,
  });
}

export function deleteAccount(platform: Platform): void {
  db.prepare(`DELETE FROM social_accounts WHERE platform = ?`).run(platform);
}

// --- Switches ---

export function isSwitchOn(platform: Platform, preset: Preset): boolean {
  const row = db
    .prepare(`SELECT enabled FROM social_switches WHERE platform = ? AND preset = ?`)
    .get(platform, preset) as { enabled: number } | undefined;
  return row ? row.enabled === 1 : true;
}

export function setSwitch(platform: Platform, preset: Preset, enabled: boolean): void {
  db.prepare(
    `INSERT INTO social_switches (platform, preset, enabled) VALUES (?, ?, ?)
     ON CONFLICT(platform, preset) DO UPDATE SET enabled = excluded.enabled`
  ).run(platform, preset, enabled ? 1 : 0);
}

export function toggleSwitch(platform: Platform, preset: Preset): boolean {
  const next = !isSwitchOn(platform, preset);
  setSwitch(platform, preset, next);
  return next;
}

export function listSwitches(preset: Preset): Record<Platform, boolean> {
  const out = {} as Record<Platform, boolean>;
  for (const p of PLATFORMS) out[p] = isSwitchOn(p, preset);
  return out;
}

// --- Jobs ---

export interface SocialJobRow {
  id: number;
  preset: Preset;
  title: string | null;
  caption: string | null;
  media_path: string;
  duration_sec: number | null;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  privacy: string;
  source: string;
  status: JobStatus;
  scheduled_at: number | null;
  chat_id: number | null;
  created_at: string;
  finished_at: string | null;
}

export interface SocialTargetRow {
  id: number;
  job_id: number;
  platform: Platform;
  status: TargetStatus;
  remote_id: string | null;
  url: string | null;
  error: string | null;
  warning: string | null;
}

export function createJob(job: {
  preset: Preset;
  title: string;
  caption: string;
  mediaPath: string;
  durationSec: number;
  width: number;
  height: number;
  sizeBytes: number;
  privacy: string;
  source: string;
}): number {
  const res = db
    .prepare(
      `INSERT INTO social_jobs (preset, title, caption, media_path, duration_sec, width, height, size_bytes, privacy, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      job.preset,
      job.title,
      job.caption,
      job.mediaPath,
      job.durationSec,
      job.width,
      job.height,
      job.sizeBytes,
      job.privacy,
      job.source
    );
  return res.lastInsertRowid as number;
}

export function updateJob(id: number, patch: Partial<SocialJobRow>): void {
  const fields = Object.keys(patch);
  if (!fields.length) return;
  const set = fields.map((f) => `${f} = @${f}`).join(", ");
  db.prepare(`UPDATE social_jobs SET ${set} WHERE id = @id`).run({ ...patch, id });
}

export function setJobStatus(id: number, status: JobStatus): void {
  const finished = status === "done" || status === "failed" || status === "cancelled";
  db.prepare(
    `UPDATE social_jobs SET status = ?, finished_at = ${finished ? "datetime('now')" : "finished_at"} WHERE id = ?`
  ).run(status, id);
}

export function getJob(id: number): SocialJobRow | undefined {
  return db.prepare(`SELECT * FROM social_jobs WHERE id = ?`).get(id) as SocialJobRow | undefined;
}

export function setTargets(jobId: number, platforms: Platform[]): void {
  db.prepare(`DELETE FROM social_job_targets WHERE job_id = ?`).run(jobId);
  const ins = db.prepare(
    `INSERT INTO social_job_targets (job_id, platform, status) VALUES (?, ?, 'pending')`
  );
  for (const p of platforms) ins.run(jobId, p);
}

export function getTargets(jobId: number): SocialTargetRow[] {
  return db
    .prepare(`SELECT * FROM social_job_targets WHERE job_id = ? ORDER BY id`)
    .all(jobId) as SocialTargetRow[];
}

export function updateTarget(
  jobId: number,
  platform: Platform,
  patch: { status?: TargetStatus; remote_id?: string; url?: string; error?: string; warning?: string }
): void {
  db.prepare(
    `UPDATE social_job_targets SET
       status    = COALESCE(@status, status),
       remote_id = COALESCE(@remote_id, remote_id),
       url       = COALESCE(@url, url),
       error     = COALESCE(@error, error),
       warning   = COALESCE(@warning, warning),
       updated_at = datetime('now')
     WHERE job_id = @job_id AND platform = @platform`
  ).run({
    job_id: jobId,
    platform,
    status: patch.status ?? null,
    remote_id: patch.remote_id ?? null,
    url: patch.url ?? null,
    error: patch.error ?? null,
    warning: patch.warning ?? null,
  });
}

// --- Scheduling ---

/** Park a job until `whenMs`, remembering which chat to report back to. */
export function scheduleJob(id: number, whenMs: number, chatId: number): void {
  db.prepare(
    `UPDATE social_jobs SET status = 'scheduled', scheduled_at = ?, chat_id = ? WHERE id = ?`
  ).run(whenMs, chatId, id);
}

export function unscheduleJob(id: number): void {
  db.prepare(`UPDATE social_jobs SET status = 'draft', scheduled_at = NULL WHERE id = ?`).run(id);
}

/** Scheduled jobs whose time has come. */
export function dueJobs(nowMs = Date.now()): SocialJobRow[] {
  return db
    .prepare(`SELECT * FROM social_jobs WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at`)
    .all(nowMs) as SocialJobRow[];
}

export function pendingScheduled(): SocialJobRow[] {
  return db
    .prepare(`SELECT * FROM social_jobs WHERE status = 'scheduled' ORDER BY scheduled_at`)
    .all() as SocialJobRow[];
}

export function listRecentJobs(limit = 10): SocialJobRow[] {
  return db
    .prepare(`SELECT * FROM social_jobs ORDER BY id DESC LIMIT ?`)
    .all(limit) as SocialJobRow[];
}
