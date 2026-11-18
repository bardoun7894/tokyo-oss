/**
 * Loopback-only send to the owner's own WhatsApp self-chat, over Tokyo's existing WhatsApp socket
 * (no second device). Used by the factory's `owner-notify`; the jid is resolved here at runtime, never by the caller.
 *
 *   POST /api/internal/owner-whatsapp {text} -> {ok: true}   503 when WhatsApp is not connected
 */

import type { Express, Request, Response } from "express";
import { loopbackOnly } from "./loopback";

const MAX_TEXT = 4000;

type Wa = typeof import("../whatsapp");

/** Same self-chat address the mission cards use (mission-wiring sendBoth). */
export async function sendToOwnSelfChat(text: string, load: () => Wa = () => require("../whatsapp")): Promise<boolean> {
  const wa = load();
  const me = wa.getOwnJids();
  if (!me) return false;
  await wa.sendWhatsAppMessage(`${me.jid.split("@")[0].split(":")[0]}@s.whatsapp.net`, text);
  return true;
}

export function registerInternalOwnerWhatsApp(app: Express, send: (text: string) => Promise<boolean> = sendToOwnSelfChat): void {
  app.post("/api/internal/owner-whatsapp", async (req: Request, res: Response) => {
    if (!loopbackOnly(req, res)) return;
    const text = req.body?.text;
    if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT) {
      res.status(400).json({ error: `text is required (max ${MAX_TEXT} chars)` });
      return;
    }
    try {
      if (!(await send(text))) {
        res.status(503).json({ error: "whatsapp not connected" });
        return;
      }
    } catch (e: any) {
      res.status(503).json({ error: String(e?.message ?? e).slice(0, 200) });
      return;
    }
    res.json({ ok: true });
  });
}
