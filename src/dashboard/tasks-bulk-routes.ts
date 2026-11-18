/**
 * Dashboard API — bulk task cleanup.
 *
 * Mark-done / delete many tasks at once, and serve the read-only audit
 * suggestions written to /root/tokyo-tasks-audit.json. Paths live under
 * /api/tasks-bulk so they never collide with routes.ts's /api/tasks/:id/*.
 */

import fs from "fs";
import { Router, type Request, type Response } from "express";
import rawDb, * as db from "../db";

const router = Router();

const MAX_IDS = 500;
const AUDIT_FILE = process.env.TASKS_AUDIT_FILE || "/root/tokyo-tasks-audit.json";
const SUGGESTED = new Set(["LIKELY_DONE", "OBSOLETE"]);

type IdsResult = { ids: number[] } | { error: string };

function parseIds(body: unknown): IdsResult {
  const raw = (body as { ids?: unknown } | undefined)?.ids;
  if (!Array.isArray(raw) || raw.length === 0) return { error: "ids must be a non-empty array" };
  if (raw.length > MAX_IDS) return { error: `At most ${MAX_IDS} ids per request` };
  const ids = new Set<number>();
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) {
      return { error: "ids must be positive integers" };
    }
    ids.add(v);
  }
  return { ids: [...ids] };
}

function openIdsAmong(ids: number[]): Set<number> {
  const placeholders = ids.map(() => "?").join(",");
  const rows = rawDb
    .prepare(`SELECT id FROM tasks WHERE status IN ('pending','in_progress') AND id IN (${placeholders})`)
    .all(...ids) as { id: number }[];
  return new Set(rows.map((r) => r.id));
}

// ========================
// POST /api/tasks-bulk/complete  { ids: number[] }
// Only open tasks are completed; already-done or missing ids are reported as skipped.
// ========================
router.post("/api/tasks-bulk/complete", (req: Request, res: Response) => {
  const parsed = parseIds(req.body);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const open = openIdsAmong(parsed.ids);
    const run = rawDb.transaction((ids: number[]) => {
      for (const id of ids) db.completeTask(id);
    });
    const toComplete = parsed.ids.filter((id) => open.has(id));
    run(toComplete);
    res.json({
      ok: true,
      updated: toComplete.length,
      skipped: parsed.ids.filter((id) => !open.has(id)),
    });
  } catch (err) {
    console.error("Bulk complete tasks error:", err);
    res.status(500).json({ error: "Failed to complete tasks" });
  }
});

// ========================
// POST /api/tasks-bulk/delete  { ids: number[] }
// Uses db.deleteTask, which also removes subtasks.
// ========================
router.post("/api/tasks-bulk/delete", (req: Request, res: Response) => {
  const parsed = parseIds(req.body);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    let deleted = 0;
    const run = rawDb.transaction((ids: number[]) => {
      for (const id of ids) deleted += db.deleteTask(id).changes;
    });
    run(parsed.ids);
    res.json({ ok: true, deleted });
  } catch (err) {
    console.error("Bulk delete tasks error:", err);
    res.status(500).json({ error: "Failed to delete tasks" });
  }
});

// ========================
// GET /api/tasks-bulk/suggestions
// Audit rows classified LIKELY_DONE / OBSOLETE that are still open right now.
// ========================
interface AuditRow {
  id: number;
  title: string;
  category: string;
  created: string;
  due: string | null;
  age_days: number;
  classification: string;
  evidence: string[];
}

router.get("/api/tasks-bulk/suggestions", (_req: Request, res: Response) => {
  let audit: { generated_at?: string; counts?: Record<string, number>; tasks?: AuditRow[] };
  try {
    audit = JSON.parse(fs.readFileSync(AUDIT_FILE, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      res.json({ generatedAt: null, counts: {}, suggestions: [] });
      return;
    }
    console.error("Read task audit error:", err);
    res.status(500).json({ error: "Failed to read task audit file" });
    return;
  }
  try {
    const rows = (audit.tasks ?? []).filter((t) => SUGGESTED.has(t.classification));
    const open = rows.length ? openIdsAmong(rows.map((r) => r.id)) : new Set<number>();
    const suggestions = rows
      .filter((r) => open.has(r.id))
      .map((r) => ({
        id: r.id,
        title: r.title,
        category: r.category,
        created: r.created,
        due: r.due,
        ageDays: r.age_days,
        classification: r.classification,
        evidence: r.evidence,
      }));
    res.json({ generatedAt: audit.generated_at ?? null, counts: audit.counts ?? {}, suggestions });
  } catch (err) {
    console.error("Task suggestions error:", err);
    res.status(500).json({ error: "Failed to load suggestions" });
  }
});

export default router;
