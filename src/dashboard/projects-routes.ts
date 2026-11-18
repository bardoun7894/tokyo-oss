/**
 * Dashboard API — git-synced project repos.
 *
 * Mounted from routes.ts with a single router.use(). Lives under
 * /api/project-repos so it never collides with the manual GET /api/projects.
 * Loading this module starts the hourly sync (guarded against double start).
 */

import { Router } from "express";
import db from "../db";
import {
  isSyncRunning,
  listProjectRepos,
  listSyncHosts,
  startProjectReposSync,
  syncProjectRepos,
  updateProjectRepo,
} from "../projects-sync";

const router = Router();

startProjectReposSync();

function payload() {
  return {
    repos: listProjectRepos(),
    hosts: listSyncHosts(),
    syncing: isSyncRunning(),
    clients: db.prepare("SELECT id, name FROM clients WHERE active = 1 ORDER BY name").all(),
    projects: db.prepare(`
      SELECT p.*, c.name AS client_name
      FROM projects p LEFT JOIN clients c ON c.id = p.client_id
      ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'proposal' THEN 1 ELSE 2 END, p.deadline ASC NULLS LAST
    `).all(),
  };
}

// GET /api/project-repos — repos + sync state + lookups for inline edit
router.get("/api/project-repos", (_req, res) => {
  try {
    res.json(payload());
  } catch (err) {
    console.error("Dashboard project-repos error:", err);
    res.status(500).json({ error: "Failed to load project repos" });
  }
});

// POST /api/project-repos/sync — scan all hosts now, return fresh data
router.post("/api/project-repos/sync", async (_req, res) => {
  try {
    const results = await syncProjectRepos();
    res.json({ results, ...payload() });
  } catch (err) {
    console.error("Dashboard project-repos sync error:", err);
    res.status(500).json({ error: "Sync failed" });
  }
});

// POST /api/project-repos/:id — edit user-owned fields
router.post("/api/project-repos/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "invalid id" });
  try {
    const error = updateProjectRepo(id, (req.body ?? {}) as Record<string, unknown>);
    if (error) return res.status(error === "not found" ? 404 : 400).json({ error });
    res.json({ ok: true });
  } catch (err) {
    console.error("Dashboard project-repos update error:", err);
    res.status(500).json({ error: "Update failed" });
  }
});

export default router;
