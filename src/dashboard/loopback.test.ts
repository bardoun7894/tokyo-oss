import { test } from "node:test";
import assert from "node:assert/strict";
import { loopbackOnly } from "./loopback";

function run(remoteAddress: string | undefined, headers: Record<string, string> = {}) {
  let status = 0;
  let body: unknown;
  const res: any = { status(c: number) { status = c; return res; }, json(b: unknown) { body = b; return res; } };
  const ok = loopbackOnly({ socket: { remoteAddress }, headers } as any, res);
  return { ok, status, body };
}

test("accepts the three loopback spellings", () => {
  for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    const r = run(a);
    assert.equal(r.ok, true, a);
    assert.equal(r.status, 0, "nothing is sent when allowed");
  }
});

test("refuses a non-loopback or unknown peer with 403", () => {
  for (const a of ["100.64.0.1", "10.0.0.5", "::ffff:10.0.0.5", "8.8.8.8", undefined]) {
    const r = run(a);
    assert.equal(r.ok, false, String(a));
    assert.equal(r.status, 403);
  }
});

test("refuses a loopback peer that carries X-Forwarded-For or X-Real-IP (nginx proxies from 127.0.0.1)", () => {
  for (const h of [{ "x-forwarded-for": "1.2.3.4" }, { "x-real-ip": "1.2.3.4" }, { "x-forwarded-for": "", "x-real-ip": "" }] as Record<string, string>[]) {
    const r = run("127.0.0.1", h);
    assert.equal(r.ok, false, JSON.stringify(h));
    assert.equal(r.status, 403);
  }
  assert.equal(run("127.0.0.1", { "user-agent": "curl" }).ok, true, "other headers are fine");
});
