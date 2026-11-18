import Database from "better-sqlite3";
import path from "path";
import { getActiveWorkSession } from "./db";

const DB_PATH = path.join(__dirname, "..", "life.db");
const db: import("better-sqlite3").Database = new Database(DB_PATH);

export type UserState =
  | "deep_work"
  | "shop_mode"
  | "meeting_mode"
  | "admin_mode"
  | "low_energy"
  | "family_mode"
  | "post_prayer"
  | "idle";

export interface StateInfo {
  state: UserState;
  source: "auto" | "manual" | "ai_inferred";
  note?: string;
  setAt: string;
}

const STATE_CATEGORIES: Record<UserState, string[]> = {
  deep_work: ["client", "product"],
  shop_mode: ["shop", "admin"],
  admin_mode: ["admin", "client"],
  low_energy: ["personal", "learning", "deen"],
  post_prayer: ["deen", "personal"],
  family_mode: ["personal"],
  meeting_mode: ["client"],
  idle: ["client", "product", "shop", "learning", "deen", "admin", "health", "personal"],
};

export function initStateTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      state TEXT NOT NULL,
      source TEXT NOT NULL,
      note TEXT,
      set_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      ended_at TEXT
    )
  `);
}

export function getCurrentState(): StateInfo {
  // 1. Active work session overrides everything
  const session = getActiveWorkSession();

  if (session) {
    const stateMap: Record<string, UserState> = {
      dev: "deep_work",
      shop: "shop_mode",
      admin: "admin_mode",
    };
    const state = stateMap[session.work_type];
    if (state) {
      return {
        state,
        source: "auto",
        note: session.note,
        setAt: new Date().toISOString(),
      };
    }
  }

  // 2. Check for a recent manual/ai state set within the last 4 hours
  const recentState = db.prepare(
    "SELECT * FROM user_state WHERE ended_at IS NULL AND set_at >= datetime('now', '-4 hours') ORDER BY set_at DESC LIMIT 1"
  ).get() as any;

  if (recentState) {
    return {
      state: recentState.state as UserState,
      source: recentState.source as "auto" | "manual" | "ai_inferred",
      note: recentState.note ?? undefined,
      setAt: recentState.set_at,
    };
  }

  // 3. Fall back to time-based inference
  const now = new Date();
  const hour = now.getHours();

  if (hour >= 22) {
    return {
      state: "family_mode",
      source: "ai_inferred",
      note: "late evening",
      setAt: now.toISOString(),
    };
  }

  return {
    state: "idle",
    source: "auto",
    setAt: now.toISOString(),
  };
}

export function setState(
  state: UserState,
  source: "manual" | "auto" | "ai_inferred",
  note?: string
): StateInfo {
  endCurrentState();

  const insert = db.prepare(
    "INSERT INTO user_state (state, source, note) VALUES (?, ?, ?)"
  );
  const result = insert.run(state, source, note ?? null);

  const row = db
    .prepare("SELECT * FROM user_state WHERE id = ?")
    .get(result.lastInsertRowid) as any;

  return {
    state: row.state as UserState,
    source: row.source as "auto" | "manual" | "ai_inferred",
    note: row.note ?? undefined,
    setAt: row.set_at,
  };
}

export function endCurrentState(): void {
  db.prepare(
    "UPDATE user_state SET ended_at = datetime('now', 'localtime') WHERE ended_at IS NULL"
  ).run();
}

export function getStateHistory(hours: number): StateInfo[] {
  const rows = db
    .prepare(
      `SELECT state, source, note, set_at as setAt FROM user_state
       WHERE set_at >= datetime('now', 'localtime', '-${hours} hours')
       ORDER BY set_at DESC`
    )
    .all() as any[];

  return rows.map((row) => ({
    state: row.state as UserState,
    source: row.source as "auto" | "manual" | "ai_inferred",
    note: row.note ?? undefined,
    setAt: row.setAt,
  }));
}

export function getAllowedCategories(state: UserState): string[] {
  return STATE_CATEGORIES[state] ?? STATE_CATEGORIES.idle;
}
