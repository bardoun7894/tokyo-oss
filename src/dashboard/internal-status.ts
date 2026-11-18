/**
 * Loopback-only, read-only channel health for another local service (GodHome).
 *
 * The endpoint deliberately lives *before* the session-auth middleware so a
 * process on the same host can poll it without a dashboard login, and *after*
 * the network gate so nothing else on the internet can reach it. The only
 * authorisation is the peer address: socket.remoteAddress (never req.ip or a
 * header), because a header is something the caller controls.
 */

import type { Express, NextFunction, Request, Response } from "express";

export function isLoopback(addr: string | undefined): boolean {
  if (addr === undefined) return false;
  // Dual-stack peers arrive as ::ffff:127.0.0.1; bare IPv6 loopback as ::1.
  if (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1") return true;
  return false;
}

export interface TelegramHealthLike {
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  lastErrorMethod: string | null;
  blocked: boolean;
  errorsLastHour: number;
}

const EMPTY_TELEGRAM: TelegramHealthLike = {
  lastOkAt: null,
  lastErrorAt: null,
  lastError: null,
  lastErrorMethod: null,
  blocked: false,
  errorsLastHour: 0,
};

export function buildStatus(deps: {
  whatsapp: () => { status: string };
  lastIncomingWhatsAppAt: () => number | null; // unix ms
  missionCounts: () => Record<string, number>; // state → count
  transcriptionEnabled: () => boolean;
  telegram: () => ReturnType<typeof import("../channel-health").telegramHealth>;
  now: number;
  uptimeS: number;
}): {
  at: string;
  uptimeS: number;
  whatsapp: { status: string; connected: boolean; lastIncomingAt: number | null; minutesSinceIncoming: number | null };
  telegram: TelegramHealthLike;
  missions: { proposed: number; running: number; held: number; failed: number };
  transcription: { enabled: boolean };
} {
  let status = "disconnected";
  try {
    const s = deps.whatsapp().status;
    if (typeof s === "string") status = s;
  } catch {
    /* one dep failing must never 500 the endpoint */
  }
  const connected = status === "connected";

  let lastIncomingAt: number | null = null;
  try {
    const v = deps.lastIncomingWhatsAppAt();
    lastIncomingAt = v;
  } catch {
    lastIncomingAt = null;
  }
  let minutesSinceIncoming: number | null = null;
  if (lastIncomingAt != null) {
    minutesSinceIncoming = Math.max(0, Math.floor((deps.now - lastIncomingAt) / 60000));
  }

  let counts: Record<string, number> = {};
  try {
    counts = deps.missionCounts() ?? {};
  } catch {
    counts = {};
  }

  let telegram: TelegramHealthLike = EMPTY_TELEGRAM;
  try {
    telegram = deps.telegram() ?? EMPTY_TELEGRAM;
  } catch {
    telegram = EMPTY_TELEGRAM;
  }

  let transcriptionEnabled = false;
  try {
    transcriptionEnabled = !!deps.transcriptionEnabled();
  } catch {
    transcriptionEnabled = false;
  }

  return {
    at: new Date(deps.now).toISOString(),
    uptimeS: deps.uptimeS,
    whatsapp: { status, connected, lastIncomingAt, minutesSinceIncoming },
    telegram,
    missions: {
      proposed: counts.proposed ?? 0,
      running: counts.running ?? 0,
      held: counts.held ?? 0,
      failed: counts.failed ?? 0,
    },
    transcription: { enabled: transcriptionEnabled },
  };
}

/**
 * Adds GET /api/internal/status. Lazy requires keep the real deps (better-
 * sqlite3, the WhatsApp socket, STT flag) out of the module graph unless the
 * route is actually wired up — so tests import isLoopback/buildStatus without
 * opening a database.
 */
export function registerInternalStatus(app: Express): void {
  app.get("/api/internal/status", (req: Request, res: Response, _next: NextFunction) => {
    if (!isLoopback(req.socket?.remoteAddress)) {
      res.status(403).json({ error: "loopback only" });
      return;
    }
    const db = require("../db").default as import("better-sqlite3").Database;
    const { getWhatsAppStatus } = require("../whatsapp") as {
      getWhatsAppStatus: () => { status: string };
    };
    const { isTranscriptionEnabled } = require("../stt") as {
      isTranscriptionEnabled: () => boolean;
    };
    const { telegramHealth } = require("../channel-health") as {
      telegramHealth: (now?: number) => TelegramHealthLike;
    };
    const status = buildStatus({
      whatsapp: () => getWhatsAppStatus(),
      lastIncomingWhatsAppAt: () => {
        const row = db
          .prepare("SELECT MAX(timestamp) AS last FROM whatsapp_messages WHERE from_me = 0")
          .get() as { last: number | null } | undefined;
        const last = row?.last ?? null;
        return last == null ? null : last * 1000;
      },
      missionCounts: () => {
        const rows = db
          .prepare("SELECT state, COUNT(*) AS c FROM missions GROUP BY state")
          .all() as { state: string; c: number }[];
        const map: Record<string, number> = {};
        for (const r of rows) map[r.state] = r.c;
        return map;
      },
      transcriptionEnabled: () => isTranscriptionEnabled(),
      telegram: () => telegramHealth(),
      now: Date.now(),
      uptimeS: Math.floor(process.uptime()),
    });
    res.json(status);
  });
}