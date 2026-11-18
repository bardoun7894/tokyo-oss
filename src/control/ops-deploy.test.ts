import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import express from "express";
import { ControlStore, type ControlRun } from "./store";
import { bearerAuth, loginHandler, type ControlDeps } from "./auth";
import { LoginThrottle } from "./rate-limit";
import { opsRoutes } from "./ops";
import { OpsStore } from "./ops-store";
import { serveApp } from "./test-http";
import { deployProgress, DEPLOY_OFFER_ID, DEPLOY_START_TIMEOUT_MS } from "./ops-deploy";
import { DeployOffers, DEPLOY_OFFER_TTL_MS, type DeployOffer } from "../deploy-offers";
import { DeployOfferStore } from "../deploy-offers-store";
import type { ProjectRef } from "../project-registry";

const NOW = Date.parse("2026-10-16T09:00:00Z");
const P = { name: "tokyo", location: "server", path: "/root/tokyo" } as unknown as ProjectRef;
const known = (n: string) => (n === "tokyo" ? P : undefined);
const RUN = "0a1b2c3d";

const run = (over: Partial<ControlRun> = {}): ControlRun => ({
  id: RUN, project: "tokyo", source: "tokyo", status: "running", model: null, harness: "claude", worker: null, tier: null,
  promptPreview: "Deploy the work that Tokyo's previous run just committed /root/secret/path", startedAt: NOW - 600_000, endedAt: null, exitCode: null,
  host: "server", offerId: "a1b2c3d4", workspace: "tokyo-run-0a1b2c3d", ...over,
});
const offer = (over: Partial<DeployOffer> = {}): DeployOffer => ({ id: "a1b2c3d4", project: P, chatId: 1, createdAt: NOW - 3_600_000, state: "pending", ...over });

test("outcome follows the offer state and the run status", () => {
  assert.equal(deployProgress(offer(), undefined, NOW).outcome, "pending");
  assert.equal(deployProgress(offer({ state: "declined", channel: "app", answeredAt: NOW - 1 }), undefined, NOW).outcome, "skipped");
  const approved = offer({ state: "approved", channel: "app", answeredAt: NOW - 700_000, runId: RUN });
  const fresh = offer({ state: "approved", channel: "app", answeredAt: NOW - 60_000, runId: RUN });
  assert.equal(deployProgress(fresh, undefined, NOW).outcome, "pending", "approved a minute ago, no run row yet: not started, never `running`");
  assert.equal(deployProgress(fresh, run({ status: "queued", workspace: null, startedAt: NOW - 60_000 }), NOW).outcome, "pending");
  assert.equal(deployProgress(fresh, run({ status: "queued", workspace: null, startedAt: NOW - 60_000 }), NOW).run?.status, "queued", "the run row shows it is queued");
  const old = offer({ state: "approved", channel: "app", answeredAt: NOW - DEPLOY_START_TIMEOUT_MS - 1, runId: RUN });
  assert.equal(deployProgress(old, run({ status: "queued", workspace: null }), NOW).outcome, "expired", "queued past the start timeout and never started");
  assert.equal(deployProgress(old, undefined, NOW).outcome, "expired", "no run row past the start timeout (herdr start failed, Mac offline)");
  assert.equal(deployProgress(offer({ ...fresh, answeredAt: NOW - DEPLOY_START_TIMEOUT_MS + 1 }), undefined, NOW).outcome, "pending");
  assert.equal(deployProgress(approved, run({ status: "running" }), NOW).outcome, "running");
  assert.equal(deployProgress(approved, run({ status: "succeeded", endedAt: NOW - 5, exitCode: 0 }), NOW).outcome, "succeeded");
  assert.equal(deployProgress(approved, run({ status: "failed", endedAt: NOW - 5, exitCode: 1 }), NOW).outcome, "failed");
  assert.equal(deployProgress(approved, run({ status: "stopped", endedAt: NOW - 5 }), NOW).outcome, "failed", "a run stopped by hand did not deploy");
  assert.equal(deployProgress(offer({ createdAt: NOW - DEPLOY_OFFER_TTL_MS - 1 }), undefined, NOW).outcome, "expired");
  assert.equal(deployProgress(offer({ state: "approved", createdAt: NOW - DEPLOY_OFFER_TTL_MS - 1, answeredAt: NOW - 60_000, runId: RUN }), run({ status: "running" }), NOW).outcome, "running", "an approved offer follows its run, not the offer TTL");
});

test("the body has the contract fields and no log text, prompt, workspace or host path", () => {
  const body = deployProgress(offer({ state: "approved", channel: "app", answeredAt: NOW - 700_000, runId: RUN }), run({ status: "succeeded", endedAt: NOW - 5, exitCode: 0 }), NOW);
  assert.deepEqual(body, {
    offerId: "a1b2c3d4", project: "tokyo", state: "approved",
    answeredBy: { channel: "app", at: new Date(NOW - 700_000).toISOString() },
    run: { id: RUN, status: "succeeded", startedAt: new Date(NOW - 600_000).toISOString(), endedAt: new Date(NOW - 5).toISOString(), exitCode: 0 },
    outcome: "succeeded",
  });
  const s = JSON.stringify(body);
  assert.ok(!/secret|workspace|tokyo-run|Deploy the work|model/.test(s));
  const pending = deployProgress(offer(), undefined, NOW);
  assert.deepEqual(pending, { offerId: "a1b2c3d4", project: "tokyo", state: "pending", run: null, outcome: "pending" });
  assert.deepEqual(deployProgress(offer({ state: "approved", channel: "app", answeredAt: NOW, runId: RUN }), run(), NOW).run, { id: RUN, status: "running", startedAt: new Date(NOW - 600_000).toISOString(), endedAt: null, exitCode: null });
});

test("a run with another id than the offer's runId, or a run of another offer, is not shown", () => {
  const approved = offer({ state: "approved", channel: "app", answeredAt: NOW, runId: RUN });
  assert.equal(deployProgress(approved, run({ offerId: "ffffffff" }), NOW).run, null);
  assert.equal(deployProgress(approved, run({ offerId: null }), NOW).run, null);
});

async function setup() {
  const db = new Database(":memory:");
  const store = new ControlStore(db);
  const backing = new DeployOfferStore(db);
  let deploys = new DeployOffers(backing, { resolve: known, loadNow: NOW });
  const deps: ControlDeps = { store, now: () => NOW, throttle: new LoginThrottle(), checkCredentials: (u, p) => u === "admin" && p === "pw" };
  const app = express();
  app.use(express.json());
  const v1 = express.Router();
  v1.post("/auth/login", loginHandler(deps));
  v1.use(bearerAuth(deps));
  v1.use(opsRoutes({
    godhome: { summary: async () => { throw new Error("not used"); }, runs: async () => { throw new Error("not used"); }, run: async () => { throw new Error("not used"); }, graph: async () => { throw new Error("not used"); } },
    store: new OpsStore(db), now: () => NOW,
    deploys: { get: (id: string) => deploys.get(id, NOW) },
    runs: { getRun: (id: string) => store.getRun(id) },
  } as any));
  app.use("/v1", v1);
  const srv = await serveApp(app);
  const login = await srv.call("POST", "/v1/auth/login", { username: "admin", password: "pw", deviceName: "t" });
  const auth = { authorization: `Bearer ${login.json.deviceToken}` };
  return {
    srv, db, store, deviceId: login.json.deviceId as string, get: (p: string) => srv.call("GET", "/v1" + p, undefined, auth),
    offers: () => deploys, reload: () => { deploys = new DeployOffers(backing, { resolve: known, loadNow: NOW }); },
  };
}

test("X12: pending, skipped, running, succeeded, failed come back by offer id; fetchedAt and reachable are set", async () => {
  const t = await setup();
  const o = t.offers().create({ project: P, chatId: 1, now: NOW });
  let r = await t.get(`/ops/deploys/${o.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { fetchedAt: new Date(NOW).toISOString(), reachable: true, offerId: o.id, project: "tokyo", state: "pending", run: null, outcome: "pending" });
  t.offers().take(o.id, "deploy", "app", NOW);
  t.offers().setRunId(o.id, RUN);
  r = await t.get(`/ops/deploys/${o.id}`);
  assert.equal(r.json.outcome, "pending", "approved, no run row yet");
  assert.equal(r.json.run, null);
  assert.deepEqual(r.json.answeredBy, { channel: "app", at: new Date(NOW).toISOString() });
  t.store.insertRun(run({ offerId: o.id }));
  assert.deepEqual([(await t.get(`/ops/deploys/${o.id}`)).json.outcome, (await t.get(`/ops/deploys/${o.id}`)).json.run.status], ["running", "running"]);
  t.store.updateRun(RUN, { status: "succeeded", endedAt: NOW, exitCode: 0 });
  assert.equal((await t.get(`/ops/deploys/${o.id}`)).json.outcome, "succeeded");
  t.store.updateRun(RUN, { status: "failed", exitCode: 2 });
  assert.equal((await t.get(`/ops/deploys/${o.id}`)).json.outcome, "failed");
  const skipped = t.offers().create({ project: P, chatId: 1, now: NOW });
  t.offers().take(skipped.id, "skip", "telegram", NOW);
  const s = await t.get(`/ops/deploys/${skipped.id}`);
  assert.deepEqual([s.json.outcome, s.json.run], ["skipped", null]);
  await t.srv.close();
});

test("X12: an unknown or malformed offer id is 404 / 400; a TTL-expired offer is 404", async () => {
  const t = await setup();
  assert.equal((await t.get("/ops/deploys/deadbeef")).status, 404);
  assert.deepEqual((await t.get("/ops/deploys/deadbeef")).json, { error: { code: "not_found", message: "No such offer" } });
  for (const bad of ["DEADBEEF", "dead", "deadbeef0", "..%2f..", "a1b2c3d4%00"]) assert.equal((await t.get(`/ops/deploys/${bad}`)).status, 400, bad);
  assert.ok(DEPLOY_OFFER_ID.test("a1b2c3d4") && !DEPLOY_OFFER_ID.test("A1B2C3D4"));
  await t.srv.close();
});

test("X12: a persisted offer after a reload still answers, with its run link", async () => {
  const t = await setup();
  const o = t.offers().create({ project: P, chatId: 1, now: NOW });
  t.offers().take(o.id, "deploy", "app", NOW);
  t.offers().setRunId(o.id, RUN);
  t.store.insertRun(run({ offerId: o.id, status: "succeeded", endedAt: NOW, exitCode: 0 }));
  t.reload();
  const r = await t.get(`/ops/deploys/${o.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.outcome, r.json.run.id, r.json.state], ["succeeded", RUN, "approved"]);
  await t.srv.close();
});

test("X12: needs ops:read, and no log text or prompt is returned", async () => {
  const t = await setup();
  const o = t.offers().create({ project: P, chatId: 1, now: NOW, summary: "SECRET summary /root/x/y" });
  t.offers().take(o.id, "deploy", "app", NOW);
  t.offers().setRunId(o.id, RUN);
  t.store.insertRun(run({ offerId: o.id }));
  const r = await t.get(`/ops/deploys/${o.id}`);
  assert.ok(!/SECRET|Deploy the work|\/root\//.test(JSON.stringify(r.json)));
  assert.equal((await t.srv.call("GET", `/v1/ops/deploys/${o.id}`)).status, 401);
  t.db.prepare("UPDATE control_devices SET caps = 'ops:write' WHERE id = ?").run(t.deviceId);
  assert.equal((await t.get(`/ops/deploys/${o.id}`)).status, 403);
  await t.srv.close();
});

test("X12: an approved offer whose run still waits in the laptop queue stays pending past the start timeout, not expired", async () => {
  const t = await setup();
  let waiting = true;
  const app = express();
  app.use(express.json());
  const v1 = express.Router();
  const deps: ControlDeps = { store: t.store, now: () => NOW + DEPLOY_START_TIMEOUT_MS * 2, throttle: new LoginThrottle(), checkCredentials: (u, p) => u === "admin" && p === "pw" };
  v1.post("/auth/login", loginHandler(deps));
  v1.use(bearerAuth(deps));
  v1.use(opsRoutes({
    godhome: {} as any, store: new OpsStore(t.db), now: () => NOW + DEPLOY_START_TIMEOUT_MS * 2,
    deploys: { get: (id: string) => t.offers().get(id, NOW), waiting: (runId: string) => waiting && runId === RUN },
    runs: { getRun: (id: string) => t.store.getRun(id) },
  } as any));
  app.use("/v1", v1);
  const srv = await serveApp(app);
  const login = await srv.call("POST", "/v1/auth/login", { username: "admin", password: "pw", deviceName: "t2" });
  const auth = { authorization: `Bearer ${login.json.deviceToken}` };
  const o = t.offers().create({ project: P, chatId: 1, now: NOW });
  t.offers().take(o.id, "deploy", "app", NOW);
  t.offers().setRunId(o.id, RUN);
  t.store.insertRun(run({ offerId: o.id, status: "queued", workspace: null, startedAt: NOW }));
  assert.equal((await srv.call("GET", `/v1/ops/deploys/${o.id}`, undefined, auth)).json.outcome, "pending", "the Mac has not drained it yet");
  waiting = false;
  assert.equal((await srv.call("GET", `/v1/ops/deploys/${o.id}`, undefined, auth)).json.outcome, "expired", "no queue row left: the old rule");
  await srv.close();
  await t.srv.close();
});
