/**
 * Loopback-only feed entries for senders that post to the owner's Telegram themselves (server-health,
 * GodHome alerts, the on-call monitor), so the Control app's feed shows them too.
 *
 *   POST /api/internal/feed {source, text, kind?} -> {id}
 */

import type { Express, Request, Response } from "express";
import { FEED_KINDS, MAX_TEXT, type FeedKind, type FeedStore } from "../control/feed";
import { loopbackOnly } from "./loopback";

const SOURCE = /^[A-Za-z0-9._-]{1,32}$/;

export function registerInternalFeed(app: Express, feed: () => FeedStore): void {
  app.post("/api/internal/feed", (req: Request, res: Response) => {
    if (!loopbackOnly(req, res)) return;
    const { source, text, kind } = req.body ?? {};
    if (typeof source !== "string" || !SOURCE.test(source)) return res.status(400).json({ error: "source must be a short label" });
    if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT * 2) return res.status(400).json({ error: "text is required" });
    if (kind !== undefined && !(FEED_KINDS as readonly unknown[]).includes(kind)) return res.status(400).json({ error: `kind must be one of ${FEED_KINDS.join(", ")}` });
    const id = feed().add({ source, text, kind: kind as FeedKind | undefined });
    res.json({ id: String(id) });
  });
}
