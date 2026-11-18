import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { ActionOffers } from "../action-offers";
import { createActionOfferFlow } from "../action-offer-flow";
import { TriageStore } from "../finish-apps/triage-store";
import { buildOffers } from "../finish-apps/offers";
import type { ProjectRef } from "../project-registry";
import { controlApp } from "./test-app";

const T0 = Date.parse("2026-10-09T09:00:00Z");
const DATE = "2026-10-09";
const P = (name: string) => ({ name, location: "server", path: `/root/${name}` }) as unknown as ProjectRef;
const rec = (n: number) => ({ code: `R${n}`, title: `Rec ${n}`, kind: "feature", why: `why ${n}`, evidence: [`ev ${n}`], size: "M", impact: 3 });
const tokyo = { name: "tokyo", host: "server", completeness: 2, next_action: "write-specs", open_tasks: 4 };
const registry = (n: string) => (n === "tokyo" ? { name: "tokyo", location: "server" as const, path: "/root/tokyo" } : undefined);

function expectedCards(entry: any, recs: any[]) {
  return buildOffers([entry], [{ name: entry.name, recommendations: recs }], {
    date: DATE, now: T0, getProject: registry, recentSkips: () => 0, readerFor: () => null, log: () => {},
  });
}

async function setup(entry: any = tokyo, recs: any[] = [rec(1), rec(2), rec(3), rec(4)]) {
  const db = new Database(":memory:");
  const triage = new TriageStore(db);
  triage.upsert(DATE, entry.name, entry, recs, []);
  const edits: any[] = [];
  const runs: any[] = [];
  const bot: any = {
    api: {
      sendMessage: async () => ({ message_id: 7 }),
      editMessageText: async (_c: number, mid: number, text: string) => { edits.push({ mid, text }); return true; },
    },
  };
  let ids = 0;
  const actions = new ActionOffers({ newId: () => (++ids).toString(16).padStart(8, "0") });
  const flow = createActionOfferFlow({
    offers: actions, getBot: () => bot, chatId: 42, now: () => T0,
    getProject: (n) => (n === "tokyo" ? P(n) : undefined),
    startRun: async (r) => { runs.push(r); },
  });
  const app = await controlApp({
    now: () => T0,
    projects: { triage, readerFor: () => null, pendingOfferFor: () => null },
    offers: {
      now: () => T0, listActions: () => actions.list(T0), listDeploys: () => [],
      answerAction: (id, b, ch, o) => flow.answerActionOfferDetailed(id, b, ch, o),
      answerDeploy: async () => ({ status: "missing" }),
    },
    writeSpec: {
      getProject: registry,
      pendingActionFor: (project) => actions.listPending(T0).find((o) => o.project === project),
      createOffer: (a) => flow.offerActionFromSession(a),
    },
  }, db);
  const url = (code: string, name = "tokyo") => `/projects/${name}/recommendations/${code}/write-spec`;
  return { ...app, actions, flow, edits, runs, url, expected: expectedCards(entry, recs) };
}

test("a pending card holding spec2 is taken once; its offerId and runId come back and the card is edited", async () => {
  const s = await setup();
  const card = s.expected[0];
  const spec2 = card.buttons.find((b) => b.id === "spec2")!;
  const made = await s.flow.offerAction(P("tokyo"), { project: "tokyo", title: card.title, body: card.body, buttons: card.buttons, from: card.from }) as any;
  const r = await s.post(s.url("R2"));
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ["offerId", "runId"]);
  assert.equal(r.json.offerId, made.id);
  assert.match(r.json.runId, /^[0-9a-f]{8}$/);
  assert.match(s.edits.at(-1).text, /Answered on app: Write spec R2/);
  assert.equal(s.runs.length, 1);
  assert.equal(s.runs[0].prompt, spec2.prompt);
  assert.equal(s.runs[0].runId, r.json.runId);
  assert.equal(s.runs[0].noDeployOffer, true);
  const row = s.store.getRun(r.json.runId)!;
  assert.equal(row.project, "tokyo");
  assert.equal(row.status, "queued");
  assert.equal(row.offerId, made.id);
  assert.equal(row.host, "server");
  assert.equal(s.actions.get(made.id, T0)!.answeredButton, "spec2");
  await s.close();
});

test("the run prompt names only R2, forbids plan, tasks and code, and ends with the approval card", async () => {
  const s = await setup();
  const r = await s.post(s.url("R2"));
  assert.equal(r.status, 200);
  const prompt: string = s.runs[0].prompt;
  assert.match(prompt, /R2: Rec 2/);
  assert.doesNotMatch(prompt, /\bR1\b|\bR3\b|Rec 1|Rec 3/);
  assert.match(prompt, /no plan, no tasks, no code/);
  assert.match(prompt, /tokyo-offer ask tokyo "Plan and implement spec R2\?"/);
  await s.close();
});

test("no pending offer: a one-button offer from control-app is created and taken, the prompt equals the card's", async () => {
  const s = await setup();
  assert.equal(s.actions.list(T0).length, 0);
  const r = await s.post(s.url("R3"));
  assert.equal(r.status, 200);
  const o = s.actions.get(r.json.offerId, T0)!;
  assert.equal(o.from, "control-app");
  assert.deepEqual(o.buttons.map((b) => b.id), ["spec3"]);
  assert.equal(o.state, "answered");
  assert.equal(o.channel, "app");
  assert.equal(s.runs[0].prompt, s.expected[0].buttons.find((b) => b.id === "spec3")!.prompt);
  assert.equal(s.store.getRun(r.json.runId)!.offerId, o.id);
  assert.match(s.edits.at(-1).text, /Answered on app/);
  await s.close();
});

test("customer and Mac projects: 403 report_only, no offer and no run row", async () => {
  for (const entry of [{ ...tokyo, customer: true }, { ...tokyo, host: "mac" }, { ...tokyo, report_only: true }]) {
    const s = await setup(entry);
    const r = await s.post(s.url("R1"));
    assert.equal(r.status, 403, JSON.stringify(entry));
    assert.equal(r.json.error.code, "report_only");
    assert.equal(s.actions.list(T0).length, 0);
    assert.equal(s.store.listRuns({}).length, 0);
    assert.equal(s.runs.length, 0);
    await s.close();
  }
});

test("a code outside the latest top 3, a malformed code or an unknown project is 404; a bad name is 400", async () => {
  const s = await setup();
  for (const code of ["R4", "R0", "R9", "r1", "X1"]) assert.equal((await s.post(s.url(code))).status, 404, code);
  assert.equal((await s.post(s.url("R1", "nope"))).status, 404);
  assert.equal((await s.post(s.url("R1", "..%2Fx"))).status, 400);
  assert.equal(s.actions.list(T0).length, 0);
  assert.equal(s.store.listRuns({}).length, 0);
  await s.close();
});

test("a second call while the run is queued or running, or the card already answered, is a flat 409", async () => {
  const s = await setup();
  const first = await s.post(s.url("R2"));
  assert.equal(first.status, 200);
  const again = await s.post(s.url("R2"));
  assert.equal(again.status, 409);
  assert.equal(again.json.error, "already");
  assert.equal(typeof again.json.answeredBy.at, "string");
  assert.equal(s.runs.length, 1);
  assert.equal(s.store.listRuns({}).length, 1);
  // another recommendation is independent
  assert.equal((await s.post(s.url("R1"))).status, 200);
  // once the run has finished the recommendation can be written again
  s.store.updateRun(first.json.runId, { status: "succeeded", endedAt: T0 });
  assert.equal((await s.post(s.url("R2"))).status, 200);
  await s.close();
});

test("a pending card answered on Telegram in the meantime gives 409 with that channel", async () => {
  const s = await setup();
  const card = s.expected[0];
  const made = await s.flow.offerAction(P("tokyo"), { project: "tokyo", title: card.title, body: card.body, buttons: card.buttons, from: card.from }) as any;
  const orig = s.actions.listPending.bind(s.actions);
  // the route sees the card as pending, then Telegram wins the race
  (s.actions as any).listPending = (n: number) => { const l = orig(n); void s.flow.answerActionOffer(made.id, "skip", "telegram"); return l; };
  const r = await s.post(s.url("R2"));
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "already");
  assert.equal(r.json.answeredBy.channel, "telegram");
  assert.equal(s.store.listRuns({}).length, 0, "no run row is left behind");
  await s.close();
});

test("401 without a token", async () => {
  const s = await setup();
  const r = await s.srv.call("POST", "/control-api/v1" + s.url("R1"), {});
  assert.equal(r.status, 401);
  await s.close();
});
