import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokyo-history-'));
process.env.TOKYO_DB_PATH = path.join(dir, 'life.db');

let db: typeof import('./db');
let utils: typeof import('./utils');

// Not initDatabase(): it cannot bootstrap an empty file (see transcripts.test.ts).
// The tables below mirror the live columns these functions touch.
before(async () => {
  const raw = require('better-sqlite3')(process.env.TOKYO_DB_PATH);
  raw.exec(`
    CREATE TABLE habit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, habit_id INTEGER NOT NULL,
      logged_date TEXT NOT NULL, done INTEGER DEFAULT 1, UNIQUE(habit_id, logged_date));
    CREATE TABLE adhkar_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL,
      logged_date TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE quran_progress (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, juz INTEGER,
      surah TEXT, pages_read REAL, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
  `);
  raw.close();
  db = await import('./db');
  utils = await import('./utils');
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function daysAgo(n: number): string {
  const d = new Date(utils.localToday() + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

test('recentDates returns N days, oldest first, ending today', () => {
  const dates = db.recentDates(3);
  assert.deepEqual(dates, [daysAgo(2), daysAgo(1), daysAgo(0)]);
});

test('getHabitHistory maps each day to the habits done that day', () => {
  const raw = require('better-sqlite3')(process.env.TOKYO_DB_PATH);
  raw.prepare('INSERT INTO habit_logs (habit_id, logged_date, done) VALUES (?, ?, ?)').run(1, daysAgo(0), 1);
  raw.prepare('INSERT INTO habit_logs (habit_id, logged_date, done) VALUES (?, ?, ?)').run(2, daysAgo(0), 0);
  raw.prepare('INSERT INTO habit_logs (habit_id, logged_date, done) VALUES (?, ?, ?)').run(2, daysAgo(1), 1);
  raw.prepare('INSERT INTO habit_logs (habit_id, logged_date, done) VALUES (?, ?, ?)').run(3, daysAgo(9), 1);
  raw.close();

  const h = db.getHabitHistory(7);
  assert.equal(h.length, 7);
  assert.deepEqual(h[6], { date: daysAgo(0), habits: { 1: true } });
  assert.deepEqual(h[5], { date: daysAgo(1), habits: { 2: true } });
  assert.deepEqual(h[0], { date: daysAgo(6), habits: {} });
});

test('getAdhkarHistory gives one row per day with each type flagged', () => {
  const raw = require('better-sqlite3')(process.env.TOKYO_DB_PATH);
  raw.prepare('INSERT INTO adhkar_logs (type, logged_date) VALUES (?, ?)').run('morning', daysAgo(0));
  raw.prepare('INSERT INTO adhkar_logs (type, logged_date) VALUES (?, ?)').run('post_prayer', daysAgo(0));
  raw.prepare('INSERT INTO adhkar_logs (type, logged_date) VALUES (?, ?)').run('evening', daysAgo(2));
  raw.close();

  const a = db.getAdhkarHistory(3);
  assert.deepEqual(a, [
    { date: daysAgo(2), morning: false, evening: true, post_prayer: false },
    { date: daysAgo(1), morning: false, evening: false, post_prayer: false },
    { date: daysAgo(0), morning: true, evening: false, post_prayer: true },
  ]);
});

test('getQuranHistory sums pages per day and fills empty days with 0', () => {
  const raw = require('better-sqlite3')(process.env.TOKYO_DB_PATH);
  raw.prepare('INSERT INTO quran_progress (date, pages_read) VALUES (?, ?)').run(daysAgo(0), 2);
  raw.prepare('INSERT INTO quran_progress (date, pages_read) VALUES (?, ?)').run(daysAgo(0), 3.5);
  raw.prepare('INSERT INTO quran_progress (date, pages_read) VALUES (?, ?)').run(daysAgo(40), 9);
  raw.close();

  const q = db.getQuranHistory(3);
  assert.deepEqual(q, [
    { date: daysAgo(2), pages: 0 },
    { date: daysAgo(1), pages: 0 },
    { date: daysAgo(0), pages: 5.5 },
  ]);
});
