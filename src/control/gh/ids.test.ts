import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import Database from "better-sqlite3";
import { GhIds, GH_ID } from "./ids";

const NOW = Date.parse("2026-10-17T10:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

test("opaque id: g_ + the first 12 hex of sha256(kind + source id), stable across calls and instances", () => {
  const db = new Database(":memory:");
  const a = new GhIds(db);
  const id = a.opaque("agent", "Sample", NOW);
  assert.equal(id, `g_${sha("agentSample").slice(0, 12)}`);
  assert.match(id, GH_ID);
  assert.equal(a.opaque("agent", "Sample", NOW + 5), id);
  assert.equal(new GhIds(db).opaque("agent", "Sample", NOW + 9), id);
});

test("the same source id under two kinds gets two ids; resolve needs the right kind", () => {
  const ids = new GhIds(new Database(":memory:"));
  const agent = ids.opaque("agent", "x", NOW);
  const term = ids.opaque("terminal", "x", NOW);
  assert.notEqual(agent, term);
  assert.equal(ids.resolve("agent", agent), "x");
  assert.equal(ids.resolve("terminal", agent), null);
  assert.equal(ids.resolve("agent", "g_ffffffffffff"), null);
  assert.equal(ids.resolve("agent", "not an id"), null);
});

test("a prefix already held by another source is rehashed with a salt and keeps the 12-hex shape", () => {
  // The unsalted hash of every source collides; a salted one (`...#n`) is free.
  const ids = new GhIds(new Database(":memory:"), (s) => (s.includes("#") ? sha(s) : "abcdef012345ffff"));
  const one = ids.opaque("agent", "one", NOW);
  const two = ids.opaque("agent", "two", NOW);
  assert.notEqual(one, two);
  assert.match(two, GH_ID);
  assert.equal(ids.resolve("agent", one), "one");
  assert.equal(ids.resolve("agent", two), "two");
});

test("prune drops ids not seen for 30 days and keeps those seen since", () => {
  const db = new Database(":memory:");
  const ids = new GhIds(db);
  const old = ids.opaque("agent", "old", NOW);
  const seen = ids.opaque("agent", "seen", NOW);
  ids.opaque("agent", "seen", NOW + 29 * DAY); // seen again
  assert.equal(ids.prune(NOW + 31 * DAY), 1);
  assert.equal(ids.resolve("agent", old), null);
  assert.equal(ids.resolve("agent", seen), "seen");
});

test("the table is control_gh_ids with the plan columns", () => {
  const db = new Database(":memory:");
  new GhIds(db);
  const cols = (db.prepare("PRAGMA table_info(control_gh_ids)").all() as { name: string }[]).map((c) => c.name);
  for (const c of ["opaque_id", "kind", "source_id", "first_seen"]) assert.ok(cols.includes(c), c);
});
