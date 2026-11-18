/**
 * Tests the periodic products sync scheduler (Gap 1b): a first run shortly
 * after boot, then a recurring rescan, guarded so a second call to
 * startProductsSync() (e.g. a second import in the same process) never
 * double-schedules. Uses node:test's fake timers so no real 5s/10min wait
 * happens in CI.
 *
 * Mirrors products-routes.test.ts: does NOT call db.initDatabase() (its
 * full migration list has a pre-existing, unrelated ordering bug — an
 * index on `promises` is created before the `promises` table itself — that
 * only bites a byte-empty scratch DB). Only the tables the scheduler path
 * touches are created directly.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Point db.ts at a fresh scratch file BEFORE importing anything that opens
// it — same convention as products-routes.test.ts.
const dir = mkdtempSync(join(tmpdir(), "tokyo-products-sched-"));
process.env.TOKYO_DB_PATH = join(dir, "life.db");

const SUPPLIER_JID = "182012157624438@lid";

function rawDb() {
  return require("better-sqlite3")(process.env.TOKYO_DB_PATH as string);
}

test("startProductsSync: runs once at boot, then on the interval, and a second call never double-schedules", async () => {
  const raw = rawDb();
  raw.exec(`
    CREATE TABLE whatsapp_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL,
      sender TEXT, sender_name TEXT, content TEXT,
      message_type TEXT DEFAULT 'text', from_me INTEGER DEFAULT 0, is_group INTEGER DEFAULT 0,
      replied INTEGER DEFAULT 0, reply_content TEXT, timestamp INTEGER,
      created_at TEXT DEFAULT (datetime('now')), media_path TEXT, transcription TEXT,
      wa_msg_id TEXT, quoted_msg_id TEXT
    );
    CREATE TABLE whatsapp_contacts (
      jid TEXT PRIMARY KEY, category TEXT DEFAULT 'other', display_name TEXT, notes TEXT,
      created_at TEXT DEFAULT (datetime('now')), auto_transcribe TEXT, supplier INTEGER DEFAULT 0
    );
    CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL UNIQUE,
      jid TEXT NOT NULL,
      media_file TEXT NOT NULL,
      title TEXT, brand TEXT, price REAL,
      currency TEXT NOT NULL DEFAULT 'DH',
      price_source TEXT NOT NULL DEFAULT 'none',
      confidence TEXT NOT NULL DEFAULT 'low',
      batch_id TEXT, price_message_id INTEGER,
      status TEXT NOT NULL DEFAULT 'new', notes TEXT,
      timestamp INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT
    );
  `);
  raw.prepare("INSERT INTO whatsapp_contacts (jid, supplier) VALUES (?, 1)").run(SUPPLIER_JID);
  raw.prepare(`
    INSERT INTO whatsapp_messages (jid, content, message_type, from_me, timestamp, media_path)
    VALUES (?, ?, 'image', 0, ?, ?)
  `).run(SUPPLIER_JID, '[Image] [Transcription: "Aya mode" velvet kaftan taupe]', 1789923000, "whatsapp-media/wa_sched_test.jpg");
  raw.close();

  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const db = await import("../db");

    // Importing the module fires startProductsSync() once at module load
    // (mirrors src/dashboard/projects-routes.ts calling startProjectReposSync()).
    const mod = await import("./products-routes");
    assert.equal(typeof mod.startProductsSync, "function");
    assert.equal(typeof mod.PRODUCTS_FIRST_SYNC_DELAY_MS, "number");
    assert.equal(typeof mod.PRODUCTS_SYNC_INTERVAL_MS, "number");

    // Nothing has run yet — the products table is still empty.
    assert.equal(db.getProductStats().total, 0, "no sync before the first-run timer fires");
    assert.equal(mod.getProductsSyncRunCountForTest(), 0);

    mock.timers.tick(mod.PRODUCTS_FIRST_SYNC_DELAY_MS);
    assert.equal(db.getProductStats().total, 1, "the boot-time sync populated the catalog from the seeded image");
    assert.equal(mod.getProductsSyncRunCountForTest(), 1);

    // A second call to startProductsSync() (e.g. a hot-reload re-import) must
    // be a no-op: no extra timer registered, no extra run scheduled.
    mod.startProductsSync();
    mock.timers.tick(mod.PRODUCTS_FIRST_SYNC_DELAY_MS);
    assert.equal(mod.getProductsSyncRunCountForTest(), 1, "a duplicate start() must not schedule a second boot-time run");

    // Advancing by the interval should fire the *original* recurring job
    // exactly once more — not twice, which is what a double-registered
    // interval would produce.
    mock.timers.tick(mod.PRODUCTS_SYNC_INTERVAL_MS);
    assert.equal(mod.getProductsSyncRunCountForTest(), 2, "one interval period => exactly one more recurring sync run");
  } finally {
    mock.timers.reset();
  }
});
