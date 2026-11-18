import { test } from "node:test";
import assert from "node:assert/strict";
import { parseApproval, mostRecent } from "./tg-approval";

test("plain yes and no, in the languages the owner actually types", () => {
  for (const t of ["yes", "Yes!", "ok", "OK.", "go ahead", "do it", "👍", "نعم", "واخا", "سير عليه", "اوك", "oui"]) {
    assert.equal(parseApproval(t), "yes", t);
  }
  for (const t of ["no", "Nope", "cancel", "not now", "لا", "ماشي", "non", "❌"]) {
    assert.equal(parseApproval(t), "no", t);
  }
});

test("a sentence is a request, not an answer", () => {
  assert.equal(parseApproval("yes but first check the tests please"), null);
  assert.equal(parseApproval("ok so where is godhome"), null);
  assert.equal(parseApproval(""), null);
  assert.equal(parseApproval("yesterday"), null);
});

test("mostRecent picks the newest open card, or nothing", () => {
  const a = { kind: "run" as const, id: "a", createdAt: 100, project: "up" };
  const b = { kind: "deploy" as const, id: "b", createdAt: 300, project: "tokyo" };
  assert.equal(mostRecent([a, b, null]), b);
  assert.equal(mostRecent([null, undefined]), null);
});
