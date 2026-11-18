import express from "express";
import { countPendingOffers, type OffersDeps } from "./offers";
import type { ControlStore, Device } from "./store";
import type { Monitor } from "./monitor";
import type { Factory } from "./factory";
import type { OpsGodhome } from "./ops-godhome";
import { adjustedCounts } from "./ops-incidents";
import type { OpsStore } from "./ops-store";

const DAY_MS = 24 * 60 * 60 * 1000;

/** What `/counts` needs for the incident badge. Absent: the two incident fields are omitted. */
export interface CountsOps { godhome: Pick<OpsGodhome, "summary">; /** The overlay (mute, resolve); without it the counts are GodHome's. */ store?: OpsStore }

/** Badge counts without paging a list. */
export function countsRoutes(store: ControlStore, offers: OffersDeps | undefined, now: () => number, monitor?: Monitor, factory?: Factory, ops?: CountsOps): express.Router {
  const r = express.Router();
  r.get("/counts", async (_req, res) => {
    const body = {
      factoryFailed: (await factory?.failedCount()) ?? 0,
      pendingOffers: offers ? countPendingOffers(offers, monitor) : 0,
      runningRuns: store.countRuns("running") + (monitor?.listRuns().filter((r) => r.status === "running").length ?? 0),
      failedRuns24h: store.countFailedSince(now() - DAY_MS) +
        (monitor?.listRuns().filter((r) => r.status === "failed" && (r.endedAt ?? r.startedAt) >= now() - DAY_MS).length ?? 0),
    };
    res.json({ ...body, ...(await incidentCounts(ops, res.locals.device as Device | undefined, now())) });
  });
  return r;
}

/**
 * `incidentsOpen` and `incidentsCritical` for the Ops tab badge: GodHome's all-window counts (the same ones
 * X5 returns). Omitted, never 0, when there is no ops wiring, the device lacks `ops:read`, or GodHome has no
 * fresh reply: a missing number tells the app "unknown", a 0 would tell it "all clear".
 */
async function incidentCounts(ops: CountsOps | undefined, device: Device | undefined, now: number): Promise<{ incidentsOpen?: number; incidentsCritical?: number }> {
  if (!ops || !device?.caps.includes("ops:read")) return {};
  try {
    const got = await ops.godhome.summary("all");
    if (!got.reachable || got.data === null) return {};
    const c = adjustedCounts(got.data, ops.store?.overlay(now), now);
    return { incidentsOpen: c.open, incidentsCritical: c.critical };
  } catch (e: any) {
    console.warn(`[control-api] counts incidents: ${String(e?.name ?? "Error").slice(0, 40)}`);
    return {};
  }
}
