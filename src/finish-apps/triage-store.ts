import type { Database } from "better-sqlite3";

// Daily triage snapshots: history of completeness plus the recommendations and gaps of
// each sweep, served to the Control app (Part C). The table is created here, not in db.ts (D2).

export interface SnapshotProject extends Record<string, unknown> {
  name: string;
  completeness: number | null;
  recommendations: unknown[];
  gaps: unknown[];
}

export class TriageStore {
  constructor(private db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS triage_snapshots (
        date TEXT NOT NULL,
        project TEXT NOT NULL,
        json TEXT NOT NULL,
        recommendations_json TEXT NOT NULL DEFAULT '[]',
        gaps_json TEXT NOT NULL DEFAULT '[]',
        completeness INTEGER,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (date, project)
      );
    `);
  }

  upsert(date: string, project: string, entry: Record<string, unknown>, recommendations: unknown[], gaps: unknown[]): void {
    const c = typeof entry.completeness === "number" ? entry.completeness : null;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO triage_snapshots (date, project, json, recommendations_json, gaps_json, completeness, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(date, project, JSON.stringify(entry), JSON.stringify(recommendations), JSON.stringify(gaps), c, Date.now());
  }

  /** Every project of the newest date. */
  latest(): { date: string | null; projects: SnapshotProject[] } {
    const d = this.db.prepare("SELECT MAX(date) AS date FROM triage_snapshots").get() as { date: string | null };
    if (!d.date) return { date: null, projects: [] };
    const rows = this.db
      .prepare("SELECT json, recommendations_json, gaps_json FROM triage_snapshots WHERE date = ? ORDER BY project")
      .all(d.date) as { json: string; recommendations_json: string; gaps_json: string }[];
    return {
      date: d.date,
      projects: rows.map((r) => ({
        ...JSON.parse(r.json),
        recommendations: JSON.parse(r.recommendations_json),
        gaps: JSON.parse(r.gaps_json),
      })),
    };
  }

  /** Last `limit` points, oldest first. */
  history(project: string, limit = 30): { date: string; completeness: number | null }[] {
    const rows = this.db
      .prepare("SELECT date, completeness FROM triage_snapshots WHERE project = ? ORDER BY date DESC LIMIT ?")
      .all(project, limit) as { date: string; completeness: number | null }[];
    return rows.reverse();
  }
}

let shared: TriageStore | undefined;
/** The store on the live database (lazy, so importing this module opens nothing). */
export function defaultTriageStore(): TriageStore {
  if (!shared) shared = new TriageStore(require("../db").default);
  return shared;
}
