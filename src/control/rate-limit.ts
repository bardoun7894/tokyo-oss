import type { NextFunction, Request, RequestHandler, Response } from "express";
import { errorBody } from "./contract";

export interface HitResult { ok: boolean; retryAfterSec: number }

/** Fixed window per key. `now` is injectable for tests. */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(private opts: { max: number; windowMs: number }) {}

  hit(key: string, now = Date.now()): HitResult {
    let w = this.windows.get(key);
    if (!w || now >= w.start + this.opts.windowMs) {
      this.sweep(now);
      w = { start: now, count: 0 };
      this.windows.set(key, w);
    }
    w.count += 1;
    if (w.count <= this.opts.max) return { ok: true, retryAfterSec: 0 };
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((w.start + this.opts.windowMs - now) / 1000)) };
  }

  private sweep(now: number): void {
    if (this.windows.size < 1000) return;
    for (const [k, w] of this.windows) if (now >= w.start + this.opts.windowMs) this.windows.delete(k);
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Peer address, or X-Real-IP when (and only when) the peer is loopback, i.e. our own nginx. */
export function clientAddress(req: Request): string {
  const peer = req.socket?.remoteAddress;
  if (peer && LOOPBACK.has(peer)) {
    const real = req.headers?.["x-real-ip"];
    if (typeof real === "string" && real.trim()) return real.trim();
  }
  return peer ?? "unknown";
}

export function rateLimit(opts: { max: number; windowMs: number; key?: (req: Request) => string }): RequestHandler {
  const limiter = new RateLimiter(opts);
  return (req: Request, res: Response, next: NextFunction) => {
    const r = limiter.hit(opts.key ? opts.key(req) : clientAddress(req));
    if (r.ok) return next();
    res.setHeader("Retry-After", String(r.retryAfterSec));
    res.status(429).json(errorBody("rate_limited", `Too many requests -- retry in ${r.retryAfterSec}s`));
  };
}

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_FAILURES = 8;

/** Login failure throttle: 8 failures per 15 min per client address. */
export class LoginThrottle {
  private failures = new Map<string, { count: number; until: number }>();

  /** Milliseconds left on a block, 0 if the address may try. */
  blockedFor(addr: string, now = Date.now()): number {
    const rec = this.failures.get(addr);
    if (!rec) return 0;
    if (now > rec.until) { this.failures.delete(addr); return 0; }
    return rec.count >= LOGIN_MAX_FAILURES ? rec.until - now : 0;
  }

  fail(addr: string, now = Date.now()): void {
    const rec = this.failures.get(addr);
    if (rec && now <= rec.until) rec.count += 1;
    else this.failures.set(addr, { count: 1, until: now + LOGIN_WINDOW_MS });
  }

  clear(addr: string): void { this.failures.delete(addr); }
}
