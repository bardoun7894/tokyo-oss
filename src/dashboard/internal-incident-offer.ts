/**
 * Loopback-only incident approval card for the on-call system (/root/oncall).
 *
 * The card's buttons send a Temporal signal (`approve` / `decline`) to the incident's
 * workflow; Tokyo never deploys from this card. Same gate position as internal-deploy.ts.
 *
 *   POST /api/internal/incident-offer     {incidentId, app, title, summary, risk, diffStat?, branch?, from?} -> {id}
 *   GET  /api/internal/incident-offer/:id -> {state, answeredButton?, channel?}
 *
 * A second POST for the same incidentId returns the existing offer id.
 */

import type { Express, Request, Response } from "express";
import { parseIncidentArgs } from "../action-offer-flow";
import { loopbackOnly } from "./loopback";

const ID = /^[0-9a-f]{8}$/;

type Runner = typeof import("../claude-runner");

export function registerInternalIncidentOffer(app: Express, load: () => Runner = () => require("../claude-runner")): void {
  app.post("/api/internal/incident-offer", async (req: Request, res: Response) => {
    if (!loopbackOnly(req, res)) return;
    const p = parseIncidentArgs(req.body);
    if (!p.ok) {
      res.status(400).json({ error: p.error });
      return;
    }
    const r = await load().offerIncidentFromSession(p.args);
    if (!r.ok) {
      res.status(r.kind === "invalid" ? 400 : 503).json({ error: r.error });
      return;
    }
    res.json({ id: r.id });
  });

  app.get("/api/internal/incident-offer/:id", (req: Request, res: Response) => {
    if (!loopbackOnly(req, res)) return;
    const id = String(req.params.id);
    const s = ID.test(id) ? load().incidentOfferStatus(id) : null;
    if (!s) {
      res.status(404).json({ error: "no such incident offer (expired or unknown)" });
      return;
    }
    res.json(s);
  });
}
