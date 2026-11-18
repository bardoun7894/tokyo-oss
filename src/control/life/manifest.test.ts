import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import express from "express";
import Database from "better-sqlite3";
import { controlApp } from "../test-app";
import { OpsStore } from "../ops-store";
import type { Cap } from "../store";
import { buildManifest, SECTION_IDS, SECTIONS_OF } from "./manifest";
import { LIFE_ROWS } from "./table";

const WRITES = LIFE_ROWS.filter((r) => r.method !== "GET");
const UPLOAD_IDS = LIFE_ROWS.filter((r) => r.kind === "upload").map((r) => r.id);
const all = (m: ReturnType<typeof buildManifest>): string[] => m.sections.flatMap((s) => s.actions);

test("every table row belongs to a known section, and every section has a row", () => {
  assert.deepEqual(Object.keys(SECTIONS_OF).sort(), LIFE_ROWS.map((r) => r.id).sort(), "one entry per row, no extra");
  for (const [id, sections] of Object.entries(SECTIONS_OF)) {
    assert.ok(sections.length >= 1, id);
    for (const s of sections) assert.ok(SECTION_IDS.includes(s), `${id} -> ${s}`);
  }
  for (const s of SECTION_IDS) assert.ok(Object.values(SECTIONS_OF).some((x) => x.includes(s)), `no row for ${s}`);
  assert.equal(new Set(SECTION_IDS).size, SECTION_IDS.length);
  // Write rows sit in exactly one section so an action is never drawn twice.
  for (const w of WRITES) assert.equal(SECTIONS_OF[w.id].length, 1, w.id);
});

test("sections come in the shell's order: Today, Plan, Work and money, Business, Comms, System", () => {
  assert.deepEqual([...SECTION_IDS], [
    "today", "tasks", "habits", "goals", "schedule", "journal", "deen",
    "work", "money", "finance", "trends", "shop",
    "products", "content", "instagram", "repos",
    "whatsapp", "chat", "analytics", "transcripts", "media",
    "server", "settings",
  ]);
});

test("a device with both caps gets every section and every write action once, in table order; uploads off hides the two upload actions", () => {
  const m = buildManifest(["life:read", "life:write"], false);
  assert.deepEqual(m.sections.map((s) => s.id), [...SECTION_IDS]);
  assert.equal(m.uploads, false);
  const actions = all(m);
  assert.equal(new Set(actions).size, actions.length, "no action twice");
  assert.deepEqual([...actions].sort(), WRITES.filter((w) => !UPLOAD_IDS.includes(w.id)).map((w) => w.id).sort());
  for (const s of m.sections) {
    const nums = s.actions.map((a) => Number(a.slice(1)));
    assert.deepEqual(nums, [...nums].sort((a, b) => a - b), `${s.id} in table order`);
  }
  const tasks = m.sections.find((s) => s.id === "tasks")!;
  assert.deepEqual(tasks.actions, ["L42", "L43", "L44", "L45", "L46", "L47", "L48", "L49", "L50"]);
});

test("uploads on: the manifest says so and the upload actions come back in their sections", () => {
  const m = buildManifest(["life:read", "life:write"], true);
  assert.equal(m.uploads, true);
  assert.deepEqual([...all(m)].sort(), WRITES.map((w) => w.id).sort());
  assert.ok(m.sections.find((s) => s.id === "content")!.actions.includes("L80"));
  assert.ok(m.sections.find((s) => s.id === "transcripts")!.actions.includes("L96"));
});

test("a read-only device sees every section and no write action, even with uploads on", () => {
  const m = buildManifest(["life:read"], true);
  assert.deepEqual(m.sections.map((s) => s.id), [...SECTION_IDS]);
  assert.deepEqual(all(m), []);
  assert.equal(m.uploads, false, "a device that cannot write is not offered uploads");
});

test("a write-only device sees only the sections it can write to; a device with neither cap sees nothing", () => {
  const m = buildManifest(["life:write"], false);
  assert.ok(m.sections.length > 0 && m.sections.length < SECTION_IDS.length);
  for (const s of m.sections) assert.ok(s.actions.length > 0, s.id);
  assert.ok(!m.sections.some((s) => s.id === "today" || s.id === "trends" || s.id === "server"), "read-only sections are not there");
  assert.deepEqual(buildManifest(["ops:read", "ops:write"] as Cap[], true), { sections: [], uploads: false });
  assert.deepEqual(buildManifest([], true), { sections: [], uploads: false });
});

test("the manifest is stable and carries no path: the same input gives the same bytes, and nothing in it is a url or a route", () => {
  const a = JSON.stringify(buildManifest(["life:read", "life:write"], true));
  assert.equal(a, JSON.stringify(buildManifest(["life:write", "life:read"], true)), "the order of caps does not matter");
  assert.equal(a, JSON.stringify(buildManifest(["life:read", "life:write"], true)));
  assert.ok(!a.includes("/") && !a.includes("api") && !a.includes("http"), a.slice(0, 200));
  for (const row of LIFE_ROWS) assert.ok(!a.includes(row.pattern.replace(/^\//, "").split("/")[0] + "/"), row.pattern);
  // Actions are row ids only.
  for (const x of all(JSON.parse(a))) assert.match(x, /^L\d+$/);
});

test("GET /life/manifest follows the device's caps and the uploads flag, and matches the contract example", async () => {
  const db = new Database(":memory:");
  const flag = { on: false };
  const t = await controlApp({
    life: { dashboard: express.Router(), ops: new OpsStore(db), media: { uploads: () => flag.on } },
  }, db);
  const dev = t.store.listDevices()[0]!;

  t.store.setCaps(dev.id, ["life:read"]);
  const ro = await t.get("/life/manifest");
  assert.equal(ro.status, 200);
  assert.deepEqual(Object.keys(ro.json), ["sections", "uploads"]);
  assert.deepEqual(ro.json.sections.flatMap((s: any) => s.actions), []);
  assert.equal(ro.json.uploads, false);

  t.store.setCaps(dev.id, ["life:read", "life:write"]);
  const rw = await t.get("/life/manifest");
  assert.deepEqual(rw.json, buildManifest(["life:read", "life:write"], false));
  flag.on = true;
  assert.deepEqual((await t.get("/life/manifest")).json, buildManifest(["life:read", "life:write"], true));
  flag.on = false;

  const examples = JSON.parse(fs.readFileSync(path.join(process.cwd(), "specs", "012-full-control", "contract-examples.json"), "utf8")).routes as { id: string; method: string; path: string; cap: string; response: unknown }[];
  const l0 = examples.find((r) => r.id === "L0")!;
  assert.deepEqual([l0.method, l0.path, l0.cap], ["GET", "/life/manifest", "life:read"]);
  assert.deepEqual(l0.response, buildManifest(["life:read", "life:write"], false), "the example is a read-write device with uploads off");

  t.store.setCaps(dev.id, ["life:write"]);
  const wo = await t.get("/life/manifest");
  assert.deepEqual([wo.status, wo.json.error.code], [403, "forbidden"], "the route itself needs life:read");
  t.store.setCaps(dev.id, ["ops:read"]);
  assert.equal((await t.get("/life/manifest")).status, 403);
  await t.close();
});
