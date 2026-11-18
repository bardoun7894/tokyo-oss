import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokyo-settings-'));
process.env.TOKYO_DB_PATH = path.join(dir, 'life.db');

let s: typeof import('./settings');

before(async () => {
  // Only the settings table; initDatabase() cannot bootstrap an empty file.
  const raw = require('better-sqlite3')(process.env.TOKYO_DB_PATH);
  raw.exec(`CREATE TABLE settings (scope TEXT NOT NULL DEFAULT 'owner', key TEXT NOT NULL, value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (scope, key))`);
  raw.close();
  s = await import('./settings');
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  for (const k of ['SHOP_AI_REPLIES', 'WA_AUTO_REPLIES', 'JOBHUNT_DRY_RUN', 'PRAYER_CITY', 'JOBHUNT_DAILY_CAP']) { delete process.env[k]; s.saveSetting(k, null); }
});

test('dashboard value beats .env, which beats the default', () => {
  assert.equal(s.setting('PRAYER_CITY'), 'Riyadh');
  process.env.PRAYER_CITY = 'Tetouan';
  assert.equal(s.setting('PRAYER_CITY'), 'Tetouan');
  s.saveSetting('PRAYER_CITY', 'Rabat');
  assert.equal(s.setting('PRAYER_CITY'), 'Rabat');
  s.saveSetting('PRAYER_CITY', null);
  assert.equal(s.setting('PRAYER_CITY'), 'Tetouan', 'reset falls back to .env');
});

test('bools keep the string format the code already reads', () => {
  assert.equal(s.settingOn('SHOP_AI_REPLIES'), false);
  s.saveSetting('SHOP_AI_REPLIES', '1');
  assert.equal(s.settingOn('SHOP_AI_REPLIES'), true);
  assert.equal(s.setting('SHOP_AI_REPLIES'), '1');
});

test('WA_AUTO_REPLIES is on by default and off only at "0"', () => {
  assert.equal(s.settingOn('WA_AUTO_REPLIES'), true, 'replies stay on until paused');
  s.saveSetting('WA_AUTO_REPLIES', '0');
  assert.equal(s.settingOn('WA_AUTO_REPLIES'), false, 'paused from the dashboard');
  s.saveSetting('WA_AUTO_REPLIES', null);
  assert.equal(s.settingOn('WA_AUTO_REPLIES'), true, 'reset resumes replies');
});

test('JOBHUNT_DRY_RUN is on unless exactly "false", like the job hunt code', () => {
  assert.equal(s.settingOn('JOBHUNT_DRY_RUN'), true, 'unset = dry run');
  process.env.JOBHUNT_DRY_RUN = 'yes';
  assert.equal(s.settingOn('JOBHUNT_DRY_RUN'), true);
  s.saveSetting('JOBHUNT_DRY_RUN', 'false');
  assert.equal(s.settingOn('JOBHUNT_DRY_RUN'), false);
});

test('validation rejects unknown keys and bad values', () => {
  assert.equal(s.validateSetting('NOPE', '1'), 'unknown setting');
  assert.equal(s.validateSetting('OPENROUTER_API_KEY', 'x'), 'unknown setting', 'secrets are not settings');
  assert.match(s.validateSetting('SHOP_AI_REPLIES', 'yes')!, /must be 1 or 0/);
  assert.match(s.validateSetting('JOBHUNT_DAILY_CAP', 'abc')!, /number/);
  assert.match(s.validateSetting('JOBHUNT_DAILY_CAP', '500')!, /at most/);
  assert.match(s.validateSetting('PRAYER_METHOD', '99')!, /options/);
  assert.match(s.validateSetting('PROFILE_NAME', '   ')!, /1 to 200/);
  assert.equal(s.validateSetting('JOBHUNT_DAILY_CAP', '20'), null);
  assert.equal(s.validateSetting('PRAYER_CITY', null), null);
});

test('listSettings reports where each value comes from', () => {
  process.env.PRAYER_CITY = 'Tetouan';
  s.saveSetting('JOBHUNT_DAILY_CAP', '15');
  const by = Object.fromEntries(s.listSettings().map((d) => [d.key, d]));
  assert.equal(by.PRAYER_CITY.source, 'env');
  assert.equal(by.JOBHUNT_DAILY_CAP.source, 'dashboard');
  assert.equal(by.JOBHUNT_DAILY_CAP.value, '15');
  assert.equal(by.PROFILE_NAME.source, 'default');
});
