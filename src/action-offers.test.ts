import { test } from "node:test";
import assert from "node:assert/strict";
import { ActionOffers, ACTION_OFFER_TTL_MS, DEFAULT_BUTTONS, type OfferButton } from "./action-offers";

const NOW = Date.parse("2026-10-09T09:00:00Z");
const btn = (id: string): OfferButton => ({ id, label: id.toUpperCase() });
const base = { project: "tokyo", chatId: 1, title: "Tokyo is 3/4", body: "fix defects", now: NOW };

function seq() {
  let n = 0;
  return () => (++n).toString(16).padStart(8, "0");
}

test("create accepts 1 to 8 valid buttons and rejects 0 or 9", () => {
  const s = new ActionOffers({ newId: seq() });
  const one = s.create({ ...base, buttons: [btn("a")] });
  assert.equal(one.offer.id, "00000001");
  assert.equal(one.offer.state, "pending");
  const eight = Array.from({ length: 8 }, (_, i) => btn(`b${i}`));
  assert.equal(s.create({ ...base, project: "p8", buttons: eight }).offer.buttons.length, 8);
  assert.throws(() => s.create({ ...base, buttons: [] }), /1 to 8 buttons/);
  const nine = Array.from({ length: 9 }, (_, i) => btn(`b${i}`));
  assert.throws(() => s.create({ ...base, buttons: nine }), /1 to 8 buttons/);
});

test("button id, label and prompt limits", () => {
  const s = new ActionOffers();
  const bad = (b: OfferButton, re: RegExp) => assert.throws(() => s.create({ ...base, buttons: [b] }), re);
  bad({ id: "Bad", label: "x" }, /button id/);
  bad({ id: "", label: "x" }, /button id/);
  bad({ id: "a".repeat(17), label: "x" }, /button id/);
  bad({ id: "ok", label: "" }, /label/);
  bad({ id: "ok", label: "x".repeat(33) }, /label/);
  bad({ id: "ok", label: "x", prompt: "p".repeat(8001) }, /prompt/);
  assert.throws(() => s.create({ ...base, buttons: [btn("a"), btn("a")] }), /duplicate/);
  s.create({ ...base, buttons: [{ id: "a_b-1", label: "x".repeat(32), prompt: "p".repeat(8000) }] });
});

test("omitted buttons default to run, report, skip; skip has no prompt", () => {
  const s = new ActionOffers();
  const o = s.create(base).offer;
  assert.deepEqual(o.buttons.map((b) => b.id), ["run", "report", "skip"]);
  assert.deepEqual(DEFAULT_BUTTONS.map((b) => b.id), ["run", "report", "skip"]);
  assert.ok(o.buttons[0].prompt);
  assert.ok(o.buttons[1].prompt);
  assert.equal(o.buttons[2].prompt, undefined);
});

test("take is exactly-once: applied, already, missing, badbutton", () => {
  const s = new ActionOffers();
  const o = s.create(base).offer;
  assert.equal(s.take(o.id, "nope", "telegram", NOW + 1).status, "badbutton");
  assert.equal(s.get(o.id, NOW + 1)!.state, "pending", "a bad button does not consume the offer");
  const first = s.take(o.id, "run", "telegram", NOW + 2);
  assert.equal(first.status, "applied");
  assert.equal(first.status === "applied" && first.button.id, "run");
  const second = s.take(o.id, "skip", "terminal", NOW + 3);
  assert.equal(second.status, "already");
  assert.equal(second.status === "already" && second.offer.channel, "telegram");
  assert.equal(second.status === "already" && second.offer.answeredButton, "run");
  assert.equal(s.take("deadbeef", "run", "telegram", NOW).status, "missing");
  const done = s.get(o.id, NOW + 4)!;
  assert.deepEqual([done.state, done.answeredButton, done.channel, done.answeredAt], ["answered", "run", "telegram", NOW + 2]);
});

test("a new offer supersedes the older pending one of the same project only", () => {
  const s = new ActionOffers({ newId: seq() });
  const a = s.create({ ...base, project: "tokyo" }).offer;
  const other = s.create({ ...base, project: "godhome" }).offer;
  const r = s.create({ ...base, project: "tokyo", now: NOW + 5 });
  assert.deepEqual(r.superseded.map((o) => o.id), [a.id]);
  assert.equal(s.get(a.id, NOW + 6)!.state, "superseded");
  assert.equal(s.get(other.id, NOW + 6)!.state, "pending");
  assert.equal(s.take(a.id, "run", "telegram", NOW + 6).status, "already");
});

test("TTL: expired offers are missing and pruned", () => {
  const s = new ActionOffers();
  const o = s.create(base).offer;
  assert.ok(s.get(o.id, NOW + ACTION_OFFER_TTL_MS));
  assert.equal(s.take(o.id, "run", "telegram", NOW + ACTION_OFFER_TTL_MS + 1).status, "missing");
  assert.equal(s.get(o.id, NOW + ACTION_OFFER_TTL_MS + 1), undefined);
});

test("pendingFor(chatId) and listPending()", () => {
  const s = new ActionOffers({ newId: seq() });
  const a = s.create({ ...base, project: "a", chatId: 1, now: NOW }).offer;
  const b = s.create({ ...base, project: "b", chatId: 1, now: NOW + 10 }).offer;
  const c = s.create({ ...base, project: "c", chatId: 2, now: NOW + 20 }).offer;
  s.take(a.id, "skip", "telegram", NOW + 30);
  assert.deepEqual(s.pendingFor(1, NOW + 31).map((o) => o.id), [b.id]);
  assert.deepEqual(s.listPending(NOW + 31).map((o) => o.id), [c.id, b.id], "newest first");
});
