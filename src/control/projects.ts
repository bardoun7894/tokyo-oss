import express from "express";
import type { TriageStore, SnapshotProject } from "../finish-apps/triage-store";
import { summarize, type RepoReader, type Recommendation, type TriageEntry } from "../finish-apps/summary";
import { errorBody, normHost, viewGap, viewProject, viewRun } from "./contract";
import { PROJECT_NAME } from "./paging";
import type { ControlStore } from "./store";

export interface ProjectsDeps {
  triage: Pick<TriageStore, "latest" | "history">;
  /** Repo access for a server project; null when there is none (Mac projects never ask). */
  readerFor(p: { name: string; location: "server" | "laptop" }): RepoReader | null;
  /** Id of the project's open card, or null. */
  pendingOfferFor(project: string): string | null;
}

const HISTORY_POINTS = 30;
const MAX_RECS = 3;
const RECENT_RUNS = 5;

export const isCustomer = (e: Record<string, unknown>): boolean => !!(e.customer || e.report_only);

/** Customer and Mac projects get reports only: no spec buttons, no write-spec (FR-B5). */
export const isReportOnly = (e: Record<string, unknown>): boolean =>
  isCustomer(e) || normHost(e.host) === "mac";

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function recs(e: SnapshotProject): Recommendation[] {
  if (isReportOnly(e)) return [];
  return (Array.isArray(e.recommendations) ? e.recommendations : []).slice(0, MAX_RECS) as Recommendation[];
}

/** The top-3 recommendations of a project in the latest snapshot, same cut as the daily cards. */
export function topRecommendations(e: SnapshotProject): Recommendation[] {
  return recs(e);
}

function build(deps: ProjectsDeps, e: SnapshotProject, detail: boolean) {
  const host = normHost(e.host) ?? "server";
  const location = host === "mac" ? "laptop" : "server";
  const reader = location === "server" ? deps.readerFor({ name: e.name, location }) : null;
  const top = recs(e).map((r) => ({
    code: r.code, title: r.title, kind: r.kind, why: r.why, evidence: Array.isArray(r.evidence) ? r.evidence : [], size: r.size, impact: r.impact ?? null,
  }));
  const s = summarize({ name: e.name, location }, e as unknown as TriageEntry, reader, top as Recommendation[]);
  const rawGaps = s.missing.gaps.length ? s.missing.gaps : Array.isArray(e.gaps) ? (e.gaps as any[]).filter((g) => g && typeof g.code === "string" && typeof g.text === "string") : [];
  const gaps = rawGaps.map(viewGap);
  const out: Record<string, unknown> = {
    ...viewProject({ name: e.name, host, customer: isCustomer(e), completeness: num(e.completeness), nextAction: String(e.next_action ?? "") }),
    commits: num(e.commits),
    lastCommitAt: typeof e.last_commit === "string" ? e.last_commit : null,
    specsTotal: num(e.specs_total),
    specsMissingPlan: num(e.specs_missing_plan),
    specsMissingTasks: num(e.specs_missing_tasks),
    openTasks: num(e.open_tasks),
    history: deps.triage.history(e.name, HISTORY_POINTS).map((h) => ({ date: h.date, completeness: h.completeness })),
    pendingOffer: deps.pendingOfferFor(e.name),
    done: {
      specs_complete: s.done.specs_complete, tasks_done: s.done.tasks_done, tasks_total: s.done.tasks_total,
      merged_7d: s.done.merged_7d.map((m) => ({ sha: m.sha, subject: m.subject, at: m.at })),
    },
    missing: { open_tasks: s.missing.open_tasks, specs_incomplete: s.missing.specs_incomplete, gaps, recommendations: top },
  };
  if (detail) {
    out.specs = reader ? reader.specs().map((x) => ({
      name: x.name, hasSpec: x.hasSpec, hasPlan: x.hasPlan, hasTasks: x.hasTasks, tasksDone: x.tasksDone, tasksOpen: x.tasksOpen,
    })) : [];
    out.gaps = gaps;
  }
  return out;
}

export function projectsRoutes(deps: ProjectsDeps, store: ControlStore): express.Router {
  const r = express.Router();
  const unavailable = (res: express.Response, err: unknown) => {
    console.error("[control-api] projects:", (err as Error)?.message ?? err);
    return res.status(503).json(errorBody("unavailable", "Project data is unavailable"));
  };

  r.get("/projects", (_req, res) => {
    try {
      const snap = deps.triage.latest();
      res.json({ asOf: snap.date, projects: snap.projects.map((p) => build(deps, p, false)) });
    } catch (err) {
      unavailable(res, err);
    }
  });

  r.get("/projects/:name", (req, res) => {
    const name = String(req.params.name);
    if (!PROJECT_NAME.test(name)) return res.status(400).json(errorBody("bad_request", "Invalid project name"));
    try {
      const entry = deps.triage.latest().projects.find((p) => p.name === name);
      if (!entry) return res.status(404).json(errorBody("not_found", "No such project"));
      const view = build(deps, entry, true);
      view.recentRuns = store.listRuns({ project: name, limit: RECENT_RUNS }).map(viewRun);
      res.json(view);
    } catch (err) {
      unavailable(res, err);
    }
  });

  return r;
}
