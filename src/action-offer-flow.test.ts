import { test } from "node:test";
import assert from "node:assert/strict";
import { ActionOffers } from "./action-offers";
import { createActionOfferFlow } from "./action-offer-flow";
import type { ProjectRef } from "./project-registry";

const T0 = Date.parse("2026-10-09T09:00:00Z");
const P = (name: string) => ({ name, location: "server", path: `/root/${name}` }) as unknown as ProjectRef;
const CHAT = 42;

function setup(opts: { editFails?: boolean } = {}) {
  let t = T0;
  let mid = 100;
  let ids = 0;
  const sent: any[] = [];
  const edits: any[] = [];
  const runs: any[] = [];
  const bot: any = {
    api: {
      sendMessage: async (chatId: number, text: string, o?: any) => {
        sent.push({ chatId, text, markup: o?.reply_markup?.inline_keyboard });
        return { message_id: ++mid };
      },
      editMessageText: async (chatId: number, messageId: number, text: string, o?: any) => {
        edits.push({ chatId, messageId, text, markup: o?.reply_markup?.inline_keyboard });
        if (opts.editFails) throw new Error("message to edit not found");
        return true;
      },
    },
  };
  const offers = new ActionOffers({ newId: () => (++ids).toString(16).padStart(8, "0") });
  const flow = createActionOfferFlow({
    offers,
    getBot: () => bot,
    chatId: CHAT,
    now: () => t,
    getProject: (n) => (["tokyo", "godhome"].includes(n) ? P(n) : undefined),
    startRun: async (r) => { runs.push(r); },
  });
  return { flow, sent, edits, runs, offers, advance: (ms: number) => (t += ms) };
}

test("the card is posted once with its buttons two per row and act:<id>:<button> data", async () => {
  const { flow, sent } = setup();
  const r = await flow.offerActionFromSession({ project: "tokyo", title: "Tokyo is 3/4", body: "fix defects" });
  assert.deepEqual(r, { ok: true, id: "00000001", project: "tokyo" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, CHAT);
  assert.match(sent[0].text, /Tokyo is 3\/4\n\nfix defects/);
  const kb = sent[0].markup;
  assert.deepEqual(kb.map((row: any[]) => row.map((b) => b.callback_data)), [
    ["act:00000001:run", "act:00000001:report"],
    ["act:00000001:skip"],
  ]);
  assert.deepEqual(kb[0].map((b: any) => b.text), ["Run next step", "Report only"]);
});

test("unknown project and invalid buttons are reported, nothing is posted", async () => {
  const { flow, sent } = setup();
  assert.deepEqual(
    await flow.offerActionFromSession({ project: "nope", title: "t", body: "" }),
    { ok: false, kind: "unknown_project", error: 'unknown project "nope"' },
  );
  const bad = await flow.offerActionFromSession({ project: "tokyo", title: "t", body: "", buttons: [] });
  assert.equal(bad.ok === false && bad.kind, "invalid");
  assert.equal(sent.length, 0);
});

test("a second offer for the project edits the old card to superseded", async () => {
  const { flow, sent, edits, offers, advance } = setup();
  const a = await flow.offerActionFromSession({ project: "tokyo", title: "first", body: "" });
  advance(1000);
  const b = await flow.offerActionFromSession({ project: "tokyo", title: "second", body: "" });
  assert.equal(sent.length, 2);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].messageId, 101, "the first card's message");
  assert.match(edits[0].text, /superseded/i);
  assert.deepEqual(edits[0].markup, [], "buttons removed");
  assert.equal(offers.get(a.ok ? a.id : "", T0 + 2000)!.state, "superseded");
  assert.match(await flow.answerActionOffer(a.ok ? a.id : "", "run", "telegram"), /superseded|already/i);
  assert.equal(b.ok, true);
});

test("an answer with a prompt starts exactly one run with noDeployOffer", async () => {
  const { flow, runs, edits } = setup();
  const o = await flow.offerActionFromSession({ project: "tokyo", title: "Tokyo", body: "b" });
  const id = o.ok ? o.id : "";
  const reply = await flow.answerActionOffer(id, "run", "telegram");
  assert.match(reply, /Running/);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].project.name, "tokyo");
  assert.equal(runs[0].noDeployOffer, true);
  assert.equal(runs[0].chatId, CHAT);
  assert.ok(runs[0].prompt.length > 10);
  assert.match(edits.at(-1).text, /Answered on telegram: Run next step/);
  assert.deepEqual(edits.at(-1).markup, []);
  // the second press (any channel) runs nothing
  const again = await flow.answerActionOffer(id, "run", "app");
  assert.match(again, /already answered on telegram/);
  assert.equal(runs.length, 1);
});

test("an answer without a prompt starts no run", async () => {
  const { flow, runs } = setup();
  const o = await flow.offerActionFromSession({ project: "tokyo", title: "Tokyo", body: "" });
  const reply = await flow.answerActionOffer(o.ok ? o.id : "", "skip", "telegram");
  assert.match(reply, /Skip/);
  assert.equal(runs.length, 0);
});

test("an answer from the terminal edits the card", async () => {
  const { flow, edits } = setup();
  const o = await flow.offerActionFromSession({ project: "godhome", title: "GodHome", body: "" });
  await flow.answerActionOffer(o.ok ? o.id : "", "report", "terminal");
  assert.match(edits.at(-1).text, /Answered on terminal: Report only/);
});

test("missing, badbutton and already replies", async () => {
  const { flow, runs } = setup();
  assert.match(await flow.answerActionOffer("deadbeef", "run", "telegram"), /No open offer deadbeef/);
  const o = await flow.offerActionFromSession({ project: "tokyo", title: "t", body: "" });
  const id = o.ok ? o.id : "";
  assert.match(await flow.answerActionOffer(id, "nope", "telegram"), /no button "nope"/);
  assert.equal(runs.length, 0);
  assert.equal(flow.actionOfferStatus(id)!.state, "pending", "a bad button leaves the card open");
});

test("a Telegram edit failure is swallowed and the run still starts", async () => {
  const { flow, runs } = setup({ editFails: true });
  const o = await flow.offerActionFromSession({ project: "tokyo", title: "t", body: "" });
  const reply = await flow.answerActionOffer(o.ok ? o.id : "", "run", "app");
  assert.match(reply, /Running/);
  assert.equal(runs.length, 1);
});

test("actionOfferStatus reports state, project, title, answer", async () => {
  const { flow } = setup();
  const o = await flow.offerActionFromSession({ project: "tokyo", title: "Tokyo is 3/4", body: "" });
  const id = o.ok ? o.id : "";
  assert.deepEqual(flow.actionOfferStatus(id), { state: "pending", project: "tokyo", title: "Tokyo is 3/4" });
  await flow.answerActionOffer(id, "skip", "terminal");
  assert.deepEqual(flow.actionOfferStatus(id), {
    state: "answered", project: "tokyo", title: "Tokyo is 3/4", answeredButton: "skip", channel: "terminal",
  });
  assert.equal(flow.actionOfferStatus("deadbeef"), null);
});

test("no bot yet: offering reports unavailable", async () => {
  const flow = createActionOfferFlow({
    offers: new ActionOffers(), getBot: () => null, chatId: CHAT, now: () => T0,
    getProject: () => P("tokyo"), startRun: async () => {},
  });
  const r = await flow.offerActionFromSession({ project: "tokyo", title: "t", body: "" });
  assert.equal(r.ok === false && r.kind, "unavailable");
});
