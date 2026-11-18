import express, { type Request, type Response } from "express";
import { errorBody } from "../contract";
import type { OpsStore } from "../ops-store";
import { clientAddress, RateLimiter } from "../rate-limit";
import type { Device } from "../store";
import { parseEndpoint } from "./endpoint";
import { serialize } from "./format";
import { prefsRoutes } from "./prefs";
import type { StopLog } from "./sources";
import type { PushStore } from "./store";

/** Push registration, notify preferences and the test push (P1..P6). */
export interface PushDeps {
  store: PushStore;
  /** The write audit (`push.register`, `push.test`). */
  audit: Pick<OpsStore, "audit">;
  /** The configured ntfy base URL; null while /etc/tokyo/ntfy.json is missing (push off). */
  baseUrl(): string | null;
  now?(): number;
  /** The configured payload form; "up" when absent. */
  format?(): "up" | "ntfy";
  /** Sends what is queued now (the dispatcher's tick) so a test push does not wait for the next 20 s round. */
  flush?(): Promise<void>;
  /** Remembers which device stopped a run, so the dispatcher can leave that device out. */
  stops?: StopLog;
}

const TEST_LIMIT = { max: 3, windowMs: 10 * 60 * 1000 };

const KEY = /^[A-Za-z0-9_=+\/-]{1,200}$/;
const iso = (ms: number): string => new Date(ms).toISOString();

function parseKeys(v: unknown): { ok: true; keys?: { p256dh: string; auth: string } } | { ok: false } {
  if (v === undefined) return { ok: true };
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { ok: false };
  const { p256dh, auth } = v as Record<string, unknown>;
  if (typeof p256dh !== "string" || typeof auth !== "string" || !KEY.test(p256dh) || !KEY.test(auth)) return { ok: false };
  return { ok: true, keys: { p256dh, auth } };
}

export function pushRoutes(deps: PushDeps): express.Router {
  const r = express.Router();
  const now = deps.now ?? Date.now;
  const me = (res: Response) => res.locals.device as Device;
  const audit = (req: Request, res: Response, action: string, result: string, detail: string, params: unknown) =>
    deps.audit.audit({
      at: now(), deviceId: me(res).id, deviceName: me(res).name, addr: clientAddress(req), action, subject: me(res).id,
      params: JSON.stringify(params), result, detail, durMs: 0,
    });

  r.put("/devices/me/push", (req, res) => {
    const base = deps.baseUrl();
    if (!base) {
      audit(req, res, "push.register", "unavailable", "push is not configured", {});
      return res.status(503).json(errorBody("unavailable", "Push is not configured on the server"));
    }
    const topic = parseEndpoint(req.body?.endpoint, base);
    const keys = parseKeys(req.body?.keys);
    if (!topic || !keys.ok) {
      const message = !topic ? "endpoint must be the configured push server's /up<id> address" : "keys must be {p256dh, auth} base64url strings";
      audit(req, res, "push.register", "bad_request", message, {});
      return res.status(400).json(errorBody("bad_request", message));
    }
    deps.store.register(me(res).id, topic, keys.keys, now());
    audit(req, res, "push.register", "ok", "", { topicHint: topic.slice(-4), keys: !!keys.keys });
    res.json({ ok: true, baseUrl: base.replace(/\/+$/, ""), topicHint: topic.slice(-4) });
  });

  r.delete("/devices/me/push", (req, res) => {
    const cleared = deps.store.clear(me(res).id);
    audit(req, res, "push.register", "ok", "cleared", { cleared });
    res.json({ ok: true });
  });

  r.get("/devices/me/push", (_req, res) => {
    const e = deps.store.get(me(res).id);
    if (!e) return res.json({ registered: false, encrypted: false });
    const base = deps.baseUrl();
    res.json({
      registered: true,
      ...(base ? { baseUrl: base.replace(/\/+$/, "") } : {}),
      lastSentAt: e.lastSentAt === null ? null : iso(e.lastSentAt),
      lastError: e.lastError,
      // True only when the device stored both keys at P1: the publisher then sends it RFC 8291 encrypted records.
      encrypted: !!e.p256dh && !!e.auth,
    });
  });

  // P5: three test pushes per 10 minutes per device.
  const testLimiter = new RateLimiter(TEST_LIMIT);
  r.post("/devices/me/push/test", async (req, res) => {
    const base = deps.baseUrl();
    if (!base) return res.status(503).json(errorBody("unavailable", "Push is not configured on the server"));
    if (!deps.store.get(me(res).id)) {
      audit(req, res, "push.test", "not_registered", "no registration", {});
      return res.status(409).json(errorBody("not_registered", "This device has no push registration"));
    }
    const hit = testLimiter.hit(me(res).id, now());
    if (!hit.ok) {
      audit(req, res, "push.test", "rate_limited", "limit reached", {});
      res.setHeader("Retry-After", String(hit.retryAfterSec));
      return res.status(429).json(errorBody("rate_limited", `Too many test pushes -- retry in ${hit.retryAfterSec}s`));
    }
    // Each test push has its own number: the id of its payload and the tail of its event key `test:<n>`.
    let n = deps.store.countOfType(me(res).id, "test") + 1;
    for (let tries = 0; tries < 20; tries++, n++) {
      const built = serialize({ type: "test", id: String(n) }, deps.format?.() ?? "up");
      if (!built.ok) break;
      if (deps.store.enqueue(me(res).id, `test:${n}`, "test", built.payload, now())) {
        audit(req, res, "push.test", "ok", "", { n });
        if (deps.flush) await deps.flush().catch(() => {});
        return res.json({ ok: true, queuedAt: iso(now()) });
      }
    }
    audit(req, res, "push.test", "unavailable", "could not queue", {});
    res.status(503).json(errorBody("unavailable", "Could not queue the test push"));
  });

  // Not a push route: noted on its way to runs.ts, which does not record who stopped a run.
  r.post("/runs/:id/stop", (req, res, next) => {
    deps.stops?.record(String(req.params.id), me(res).id);
    next();
  });

  r.use(prefsRoutes(deps));
  return r;
}
