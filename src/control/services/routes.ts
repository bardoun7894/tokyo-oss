import express from "express";
import { requireCap } from "../auth";
import { errorBody } from "../contract";
import { prepareToken } from "../actions/tokens";
import { ENTRY_ID, RESTART_KINDS, type AllowEntry, type RestartKind } from "../ops-restart";
import { clientAddress, rateLimit } from "../rate-limit";
import type { OpsStore } from "../ops-store";
import type { Device } from "../store";
import { buildServices, cooldownLeft } from "./inventory";
import { SERVICE_STATES, type ServiceState, type ServiceStates } from "./state";

/** Service inventory and restart prepare (S1, S2). */
export interface ServicesDeps {
  /** The validated allowlist, read per request (the loader caches by mtime); empty when the file is missing. */
  allowlist(): readonly AllowEntry[];
  states: Pick<ServiceStates, "read">;
  /** Cooldowns, tokens and audit (shares the Control db). */
  ops: OpsStore;
  now?: () => number;
}

/** A query parameter that is absent, or exactly one value from `allowed`; anything else is null. */
function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined | null {
  if (v === undefined) return undefined;
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

const WRITE_LIMIT = 30;

export function servicesRoutes(deps: ServicesDeps): express.Router {
  const r = express.Router();
  const now = deps.now ?? Date.now;

  // S1: every allowlisted service with its live state.
  r.get("/ops/services", requireCap("ops:read"), async (req, res) => {
    const kind = oneOf<RestartKind>(req.query.kind, RESTART_KINDS);
    const state = oneOf<ServiceState>(req.query.state, SERVICE_STATES);
    if (kind === null) return res.status(400).json(errorBody("bad_request", `kind must be ${RESTART_KINDS.join(", ")}`));
    if (state === null) return res.status(400).json(errorBody("bad_request", `state must be ${SERVICE_STATES.join(", ")}`));
    const entries = deps.allowlist();
    const snap = await deps.states.read(entries);
    const t = now();
    const device = res.locals.device as Device;
    res.json({
      fetchedAt: new Date(entries.length === 0 ? t : snap.at).toISOString(),
      services: buildServices(entries, snap.states, {
        now: t, kind, state, canRestart: device.caps.includes("ops:service"),
        cooldownLeftS: (en) => cooldownLeft(deps.ops.lastRestartAt(en.id), en.cooldownSec, t),
      }),
    });
  });

  // S2: prepare a restart of one allowlisted service, with no incident behind it. Same token and same confirm (X16, kind restart) as X15:
  // the argv, the post-state read, the limits and the cooldown are 003's, and they are counted together with the incident restarts.
  const writeLimit = rateLimit({ max: WRITE_LIMIT, windowMs: 60_000, key: (req) => (req as express.Request & { deviceId?: string }).deviceId ?? "anon" });
  r.post("/ops/services/:id/restart", requireCap("ops:service"), writeLimit, (req, res) => {
    const started = performance.now();
    const device = res.locals.device as Device;
    const id = String(req.params.id);
    if (!ENTRY_ID.test(id) || /^\.+$/.test(id)) return res.status(400).json(errorBody("bad_request", `id must match ${ENTRY_ID.source}`));
    const audit = (result: string, detail: string, params = "{}"): void => {
      deps.ops.audit({
        at: now(), deviceId: device.id, deviceName: device.name, addr: clientAddress(req), action: "service.restart.prepare", subject: id,
        params, result, detail, durMs: Math.round(performance.now() - started),
      });
    };
    const entry = deps.allowlist().find((e) => e.id === id);
    if (!entry) { audit("not_found", "not on the allowlist"); return res.status(404).json(errorBody("not_found", "No such service")); }
    const { actionId, expiresAt } = prepareToken(deps.ops, { kind: "restart", deviceId: device.id, subject: id, targetId: entry.id, now: now() });
    audit("ok", "", JSON.stringify({ target: entry.id }));
    res.json({ fetchedAt: new Date(now()).toISOString(), reachable: true, actionId, kind: entry.kind, label: entry.label, expiresAt: new Date(expiresAt).toISOString() });
  });
  return r;
}
