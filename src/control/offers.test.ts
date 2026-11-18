import { test } from "node:test";
import assert from "node:assert/strict";
import { ActionOffers } from "../action-offers";
import { DeployOffers } from "../deploy-offers";
import { createActionOfferFlow } from "../action-offer-flow";
import type { ProjectRef } from "../project-registry";
import { controlApp } from "./test-app";

const T0 = Date.parse("2026-10-09T09:00:00Z");
const P = (name: string) => ({ name, location: "server", path: `/root/${name}` }) as unknown as ProjectRef;
const ID = (n: number) => n.toString(16).padStart(8, "0");

async function setup() {
  let t = T0;
  let ids = 0;
  const edits: any[] = [];
  const runs: any[] = [];
  const bot: any = {
    api: {
      sendMessage: async () => ({ message_id: 7 }),
      editMessageText: async (_c: number, mid: number, text: string) => { edits.push({ mid, text }); return true; },
    },
  };
  const actions = new ActionOffers({ newId: () => ID(++ids) });
  const deploys = new DeployOffers();
  const deployRuns: any[] = [];
  const flow = createActionOfferFlow({
    offers: actions, getBot: () => bot, chatId: 42, now: () => t,
    getProject: (n) => (["tokyo", "godhome"].includes(n) ? P(n) : undefined),
    startRun: async (r) => { runs.push(r); },
  });
  const app = await controlApp({
    offers: {
      now: () => t,
      listActions: () => actions.list(t),
      listDeploys: () => deploys.list(t),
      answerAction: (id, b, ch, o) => flow.answerActionOfferDetailed(id, b, ch, o),
      answerDeploy: async (id, a, ch) => {
        const r = deploys.take(id, a, ch, t);
        if (r.status === "missing") return { status: "missing" };
        if (r.status === "already") return { status: "already", offer: r.offer };
        deployRuns.push({ id, a });
        return { status: "applied", offer: r.offer, reply: a === "deploy" ? "Deploying…" : "Not deploying." };
      },
    },
  });
  const card = (project: string, title: string, over: any = {}) =>
    flow.offerAction(P(project), { project, title, body: `body of ${title}`, from: "finish-apps-2026-10-09", buttons: [
      { id: "run", label: "Run next step", prompt: "do it" }, { id: "report", label: "Report only", prompt: "report" }, { id: "skip", label: "Skip" },
    ], ...over });
  return { ...app, actions, deploys, flow, edits, runs, deployRuns, advance: (ms: number) => (t += ms), card, now: () => t };
}

test("merged list of action and deploy offers, newest first, with kind and the deploy buttons", async () => {
  const s = await setup();
  await s.card("tokyo", "Tokyo is 3/4");
  s.advance(1000);
  const d = s.deploys.create({ project: P("godhome"), chatId: 42, now: s.now(), summary: "shipped x", from: "claude" });
  s.advance(1000);
  await s.card("godhome", "Godhome is 1/4");
  const r = await s.get("/offers");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.offers.map((o: any) => [o.kind, o.project]), [["action", "godhome"], ["deploy", "godhome"], ["action", "tokyo"]]);
  assert.equal(r.json.next, null);
  const dep = r.json.offers.find((o: any) => o.kind === "deploy");
  assert.equal(dep.id, d.id);
  assert.deepEqual(dep.buttons, [{ id: "deploy", label: "Deploy" }, { id: "skip", label: "Not now" }]);
  assert.equal(dep.state, "pending");
  assert.equal(dep.channel, null);
  assert.match(dep.body, /Deploy it\?/);
  const act = r.json.offers[0];
  assert.deepEqual(act.buttons.map((b: any) => b.id), ["run", "report", "skip"]);
  assert.equal(act.from, "finish-apps-2026-10-09");
  assert.equal(act.missionId, null);
  assert.deepEqual(Object.keys(act.buttons[0]).sort(), ["id", "label"]);
  await s.close();
});

test("state filter and the state mapping: skip is declined, other buttons approved, superseded is expired", async () => {
  const s = await setup();
  const a = await s.card("tokyo", "A") as any;
  s.advance(10);
  const b = await s.card("godhome", "B") as any;
  s.advance(10);
  const c = await s.card("godhome", "C") as any; // supersedes B
  s.advance(10);
  const d = await s.card("tokyo", "D") as any; // supersedes A
  assert.equal((await s.post(`/offers/${d.id}/answer`, { button: "skip" })).status, 200);
  const e = await s.card("tokyo", "E") as any;
  assert.equal((await s.post(`/offers/${e.id}/answer`, { button: "report" })).status, 200);
  const by = async (state: string) => (await s.get(`/offers?state=${state}`)).json.offers.map((o: any) => o.title).sort();
  assert.deepEqual(await by("pending"), ["C"]);
  assert.deepEqual(await by("declined"), ["D"]);
  assert.deepEqual(await by("approved"), ["E"]);
  assert.deepEqual(await by("expired"), ["A", "B"]);
  assert.deepEqual(await by("all"), ["A", "B", "C", "D", "E"]);
  assert.equal((await s.get("/offers")).json.offers.length, 1, "default is pending");
  assert.equal((await s.get("/offers?state=bogus")).status, 400);
  assert.ok(a && b && c);
  await s.close();
});

test("answer maps the button to take(): 200 once, then 409 flat already with the first channel", async () => {
  const s = await setup();
  const o = await s.card("tokyo", "Tokyo") as any;
  const r = await s.post(`/offers/${o.id}/answer`, { button: "run" });
  assert.equal(r.status, 200);
  assert.equal(r.json.offer.state, "approved");
  assert.equal(r.json.offer.answeredButton, "run");
  assert.equal(r.json.offer.channel, "app");
  assert.match(r.json.reply, /Running/);
  assert.equal(s.runs.length, 1);
  assert.equal(s.runs[0].prompt, "do it");
  assert.match(s.edits.at(-1).text, /Answered on app: Run next step/);
  const again = await s.post(`/offers/${o.id}/answer`, { button: "skip" });
  assert.equal(again.status, 409);
  assert.deepEqual(again.json, { error: "already", answeredBy: { channel: "app", at: new Date(T0).toISOString() } });
  assert.equal("result" in again.json, false);
  assert.equal(s.runs.length, 1);
  await s.close();
});

test("an offer answered on Telegram first gives 409 with channel telegram; the terminal status shows the app answer", async () => {
  const s = await setup();
  const o = await s.card("tokyo", "Tokyo") as any;
  await s.flow.answerActionOffer(o.id, "skip", "telegram");
  const r = await s.post(`/offers/${o.id}/answer`, { button: "run" });
  assert.equal(r.status, 409);
  assert.equal(r.json.answeredBy.channel, "telegram");
  const o2 = await s.card("tokyo", "Second") as any;
  await s.post(`/offers/${o2.id}/answer`, { button: "report" });
  assert.deepEqual(s.flow.actionOfferStatus(o2.id), { state: "answered", project: "tokyo", title: "Second", answeredButton: "report", channel: "app" });
  await s.close();
});

test("concurrent double answer: one 200, one 409", async () => {
  const s = await setup();
  const o = await s.card("tokyo", "Tokyo") as any;
  const [x, y] = await Promise.all([s.post(`/offers/${o.id}/answer`, { button: "run" }), s.post(`/offers/${o.id}/answer`, { button: "run" })]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  assert.equal(s.runs.length, 1);
  await s.close();
});

test("deploy offer: deploy and skip go through take(); second answer is 409; unknown button 400; unknown id 404", async () => {
  const s = await setup();
  const d = s.deploys.create({ project: P("tokyo"), chatId: 42, now: s.now(), summary: "x" });
  const bad = await s.post(`/offers/${d.id}/answer`, { button: "run" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "bad_request");
  const ok = await s.post(`/offers/${d.id}/answer`, { button: "deploy" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.offer.kind, "deploy");
  assert.equal(ok.json.offer.state, "approved");
  assert.equal(ok.json.offer.answeredButton, "deploy");
  assert.equal(ok.json.offer.channel, "app");
  assert.deepEqual(s.deployRuns, [{ id: d.id, a: "deploy" }]);
  const again = await s.post(`/offers/${d.id}/answer`, { button: "skip" });
  assert.equal(again.status, 409);
  assert.equal(again.json.answeredBy.channel, "app");
  const d2 = s.deploys.create({ project: P("tokyo"), chatId: 42, now: s.now() });
  const sk = await s.post(`/offers/${d2.id}/answer`, { button: "skip" });
  assert.equal(sk.json.offer.state, "declined");

  const o = await s.card("tokyo", "A") as any;
  assert.equal((await s.post(`/offers/${o.id}/answer`, { button: "nope" })).status, 400);
  assert.equal((await s.post(`/offers/${o.id}/answer`, {})).status, 400);
  assert.equal((await s.post(`/offers/${ID(999)}/answer`, { button: "run" })).status, 404);
  assert.equal((await s.post(`/offers/..%2Fx/answer`, { button: "run" })).status, 404);
  await s.close();
});

test("DeployOffers.listPending returns open offers only, newest first", () => {
  const d = new DeployOffers();
  const a = d.create({ project: P("tokyo"), chatId: 1, now: T0 });
  const b = d.create({ project: P("tokyo"), chatId: 2, now: T0 + 5 });
  d.take(a.id, "skip", "app", T0 + 6);
  assert.deepEqual(d.listPending(T0 + 7).map((o) => o.id), [b.id]);
  assert.deepEqual(d.list(T0 + 7).map((o) => o.id), [b.id, a.id]);
});

test("T3.1: a deploy offer with a linked run shows runId; an offer without one has no runId key", async () => {
  const s = await setup();
  const linked = s.deploys.create({ project: P("godhome"), chatId: 42, now: s.now(), summary: "a" });
  s.advance(1000);
  const plain = s.deploys.create({ project: P("tokyo"), chatId: 42, now: s.now(), summary: "b" });
  s.deploys.setRunId(linked.id, "0a1b2c3d");
  const r = await s.get("/offers");
  const byId = (id: string) => r.json.offers.find((o: any) => o.id === id);
  assert.equal(byId(linked.id).runId, "0a1b2c3d");
  assert.equal("runId" in byId(plain.id), false);
  assert.equal(r.json.offers.filter((o: any) => o.kind === "action").every((o: any) => !("runId" in o)), true);
});
