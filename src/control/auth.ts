import crypto from "crypto";
import type { Monitor } from "./monitor";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { errorBody } from "./contract";
import { clientAddress, LoginThrottle } from "./rate-limit";
import type { OffersDeps } from "./offers";
import type { ProjectsDeps } from "./projects";
import type { Cap, ControlStore, Device } from "./store";
import type { WriteSpecDeps } from "./write-spec";
import type { RunsDeps } from "./runs";
import type { TasksDeps } from "./tasks";
import type { FeedStore } from "./feed";
import type { PanelDeps } from "./panel";
import type { Factory } from "./factory";
import type { OpsDeps } from "./ops";
import type { PushDeps } from "./push/routes";
import type { AgentsDeps } from "./agents/routes";
import type { ServicesDeps } from "./services/routes";
import type { LifeDeps } from "./life/index";
import type { GhDeps } from "./gh/index";

export interface ControlDeps {
  store: ControlStore;
  /** Username and password check; the dashboard supplies its constant-time comparison. */
  checkCredentials: (username: string, password: string) => boolean;
  throttle?: LoginThrottle;
  now?: () => number;
  /** Optional route groups of the API; a group whose deps are missing is not mounted. */
  projects?: ProjectsDeps;
  offers?: OffersDeps;
  writeSpec?: WriteSpecDeps;
  runs?: RunsDeps;
  tasks?: TasksDeps;
  /** The on-call monitor's runs and alerts (see monitor.ts); absent when DPI_CONTROL_URL is not set. */
  monitor?: Monitor;
  /** The Telegram feed (feed.ts); absent in tests that do not need it. */
  feed?: FeedStore;
  /** Agents, GodHome and task options (panel.ts). */
  panel?: PanelDeps;
  /** The software factory's board on the Mac (factory.ts). */
  factory?: Factory;
  /** GodHome-backed ops routes (ops.ts); absent: `/ops/*` is not mounted and `/counts` omits the incident counts. */
  ops?: OpsDeps;
  /** Spec 012 areas; each is mounted only when its deps exist (see the wire.ts of the area). */
  push?: PushDeps;
  agents?: AgentsDeps;
  services?: ServicesDeps;
  life?: LifeDeps;
  gh?: GhDeps;
}

const hashToken = (token: string): string => crypto.createHash("sha256").update(token).digest("hex");
const BEARER = /^Bearer ([0-9a-f]{64})$/;
const DEVICE_ID = /^d_[0-9a-f]{8}$/;
const MAX_FCM_TOKEN = 4096;
const MAX_DEVICE_NAME = 100;

const unauthorized = (res: Response) => res.status(401).json(errorBody("unauthorized", "Unauthorized"));
const badRequest = (res: Response, message: string) => res.status(400).json(errorBody("bad_request", message));

/** Called when the dashboard password changes: every phone has to log in again. Returns how many were revoked. */
export function revokeAllDevices(store: ControlStore): number {
  return store.revokeAll();
}

export function loginHandler(deps: ControlDeps): RequestHandler {
  const throttle = deps.throttle ?? new LoginThrottle();
  const now = deps.now ?? Date.now;
  return (req, res) => {
    const { username, password, deviceName } = req.body ?? {};
    if (typeof username !== "string" || typeof password !== "string") return badRequest(res, "username and password are required");
    if (typeof deviceName !== "string" || !deviceName.trim() || deviceName.length > MAX_DEVICE_NAME) return badRequest(res, "deviceName is required (1 to 100 characters)");

    const addr = clientAddress(req);
    const blockedFor = throttle.blockedFor(addr, now());
    if (blockedFor > 0) {
      const sec = Math.ceil(blockedFor / 1000);
      res.setHeader("Retry-After", String(sec));
      return res.status(429).json(errorBody("rate_limited", `Too many attempts -- retry in ${sec}s`));
    }
    if (!deps.checkCredentials(username, password)) {
      throttle.fail(addr, now());
      return res.status(401).json(errorBody("unauthorized", "Invalid credentials"));
    }
    throttle.clear(addr);
    const token = crypto.randomBytes(32).toString("hex");
    const device = deps.store.createDevice({ name: deviceName.trim(), tokenHash: hashToken(token), now: now() });
    res.json({ deviceId: device.id, deviceToken: token, expiresAt: new Date(device.expiresAt).toISOString() });
  };
}

/** Bearer middleware: sets `res.locals.device` and `req.deviceId`, slides the expiry. One body for every failure. */
export function bearerAuth(deps: ControlDeps): RequestHandler {
  const now = deps.now ?? Date.now;
  return (req: Request, res: Response, next: NextFunction) => {
    const m = BEARER.exec(req.headers.authorization ?? "");
    if (!m) return unauthorized(res);
    const t = now();
    const device = deps.store.findByTokenHash(hashToken(m[1]), t);
    if (!device) return unauthorized(res);
    deps.store.touch(device.id, t);
    res.locals.device = device;
    (req as Request & { deviceId?: string }).deviceId = device.id;
    next();
  };
}

/** Mounted after bearerAuth: 403 `forbidden` unless the calling device holds `cap`. */
export function requireCap(cap: Cap): RequestHandler {
  return (_req, res, next) => {
    const device = res.locals.device as Device | undefined;
    if (!device) return unauthorized(res);
    if (!device.caps.includes(cap)) return res.status(403).json(errorBody("forbidden", `Device lacks ${cap}`));
    next();
  };
}

/** logout and the /devices routes. Mounted behind bearerAuth. */
export function deviceRoutes(deps: ControlDeps): express.Router {
  const r = express.Router();
  const current = (res: Response) => res.locals.device as Device;

  r.post("/auth/logout", (_req, res) => {
    deps.store.revoke(current(res).id);
    res.json({ ok: true });
  });

  r.get("/devices", (_req, res) => {
    const me = current(res).id;
    res.json({
      devices: deps.store.listDevices().map((d) => ({
        id: d.id, name: d.name, createdAt: new Date(d.createdAt).toISOString(), lastSeenAt: new Date(d.lastSeenAt).toISOString(),
        current: d.id === me, push: d.fcmToken !== null, caps: d.caps,
      })),
    });
  });

  r.delete("/devices/:id", (req, res) => {
    const id = String(req.params.id);
    if (!DEVICE_ID.test(id) || !deps.store.revoke(id)) return res.status(404).json(errorBody("not_found", "No such device"));
    res.json({ ok: true });
  });

  r.post("/devices", (req, res) => {
    const { fcmToken } = req.body ?? {};
    if (typeof fcmToken !== "string" || fcmToken.length < 1 || fcmToken.length > MAX_FCM_TOKEN) return badRequest(res, "fcmToken must be a string of 1 to 4096 characters");
    deps.store.setFcmToken(current(res).id, fcmToken);
    res.json({ ok: true });
  });

  return r;
}
