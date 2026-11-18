import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import express from "express";
import type { AddressInfo } from "net";
import { useTempMediaDir } from "../test-media";

// Point db.ts at a scratch file BEFORE importing anything that touches it —
// db.ts opens the database at module load (see area-db.test.ts / transcripts.test.ts).
const dir = mkdtempSync(join(tmpdir(), "tokyo-products-"));
process.env.TOKYO_DB_PATH = join(dir, "life.db");
const media = useTempMediaDir();

const SUPPLIER_JID = "182012157624438@lid";
const T = 1789923000;

let db: typeof import("../db");
let router: import("express").Router;
let buildProductsRouter: typeof import("./products-routes").buildProductsRouter;
let MEDIA_DIR: string;
const FIXTURE_FILES = ["wa_test_prod_1.jpg", "wa_test_prod_2.jpg", "wa_test_prod_3.jpg"];

function rawDb() {
  return require("better-sqlite3")(process.env.TOKYO_DB_PATH);
}

before(async () => {
  // Not initDatabase() (see area-db.test.ts): it needs the full live schema.
  // Mirror only the tables products-routes touches.
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
  raw.close();

  db = await import("../db");
  const mod = await import("./products-routes");
  router = mod.default;
  buildProductsRouter = mod.buildProductsRouter;

  // products-routes.ts resolves media from mediaDir() (TOKYO_MEDIA_DIR), not
  // from TOKYO_DB_PATH. Drop small fixture files in the temp media dir so the
  // forward path's fs.existsSync() check passes; media.cleanup() removes them.
  MEDIA_DIR = media.dir;
  mkdirSync(MEDIA_DIR, { recursive: true });
  for (const f of FIXTURE_FILES) writeFileSync(join(MEDIA_DIR, f), "test-fixture");
});

// Every test starts from the same clean slate: a 3-image burst, each with
// its own quoted-reply price (Radwan replies to each photo individually —
// see specs/products-catalog/CONTRACT.md's ingest fix). Tests that need
// extra rows add them on top, inside the test itself.
beforeEach(() => {
  const raw = rawDb();
  raw.exec("DELETE FROM whatsapp_messages; DELETE FROM products;");
  const insertMsg = raw.prepare(`
    INSERT INTO whatsapp_messages (jid, content, message_type, from_me, timestamp, media_path, transcription, wa_msg_id, quoted_msg_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertMsg.run(SUPPLIER_JID, '[Image] [Transcription: "Aya mode" velvet kaftan taupe]', "image", 0, T, "whatsapp-media/wa_test_prod_1.jpg", null, "wa_test_1", null);
  insertMsg.run(SUPPLIER_JID, '[Image] [Transcription: "Aya mode" black dress]', "image", 0, T + 5, "whatsapp-media/wa_test_prod_2.jpg", null, "wa_test_2", null);
  insertMsg.run(SUPPLIER_JID, "[Image]", "image", 0, T + 10, "whatsapp-media/wa_test_prod_3.jpg", "grey jalabiya from transcription column", "wa_test_3", null);
  insertMsg.run(SUPPLIER_JID, "price", "text", 1, T + 100, null, null, null, null);
  insertMsg.run(SUPPLIER_JID, "58", "text", 0, T + 200, null, null, null, "wa_test_1");
  insertMsg.run(SUPPLIER_JID, "65", "text", 0, T + 210, null, null, null, "wa_test_2");
  insertMsg.run(SUPPLIER_JID, "68", "text", 0, T + 220, null, null, null, "wa_test_3");
  raw.close();
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  media.cleanup();
  // ../whatsapp pulls in real side-effecting modules (Baileys, shop-group,
  // mission-wiring...) that hold the event loop open even though nothing in
  // this file starts a real connection. Force the process down once every
  // assertion above has already run — the standard workaround for testing a
  // route file whose only untestable dependency is a heavy socket module.
  setImmediate(() => process.exit(0));
});

async function serve(customRouter: import("express").Router = router) {
  const app = express();
  app.use(express.json());
  app.use(customRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, {
      method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: (await r.json()) as any };
  };
  return { call, close: () => server.close() };
}

test("POST /api/products/sync extracts titles, pairs prices, and reports honest counts", async () => {
  const s = await serve();
  try {
    const { status, json } = await s.call("POST", "/api/products/sync");
    assert.equal(status, 200);
    assert.equal(json.scanned, 3);
    assert.equal(json.added, 3);
    assert.equal(json.paired, 3);
    assert.equal(json.unpriced, 0);
    assert.equal(json.batches, 1);

    const list = (await s.call("GET", "/api/products?sort=date_asc")).json;
    assert.equal(list.total, 3);
    assert.equal(list.items[0].title, "Aya mode — kaftan taupe");
    assert.equal(list.items[0].brand, "Aya mode");
    assert.equal(list.items[0].price, 58);
    assert.equal(list.items[0].priceSource, "quote");
    assert.equal(list.items[0].confidence, "high");
    // content had no wrapper but the transcription column did (E4 fallback)
    assert.match(list.items[2].title, /jalabiya/);
  } finally {
    s.close();
  }
});

test("GET /api/products default sort is date_desc, price_asc and name_asc reorder correctly", async () => {
  const s = await serve();
  try {
    await s.call("POST", "/api/products/sync");
    const byDefault = (await s.call("GET", "/api/products")).json.items;
    assert.deepEqual(byDefault.map((i: any) => i.price), [68, 65, 58], "default = date_desc = newest image first");

    const byPriceAsc = (await s.call("GET", "/api/products?sort=price_asc")).json.items;
    assert.deepEqual(byPriceAsc.map((i: any) => i.price), [58, 65, 68]);

    const byNameAsc = (await s.call("GET", "/api/products?sort=name_asc")).json.items;
    const titles = byNameAsc.map((i: any) => i.title);
    assert.deepEqual([...titles].sort((a, b) => a.localeCompare(b)), titles);
  } finally {
    s.close();
  }
});

test("GET /api/products?unpriced=1 only returns rows with a null price", async () => {
  const s = await serve();
  try {
    await s.call("POST", "/api/products/sync");
    const before = await s.call("GET", "/api/products?unpriced=1");
    assert.equal(before.json.total, 0, "the seeded burst is fully paired");

    const raw = rawDb();
    raw.prepare(`
      INSERT INTO whatsapp_messages (jid, content, message_type, from_me, timestamp, media_path)
      VALUES (?, ?, 'image', 0, ?, ?)
    `).run(SUPPLIER_JID, "[Image] [Transcription: lonely photo]", T + 100000, "whatsapp-media/wa_test_prod_9.jpg");
    raw.close();

    await s.call("POST", "/api/products/sync");
    const after = await s.call("GET", "/api/products?unpriced=1");
    assert.equal(after.json.total, 1);
    assert.equal(after.json.items[0].price, null);
  } finally {
    s.close();
  }
});

test("PATCH /api/products/:id sets price_source=manual and confidence=high, and survives the next sync untouched", async () => {
  const s = await serve();
  try {
    await s.call("POST", "/api/products/sync");
    const first = (await s.call("GET", "/api/products?sort=date_asc")).json.items[0];

    const patched = await s.call("PATCH", `/api/products/${first.id}`, { price: 999 });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.price, 999);
    assert.equal(patched.json.priceSource, "manual");
    assert.equal(patched.json.confidence, "high");

    // Re-sync must not clobber the manual override.
    await s.call("POST", "/api/products/sync");
    const after = (await s.call("GET", `/api/products?sort=date_asc`)).json.items[0];
    assert.equal(after.price, 999);
    assert.equal(after.priceSource, "manual");
  } finally {
    s.close();
  }
});

test("GET /api/products/batches and /batches/:batchId expose the batch and its full price run", async () => {
  const s = await serve();
  try {
    const syncResult = (await s.call("POST", "/api/products/sync")).json;
    assert.equal(syncResult.batches, 1);

    const batches = (await s.call("GET", "/api/products/batches")).json.batches;
    assert.equal(batches.length, 1);
    assert.equal(batches[0].imageCount, 3);
    assert.equal(batches[0].priceCount, 3);
    assert.equal(batches[0].confidence, "high");

    const detail = (await s.call("GET", `/api/products/batches/${batches[0].batchId}`)).json;
    assert.equal(detail.images.length, 3);
    assert.equal(detail.prices.length, 3);
    assert.ok(detail.prices.every((p: any) => p.assignedTo !== null), "equal counts => every price is assigned");
  } finally {
    s.close();
  }
});

test("POST /api/products/forward without confirm returns a preview and sends nothing", async () => {
  let sendCalls = 0;
  const fakeRouter = buildProductsRouter({
    getWhatsAppChats: () => [],
    sendWhatsAppImage: async () => { sendCalls++; },
  });
  const s = await serve(fakeRouter);
  try {
    await s.call("POST", "/api/products/sync");
    const list = (await s.call("GET", "/api/products?sort=date_asc")).json.items;

    const preview = await s.call("POST", "/api/products/forward", {
      ids: [list[0].id], jid: "212600000000@s.whatsapp.net", withPrice: true, confirm: false,
    });
    assert.equal(preview.status, 400);
    assert.equal(preview.json.preview.count, 1);
    assert.equal(preview.json.preview.target, "212600000000@s.whatsapp.net");
    assert.match(preview.json.preview.captions[0], /58 DH/);
    assert.equal(sendCalls, 0, "no real send happened for a preview request");
  } finally {
    s.close();
  }
});

test("POST /api/products/forward with confirm:true sends through the stubbed WhatsApp module and paces messages", async () => {
  const sent: string[] = [];
  const fakeRouter = buildProductsRouter({
    getWhatsAppChats: () => [],
    sendWhatsAppImage: async (jid: string, _absPath: string, caption?: string) => { sent.push(`${jid}|${caption}`); },
  });
  const s = await serve(fakeRouter);
  try {
    await s.call("POST", "/api/products/sync");
    const list = (await s.call("GET", "/api/products?sort=date_asc")).json.items;

    const result = await s.call("POST", "/api/products/forward", {
      ids: [list[0].id, list[1].id], jid: "212600000000@s.whatsapp.net", withPrice: false, confirm: true,
    });
    assert.equal(result.status, 200);
    assert.equal(result.json.sent, 2);
    assert.equal(result.json.failed, 0);
    assert.equal(sent.length, 2);
  } finally {
    s.close();
  }
});

/* ---- the burned-in price badge on forwarded photos ---- */

test("forwarding with a price sends the badged photo, not the bare original", async () => {
  // A real JPEG, so sharp can actually produce a badge for this one.
  const sharp = require("sharp");
  const realPhoto = "wa_test_real_photo.jpg";
  await sharp({ create: { width: 800, height: 1000, channels: 3, background: "#dddddd" } })
    .jpeg()
    .toFile(join(MEDIA_DIR, realPhoto));

  const sentPaths: string[] = [];
  const captions: string[] = [];
  const fakeRouter = buildProductsRouter({
    getWhatsAppChats: () => [],
    sendWhatsAppImage: async (_jid: string, absPath: string, caption?: string) => {
      sentPaths.push(absPath);
      captions.push(caption || "");
    },
  });
  const s = await serve(fakeRouter);
  try {
    const raw = rawDb();
    raw
      .prepare(
        `INSERT INTO products (message_id, jid, media_file, title, brand, price, price_source, confidence, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(90210, SUPPLIER_JID, realPhoto, "Nightgown gray", "Ghita Style", 67, "manual", "high", T + 900);
    const id = (raw.prepare("SELECT id FROM products WHERE message_id = 90210").get() as any).id;
    raw.close();

    const res = await s.call("POST", "/api/products/forward", {
      ids: [id], jid: "212600000000@s.whatsapp.net", withPrice: true, confirm: true,
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.sent, 1);
    assert.equal(sentPaths.length, 1);
    assert.ok(sentPaths[0].includes("/share/"), `expected a badged image, got ${sentPaths[0]}`);
    assert.ok(sentPaths[0].includes("67"), "the badge cache key carries the price that was burned in");
    assert.match(captions[0], /67 DH/, "the caption still carries the price for anyone who can read it");
  } finally {
    s.close();
  }
});

test("a markup burns the marked-up price, so the photo and the caption cannot disagree", async () => {
  const sharp = require("sharp");
  const realPhoto = "wa_test_real_photo2.jpg";
  await sharp({ create: { width: 800, height: 1000, channels: 3, background: "#eeeeee" } })
    .jpeg()
    .toFile(join(MEDIA_DIR, realPhoto));

  const sentPaths: string[] = [];
  const captions: string[] = [];
  const fakeRouter = buildProductsRouter({
    getWhatsAppChats: () => [],
    sendWhatsAppImage: async (_jid: string, absPath: string, caption?: string) => {
      sentPaths.push(absPath);
      captions.push(caption || "");
    },
  });
  const s = await serve(fakeRouter);
  try {
    const raw = rawDb();
    raw
      .prepare(
        `INSERT INTO products (message_id, jid, media_file, title, brand, price, price_source, confidence, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(90211, SUPPLIER_JID, realPhoto, "Nightgown gray", "Ghita Style", 100, "manual", "high", T + 901);
    const id = (raw.prepare("SELECT id FROM products WHERE message_id = 90211").get() as any).id;
    raw.close();

    const res = await s.call("POST", "/api/products/forward", {
      ids: [id], jid: "212600000000@s.whatsapp.net", withPrice: true, markup: 30, confirm: true,
    });
    assert.equal(res.status, 200);
    assert.match(captions[0], /130 DH/, "caption quotes the marked-up price");
    assert.ok(sentPaths[0].includes("130"), `the badge must be the marked-up price too, got ${sentPaths[0]}`);
  } finally {
    s.close();
  }
});

test("forwarding without a price sends the untouched original", async () => {
  const sentPaths: string[] = [];
  const fakeRouter = buildProductsRouter({
    getWhatsAppChats: () => [],
    sendWhatsAppImage: async (_jid: string, absPath: string) => { sentPaths.push(absPath); },
  });
  const s = await serve(fakeRouter);
  try {
    await s.call("POST", "/api/products/sync");
    const list = (await s.call("GET", "/api/products?sort=date_asc")).json.items;
    const res = await s.call("POST", "/api/products/forward", {
      ids: [list[0].id], jid: "212600000000@s.whatsapp.net", withPrice: false, confirm: true,
    });
    assert.equal(res.status, 200);
    assert.ok(!sentPaths[0].includes("/share/"), "no price asked for means no badge burned");
  } finally {
    s.close();
  }
});
