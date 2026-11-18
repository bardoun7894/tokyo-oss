import { test } from "node:test";
import assert from "node:assert/strict";
import { ActionOffers } from "../action-offers";
import { DeployOffers } from "../deploy-offers";
import type { ProjectRef } from "../project-registry";
import { controlApp } from "./test-app";

const T0 = Date.parse("2026-10-09T09:00:00Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const P = { name: "tokyo", location: "server", path: "/root/tokyo" } as unknown as ProjectRef;
const run = (id: string, over: Record<string, unknown> = {}) => ({
  id, project: "tokyo", source: "tokyo" as const, status: "succeeded" as const, model: null, harness: null, worker: null, tier: null,
  promptPreview: "p", startedAt: T0, endedAt: T0 + 1000, exitCode: 0, host: "server" as const, offerId: null, workspace: null, ...over,
});

async function setup() {
  const actions = new ActionOffers({ newId: (() => { let i = 0; return () => (++i).toString(16).padStart(8, "0"); })() });
  const deploys = new DeployOffers();
  const app = await controlApp({
    now: () => T0 + 60 * MIN,
    offers: {
      now: () => T0 + 60 * MIN, listActions: () => actions.list(T0 + 60 * MIN), listDeploys: () => deploys.list(T0 + 60 * MIN),
      answerAction: async () => ({ status: "missing" }), answerDeploy: async () => ({ status: "missing" }),
    },
  });
  return { ...app, actions, deploys };
}

test("GET /counts returns pendingOffers, runningRuns and failedRuns24h", async () => {
  const s = await setup();
  const now = T0 + 60 * MIN;
  s.actions.create({ project: "a", chatId: 1, title: "t", body: "", now: T0 });
  s.actions.create({ project: "b", chatId: 1, title: "t", body: "", now: T0 });
  s.deploys.create({ project: P, chatId: 1, now: T0 });
  const answered = s.deploys.create({ project: P, chatId: 1, now: T0 });
  s.deploys.take(answered.id, "skip", "app", T0);
  s.store.insertRun(run("aaaaaaa1", { status: "running", endedAt: null, exitCode: null }));
  s.store.insertRun(run("aaaaaaa2", { status: "failed", endedAt: now - 60 * MIN, exitCode: 1 }));
  s.store.insertRun(run("aaaaaaa3", { status: "failed", endedAt: now - 25 * 60 * MIN, exitCode: 1 }));
  s.store.insertRun(run("aaaaaaa4", { status: "succeeded" }));
  const r = await s.get("/counts");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { pendingOffers: 3, runningRuns: 1, failedRuns24h: 1, factoryFailed: 0 });
  await s.close();
});

test("GET /offers: limit default 50, max 100, 101 is 400; before and next page through newest first", async () => {
  const s = await setup();
  for (let i = 0; i < 7; i++) s.actions.create({ project: `p${i}`, chatId: 1, title: `t${i}`, body: "", now: T0 + i * MIN });
  const p1 = await s.get("/offers?limit=3");
  assert.deepEqual(p1.json.offers.map((o: any) => o.title), ["t6", "t5", "t4"]);
  assert.equal(p1.json.next, iso(T0 + 4 * MIN));
  const p2 = await s.get(`/offers?limit=3&before=${encodeURIComponent(p1.json.next)}`);
  assert.deepEqual(p2.json.offers.map((o: any) => o.title), ["t3", "t2", "t1"]);
  const p3 = await s.get(`/offers?limit=3&before=${encodeURIComponent(p2.json.next)}`);
  assert.deepEqual(p3.json.offers.map((o: any) => o.title), ["t0"]);
  assert.equal(p3.json.next, null);
  const exact = await s.get("/offers?limit=7");
  assert.equal(exact.json.offers.length, 7);
  assert.equal(exact.json.next, null);
  assert.equal((await s.get("/offers?limit=100")).status, 200);
  for (const bad of ["101", "0", "-1", "x", "1.5"]) assert.equal((await s.get(`/offers?limit=${bad}`)).status, 400, bad);
  assert.equal((await s.get("/offers?before=notadate")).status, 400);
  assert.equal((await s.get("/offers?since=notadate")).status, 400);
  await s.close();
});

test("GET /offers since returns offers created or answered at or after it", async () => {
  const s = await setup();
  const old = s.actions.create({ project: "old", chatId: 1, title: "old", body: "", now: T0 }).offer;
  s.actions.create({ project: "new", chatId: 1, title: "new", body: "", now: T0 + 10 * MIN });
  s.actions.take(old.id, "skip", "telegram", T0 + 20 * MIN);
  const r = await s.get(`/offers?state=all&since=${encodeURIComponent(iso(T0 + 5 * MIN))}`);
  assert.deepEqual(r.json.offers.map((o: any) => o.title).sort(), ["new", "old"]);
  const r2 = await s.get(`/offers?state=all&since=${encodeURIComponent(iso(T0 + 30 * MIN))}`);
  assert.deepEqual(r2.json.offers, []);
  await s.close();
});

test("GET /runs: limit default 20, max 100, 101 is 400; before, since and next", async () => {
  const s = await setup();
  for (let i = 0; i < 25; i++) s.store.insertRun(run((i + 1).toString(16).padStart(8, "0"), { startedAt: T0 + i * MIN, endedAt: T0 + i * MIN + 1000 }));
  const first = await s.get("/runs");
  assert.equal(first.status, 200);
  assert.equal(first.json.runs.length, 20);
  assert.equal(first.json.runs[0].startedAt, iso(T0 + 24 * MIN));
  assert.equal(first.json.next, iso(T0 + 5 * MIN));
  const second = await s.get(`/runs?before=${encodeURIComponent(first.json.next)}`);
  assert.equal(second.json.runs.length, 5);
  assert.equal(second.json.next, null);
  const exact = await s.get("/runs?limit=25");
  assert.equal(exact.json.runs.length, 25);
  assert.equal(exact.json.next, null);
  const since = await s.get(`/runs?since=${encodeURIComponent(iso(T0 + 23 * MIN))}`);
  assert.equal(since.json.runs.length, 2);
  assert.equal((await s.get("/runs?limit=100")).status, 200);
  assert.equal((await s.get("/runs?limit=101")).status, 400);
  assert.equal((await s.get("/runs?before=x")).status, 400);
  assert.equal((await s.get("/runs?status=bogus")).status, 400);
  assert.equal((await s.get("/runs?project=..%2Fx")).status, 400);
  assert.equal(JSON.stringify(first.json).includes("workspace"), false);
  await s.close();
});

test("GET /runs filters by project and status", async () => {
  const s = await setup();
  s.store.insertRun(run("aaaaaaa1", { project: "tokyo", status: "running", endedAt: null, exitCode: null }));
  s.store.insertRun(run("aaaaaaa2", { project: "godhome", status: "failed", exitCode: 1 }));
  assert.deepEqual((await s.get("/runs?project=godhome")).json.runs.map((r: any) => r.id), ["aaaaaaa2"]);
  assert.deepEqual((await s.get("/runs?status=running")).json.runs.map((r: any) => r.id), ["aaaaaaa1"]);
  await s.close();
});
