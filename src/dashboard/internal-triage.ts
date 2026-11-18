/**
 * Loopback-only store for the daily finish-apps triage (Part B), read by the Control API (Part C).
 *
 *   POST /api/internal/triage {date, projects[], recommendations[], gaps?{project: Gap[]}} -> {ok, stored}
 *   GET  /api/internal/triage/latest                -> {date, projects[]}  (each with recommendations, gaps)
 *   GET  /api/internal/triage/history/:project      -> {project, history: [{date, completeness}]}  (last 30)
 */

import type { Express, Request, Response } from "express";
import { defaultTriageStore, type TriageStore } from "../finish-apps/triage-store";
import { loopbackOnly } from "./loopback";

const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PROJECTS = 500;

export function registerInternalTriage(app: Express, store: () => TriageStore = defaultTriageStore): void {
  app.post("/api/internal/triage", (req: Request, res: Response) => {
    if (!loopbackOnly(req, res)) return;
    const b = req.body ?? {};
    const bad = (m: string) => res.status(400).json({ error: m });
    if (typeof b.date !== "string" || !DATE.test(b.date)) return bad("date must be YYYY-MM-DD");
    if (!Array.isArray(b.projects) || b.projects.length > MAX_PROJECTS) return bad(`projects must be an array of at most ${MAX_PROJECTS}`);
    if (!Array.isArray(b.recommendations)) return bad("recommendations must be an array");
    if (b.gaps !== undefined && (typeof b.gaps !== "object" || b.gaps === null || Array.isArray(b.gaps))) return bad("gaps must be an object");
    for (const p of b.projects) {
      if (!p || typeof p !== "object" || typeof p.name !== "string" || !NAME.test(p.name)) return bad("every project needs a valid name");
    }
    const recs = new Map<string, unknown[]>();
    for (const r of b.recommendations) {
      if (r && typeof r.name === "string" && Array.isArray(r.recommendations)) recs.set(r.name, r.recommendations);
    }
    const s = store();
    for (const p of b.projects) {
      const g = b.gaps?.[p.name];
      s.upsert(b.date, p.name, p, recs.get(p.name) ?? [], Array.isArray(g) ? g : []);
    }
    res.json({ ok: true, stored: b.projects.length });
  });

  app.get("/api/internal/triage/latest", (req: Request, res: Response) => {
    if (!loopbackOnly(req, res)) return;
    res.json(store().latest());
  });

  app.get("/api/internal/triage/history/:project", (req: Request, res: Response) => {
    if (!loopbackOnly(req, res)) return;
    const project = String(req.params.project);
    if (!NAME.test(project)) {
      res.status(400).json({ error: "bad project name" });
      return;
    }
    res.json({ project, history: store().history(project, 30) });
  });
}
