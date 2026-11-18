import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { registerInternalIncidentOffer } from "./internal-incident-offer";
import { serveApp } from "../control/test-http";

function fakeRunner() {
  const calls: any[] = [];
  const runner: any = {
    offerIncidentFromSession: async (a: any) => {
      calls.push(a);
      if (a.app === "down") return { ok: false, kind: "unavailable", error: "telegram bot not ready" };
      if (typeof a.incidentId !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(a.incidentId)) return { ok: false, kind: "invalid", error: "incidentId must match [A-Za-z0-9_-]{1,120}" };
      return { ok: true, id: "ab12cd34", existing: calls.length > 1 };
    },
    incidentOfferStatus: (id: string) => (id === "ab12cd34" ? { state: "answered", answeredButton: "approve", channel: "app" } : null),
  };
  return { runner, calls };
}

async function serve(runner: any) {
  const app = express();
  app.use(express.json());
  registerInternalIncidentOffer(app, () => runner);
  return serveApp(app);
}

const BODY = { incidentId: "inc-1", app: "godhome", title: "godhome down", summary: "s", risk: "high", diffStat: "1 file", branch: "fix/x", from: "oncall" };

test("POST returns the id; the second POST for the same incident returns the same id", async () => {
  const { runner, calls } = fakeRunner();
  const s = await serve(runner);
  try {
    assert.deepEqual(await s.call("POST", "/api/internal/incident-offer", BODY).then((r) => [r.status, r.json]), [200, { id: "ab12cd34" }]);
    assert.deepEqual(await s.call("POST", "/api/internal/incident-offer", BODY).then((r) => [r.status, r.json]), [200, { id: "ab12cd34" }]);
    assert.equal(calls[0].incidentId, "inc-1");
    assert.equal(calls[0].risk, "high");
  } finally { await s.close(); }
});

test("body validation: 400 with a message, runner not reached for bad shapes", async () => {
  const { runner, calls } = fakeRunner();
  const s = await serve(runner);
  try {
    const bad = async (over: any, re: RegExp) => {
      const r = await s.call("POST", "/api/internal/incident-offer", { ...BODY, ...over });
      assert.equal(r.status, 400, JSON.stringify(over));
      assert.match(r.json.error, re);
    };
    await bad({ incidentId: "has space" }, /incidentId/);
    await bad({ incidentId: "a".repeat(121) }, /incidentId/);
    await bad({ incidentId: 5 }, /incidentId/);
    await bad({ risk: "extreme" }, /risk/);
    await bad({ risk: undefined }, /risk/);
    await bad({ app: "" }, /app/);
    await bad({ title: "" }, /title/);
    await bad({ summary: 3 }, /summary/);
    assert.equal(calls.length, 0);
  } finally { await s.close(); }
});

test("runner unavailable maps to 503", async () => {
  const { runner } = fakeRunner();
  const s = await serve(runner);
  try {
    assert.equal((await s.call("POST", "/api/internal/incident-offer", { ...BODY, app: "down" })).status, 503);
  } finally { await s.close(); }
});

test("GET returns state, answeredButton, channel; unknown or malformed id is 404", async () => {
  const { runner } = fakeRunner();
  const s = await serve(runner);
  try {
    assert.deepEqual(await s.call("GET", "/api/internal/incident-offer/ab12cd34").then((r) => [r.status, r.json]), [200, { state: "answered", answeredButton: "approve", channel: "app" }]);
    assert.equal((await s.call("GET", "/api/internal/incident-offer/deadbeef")).status, 404);
    assert.equal((await s.call("GET", "/api/internal/incident-offer/..%2Fx")).status, 404);
  } finally { await s.close(); }
});

test("proxied requests are refused (loopback only)", async () => {
  const { runner, calls } = fakeRunner();
  const s = await serve(runner);
  try {
    assert.equal((await s.call("POST", "/api/internal/incident-offer", BODY, { "x-forwarded-for": "1.2.3.4" })).status, 403);
    assert.equal((await s.call("GET", "/api/internal/incident-offer/ab12cd34", undefined, { "x-real-ip": "1.2.3.4" })).status, 403);
    assert.equal(calls.length, 0);
  } finally { await s.close(); }
});
