import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokyo-profile-"));
process.env.TOKYO_DB_PATH = path.join(dir, "life.db");

let s: typeof import("./settings");
let p: typeof import("./profile");

const KEYS = ["PROFILE_NAME", "PROFILE_COUNTRY", "PROFILE_CITY", "PROFILE_LANGUAGE", "PROFILE_WORK", "PROFILE_GOALS",
  "CURRENCY", "TIMEZONE", "FEATURE_PRAYER", "FEATURE_SHOP", "FEATURE_WHATSAPP", "OWNER_NAME", "MYSHOP_GROUP_JIDS", "MYSHOP_GROUP_JID", "OWNER_PROFILE_FILE"];

before(async () => {
  const raw = require("better-sqlite3")(process.env.TOKYO_DB_PATH);
  raw.exec(`CREATE TABLE settings (scope TEXT NOT NULL DEFAULT 'owner', key TEXT NOT NULL, value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (scope, key))`);
  raw.close();
  s = await import("./settings");
  p = await import("./profile");
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  for (const k of KEYS) { delete process.env[k]; s.saveSetting(k, null); }
});

test("a fresh install is neutral: no name, UTC, USD, prayer on, no shop", () => {
  assert.equal(p.ownerName(), "the owner");
  assert.equal(p.timezone(), "UTC");
  assert.equal(p.currency(), "USD");
  assert.equal(p.languageRule(), "Answer in the language the user writes in.");
  assert.equal(p.prayerOn(), true);
  assert.equal(p.shopOn(), false, "shop needs a group JID as well as the switch");
  const profile = p.ownerProfile();
  assert.doesNotMatch(profile, /Morocc|Casablanca|Darija|\bDH\b|MAD|father|developer/i);
});

test("an Egyptian nurse without prayer or shop gets exactly that in the prompt", () => {
  s.saveSetting("PROFILE_NAME", "Mona");
  s.saveSetting("PROFILE_COUNTRY", "Egypt");
  s.saveSetting("PROFILE_CITY", "Alexandria");
  s.saveSetting("TIMEZONE", "Africa/Cairo");
  s.saveSetting("PROFILE_LANGUAGE", "Egyptian Arabic");
  s.saveSetting("CURRENCY", "EGP");
  s.saveSetting("PROFILE_WORK", "Nurse, night shifts");
  s.saveSetting("FEATURE_PRAYER", "0");
  s.saveSetting("FEATURE_SHOP", "0");

  assert.equal(p.ownerName(), "Mona");
  assert.equal(p.currency(), "EGP");
  assert.equal(p.timezone(), "Africa/Cairo", "saving TIMEZONE updates process.env for the date helpers");
  assert.match(p.languageRule(), /Egyptian Arabic/);
  const profile = p.ownerProfile();
  assert.match(profile, /Mona/);
  assert.match(profile, /Alexandria, Egypt/);
  assert.match(profile, /Nurse, night shifts/);
  assert.match(profile, /EGP/);
  assert.doesNotMatch(profile, /prayer|Muslim|shop/i);
});

test("resetting TIMEZONE goes back to the .env value", () => {
  s.saveSetting("TIMEZONE", "Asia/Riyadh");
  assert.equal(process.env.TIMEZONE, "Asia/Riyadh");
  s.saveSetting("TIMEZONE", null);
  assert.notEqual(process.env.TIMEZONE, "Asia/Riyadh");
});

test("an invalid timezone is refused", () => {
  assert.ok(s.validateSetting("TIMEZONE", "Mars/Base"));
  assert.equal(s.validateSetting("TIMEZONE", "Africa/Cairo"), null);
});

test("the shop is on only with the switch AND a group JID", () => {
  process.env.MYSHOP_GROUP_JIDS = "120363000000000001@g.us";
  assert.equal(p.shopOn(), true);
  s.saveSetting("FEATURE_SHOP", "0");
  assert.equal(p.shopOn(), false);
});

test("OWNER_NAME in .env still works when PROFILE_NAME is unset", () => {
  process.env.OWNER_NAME = "Sam";
  assert.equal(p.ownerName(), "Sam");
  s.saveSetting("PROFILE_NAME", "Samira");
  assert.equal(p.ownerName(), "Samira");
});

test("with prayer off there is no next prayer and the day splits into plain blocks", async () => {
  const prayer = await import("./prayer");
  s.saveSetting("FEATURE_PRAYER", "0");
  const next = await prayer.getNextPrayer();
  assert.equal(next.minutesUntil, 24 * 60, "nothing ever looks 'about to start'");
  const windows = await prayer.getWorkWindows();
  assert.deepEqual(windows.map((w) => w.label), ["Morning", "Afternoon", "Evening"]);
});
