import express from "express";
import { findSession, isProtectedSession, TERMINAL_KIND } from "../actions/kinds/terminal_kill";
import { prepareToken } from "../actions/tokens";
import { baseName, clean, isOutcome, iso, pick, readRoute, refuse, resolveOpaque, rows, writeRoute, type GhArea } from "./common";

// K35, K36: GodHome's terminal sessions, listed without their panes, and a fingerprint-confirmed kill (kinds/terminal_kill.ts). Output,
// keystrokes, interrupts, resizes and new sessions are not reachable from here: the session list is the only terminal read.

const MAX_SESSIONS = 100;

/** Seconds since a session was created: `created` is epoch seconds as a string (tmux) or a time string; absent or unreadable gives none. */
function ageSeconds(created: unknown, now: number): number | undefined {
  let at: number;
  if (typeof created === "string" && /^\d{9,11}$/.test(created)) at = Number(created) * 1000;
  else if (typeof created === "string" && !Number.isNaN(Date.parse(created))) at = Date.parse(created);
  else return undefined;
  return Math.max(0, Math.floor((now - at) / 1000));
}

export function terminalsRoutes(d: GhArea): express.Router {
  const r = express.Router();
  const now = d.now ?? Date.now;
  const c = d.client;

  // K35: sessions with an opaque id, base name, backend, age, attached flag, window and pane counts.
  readRoute(r, d, "/ops/gh/terminals", () => [c.read("tmuxSessions")], ([body]) => ({
    sessions: rows(body?.sessions, MAX_SESSIONS).filter((s) => typeof s.name === "string").map((s) => {
      const age = ageSeconds(s.created, now());
      return {
        id: d.ids.opaque(TERMINAL_KIND, s.name as string, now()), name: baseName(s.name),
        ...(typeof s.backend === "string" ? { kind: clean(s.backend, 20) } : {}),
        ...pick(s, ["attached", "windows"]), panes: Array.isArray(s.panes) ? s.panes.length : 0,
        ...(age !== undefined ? { ageS: age } : {}),
      };
    }),
  }));

  // K36: prepare killing a session. The id must be one Tokyo issued and the session must exist now.
  writeRoute(r, d, {
    code: "K36", method: "post", path: "/ops/gh/terminals/:id/kill", cap: "ops:service",
    run: async (req, device) => {
      const id = String(req.params.id);
      const got = resolveOpaque(d.ids, TERMINAL_KIND, id);
      if (isOutcome(got)) return got;
      const found = await findSession({ client: c, ids: d.ids }, id, false);
      if (found === "down") return refuse(503, "unavailable", "GodHome is not reachable", { subject: id });
      if (found === null) return refuse(404, "not_found", "That session is gone", { subject: id });
      if (isProtectedSession(found.name)) return refuse(403, "forbidden", "Tokyo depends on that session; it cannot be killed from the app", { subject: id });
      const { actionId, expiresAt } = prepareToken(d.ops, { kind: "terminal_kill", deviceId: device.id, subject: id, targetId: id, now: now() });
      return { status: 200, body: { actionId, kind: "terminal_kill", label: baseName(found.name), expiresAt: iso(expiresAt) }, result: "ok", subject: id };
    },
  });

  return r;
}
