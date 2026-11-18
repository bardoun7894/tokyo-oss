import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokyo-area-'));
process.env.TOKYO_DB_PATH = path.join(dir, 'life.db');
delete process.env.OPENROUTER_API_KEY; // category fallback only, no network

let db: typeof import('./db');
const tick = () => new Promise((r) => setTimeout(r, 20));

// Not initDatabase(): it cannot bootstrap an empty file (see transcripts.test.ts).
// The two tables below mirror the live columns these functions touch.
before(async () => {
  const raw = require('better-sqlite3')(process.env.TOKYO_DB_PATH);
  raw.exec(`
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
      category TEXT DEFAULT 'client', priority TEXT DEFAULT 'medium', due_date TEXT, status TEXT DEFAULT 'pending',
      parent_id INTEGER, client_id INTEGER, project_id INTEGER, estimated_hours REAL, notes TEXT,
      created_at TEXT DEFAULT (datetime('now')), completed_at TEXT, area TEXT);
    CREATE TABLE journal (id INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT NOT NULL, mood TEXT, energy_level INTEGER,
      category TEXT DEFAULT 'general', logged_at TEXT DEFAULT (datetime('now')), area TEXT);
  `);
  raw.close();
  db = await import('./db');
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a new task gets its area written back after the insert', async () => {
  const id = Number(db.addTask('fix checkout bug', 'client').lastInsertRowid);
  await tick();
  assert.equal(db.getTask(id).area, 'work');
});

test('a task whose area cannot be decided stays unsorted and shows up for the backfill', async () => {
  const id = Number(db.addTask('something vague', 'other').lastInsertRowid);
  await tick();
  assert.equal(db.getTask(id).area, null);
  assert.ok(db.getUnsortedForArea().some((r) => r.table === 'tasks' && r.id === id));
});

test('journal entries get an area too', async () => {
  const id = Number(db.addJournalEntry('read two chapters', undefined, undefined, 'reading').lastInsertRowid);
  await tick();
  const row = db.getUnsortedForArea().find((r) => r.table === 'journal' && r.id === id);
  assert.equal(row, undefined, 'journal row was sorted');
});

test('manual override replaces the decided area and accepts null', () => {
  const id = Number(db.addTask('x', 'client').lastInsertRowid);
  db.setTaskArea(id, 'learn');
  assert.equal(db.getTask(id).area, 'learn');
  db.setTaskArea(id, null);
  assert.equal(db.getTask(id).area, null);
});
