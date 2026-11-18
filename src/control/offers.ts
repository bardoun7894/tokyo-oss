import express from "express";
import type { ActionOffer } from "../action-offers";
import { ACTION_OFFER_TTL_MS } from "../action-offers";
import type { ActionAnswer } from "../action-offer-flow";
import { DEPLOY_OFFER_TTL_MS, offerText, type DeployAnswer, type DeployOffer } from "../deploy-offers";
import { alreadyBody, DEPLOY_BUTTONS, errorBody, OFFER_STATES, viewOffer, type OfferRow, type OfferState } from "./contract";
import { pageOf, parsePage } from "./paging";
import { missionRow, type MissionAnswer } from "./mission-offers";
import type { MissionRow } from "../mission-store";
import { monitorOffer, type Monitor } from "./monitor";

export interface OffersDeps {
  now(): number;
  /** Every action offer held, any state. */
  listActions(): ActionOffer[];
  listDeploys(): DeployOffer[];
  answerAction(id: string, button: string, channel: string, opts?: { runId?: string }): Promise<ActionAnswer>;
  answerDeploy(id: string, answer: "deploy" | "skip", channel: string): Promise<DeployAnswer>;
  /** Mission approvals (app tasks and self-chat tasks), any state. */
  listMissions?(): MissionRow[];
  answerMission?(id: string, answer: "approve" | "decline", channel: string): Promise<MissionAnswer>;
}

const ID = /^[A-Za-z0-9_-]{1,32}$/;
const DEFAULT_LIMIT = 50;

/** Action offer -> API row. A pending offer past its TTL reads as expired. */
export function actionRow(o: ActionOffer, now: number): OfferRow {
  const expiresAt = o.createdAt + ACTION_OFFER_TTL_MS;
  return {
    id: o.id, kind: "action", project: o.project, title: o.title, body: o.body, from: o.from ?? null,
    state: o.state === "pending" && now > expiresAt ? "expired" : o.state, missionId: null, buttons: o.buttons,
    createdAt: o.createdAt, expiresAt, answeredButton: o.answeredButton ?? null, channel: o.channel ?? null, answeredAt: o.answeredAt ?? null,
  };
}

export function deployRow(o: DeployOffer, now: number): OfferRow {
  const expiresAt = o.createdAt + DEPLOY_OFFER_TTL_MS;
  return {
    id: o.id, kind: "deploy", project: o.project.name, title: `Deploy ${o.project.name}?`, body: offerText(o), from: o.from ?? null,
    state: o.state === "pending" && now > expiresAt ? "expired" : o.state, missionId: null, buttons: DEPLOY_BUTTONS,
    createdAt: o.createdAt, expiresAt, answeredButton: o.state === "approved" ? "deploy" : o.state === "declined" ? "skip" : null,
    channel: o.channel ?? null, answeredAt: o.answeredAt ?? null,
    ...(o.runId ? { runId: o.runId } : {}),
  };
}

/** Every offer as an API row, newest first. */
export function allOfferRows(deps: OffersDeps, monitor?: Monitor): OfferRow[] {
  const now = deps.now();
  const missions = deps.listMissions ? deps.listMissions().map((m) => missionRow(m, now)) : [];
  return [...deps.listActions().map((o) => actionRow(o, now)), ...deps.listDeploys().map((o) => deployRow(o, now)), ...missions, ...(monitor?.listOffers() ?? [])]
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
}

export function countPendingOffers(deps: OffersDeps, monitor?: Monitor): number {
  return allOfferRows(deps, monitor).filter((o) => viewOffer(o).state === "pending").length;
}

/** A monitor alert has one button, Dismiss; the monitor decides who answered first. */
async function answerAlert(res: express.Response, monitor: Monitor, id: string, button: string) {
  if (button !== "skip") return res.status(400).json(errorBody("bad_request", 'Monitor alerts answer "skip"'));
  let out;
  try {
    out = await monitor.answer(id, button);
  } catch (e: any) {
    console.error("[control-api] monitor answer failed:", e?.message ?? e);
    return res.status(503).json(errorBody("unavailable", "Cannot reach the monitor"));
  }
  const row = out.status === 200 ? monitorOffer(out.json?.offer) : null;
  if (row) return res.json({ offer: viewOffer(row), reply: String(out.json?.reply ?? "Dismissed").slice(0, 200) });
  if (out.status === 409) {
    const by = out.json?.answeredBy;
    return res.status(409).json(alreadyBody(typeof by?.channel === "string" ? by.channel : null, Date.parse(by?.at) || Date.now()));
  }
  if (out.status === 404) return res.status(404).json(errorBody("not_found", "No such offer"));
  return res.status(503).json(errorBody("unavailable", "The monitor could not answer"));
}

export function offersRoutes(deps: OffersDeps, monitor?: Monitor): express.Router {
  const r = express.Router();
  const bad = (res: express.Response, message: string) => res.status(400).json(errorBody("bad_request", message));

  r.get("/offers", (req, res) => {
    const page = parsePage(req, DEFAULT_LIMIT);
    if (typeof page === "string") return bad(res, page);
    const state = typeof req.query.state === "string" ? req.query.state : "pending";
    if (state !== "all" && !(OFFER_STATES as readonly string[]).includes(state)) return bad(res, "state must be pending, approved, declined, expired or all");
    const rows = allOfferRows(deps, monitor).filter((o) => {
      if (state !== "all" && viewOffer(o).state !== (state as OfferState)) return false;
      if (page.before !== undefined && !(o.createdAt < page.before)) return false;
      if (page.since !== undefined && !(o.createdAt >= page.since || (o.answeredAt ?? -1) >= page.since)) return false;
      return true;
    });
    const { page: items, next } = pageOf(rows, page.limit, (o) => o.createdAt);
    res.json({ offers: items.map(viewOffer), next });
  });

  r.post("/offers/:id/answer", async (req, res) => {
    const id = String(req.params.id);
    const button = req.body?.button;
    if (typeof button !== "string" || !button) return bad(res, "button is required");
    if (!ID.test(id)) return res.status(404).json(errorBody("not_found", "No such offer"));
    const now = deps.now();
    const action = deps.listActions().find((o) => o.id === id);
    const deploy = action ? undefined : deps.listDeploys().find((o) => o.id === id);
    const mission = action || deploy || !deps.listMissions ? undefined : deps.listMissions().find((m) => m.id === id);
    const alert = action || deploy || mission ? undefined : monitor?.getOffer(id);
    if (alert) return answerAlert(res, monitor!, id, button);
    if (!action && !deploy && !mission) return res.status(404).json(errorBody("not_found", "No such offer"));
    if (mission) {
      if (button !== "approve" && button !== "skip") return bad(res, 'Mission offers answer "approve" or "skip"');
      const out = await deps.answerMission!(id, button === "approve" ? "approve" : "decline", "app");
      if (out.status === "missing") return res.status(404).json(errorBody("not_found", "No such offer"));
      if (out.status === "expired") return res.status(409).json(alreadyBody(null, out.mission?.expires_at ?? now));
      if (out.status === "already") return res.status(409).json(alreadyBody(out.mission.answered_by, out.mission.answered_at ?? out.mission.created_at));
      return res.json({ offer: viewOffer(missionRow(out.mission, now)), reply: out.reply });
    }
    if (action && !action.buttons.some((b) => b.id === button)) return bad(res, `Offer has no button "${button}"`);
    if (deploy && button !== "deploy" && button !== "skip") return bad(res, 'Deploy offers answer "deploy" or "skip"');

    const out = action ? await deps.answerAction(id, button, "app") : await deps.answerDeploy(id, button as "deploy" | "skip", "app");
    if (out.status === "missing") return res.status(404).json(errorBody("not_found", "No such offer"));
    if (out.status === "already") {
      const o = out.offer;
      return res.status(409).json(alreadyBody(o.channel ?? null, o.answeredAt ?? o.createdAt));
    }
    if (out.status !== "applied") return bad(res, `Offer has no button "${button}"`);
    const row = action ? actionRow(out.offer as ActionOffer, now) : deployRow(out.offer as DeployOffer, now);
    res.json({ offer: viewOffer(row), reply: out.reply });
  });

  return r;
}
