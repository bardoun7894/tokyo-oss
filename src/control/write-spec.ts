import crypto from "crypto";
import express from "express";
import type { ActionOffer, OfferButton } from "../action-offers";
import type { OfferActionArgs, OfferActionResult } from "../action-offer-flow";
import { buildOffers } from "../finish-apps/offers";
import type { TriageEntry } from "../finish-apps/summary";
import { alreadyBody, errorBody } from "./contract";
import type { OffersDeps } from "./offers";
import { PROJECT_NAME } from "./paging";
import { isReportOnly, topRecommendations, type ProjectsDeps } from "./projects";
import type { ControlStore } from "./store";

export interface WriteSpecDeps {
  getProject(name: string): { name: string; location: "server" | "laptop"; path: string } | undefined;
  /** The project's open action card, if any. */
  pendingActionFor(project: string): ActionOffer | undefined;
  createOffer(a: OfferActionArgs): Promise<OfferActionResult>;
  newRunId?: () => string;
}

const CODE = /^R[1-3]$/;
const PREVIEW = 200;

/**
 * POST /projects/:name/recommendations/:code/write-spec -- the explicit owner action of an authenticated
 * device, equivalent to tapping `Write spec Rn`: same prompt (buildOffers), same take() path.
 */
export function writeSpecRoutes(
  deps: WriteSpecDeps, projects: ProjectsDeps, offers: OffersDeps, store: ControlStore, now: () => number,
): express.Router {
  const r = express.Router();
  const notFound = (res: express.Response) => res.status(404).json(errorBody("not_found", "No such project or recommendation"));

  r.post("/projects/:name/recommendations/:code/write-spec", async (req, res) => {
    const name = String(req.params.name);
    const code = String(req.params.code);
    if (!PROJECT_NAME.test(name)) return res.status(400).json(errorBody("bad_request", "Invalid project name"));
    let snap;
    try { snap = projects.triage.latest(); } catch { return res.status(503).json(errorBody("unavailable", "Project data is unavailable")); }
    const entry = snap.projects.find((p) => p.name === name);
    if (!entry) return notFound(res);
    if (isReportOnly(entry)) return res.status(403).json(errorBody("report_only", "Report-only project: no spec runs from the app"));
    const top = topRecommendations(entry);
    const index = CODE.test(code) ? top.findIndex((x) => x.code === code) : -1;
    if (index < 0) return notFound(res);
    const buttonId = `spec${index + 1}`;

    // The card the daily sweep would raise for this project; its button carries the prompt.
    const date = snap.date ?? new Date(now()).toISOString().slice(0, 10);
    const card = buildOffers([entry as unknown as TriageEntry], [{ name, recommendations: top }], {
      date, now: now(), getProject: deps.getProject, recentSkips: () => 0, readerFor: () => null, log: () => {},
    }).find((c) => c.project === name && c.buttons.some((b) => b.id === buttonId));
    const button = card?.buttons.find((b) => b.id === buttonId);
    if (!card || !button?.prompt) return notFound(res);
    const project = deps.getProject(name);
    if (!project) return notFound(res);
    const preview = button.prompt.slice(0, PREVIEW);

    // A spec run for this recommendation is already queued or running.
    for (const status of ["queued", "running"]) {
      const dup = store.listRuns({ project: name, status, limit: 100 }).find((x) => x.promptPreview === preview);
      if (dup) return res.status(409).json(alreadyBody("app", dup.startedAt));
    }

    let offerId: string;
    const pending = deps.pendingActionFor(name);
    if (pending?.buttons.some((b) => b.id === buttonId)) {
      offerId = pending.id;
    } else {
      const solo: OfferButton = { id: buttonId, label: button.label, prompt: button.prompt };
      const made = await deps.createOffer({ project: name, title: `Write spec ${code}: ${top[index].title}`.slice(0, 200), body: card.body, buttons: [solo], from: "control-app" });
      if (!made.ok) return res.status(made.kind === "unknown_project" ? 404 : 503).json(errorBody(made.kind === "unknown_project" ? "not_found" : "unavailable", made.error));
      offerId = made.id;
    }

    const runId = (deps.newRunId ?? (() => crypto.randomBytes(4).toString("hex")))();
    store.insertRun({
      id: runId, project: name, source: "tokyo", status: "queued", model: null, harness: "claude", worker: null, tier: null,
      promptPreview: preview, startedAt: now(), endedAt: null, exitCode: null,
      host: project.location === "laptop" ? "mac" : "server", offerId, workspace: null,
    });
    const out = await offers.answerAction(offerId, buttonId, "app", { runId });
    if (out.status === "applied") return res.json({ offerId, runId });
    store.deleteRun(runId);
    if (out.status === "already") return res.status(409).json(alreadyBody(out.offer.channel ?? null, out.offer.answeredAt ?? out.offer.createdAt));
    return notFound(res);
  });

  return r;
}
