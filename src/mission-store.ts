import type { Database } from "better-sqlite3";
import { randomBytes } from "crypto";

// Missions live in life.db. Every state change is one conditional UPDATE, so an
// approval answered on Telegram and WhatsApp at the same moment takes effect once.

export type MissionState =
  | "proposed" | "approved" | "declined" | "expired"
  | "running" | "verified" | "failed" | "unverified"
  | "deploying" | "deployed" | "deploy_failed" | "held";

export interface MissionRow {
  id: string;
  project: string;
  prompt: string;
  sender: string;
  jid: string;
  state: MissionState;
  engine: "claude" | "dsh";
  answered_by: string | null;
  answered_at: number | null;
  branch: string | null;
  base_commit: string | null;
  clone_path: string | null;
  tmux_session: string | null;
  exit_code: number | null;
  result: string | null;
  test_output: string | null;
  deploy_output: string | null;
  hold_reason: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

const PATCHABLE = new Set([
  "branch", "base_commit", "clone_path", "tmux_session", "exit_code", "result", "test_output", "deploy_output", "hold_reason",
]);

export function initMissions(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      prompt TEXT NOT NULL,
      sender TEXT NOT NULL,
      jid TEXT NOT NULL,
      state TEXT NOT NULL,
      answered_by TEXT,
      answered_at INTEGER,
      branch TEXT,
      base_commit TEXT,
      clone_path TEXT,
      tmux_session TEXT,
      exit_code INTEGER,
      result TEXT,
      test_output TEXT,
      deploy_output TEXT,
      hold_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_missions_state ON missions(state);
  `);
  // Tables created before engines existed (the live life.db, 2026-09-17).
  const cols = (db.prepare("PRAGMA table_info(missions)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("engine")) db.exec("ALTER TABLE missions ADD COLUMN engine TEXT NOT NULL DEFAULT 'claude'");
}

export function createMission(
  db: Database,
  m: { project: string; prompt: string; sender: string; jid: string; now: number; ttlMs: number; engine?: "claude" | "dsh" },
): string {
  const id = randomBytes(4).toString("hex");
  db.prepare(
    `INSERT INTO missions (id, project, prompt, sender, jid, state, created_at, updated_at, expires_at, engine)
     VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?)`,
  ).run(id, m.project, m.prompt, m.sender, m.jid, m.now, m.now, m.now + m.ttlMs, m.engine ?? "claude");
  return id;
}

export function getMission(db: Database, id: string): MissionRow | undefined {
  return db.prepare("SELECT * FROM missions WHERE id = ?").get(id) as MissionRow | undefined;
}

export type AnswerResult =
  | { status: "applied"; state: "approved" | "declined" }
  | { status: "already"; state: MissionState; answeredBy: string | null }
  | { status: "expired" }
  | { status: "unknown" };

export function answerMission(
  db: Database, id: string, answer: "approve" | "decline", channel: string, now: number,
): AnswerResult {
  const to = answer === "approve" ? "approved" : "declined";
  const r = db.prepare(
    `UPDATE missions SET state = ?, answered_by = ?, answered_at = ?, updated_at = ?
     WHERE id = ? AND state = 'proposed' AND expires_at > ?`,
  ).run(to, channel, now, now, id, now);
  if (r.changes === 1) return { status: "applied", state: to };
  const row = getMission(db, id);
  if (!row) return { status: "unknown" };
  if (row.state === "proposed" || row.state === "expired") {
    expireMissions(db, now);
    return { status: "expired" };
  }
  return { status: "already", state: row.state, answeredBy: row.answered_by };
}

export function expireMissions(db: Database, now: number): string[] {
  const ids = (db.prepare("SELECT id FROM missions WHERE state = 'proposed' AND expires_at <= ?").all(now) as { id: string }[])
    .map((r) => r.id);
  if (ids.length) {
    db.prepare("UPDATE missions SET state = 'expired', updated_at = ? WHERE state = 'proposed' AND expires_at <= ?").run(now, now);
  }
  return ids;
}

/** Move a mission only if it is currently in one of `from`. Returns whether it moved. */
export function transitionMission(
  db: Database, id: string, from: MissionState[], to: MissionState,
  patch: Partial<Pick<MissionRow, "branch" | "base_commit" | "clone_path" | "tmux_session" | "exit_code" | "result" | "test_output" | "deploy_output" | "hold_reason">>,
  now: number,
): boolean {
  const keys = Object.keys(patch);
  for (const k of keys) if (!PATCHABLE.has(k)) throw new Error(`not patchable: ${k}`);
  const sets = ["state = ?", "updated_at = ?", ...keys.map((k) => `${k} = ?`)].join(", ");
  const placeholders = from.map(() => "?").join(", ");
  const r = db.prepare(`UPDATE missions SET ${sets} WHERE id = ? AND state IN (${placeholders})`)
    .run(to, now, ...keys.map((k) => (patch as any)[k]), id, ...from);
  return r.changes === 1;
}

export function listMissions(db: Database, limit = 50): MissionRow[] {
  return db.prepare("SELECT * FROM missions ORDER BY created_at DESC LIMIT ?").all(limit) as MissionRow[];
}
