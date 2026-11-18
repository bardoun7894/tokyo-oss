import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import Database from "better-sqlite3";
import { ActionOffers } from "../action-offers";
import { DeployOffers } from "../deploy-offers";
import { createActionOfferFlow } from "../action-offer-flow";
import { TriageStore } from "../finish-apps/triage-store";
import type { RepoReader } from "../finish-apps/summary";
import type { HerdrHost } from "../herdr-run";
import type { MissionRow } from "../mission-store";
import type { ProjectRef } from "../project-registry";
import { recordRunStarted } from "./runs";
import { ControlStore } from "./store";
import { createControlRouter } from "./router";
import { LoginThrottle } from "./rate-limit";
import { serveApp } from "./test-http";

// The whole Control API on an ephemeral port, with fake runner, herdr host, mission store and offer stores.
const T0 = Date.parse("2026-10-09T09:00:00Z");
const DATE = "2026-10-09";
const RUN_ID = "0a1b2c3d";
const P = (name: string) => ({ name, location: "server", path: `/root/${name}` }) as unknown as ProjectRef;
const line = (o: unknown) => JSON.stringify(o) + "\n";
const LOG = line({ type: "system", subtype: "init", model: "claude-sonnet-5-5" }) + line({ type: "result", result: "Done.", is_error: false });
const reader: RepoReader = {
  specs: () => [{ name: "001-a", hasSpec: true, hasPlan: true, hasTasks: true, tasksDone: 5, tasksOpen: 0 }, { name: "002-b", hasSpec: true, hasPlan: false, hasTasks: false, tasksDone: 0, tasksOpen: 0 }],
  merged7d: () => [],
  gaps: () => [{ code: "G1", text: "no tests", severity: "P1", source: "defects" }],
};
const entry = (name: string) => ({ name, host: "server", completeness: 2, next_action: "write-specs", open_tasks: 4, specs_total: 2, specs_missing_plan: 1, specs_missing_tasks: 1 });
const rec = (n: number) => ({ code: `R${n}`, title: `Rec ${n}`, kind: "feature", why: "w", evidence: ["e"], size: "M", impact: 3 });

async function boot() {
  const db = new Database(":memory:");
  const store = new ControlStore(db);
  const triage = new TriageStore(db);
  triage.upsert(DATE, "tokyo", entry("tokyo"), [rec(1), rec(2)], []);
  triage.upsert(DATE, "godhome", entry("godhome"), [rec(1)], []);
  let t = T0;
  let ids = 0;
  const edits: any[] = [];
  const bot: any = { api: { sendMessage: async () => ({ message_id: 7 }), editMessageText: async (_c: number, _m: number, text: string) => { edits.push(text); return true; } } };
  const actions = new ActionOffers({ newId: () => (++ids).toString(16).padStart(8, "0") });
  const deploys = new DeployOffers();
  const deployed: string[] = [];
  const stopped: string[] = [];
  const missions = new Map<string, MissionRow>();
  const flow = createActionOfferFlow({
    offers: actions, getBot: () => bot, chatId: 42, now: () => t,
    getProject: (n) => (["tokyo", "godhome"].includes(n) ? P(n) : undefined),
    // The fake runner: what executeClaude records when a run starts.
    startRun: async (r: any) => {
      recordRunStarted(store, { id: r.runId ?? RUN_ID, project: r.project.name, host: "server", prompt: r.prompt, model: "claude-sonnet-5-5", tier: "medium", label: `tokyo-run-${r.runId ?? RUN_ID}`, now: t });
    },
  });
  const host: HerdrHost = {
    dir: (id) => `/x/${id}`, prepare: async () => {}, start: async () => {},
    read: async (_id, f) => (f === "exit_code" ? null : LOG),
    readFrom: async (_id, offset, max) => ({ text: LOG.slice(offset, offset + max), offset: Math.min(LOG.length, offset + max) }),
    size: async () => LOG.length, stop: async (label) => { stopped.push(label); },
  };
  const app = express();
  app.use("/control-api", createControlRouter({
    store, throttle: new LoginThrottle(), checkCredentials: (u, p) => u === "admin" && p === "pw", now: () => t,
    projects: { triage, readerFor: () => reader, pendingOfferFor: (n) => actions.listPending(t).find((o) => o.project === n)?.id ?? null },
    offers: {
      now: () => t, listActions: () => actions.list(t), listDeploys: () => deploys.list(t),
      answerAction: (id, b, ch, o) => flow.answerActionOfferDetailed(id, b, ch, o),
      answerDeploy: async (id, a, ch) => {
        const r = deploys.take(id, a, ch, t);
        if (r.status === "missing") return { status: "missing" };
        if (r.status === "already") return { status: "already", offer: r.offer };
        if (a === "deploy") deployed.push(id);
        return { status: "applied", offer: r.offer, reply: a === "deploy" ? "Deploying…" : "Not deploying." };
      },
      listMissions: () => [...missions.values()],
      answerMission: async (id, answer, ch) => {
        const m = missions.get(id);
        if (!m) return { status: "missing" };
        if (m.state !== "proposed") return { status: "already", mission: m };
        m.state = answer === "approve" ? "approved" : "declined";
        m.answered_by = ch;
        m.answered_at = t;
        return { status: "applied", mission: m, reply: `Mission ${id} ${m.state}.` };
      },
    },
    writeSpec: {
      getProject: (n) => (n === "godhome" ? { name: "godhome", location: "server", path: "/root/godhome" } : undefined),
      pendingActionFor: (p) => actions.listPending(t).find((o) => o.project === p),
      createOffer: (a) => flow.offerActionFromSession(a),
    },
    runs: { hostFor: () => host, now: () => t, sleep: async (ms) => { t += ms; } },
    tasks: {
      getProject: (n) => (n === "tokyo" ? P(n) : undefined),
      propose: async (_p, msg) => {
        const id = "4f2a9c1b";
        missions.set(id, {
          id, project: "tokyo", prompt: msg.content, sender: msg.sender_name, jid: msg.jid, state: "proposed", engine: "claude", answered_by: null, answered_at: null,
          branch: null, base_commit: null, clone_path: null, tmux_session: null, exit_code: null, result: null, test_output: null, deploy_output: null, hold_reason: null,
          created_at: t, updated_at: t, expires_at: t + 30 * 60_000,
        });
        return id;
      },
    },
  }));
  const srv = await serveApp(app);
  return { srv, store, actions, deploys, flow, deployed, stopped, edits, tick: (ms: number) => (t += ms), now: () => t };
}

test("the whole app journey through the public API", async () => {
  const s = await boot();
  const base = "/control-api/v1";
  const login = await s.srv.call("POST", `${base}/auth/login`, { username: "admin", password: "pw", deviceName: "pixel" });
  assert.equal(login.status, 200);
  const auth = { authorization: `Bearer ${login.json.deviceToken}` };
  const get = (p: string) => s.srv.call("GET", base + p, undefined, auth);
  const post = (p: string, b: unknown = {}) => s.srv.call("POST", base + p, b, auth);

  // an action offer and a deploy offer
  const made = await s.flow.offerAction(P("tokyo"), { project: "tokyo", title: "Tokyo is 2/4", body: "next steps", from: "finish-apps", buttons: [
    { id: "run", label: "Run next step", prompt: "do the next step" }, { id: "skip", label: "Skip" },
  ] }) as any;
  const dep = s.deploys.create({ project: P("godhome"), chatId: 42, now: s.now(), summary: "shipped x", from: "claude" });
  const offers = (await get("/offers")).json.offers;
  assert.deepEqual(offers.map((o: any) => o.kind).sort(), ["action", "deploy"]);
  assert.equal(offers.find((o: any) => o.kind === "action").id, made.id);
  assert.equal(offers.find((o: any) => o.kind === "deploy").id, dep.id);

  // answer run: a run row with model, harness, worker, tier and source
  const ran = await post(`/offers/${made.id}/answer`, { button: "run" });
  assert.equal(ran.status, 200);
  assert.equal(ran.json.offer.state, "approved");
  assert.equal(ran.json.offer.channel, "app");
  const runs = (await get("/runs?project=tokyo")).json.runs;
  assert.equal(runs.length, 1);
  const r0 = runs[0];
  assert.deepEqual([r0.id, r0.model, r0.harness, r0.worker, r0.tier, r0.source, r0.status], [RUN_ID, "claude-sonnet-5-5", "claude", `tokyo-run-${RUN_ID}`, "medium", "tokyo", "running"]);
  assert.equal((await get("/counts")).json.runningRuns, 1);

  // answer deploy
  const dr = await post(`/offers/${dep.id}/answer`, { button: "deploy" });
  assert.equal(dr.status, 200);
  assert.deepEqual(s.deployed, [dep.id]);
  assert.equal((await post(`/offers/${dep.id}/answer`, { button: "skip" })).status, 409);

  // log long-poll: returns the parsed events, then a wait on a drained log comes back empty at the same cursor
  const log = await get(`/runs/${RUN_ID}/log`);
  assert.deepEqual(log.json.events.map((e: any) => e.kind), ["system", "result"]);
  const waited = await get(`/runs/${RUN_ID}/log?after=${log.json.cursor}&wait=2`);
  assert.equal(waited.status, 200);
  assert.deepEqual(waited.json.events, []);
  assert.equal(waited.json.cursor, log.json.cursor);

  // stop
  const stop = await post(`/runs/${RUN_ID}/stop`);
  assert.deepEqual(stop.json, { ok: true, status: "stopped" });
  assert.deepEqual(s.stopped, [`tokyo-run-${RUN_ID}`]);
  assert.equal((await get("/counts")).json.runningRuns, 0);

  // projects: done / missing / gap severity
  const projects = (await get("/projects")).json.projects;
  const tokyo = projects.find((p: any) => p.name === "tokyo");
  assert.equal(tokyo.done.tasks_done, 5);
  assert.deepEqual(tokyo.missing.specs_incomplete, [{ name: "002-b", missing: ["plan", "tasks"] }]);
  assert.deepEqual(tokyo.missing.gaps, [{ code: "G1", text: "no tests", severity: "P1", source: "defects" }]);

  // write-spec on a project with no pending offer raises one and starts a run
  const ws = await post("/projects/godhome/recommendations/R1/write-spec");
  assert.equal(ws.status, 200);
  assert.match(ws.json.runId, /^[0-9a-f]{8}$/);
  assert.equal(s.store.getRun(ws.json.runId)!.offerId, ws.json.offerId);

  // a task: the offerId is the id of the mission offer
  const task = await post("/tasks", { project: "tokyo", text: "add dark mode" });
  assert.equal(task.status, 200);
  assert.equal(task.json.status, "awaiting_approval");
  const mission = (await get("/offers")).json.offers.find((o: any) => o.kind === "mission");
  assert.equal(mission.id, task.json.offerId);
  assert.equal(mission.missionId, task.json.missionId);

  // counts: one pending mission offer, nothing running, no failures
  assert.deepEqual((await get("/counts")).json, { pendingOffers: 1, runningRuns: 1, failedRuns24h: 0, factoryFailed: 0 });

  // SC-C4: nothing outside /v1 reaches anything but a 404 or 401
  for (const p of ["/control-api/api/internal/x", "/control-api/../api/internal/x", "/control-api/%2e%2e/api/internal/x", "/control-api/v1/../../api/internal/x", "/control-api/internal", "/control-api/"]) {
    for (const h of [{}, auth]) {
      const r = await s.srv.call("GET", p, undefined, h);
      assert.ok([401, 404].includes(r.status), `${p} -> ${r.status}`);
    }
  }

  // a revoked token stops working at once
  const me = (await get("/devices")).json.devices.find((d: any) => d.current).id;
  assert.equal((await s.srv.call("DELETE", `${base}/devices/${me}`, undefined, auth)).status, 200);
  assert.equal((await get("/projects")).status, 401);
  assert.equal((await get("/counts")).status, 401);
  await s.srv.close();
});
