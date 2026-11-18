import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import express from "express";
import type { AddressInfo } from "net";

// Point db.ts at a scratch file BEFORE importing anything that touches it (see products-routes.test.ts).
const dir = mkdtempSync(join(tmpdir(), "tokyo-subtasks-"));
process.env.TOKYO_DB_PATH = join(dir, "life.db");

let db: typeof import("../db");
let router: import("express").Router;
let base = "";

const rawDb = () => require("better-sqlite3")(process.env.TOKYO_DB_PATH);

before(async () => {
  // Not initDatabase(): it needs the full live schema. Only the tasks table is used here.
  const raw = rawDb();
  raw.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, description TEXT,
      category TEXT DEFAULT 'client',
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
      due_date TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'done', 'cancelled')),
      parent_id INTEGER REFERENCES tasks(id), client_id INTEGER, project_id INTEGER, estimated_hours REAL, notes TEXT,
      created_at TEXT DEFAULT (datetime('now')), completed_at TEXT, area TEXT
    );
  `);
  raw.close();
  db = await import("../db");
  router = (await import("./routes")).default;
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  const raw = rawDb();
  raw.exec("DELETE FROM tasks; DELETE FROM sqlite_sequence WHERE name = 'tasks';");
  raw.close();
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  // ./routes pulls in Baileys and other modules that hold the event loop open; every assertion has already run.
  setImmediate(() => process.exit(0));
});

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
}
const parent = (title = "Parent", category = "work"): number => Number(db.addTask(title, category, "high").lastInsertRowid);
const rows = (): any[] => rawDb().prepare("SELECT id, title, parent_id, status, category, completed_at FROM tasks ORDER BY id").all();

test("the page's add call works: ok and id, the subtask sits under its parent and the active list still shows the parent only", async () => {
  const p = parent();
  const r = await call("POST", `/api/tasks/${p}/subtasks`, { title: "First step" });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(typeof r.json.id, "number");
  const row = rows().find((x) => x.id === r.json.id);
  assert.deepEqual([row.title, row.parent_id, row.status, row.category], ["First step", p, "pending", "work"], "inherits the parent's category");
  // What /api/overview returns for it: active top-level tasks, each with getSubtasks.
  const overview = (db.getAllActiveTasks() as any[]).map((t) => ({ id: t.id, subtasks: (db.getSubtasks(t.id) as any[]).map((s) => s.title) }));
  assert.deepEqual(overview, [{ id: p, subtasks: ["First step"] }]);
});

test("add trims the title and enforces 1 to 200 characters", async () => {
  const p = parent();
  const trimmed = await call("POST", `/api/tasks/${p}/subtasks`, { title: "  spaced  " });
  assert.equal(trimmed.status, 200);
  assert.equal(rows().find((x) => x.id === trimmed.json.id).title, "spaced");
  assert.equal((await call("POST", `/api/tasks/${p}/subtasks`, { title: "x".repeat(200) })).status, 200);
  for (const body of [{ title: "x".repeat(201) }, { title: "" }, { title: "   " }, { title: 5 }, { title: null }, {}, undefined]) {
    const r = await call("POST", `/api/tasks/${p}/subtasks`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(typeof r.json.error, "string");
  }
  assert.equal(rows().filter((x) => x.parent_id === p).length, 2, "the refused ones added nothing");
});

test("add to a task that does not exist is 404, and a bad id is 400", async () => {
  assert.equal((await call("POST", "/api/tasks/9999/subtasks", { title: "x" })).status, 404);
  assert.equal((await call("POST", "/api/tasks/abc/subtasks", { title: "x" })).status, 400);
  assert.equal(rows().length, 0);
});

test("the page's complete call works: the subtask is done with a completion time, the parent is untouched", async () => {
  const p = parent();
  const s = (await call("POST", `/api/tasks/${p}/subtasks`, { title: "Step" })).json.id;
  const r = await call("POST", `/api/tasks/${p}/subtasks/${s}/complete`);
  assert.deepEqual([r.status, r.json], [200, { ok: true }]);
  const [par, sub] = [rows().find((x) => x.id === p), rows().find((x) => x.id === s)];
  assert.equal(sub.status, "done");
  assert.ok(sub.completed_at);
  assert.equal(par.status, "pending");
  assert.equal(par.completed_at, null);
});

test("completing a subtask of another parent is 404 and changes nothing; so is a task that is not a subtask or does not exist", async () => {
  const a = parent("A");
  const b = parent("B");
  const sub = (await call("POST", `/api/tasks/${a}/subtasks`, { title: "A1" })).json.id;
  const before = JSON.stringify(rows());
  assert.equal((await call("POST", `/api/tasks/${b}/subtasks/${sub}/complete`)).status, 404, "wrong parent");
  assert.equal((await call("POST", `/api/tasks/${a}/subtasks/${b}/complete`)).status, 404, "a top-level task is not a subtask of a");
  assert.equal((await call("POST", `/api/tasks/${a}/subtasks/9999/complete`)).status, 404, "no such subtask");
  assert.equal((await call("POST", `/api/tasks/9999/subtasks/${sub}/complete`)).status, 404, "no such parent");
  assert.equal((await call("POST", `/api/tasks/${a}/subtasks/abc/complete`)).status, 400, "bad id");
  assert.equal(JSON.stringify(rows()), before);
});

test("the neighbouring task routes still work", async () => {
  const p = parent();
  assert.equal((await call("POST", "/api/tasks", { title: "Plain" })).status, 200);
  assert.equal((await call("POST", `/api/tasks/${p}/complete`)).status, 200);
  const sub = (await call("POST", `/api/tasks/${p}/subtasks`, { title: "x" })).json.id;
  assert.equal((await call("DELETE", `/api/tasks/${p}`)).status, 200);
  assert.equal(rows().some((x) => x.id === sub), false, "deleting the parent deletes its subtasks");
});
