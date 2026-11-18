import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, clientAddress, rateLimit, LoginThrottle } from "./rate-limit";

const req = (peer: string, headers: Record<string, string> = {}) => ({ headers, socket: { remoteAddress: peer } }) as any;

test("fixed window: allows max then blocks with retryAfter, resets after the window", () => {
  const rl = new RateLimiter({ max: 3, windowMs: 60_000 });
  for (let i = 0; i < 3; i++) assert.equal(rl.hit("k", 1000).ok, true);
  const r = rl.hit("k", 2000);
  assert.equal(r.ok, false);
  assert.equal(r.retryAfterSec, 59);
  assert.equal(rl.hit("other", 2000).ok, true, "keys are independent");
  assert.equal(rl.hit("k", 61_001).ok, true, "new window");
});

test("clientAddress: X-Real-IP only from a loopback peer", () => {
  assert.equal(clientAddress(req("127.0.0.1", { "x-real-ip": "5.6.7.8" })), "5.6.7.8");
  assert.equal(clientAddress(req("::1", { "x-real-ip": "5.6.7.8" })), "5.6.7.8");
  assert.equal(clientAddress(req("::ffff:127.0.0.1", { "x-real-ip": "5.6.7.8" })), "5.6.7.8");
  assert.equal(clientAddress(req("100.64.0.9", { "x-real-ip": "5.6.7.8" })), "100.64.0.9");
  assert.equal(clientAddress(req("127.0.0.1")), "127.0.0.1");
  assert.equal(clientAddress({ headers: {}, socket: {} } as any), "unknown");
});

test("login throttle: 9th failure within 15 min is blocked, success clears, window expires", () => {
  const t = new LoginThrottle();
  for (let i = 0; i < 8; i++) { assert.equal(t.blockedFor("a", 1000), 0); t.fail("a", 1000); }
  assert.ok(t.blockedFor("a", 2000) > 0);
  assert.equal(t.blockedFor("b", 2000), 0);
  assert.equal(t.blockedFor("a", 1000 + 15 * 60_000 + 1), 0);
  t.fail("c", 1); t.clear("c");
  assert.equal(t.blockedFor("c", 2), 0);
});

test("middleware: 429 with Retry-After and envelope; keyed per device when set", () => {
  const mw = rateLimit({ max: 1, windowMs: 60_000, key: (r) => (r as any).deviceId ?? clientAddress(r) });
  let status = 0; let body: any; const hdr: Record<string, string> = {};
  const res: any = { status(s: number) { status = s; return this; }, json(b: any) { body = b; return this; }, setHeader(k: string, v: string) { hdr[k] = v; } };
  let nexts = 0;
  const r = req("127.0.0.1"); r.deviceId = "d1";
  mw(r, res, () => nexts++);
  mw(r, res, () => nexts++);
  assert.equal(nexts, 1);
  assert.equal(status, 429);
  assert.equal(body.error.code, "rate_limited");
  assert.ok(Number(hdr["Retry-After"]) > 0);
});
