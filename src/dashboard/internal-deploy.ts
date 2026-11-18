/**
 * Loopback-only "Deploy it?" for Claude sessions Tokyo did not start.
 *
 * `tokyo-deploy` (on this host, or over ssh from the Mac) calls these when a
 * session finishes a task: the owner gets the same Telegram card Tokyo's own
 * runs end with, and a yes from Telegram or from the terminal starts the same
 * deploy run. Like /api/internal/status it sits after the network gate and
 * before session auth, and it authorises on socket.remoteAddress only.
 *
 *   POST /api/internal/deploy-offer            {project, summary?, from?, sha?} -> {id, project}
 *   GET  /api/internal/deploy-offer/:id        -> {state, project, channel?}
 *   POST /api/internal/deploy-offer/:id/answer {answer: "deploy"|"skip", channel?}
 */

import type { Express, Request, Response } from "express";
import { loopbackOnly } from "./loopback";

const ID = /^[0-9a-f]{8}$/;

type Runner = typeof import("../claude-runner");

export function registerInternalDeploy(app: Express, load: () => Runner = () => require("../claude-runner")): void {
  app.post("/api/internal/deploy-offer", async (req: Request, res: Response) => {
    if (!loopbackOnly(req, res)) return;
    const project = String(req.body?.project ?? "").trim();
    if (!project) {
      res.status(400).json({ error: "project is required" });
      return;
    }
    const summary = req.body?.summary == null ? undefined : String(req.body.summary).slice(0, 4000);
    const from = req.body?.from == null ? undefined : String(req.body.from).slice(0, 80);
    const sha = req.body?.sha == null || req.body.sha === "" ? undefined : String(req.body.sha).toLowerCase();
    if (sha !== undefined && !/^[0-9a-f]{7,40}$/.test(sha)) {
      res.status(400).json({ error: "sha must be 7-40 hex characters" });
      return;
    }
    const r = await load().offerDeployFromSession(project, summary, from, sha);
    if (!r.ok) {
      res.status(r.error.startsWith("unknown project") ? 404 : 503).json({ error: r.error });
      return;
    }
    res.json({ id: r.id, project: r.project });
  });

  app.get("/api/internal/deploy-offer/:id", (req: Request, res: Response) => {
    if (!loopbackOnly(req, res)) return;
    const id = String(req.params.id);
    const s = ID.test(id) ? load().deployOfferStatus(id) : null;
    if (!s) {
      res.status(404).json({ error: "no such offer (expired or unknown)" });
      return;
    }
    res.json(s);
  });

  app.post("/api/internal/deploy-offer/:id/answer", async (req: Request, res: Response) => {
    if (!loopbackOnly(req, res)) return;
    const id = String(req.params.id);
    const answer = req.body?.answer;
    if (!ID.test(id) || (answer !== "deploy" && answer !== "skip")) {
      res.status(400).json({ error: "need an 8-hex id and answer deploy|skip" });
      return;
    }
    const channel = String(req.body?.channel ?? "terminal").replace(/[^a-z0-9 _-]/gi, "").slice(0, 30) || "terminal";
    res.json({ reply: await load().answerDeployOffer(id, answer, channel) });
  });
}
