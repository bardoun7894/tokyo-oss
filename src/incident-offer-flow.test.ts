import { test } from "node:test";
import assert from "node:assert/strict";
import { ActionOffers, validateSignal, type OfferSignal } from "./action-offers";
import { createActionOfferFlow, INCIDENT_BUTTONS } from "./action-offer-flow";
const T0 = Date.parse("2026-10-12T09:00:00Z");
const CHAT = 42;
const INC = { incidentId: "inc-2026-10-12-abc", app: "godhome", title: "godhome: 500s on /checkout", summary: "Null cart on checkout.", risk: "medium" as const };

function setup(opts: { failTimes?: number } = {}) {
  let t = T0;
  let ids = 0;
  let failLeft = opts.failTimes ?? 0;
  const sent: any[] = [];
  const edits: any[] = [];
  const runs: any[] = [];
  const signals: { namespace: string; workflowId: string; signalName: string }[] = [];
  const sleeps: number[] = [];
  const bot: any = {
    api: {
      sendMessage: async (chatId: number, text: string, o?: any) => { sent.push({ chatId, text, markup: o?.reply_markup?.inline_keyboard }); return { message_id: 100 + sent.length }; },
      editMessageText: async (chatId: number, messageId: number, text: string) => { edits.push({ chatId, messageId, text }); return true; },
    },
  };
  const offers = new ActionOffers({ newId: () => (++ids).toString(16).padStart(8, "0") });
  const flow = createActionOfferFlow({
    offers, getBot: () => bot, chatId: CHAT, now: () => t,
    getProject: () => undefined,
    startRun: async (r) => { runs.push(r); },
    sendSignal: async (s) => {
      if (failLeft > 0) { failLeft--; throw new Error("temporal unreachable"); }
      signals.push(s);
    },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  return { flow, offers, sent, edits, runs, signals, sleeps, advance: (ms: number) => (t += ms) };
}

test("validateSignal accepts a well formed signal and rejects others", () => {
  const ok: OfferSignal = { namespace: "oncall", workflowId: "inc-1", map: { approve: "approve", decline: "decline" } };
  assert.deepEqual(validateSignal(ok, ["approve", "decline"]), ok);
  assert.throws(() => validateSignal({ ...ok, namespace: "bad ns" }, ["approve", "decline"]), /namespace/);
  assert.throws(() => validateSignal({ ...ok, workflowId: "" }, ["approve", "decline"]), /workflowId/);
  assert.throws(() => validateSignal({ ...ok, map: { nope: "approve" } }, ["approve", "decline"]), /button/);
  assert.throws(() => validateSignal({ ...ok, map: { approve: "bad name!" } }, ["approve", "decline"]), /signal name/);
  assert.throws(() => validateSignal({ ...ok, map: {} }, ["approve", "decline"]), /map/);
});

test("signal offers neither supersede nor are superseded", () => {
  const s = new ActionOffers();
  const sig: OfferSignal = { namespace: "oncall", workflowId: "a", map: { approve: "approve" } };
  const a = s.create({ project: "godhome", chatId: 1, title: "t", body: "", now: T0, buttons: INCIDENT_BUTTONS.map((b) => ({ ...b })), signal: sig }).offer;
  const plain = s.create({ project: "godhome", chatId: 1, title: "p", body: "", now: T0 + 1 });
  assert.deepEqual(plain.superseded, []);
  const b = s.create({ project: "godhome", chatId: 1, title: "t2", body: "", now: T0 + 2, buttons: INCIDENT_BUTTONS.map((x) => ({ ...x })), signal: { ...sig, workflowId: "b" } });
  assert.deepEqual(b.superseded, [], "a signal offer supersedes nothing");
  assert.equal(s.get(a.id, T0 + 3)!.state, "pending");
  assert.equal(s.get(plain.offer.id, T0 + 3)!.state, "pending");
  const plain2 = s.create({ project: "godhome", chatId: 1, title: "p2", body: "", now: T0 + 4 });
  assert.deepEqual(plain2.superseded.map((o) => o.id), [plain.offer.id], "plain cards still supersede plain cards only");
  assert.equal(s.get(b.offer.id, T0 + 5)!.state, "pending");
});

test("listPendingCards leaves incident cards out of the project's own card lookup", () => {
  const s = new ActionOffers();
  const sig: OfferSignal = { namespace: "oncall", workflowId: "a", map: { approve: "approve" } };
  s.create({ project: "godhome", chatId: 1, title: "inc", body: "", now: T0, buttons: INCIDENT_BUTTONS.map((b) => ({ ...b })), signal: sig });
  assert.deepEqual(s.listPendingCards(T0), []);
  const plain = s.create({ project: "godhome", chatId: 1, title: "p", body: "", now: T0 + 1 }).offer;
  assert.deepEqual(s.listPendingCards(T0 + 2).map((o) => o.id), [plain.id]);
  assert.equal(s.listPending(T0 + 2).length, 2);
});

test("the card carries title, summary, risk, branch and diff stat and has Deploy fix / Not now", async () => {
  const { flow, sent } = setup();
  const long = "x".repeat(900);
  const r = await flow.offerIncident({ ...INC, summary: long, branch: "fix/checkout-null-cart", diffStat: " src/cart.ts | 4 ++--\n 1 file changed", from: "oncall" });
  assert.deepEqual(r, { ok: true, id: "00000001", existing: false });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, CHAT);
  const text: string = sent[0].text;
  assert.match(text, /^godhome: 500s on \/checkout\n\n/);
  assert.match(text, /Risk: medium/);
  assert.match(text, /Branch: fix\/checkout-null-cart/);
  assert.match(text, /src\/cart\.ts \| 4 \+\+--/);
  assert.match(text, /Incident: inc-2026-10-12-abc/);
  assert.ok(text.includes("x".repeat(600)) && !text.includes("x".repeat(601)), "summary cut to 600 chars");
  assert.deepEqual(sent[0].markup.map((row: any[]) => row.map((b) => [b.text, b.callback_data])), [
    [["Deploy fix", "act:00000001:approve"], ["Not now", "act:00000001:decline"]],
  ]);
});

test("POSTing the same incident twice returns the existing offer and posts one card", async () => {
  const { flow, sent, offers } = setup();
  const a = await flow.offerIncident(INC);
  const b = await flow.offerIncident({ ...INC, title: "other title" });
  assert.deepEqual(a, { ok: true, id: "00000001", existing: false });
  assert.deepEqual(b, { ok: true, id: "00000001", existing: true });
  assert.equal(sent.length, 1);
  assert.equal(offers.list(T0).length, 1);
  // once answered, the same incident still maps to that offer (the poller reads the answer)
  await flow.answerActionOfferDetailed("00000001", "approve", "telegram");
  assert.deepEqual(await flow.offerIncident(INC), { ok: true, id: "00000001", existing: true });
});

test("input validation", async () => {
  const { flow, sent } = setup();
  const bad = async (over: any, re: RegExp) => {
    const r = await flow.offerIncident({ ...INC, ...over });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.error : "", re);
  };
  await bad({ incidentId: "has space" }, /incidentId/);
  await bad({ incidentId: "" }, /incidentId/);
  await bad({ incidentId: "a".repeat(121) }, /incidentId/);
  await bad({ incidentId: "a/b" }, /incidentId/);
  await bad({ risk: "extreme" }, /risk/);
  await bad({ risk: undefined }, /risk/);
  await bad({ app: "" }, /app/);
  await bad({ title: "" }, /title/);
  assert.equal(sent.length, 0);
  const ok = await flow.offerIncident({ ...INC, incidentId: "a".repeat(120) });
  assert.equal(ok.ok, true);
});

test("approve sends the approve signal exactly once and starts no run", async () => {
  const { flow, signals, runs, edits } = setup();
  await flow.offerIncident(INC);
  const reply = await flow.answerActionOffer("00000001", "approve", "telegram");
  assert.deepEqual(signals, [{ namespace: "oncall", workflowId: INC.incidentId, signalName: "approve" }]);
  assert.match(reply, /Deploy fix/);
  assert.match(reply, /signal/i);
  assert.equal(runs.length, 0);
  assert.match(edits.at(-1).text, /Answered on telegram: Deploy fix/);
});

test("decline sends the decline signal", async () => {
  const { flow, signals } = setup();
  await flow.offerIncident(INC);
  await flow.answerActionOffer("00000001", "decline", "terminal");
  assert.deepEqual(signals.map((s) => s.signalName), ["decline"]);
});

test("answering through the Control API path (channel app, detailed) sends one signal", async () => {
  const { flow, signals } = setup();
  await flow.offerIncident(INC);
  const r = await flow.answerActionOfferDetailed("00000001", "approve", "app");
  assert.equal(r.status, "applied");
  assert.equal(signals.length, 1);
  const again = await flow.answerActionOfferDetailed("00000001", "approve", "app");
  assert.equal(again.status, "already");
  assert.equal(signals.length, 1);
});

test("a second answer from another channel reports the first and sends no second signal", async () => {
  const { flow, signals } = setup();
  await flow.offerIncident(INC);
  await flow.answerActionOffer("00000001", "approve", "telegram");
  const again = await flow.answerActionOffer("00000001", "decline", "app");
  assert.match(again, /already answered on telegram/);
  assert.equal(signals.length, 1);
});

test("concurrent double answer sends one signal", async () => {
  const { flow, signals } = setup();
  await flow.offerIncident(INC);
  await Promise.all([flow.answerActionOffer("00000001", "approve", "telegram"), flow.answerActionOffer("00000001", "approve", "app")]);
  assert.equal(signals.length, 1);
});

test("a failed signal is retried once after 5 s and then succeeds quietly", async () => {
  const { flow, signals, sent, sleeps } = setup({ failTimes: 1 });
  await flow.offerIncident(INC);
  const reply = await flow.answerActionOffer("00000001", "approve", "telegram");
  assert.match(reply, /retry/i);
  await flow.settled();
  assert.deepEqual(sleeps, [5000]);
  assert.equal(signals.length, 1);
  assert.equal(sent.length, 1, "only the card, no failure message");
});

test("signal failing twice tells the owner how to answer by hand and keeps the offer answered", async () => {
  const { flow, signals, sent, sleeps, offers } = setup({ failTimes: 2 });
  await flow.offerIncident(INC);
  await flow.answerActionOffer("00000001", "approve", "telegram");
  await flow.settled();
  assert.deepEqual(sleeps, [5000]);
  assert.equal(signals.length, 0);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].chatId, CHAT);
  assert.match(sent[1].text, /signal failed, answer with: oncall approve\|decline inc-2026-10-12-abc/);
  assert.equal(offers.get("00000001", T0)!.state, "answered", "never re-opened");
  const again = await flow.answerActionOfferDetailed("00000001", "approve", "telegram");
  assert.equal(again.status, "already");
  assert.equal(signals.length, 0);
});

test("incidentOfferStatus reports state and answer for incident offers only", async () => {
  const { flow } = setup();
  await flow.offerIncident(INC);
  assert.deepEqual(flow.incidentOfferStatus("00000001"), { state: "pending" });
  await flow.answerActionOffer("00000001", "decline", "app");
  assert.deepEqual(flow.incidentOfferStatus("00000001"), { state: "answered", answeredButton: "decline", channel: "app" });
  assert.equal(flow.incidentOfferStatus("deadbeef"), null);
  const plain = await flow.offerActionFromSession({ project: "x", title: "t", body: "" });
  assert.equal(plain.ok, false, "unknown project in this setup");
});

test("without a Telegram bot the incident offer is refused", async () => {
  const offers = new ActionOffers();
  const flow = createActionOfferFlow({ offers, getBot: () => null, chatId: CHAT, now: () => T0, getProject: () => undefined, startRun: async () => {} });
  const r = await flow.offerIncident(INC);
  assert.equal(r.ok === false && r.kind, "unavailable");
  assert.equal(offers.list(T0).length, 0);
});
