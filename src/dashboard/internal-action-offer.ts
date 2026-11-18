/**
 * Loopback-only action-offer cards for Claude sessions and scripts.
 *
 * `tokyo-offer` (on this host, or over ssh from the Mac) posts a card with up to 8
 * buttons; the owner answers on Telegram, in the terminal, or later in the Control
 * app, and all of them land in answerActionOffer(). Same gate position as
 * internal-deploy.ts: after the network gate, before session auth.
 *
 *   POST /api/internal/action-offer            {project, title, body?, buttons?, from?} -> {id, project}
 *   GET  /api/internal/action-offer/:id        -> {state, project, title, answeredButton?, channel?}
 *   POST /api/internal/action-offer/:id/answer {button, channel?} -> {reply}
 */

import type { Express, Request, Response } from "express";
import { validateButtons } from "../action-offers";
import { loopbackOnly } from "./loopback";

const ID = /^[0-9a-f]{8}$/;
const BUTTON = /^[a-z0-9_-]{1,16}$/;

type Runner = typeof import("../claude-runner");

export function registerInternalActionOffer(app: Express, load: () => Runner = () => require("../claude-runner")): void {
  app.post("/api/internal/action-offer", async (req: Request, res: Response) => {
    if (!loopbackOnly(req, res)) return;
    const b = req.body ?? {};
    const project = typeof b.project === "string" ? b.project.trim() : "";
    const title = typeof b.title === "string" ? b.title.trim() : "";
    if (!project || !title) {
      res.status(400).json({ error: "project and title are required" });
      return;
    }
    let buttons;
    if (b.buttons !== undefined) {
      try {
        buttons = validateButtons(b.buttons);
      } catch (e: any) {
        res.status(400).json({ error: e?.message || "bad buttons" });
        return;
      }
    }
    const body = b.body == null ? "" : String(b.body).slice(0, 1500);
    const from = b.from == null ? undefined : String(b.from).slice(0, 80);
    const r = await load().offerActionFromSession({ project, title: title.slice(0, 200), body, buttons, from });
    if (!r.ok) {
      res.status(r.kind === "unknown_project" ? 404 : r.kind === "invalid" ? 400 : 503).json({ error: r.error });
      return;
    }
    res.json({ id: r.id, project: r.project });
  });

  app.get("/api/internal/action-offer/:id", (req: Request, res: Response) => {
    if (!loopbackOnly(req, res)) return;
    const id = String(req.params.id);
    const s = ID.test(id) ? load().actionOfferStatus(id) : null;
    if (!s) {
      res.status(404).json({ error: "no such offer (expired or unknown)" });
      return;
    }
    res.json(s);
  });

  app.post("/api/internal/action-offer/:id/answer", async (req: Request, res: Response) => {
    if (!loopbackOnly(req, res)) return;
    const id = String(req.params.id);
    const button = req.body?.button;
    if (!ID.test(id) || typeof button !== "string" || !BUTTON.test(button)) {
      res.status(400).json({ error: "need an 8-hex id and a button id" });
      return;
    }
    const channel = String(req.body?.channel ?? "terminal").replace(/[^a-z0-9 _-]/gi, "").slice(0, 30) || "terminal";
    res.json({ reply: await load().answerActionOffer(id, button, channel) });
  });
}
