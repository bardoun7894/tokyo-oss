import express, { type Response } from "express";
import { errorBody } from "../contract";
import type { Device } from "../store";
import type { PushDeps } from "./routes";
import type { IncidentLevel, NotifyPrefs } from "./store";

/** Notify preferences of the calling device (P3, P4). */
const LEVELS: readonly IncidentLevel[] = ["off", "critical", "warning"];
const SWITCHES = ["approvals", "runs", "deploys", "reminders"] as const;

function parsePrefs(v: unknown): NotifyPrefs | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  for (const k of SWITCHES) if (typeof o[k] !== "boolean") return null;
  if (typeof o.incidents !== "string" || !LEVELS.includes(o.incidents as IncidentLevel)) return null;
  return { approvals: o.approvals as boolean, runs: o.runs as boolean, deploys: o.deploys as boolean, reminders: o.reminders as boolean, incidents: o.incidents as IncidentLevel };
}

export function prefsRoutes(deps: PushDeps): express.Router {
  const r = express.Router();
  const now = deps.now ?? Date.now;
  const me = (res: Response) => (res.locals.device as Device).id;

  r.get("/devices/me/notify", (_req, res) => { res.json(deps.store.getPrefs(me(res))); });

  r.put("/devices/me/notify", (req, res) => {
    const prefs = parsePrefs(req.body);
    if (!prefs) return res.status(400).json(errorBody("bad_request", "approvals, runs, deploys, reminders (booleans) and incidents (off, critical, warning) are required"));
    deps.store.setPrefs(me(res), prefs, now());
    res.json(deps.store.getPrefs(me(res)));
  });

  return r;
}
