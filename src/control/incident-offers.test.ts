import { test } from "node:test";
import assert from "node:assert/strict";
import { ActionOffers } from "../action-offers";
import { DeployOffers } from "../deploy-offers";
import { createActionOfferFlow } from "../action-offer-flow";
import { controlApp } from "./test-app";

const T0 = Date.parse("2026-10-12T09:00:00Z");
const INC = { incidentId: "inc-7", app: "godhome", title: "godhome: 500s", summary: "Null cart.", risk: "high" as const };

async function setup() {
  let ids = 0;
  const signals: any[] = [];
  const bot: any = { api: { sendMessage: async () => ({ message_id: 7 }), editMessageText: async () => true } };
  const actions = new ActionOffers({ newId: () => (++ids).toString(16).padStart(8, "0") });
  const flow = createActionOfferFlow({
    offers: actions, getBot: () => bot, chatId: 42, now: () => T0, getProject: () => undefined,
    startRun: async () => { throw new Error("an incident answer must not start a run"); },
    sendSignal: async (s) => { signals.push(s); },
  });
  const app = await controlApp({
    offers: {
      now: () => T0,
      listActions: () => actions.list(T0),
      listDeploys: () => new DeployOffers().list(T0),
      answerAction: (id, b, ch, o) => flow.answerActionOfferDetailed(id, b, ch, o),
      answerDeploy: async () => ({ status: "missing" }),
    },
  });
  return { ...app, flow, signals };
}

test("incident offer shows in GET /offers as kind action with Deploy fix / Not now and no prompt text", async () => {
  const s = await setup();
  await s.flow.offerIncident(INC);
  const list = await s.get("/offers");
  assert.equal(list.status, 200);
  const o = list.json.offers[0];
  assert.equal(o.kind, "action");
  assert.equal(o.project, "godhome");
  assert.deepEqual(o.buttons, [{ id: "approve", label: "Deploy fix" }, { id: "decline", label: "Not now" }]);
  assert.match(o.body, /Risk: high/);
  await s.close();
});

test("Control API answer approve sends one signal, state approved, second answer is 409", async () => {
  const s = await setup();
  await s.flow.offerIncident(INC);
  const ok = await s.post("/offers/00000001/answer", { button: "approve" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.offer.state, "approved");
  assert.equal(ok.json.offer.channel, "app");
  assert.deepEqual(s.signals, [{ namespace: "oncall", workflowId: "inc-7", signalName: "approve" }]);
  const again = await s.post("/offers/00000001/answer", { button: "decline" });
  assert.equal(again.status, 409);
  assert.equal(s.signals.length, 1);
  await s.close();
});

test("Control API decline reads as declined and sends the decline signal", async () => {
  const s = await setup();
  await s.flow.offerIncident(INC);
  const r = await s.post("/offers/00000001/answer", { button: "decline" });
  assert.equal(r.json.offer.state, "declined");
  assert.deepEqual(s.signals.map((x) => x.signalName), ["decline"]);
  await s.close();
});
