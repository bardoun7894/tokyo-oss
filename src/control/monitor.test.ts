import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { controlApp } from "./test-app";
import type { AddressInfo } from "net";
import { Monitor } from "./monitor";
import type { OffersDeps } from "./offers";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const RUN = {
  id: "8f403b3a", project: "shop", source: "server-agent", status: "running", model: "claude-sonnet-5-5", harness: null,
  worker: "dpi INC-0001", tier: null, promptPreview: "INC-0001 shop-api: TypeError failures", startedAt: "2026-10-13T11:50:00.000Z",
  endedAt: null, exitCode: null, host: "server", offerId: null,
};
const ALERT = {
  id: "0a1b2c3d", kind: "action", project: "tokyo", title: "tokyo: failure outside the code", body: "Jev: outside cause 0.93",
  from: "dpi-monitor", state: "pending", missionId: null, buttons: [{ id: "skip", label: "Dismiss" }],
  createdAt: "2026-10-13T11:00:00.000Z", expiresAt: "2026-10-13T17:00:00.000Z", answeredButton: null, channel: null, answeredAt: null,
};

/** A stand-in for dpi-real-be's /api/control, recording what Tokyo sent. */
async function fakeMonitor(over: Partial<Record<"runs" | "offers" | "log" | "stop" | "answer", (req: express.Request, res: express.Response) => void>> = {}) {
  const seen: { method: string; path: string; auth?: string; body?: any }[] = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { seen.push({ method: req.method, path: req.originalUrl, auth: req.headers.authorization, body: req.body }); next(); });
  app.get("/api/control/runs", over.runs ?? ((_q, res) => void res.json({ runs: [RUN] })));
  app.get("/api/control/offers", over.offers ?? ((_q, res) => void res.json({ offers: [ALERT] })));
  app.get("/api/control/runs/:id/log", over.log ?? ((_q, res) => void res.json({
    events: [
      { t: "2026-10-13T11:51:00.000Z", kind: "tool", text: '{"command":"cat src/price.ts"}', tool: "bash" },
      { t: "2026-10-13T11:51:01.000Z", kind: "result", text: "bash: ok, 6 lines", tool: "bash" },
    ],
    cursor: "28", done: false, status: "running",
  })));
  app.post("/api/control/runs/:id/stop", over.stop ?? ((_q, res) => void res.json({ ok: true, status: "stopped" })));
  app.post("/api/control/offers/:id/answer", over.answer ?? ((_q, res) => void res.json({
    offer: { ...ALERT, state: "declined", answeredButton: "skip", channel: "app", answeredAt: "2026-10-13T12:00:00.000Z" }, reply: "Dismissed",
  })));
  const server = app.listen(0, "127.0.0.1");
  server.unref();
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => server.close() };
}

const noOffers: OffersDeps = {
  now: () => NOW, listActions: () => [], listDeploys: () => [],
  answerAction: async () => ({ status: "missing" }) as never, answerDeploy: async () => ({ status: "missing" }) as never,
};

async function setup(over: Parameters<typeof fakeMonitor>[0] = {}, url?: string) {
  const fake = await fakeMonitor(over);
  const base = url ?? fake.url;
  const monitor = new Monitor({ url: `${base}/api/control`, token: "dpi-token", now: () => NOW, ttlMs: 5000 });
  const app = await controlApp({ now: () => NOW, offers: noOffers, monitor });
  return { ...app, fake, monitor };
}

test("monitor runs list with Tokyo's runs, filter by project, and open by id", async () => {
  const s = await setup();
  s.store.insertRun({
    id: "aaaa0001", project: "tokyo", source: "tokyo", status: "succeeded", model: null, harness: "claude", worker: "w", tier: null,
    workspace: null, promptPreview: "p", startedAt: NOW - 3_600_000, endedAt: NOW - 3_000_000, exitCode: 0, host: "server", offerId: null,
  });
  const all = await s.get("/runs");
  assert.equal(all.status, 200);
  assert.deepEqual(all.json.runs.map((r: any) => r.id), ["8f403b3a", "aaaa0001"]);
  const shop = await s.get("/runs?project=shop");
  assert.deepEqual(shop.json.runs.map((r: any) => [r.id, r.source, r.status, r.startedAt]), [["8f403b3a", "server-agent", "running", RUN.startedAt]]);
  assert.equal((await s.get("/runs?status=succeeded")).json.runs.length, 1);
  const one = await s.get("/runs/8f403b3a");
  assert.equal(one.status, 200);
  assert.equal(one.json.worker, "dpi INC-0001");
  assert.ok(s.fake.seen.every((r) => r.auth === "Bearer dpi-token"));
  s.close(); s.fake.close();
});

test("lists are cached for the TTL, so one page view is one monitor call", async () => {
  const s = await setup();
  await s.get("/runs");
  await s.get("/offers");
  await s.get("/counts");
  assert.equal(s.fake.seen.filter((r) => r.path === "/api/control/runs").length, 1);
  s.close(); s.fake.close();
});

test("a monitor run's log is proxied with its cursor; q filters the events here", async () => {
  const s = await setup();
  const log = await s.get("/runs/8f403b3a/log?after=3&wait=0&q=price");
  assert.equal(log.status, 200);
  assert.deepEqual([log.json.cursor, log.json.done, log.json.status, log.json.events.length], ["28", false, "running", 1]);
  assert.equal(log.json.events[0].tool, "bash");
  assert.ok(s.fake.seen.some((r) => r.path === "/api/control/runs/8f403b3a/log?after=3&wait=0"));
  assert.equal((await s.get("/runs/8f403b3a/log?wait=99")).status, 400);
  s.close(); s.fake.close();
});

test("stop is proxied; the monitor's conflict stays a conflict", async () => {
  const s = await setup();
  const stop = await s.post("/runs/8f403b3a/stop");
  assert.deepEqual([stop.status, stop.json], [200, { ok: true, status: "stopped" }]);
  s.close(); s.fake.close();
  const c = await setup({ stop: (_q, res) => void res.status(409).json({ error: { code: "conflict", message: "Run is failed" } }) });
  const again = await c.post("/runs/8f403b3a/stop");
  assert.deepEqual([again.status, again.json.error.code], [409, "conflict"]);
  c.close(); c.fake.close();
});

test("monitor alerts are offers; only skip answers them, exactly once across channels", async () => {
  const s = await setup();
  const list = await s.get("/offers");
  assert.deepEqual(list.json.offers.map((o: any) => [o.id, o.kind, o.state, o.buttons[0].id]), [["0a1b2c3d", "action", "pending", "skip"]]);
  assert.equal((await s.post("/offers/0a1b2c3d/answer", { button: "run" })).status, 400);
  const won = await s.post("/offers/0a1b2c3d/answer", { button: "skip" });
  assert.deepEqual([won.status, won.json.offer.state, won.json.offer.channel, won.json.reply], [200, "declined", "app", "Dismissed"]);
  assert.deepEqual(s.fake.seen.find((r) => r.method === "POST")?.body, { button: "skip", channel: "app" });
  s.close(); s.fake.close();
  const by = { channel: "telegram", at: "2026-10-13T11:59:00.000Z" };
  const lost = await setup({ answer: (_q, res) => void res.status(409).json({ error: "already", answeredBy: by }) });
  const second = await lost.post("/offers/0a1b2c3d/answer", { button: "skip" });
  assert.deepEqual([second.status, second.json], [409, { error: "already", answeredBy: by }]);
  lost.close(); lost.fake.close();
});

test("counts include the monitor's pending alert and running agent", async () => {
  const s = await setup();
  const counts = await s.get("/counts");
  assert.deepEqual(counts.json, { pendingOffers: 1, runningRuns: 1, failedRuns24h: 0, factoryFailed: 0 });
  s.close(); s.fake.close();
});

test("a monitor that is down or refuses leaves the lists working without it", async () => {
  const down = await setup({}, "http://127.0.0.1:9");
  assert.deepEqual([(await down.get("/runs")).status, (await down.get("/runs")).json.runs], [200, []]);
  assert.equal((await down.get("/offers")).json.offers.length, 0);
  assert.equal((await down.get("/runs/8f403b3a")).status, 404);
  down.close(); down.fake.close();
  const refused = await setup({ runs: (_q, res) => void res.status(503).json({ error: { code: "unavailable", message: "x" } }) });
  assert.equal((await refused.get("/runs")).json.runs.length, 0);
  assert.equal((await refused.get("/counts")).status, 200);
  refused.close(); refused.fake.close();
});

test("rows from the monitor are allow-listed and ids must be 8 hex", async () => {
  const s = await setup({
    runs: (_q, res) => void res.json({ runs: [{ ...RUN, secret: "x" }, { ...RUN, id: "../../x" }] }),
  });
  const runs = (await s.get("/runs")).json.runs;
  assert.equal(runs.length, 1);
  assert.equal("secret" in runs[0], false);
  s.close(); s.fake.close();
});
