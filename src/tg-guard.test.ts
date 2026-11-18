import { test } from "node:test";
import assert from "node:assert/strict";
import { isOwnerUpdate } from "./tg-guard";

test("only the configured owner passes, by id, string or number", () => {
  assert.equal(isOwnerUpdate(12345, "12345"), true);
  assert.equal(isOwnerUpdate("12345", "12345 "), true);
  assert.equal(isOwnerUpdate(999, "12345"), false);
});

test("no owner configured, or no sender, refuses everyone", () => {
  assert.equal(isOwnerUpdate(12345, undefined), false);
  assert.equal(isOwnerUpdate(12345, ""), false);
  assert.equal(isOwnerUpdate(undefined, "12345"), false);
});
