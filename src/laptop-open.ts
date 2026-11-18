import type { Database } from "better-sqlite3";

/** The offline Claude-run fallback queue: create the table, then add the columns later versions need (PRAGMA table_info, like the other stores). */
export function ensureLaptopQueue(d: Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS laptop_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      prompt TEXT NOT NULL,
      reason TEXT,
      chat_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT ('pending'),
      started_at INTEGER,
      finished_at INTEGER,
      output TEXT
    );
  `);

  const cols = new Set((d.prepare("PRAGMA table_info(laptop_queue)").all() as any[]).map((c: any) => c.name));
  if (!cols.has("layer")) d.exec("ALTER TABLE laptop_queue ADD COLUMN layer TEXT DEFAULT 'claude-code'");
  // The Control run and deploy offer a queued task answers, so the drainer starts that run instead of an unlinked new one.
  if (!cols.has("control_run_id")) d.exec("ALTER TABLE laptop_queue ADD COLUMN control_run_id TEXT");
  if (!cols.has("offer_id")) d.exec("ALTER TABLE laptop_queue ADD COLUMN offer_id TEXT");
}

/** True while a laptop queue row for this Control run is waiting for the Mac or being started: the run is not lost, only not begun. */
export function laptopTaskOpenForRun(d: Database, controlRunId: string): boolean {
  try {
    return !!d.prepare(`SELECT 1 FROM laptop_queue WHERE control_run_id = ? AND status IN ('pending', 'running') LIMIT 1`).get(controlRunId);
  } catch {
    return false;
  }
}
