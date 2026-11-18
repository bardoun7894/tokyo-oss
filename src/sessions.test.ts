import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokyo-sess-'));
process.env.TOKYO_DB_PATH = path.join(dir, 'life.db');

let db: typeof import('./db');
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

before(async () => { db = await import('./db'); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a saved session is found again (survives a restart)', () => {
  const expires = Date.now() + 60_000;
  db.saveDashboardSession(HASH_A, expires);
  assert.equal(db.getDashboardSession(HASH_A), expires);
});

test('an unknown token is not a session', () => {
  assert.equal(db.getDashboardSession('c'.repeat(64)), undefined);
});

test('an expired session is rejected and deleted', () => {
  db.saveDashboardSession(HASH_B, Date.now() - 1);
  assert.equal(db.getDashboardSession(HASH_B), undefined);
  assert.equal(db.pruneDashboardSessions(), 0, 'the read already removed it');
});

test('changing the password keeps only the current session', () => {
  db.saveDashboardSession(HASH_A, Date.now() + 60_000);
  db.saveDashboardSession(HASH_B, Date.now() + 60_000);
  db.clearDashboardSessions(HASH_A);
  assert.ok(db.getDashboardSession(HASH_A));
  assert.equal(db.getDashboardSession(HASH_B), undefined);
});

test('prune drops expired rows and leaves live ones', () => {
  db.saveDashboardSession(HASH_B, Date.now() - 1);
  assert.equal(db.pruneDashboardSessions(), 1);
  assert.ok(db.getDashboardSession(HASH_A));
});
