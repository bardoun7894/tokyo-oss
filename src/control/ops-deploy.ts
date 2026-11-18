import { DEPLOY_OFFER_TTL_MS, type DeployOffer } from "../deploy-offers";
import { normChannel } from "./contract";
import type { ControlRun } from "./store";

/** Deploy progress for X12: a deploy offer plus the run it started (T3.1). Names, ids and times only; never log text or the prompt. */

export const DEPLOY_OFFER_ID = /^[0-9a-f]{8}$/;

/** An approved deploy whose run has not started this long after the answer never will (herdr start failed, Mac offline): `expired`. */
export const DEPLOY_START_TIMEOUT_MS = 15 * 60 * 1000;

export type DeployOutcome = "pending" | "skipped" | "running" | "succeeded" | "failed" | "expired";

export interface DeployProgress {
  offerId: string;
  project: string;
  state: DeployOffer["state"];
  answeredBy?: { channel: string; at: string };
  run: { id: string; status: ControlRun["status"]; startedAt: string; endedAt: string | null; exitCode: number | null } | null;
  outcome: DeployOutcome;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * pending offers read `pending` (`expired` past the TTL), declined ones `skipped`. An approved offer reads `pending` while its run is
 * `queued` or has no row yet (the run object shows `queued`), and `expired` if it is still not started DEPLOY_START_TIMEOUT_MS after
 * the answer (K1), unless `waiting`: a laptop queue row still holds the run for the Mac, which will start it. It is `running` only once the run runs; `succeeded` and `failed` follow the run, and a run stopped by hand is
 * `failed` because nothing was deployed.
 */
export function deployProgress(offer: DeployOffer, run: ControlRun | undefined, now: number, waiting = false): DeployProgress {
  const linked = run && offer.runId === run.id && run.offerId === offer.id ? run : undefined;
  const channel = normChannel(offer.channel);
  let outcome: DeployOutcome;
  if (offer.state === "pending") outcome = now - offer.createdAt > DEPLOY_OFFER_TTL_MS ? "expired" : "pending";
  else if (offer.state === "declined") outcome = "skipped";
  else if (linked?.status === "succeeded") outcome = "succeeded";
  else if (linked?.status === "failed" || linked?.status === "stopped") outcome = "failed";
  else if (linked?.status === "running") outcome = "running";
  else outcome = !waiting && now - (offer.answeredAt ?? offer.createdAt) > DEPLOY_START_TIMEOUT_MS ? "expired" : "pending";
  return {
    offerId: offer.id,
    project: offer.project.name,
    state: offer.state,
    ...(channel && offer.answeredAt !== undefined ? { answeredBy: { channel, at: iso(offer.answeredAt) } } : {}),
    run: linked ? { id: linked.id, status: linked.status, startedAt: iso(linked.startedAt), endedAt: linked.endedAt === null ? null : iso(linked.endedAt), exitCode: linked.exitCode } : null,
    outcome,
  };
}
