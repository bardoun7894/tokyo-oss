/**
 * Products: the supplier photo catalog synced from WhatsApp image bursts,
 * auto-paired with the price bursts that follow. See
 * specs/products-catalog/CONTRACT.md — this file implements the API exactly
 * as specified there (field names, status codes, query params) because the
 * dashboard frontend is coded against that document, not against this file.
 *
 * Mounted under /api/products from routes.ts.
 */
import express, { type Request, type Response, type Router } from "express";
import fs from "fs";
import path from "path";
import * as db from "../db";
import { pairPrices, pairingBatchDetails, type RawMsg } from "../products/pairing";
import { extractTitle, resolveCaption } from "../products/extract";
import * as realWhatsApp from "../whatsapp";
import { mediaDir } from "../media-dir";
import { ensurePricedImage } from "../products/badge";

const FORWARD_SLEEP_MS = 1200;

export interface WhatsAppDeps {
  getWhatsAppChats: typeof realWhatsApp.getWhatsAppChats;
  sendWhatsAppImage: typeof realWhatsApp.sendWhatsAppImage;
}

function toRawMsg(m: db.RawJidMessage): RawMsg {
  return {
    id: m.id, fromMe: m.from_me === 1, type: m.type, content: m.content, mediaPath: m.media_path, timestamp: m.timestamp,
    waMsgId: m.wa_msg_id, quotedMsgId: m.quoted_msg_id,
  };
}

export interface ProductsSyncResult {
  scanned: number;
  added: number;
  paired: number;
  unpriced: number;
  batches: number;
}

/**
 * The full sync: rescans every supplier chat's messages, re-pairs images
 * with prices, and upserts. Deliberately a full rescan every time, not
 * incremental-by-new-images-only — a price burst can arrive days after its
 * images, so an incremental scan would permanently miss it (see CONTRACT.md
 * decision C5). Measured at ~326ms cold / ~209ms warm over the full ~9,500
 * image supplier history, so a full rescan on every run is cheap enough to
 * not need a cheaper "only unpriced/changed batches" strategy.
 *
 * Shared by the POST /api/products/sync route and the periodic scheduler
 * below, so there is exactly one implementation of what "a sync" means.
 */
export function runProductsSync(): ProductsSyncResult {
  const jids = db.getSupplierJids();
  const existingSources = db.getExistingProductSources();

  let scanned = 0;
  let added = 0;
  let paired = 0;
  let unpriced = 0;
  const batchIds = new Set<string>();
  const rows: db.ProductUpsert[] = [];

  for (const jid of jids) {
    const raw = db.getMessagesForJid(jid);
    const msgs = raw.map(toRawMsg);
    const byId = new Map(raw.map((m) => [m.id, m]));

    const pairings = pairPrices(msgs);
    for (const p of pairings) {
      scanned++;
      batchIds.add(p.batchId);
      if (p.price !== null) paired++;
      else unpriced++;
      if (!existingSources.has(p.messageId)) added++;

      const src = byId.get(p.messageId)!;
      const mediaFile = src.media_path ? path.basename(src.media_path) : "";
      const caption = resolveCaption(src.content, src.transcription);
      const { title, brand } = extractTitle(caption, p.messageId);

      rows.push({
        messageId: p.messageId,
        jid,
        mediaFile,
        title,
        brand,
        price: p.price,
        priceSource: p.source,
        confidence: p.confidence,
        batchId: p.batchId,
        priceMessageId: p.priceMessageId,
        timestamp: src.timestamp,
      });
    }
  }

  db.upsertProducts(rows);

  return { scanned, added, paired, unpriced, batches: batchIds.size };
}

/** Full rescan every ~10 minutes — see runProductsSync() doc for why "full" is fine. */
export const PRODUCTS_SYNC_INTERVAL_MS = 10 * 60 * 1000;
/** First sync shortly after boot, once the migration has created the products table. */
export const PRODUCTS_FIRST_SYNC_DELAY_MS = 5 * 1000;

let productsSyncSchedulerStarted = false;
let productsSyncRunCount = 0;

/** Test-only: how many times the scheduled (boot + interval) run has fired. */
export function getProductsSyncRunCountForTest(): number {
  return productsSyncRunCount;
}

function scheduledProductsSyncRun(): void {
  try {
    const r = runProductsSync();
    productsSyncRunCount++;
    console.log(`[products-sync] scanned=${r.scanned} added=${r.added} paired=${r.paired} unpriced=${r.unpriced} batches=${r.batches}`);
  } catch (err) {
    console.error("[products-sync] error:", err);
  }
}

/**
 * Idempotent: a boot-time sync shortly after startup, then a full rescan
 * every PRODUCTS_SYNC_INTERVAL_MS. Mirrors src/projects-sync.ts's
 * startProjectReposSync() — same guard shape (module flag + globalThis flag,
 * so a hot-reload re-import can't double-register), same
 * setTimeout(...).unref() + setInterval(...).unref() so the scheduler never
 * keeps the process alive on its own.
 */
export function startProductsSync(): void {
  const g = globalThis as { __tokyoProductsSync?: boolean };
  if (productsSyncSchedulerStarted || g.__tokyoProductsSync) return;
  productsSyncSchedulerStarted = true;
  g.__tokyoProductsSync = true;
  setTimeout(scheduledProductsSyncRun, PRODUCTS_FIRST_SYNC_DELAY_MS).unref();
  setInterval(scheduledProductsSyncRun, PRODUCTS_SYNC_INTERVAL_MS).unref();
}

/**
 * Built as a factory (not a module-level router) so tests can inject a fake
 * WhatsApp module for the forward/forward-targets endpoints — the socket
 * module is not something a test should ever touch for real. See
 * products-routes.test.ts. routes.ts still gets a plain Router via the
 * default export at the bottom of this file, wired to the real module.
 */
export function buildProductsRouter(deps: WhatsAppDeps = realWhatsApp): Router {
  const router = express.Router();
  const { getWhatsAppChats, sendWhatsAppImage } = deps;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mediaUrls(file: string): { thumb: string; full: string } {
  return { thumb: `/api/media/${file}?w=400`, full: `/api/media/${file}` };
}

function toApiProduct(row: db.ProductWithCaption) {
  const { thumb, full } = mediaUrls(row.media_file);
  return {
    id: row.id,
    messageId: row.message_id,
    file: row.media_file,
    thumb,
    full,
    title: row.title,
    brand: row.brand,
    price: row.price,
    currency: row.currency,
    priceSource: row.price_source,
    confidence: row.confidence,
    batchId: row.batch_id,
    status: row.status,
    timestamp: row.timestamp,
    caption: row.caption ? row.caption.slice(0, 400) : null,
  };
}

// GET /api/products
router.get("/api/products", (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "60"), 10) || 60, 1), 200);
    const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
    const min = req.query.min !== undefined ? Number(req.query.min) : undefined;
    const max = req.query.max !== undefined ? Number(req.query.max) : undefined;

    const { items, total } = db.listProducts({
      sort: typeof req.query.sort === "string" ? req.query.sort : undefined,
      q: typeof req.query.q === "string" ? req.query.q : undefined,
      min: Number.isFinite(min as number) ? min : undefined,
      max: Number.isFinite(max as number) ? max : undefined,
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      unpriced: req.query.unpriced === "1",
      batch: typeof req.query.batch === "string" ? req.query.batch : undefined,
      limit,
      offset,
    });

    res.json({ items: items.map(toApiProduct), total });
  } catch (err) {
    console.error("products list error:", err);
    res.status(500).json({ error: "Failed to load products" });
  }
});

// GET /api/products/stats
router.get("/api/products/stats", (_req: Request, res: Response) => {
  try {
    res.json(db.getProductStats());
  } catch (err) {
    console.error("products stats error:", err);
    res.status(500).json({ error: "Failed to load product stats" });
  }
});

// POST /api/products/sync
router.post("/api/products/sync", (_req: Request, res: Response) => {
  try {
    res.json(runProductsSync());
  } catch (err) {
    console.error("products sync error:", err);
    res.status(500).json({ error: "Failed to sync products" });
  }
});

// PATCH /api/products/:id
router.patch("/api/products/:id", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "invalid id" }); return; }
  const existing = db.getProduct(id);
  if (!existing) { res.status(404).json({ error: "not found" }); return; }

  const { price, title, brand, status, notes } = req.body || {};
  const fields: { price?: number | null; title?: string; brand?: string | null; status?: string; notes?: string } = {};

  if (price !== undefined) {
    if (price !== null && (typeof price !== "number" || !Number.isFinite(price) || price < 0)) {
      res.status(400).json({ error: "price must be a non-negative number or null" });
      return;
    }
    fields.price = price;
  }
  if (title !== undefined) {
    if (typeof title !== "string" || !title.trim()) { res.status(400).json({ error: "title must be a non-empty string" }); return; }
    fields.title = title;
  }
  if (brand !== undefined) fields.brand = brand === null ? null : String(brand);
  if (status !== undefined) {
    if (!["new", "kept", "hidden"].includes(status)) { res.status(400).json({ error: "status must be new, kept or hidden" }); return; }
    fields.status = status;
  }
  if (notes !== undefined) fields.notes = notes === null ? "" : String(notes);

  const updated = db.updateProductFields(id, fields);
  res.json(updated ? toApiProduct({ ...updated, caption: null }) : null);
});

// GET /api/products/batches
router.get("/api/products/batches", (_req: Request, res: Response) => {
  try {
    res.json({ batches: db.listProductBatches() });
  } catch (err) {
    console.error("products batches error:", err);
    res.status(500).json({ error: "Failed to load batches" });
  }
});

// GET /api/products/batches/:batchId
router.get("/api/products/batches/:batchId", (req: Request, res: Response) => {
  try {
    const batchId = String(req.params.batchId);
    const images = db.getBatchImages(batchId);
    if (images.length === 0) { res.status(404).json({ error: "batch not found" }); return; }

    const jid = db.getBatchJid(batchId);
    let prices: { messageId: number; value: number; assignedTo: number | null }[] = [];
    if (jid) {
      const msgs = db.getMessagesForJid(jid).map(toRawMsg);
      const detail = pairingBatchDetails(msgs).find((b) => b.batchId === batchId);
      if (detail) prices = detail.prices;
    }

    res.json({ batchId, images: images.map(toApiProduct), prices });
  } catch (err) {
    console.error("products batch detail error:", err);
    res.status(500).json({ error: "Failed to load batch" });
  }
});

// POST /api/products/batches/:batchId/assign
router.post("/api/products/batches/:batchId/assign", (req: Request, res: Response) => {
  try {
    const batchId = String(req.params.batchId);
    const pairs = req.body?.pairs;
    if (!Array.isArray(pairs)) { res.status(400).json({ error: "pairs must be an array" }); return; }
    for (const p of pairs) {
      if (typeof p?.productId !== "number" || typeof p?.priceMessageId !== "number") {
        res.status(400).json({ error: "each pair needs a numeric productId and priceMessageId" });
        return;
      }
    }
    const updated = db.assignBatchPairs(batchId, pairs);
    res.json({ updated });
  } catch (err) {
    console.error("products batch assign error:", err);
    res.status(500).json({ error: "Failed to assign batch" });
  }
});

// GET /api/products/forward-targets
router.get("/api/products/forward-targets", (_req: Request, res: Response) => {
  try {
    // Read from the message history, not getWhatsAppChats(): that is an
    // in-memory Map filled only as messages arrive, so after a restart it held
    // a handful of chats and the picker looked broken. Forwarding happens long
    // after a chat was last active, so the list must come from storage.
    const targets = db.listForwardTargets().sort((a, b) => a.name.localeCompare(b.name));
    res.json({ targets });
  } catch (err) {
    console.error("products forward-targets error:", err);
    res.status(500).json({ error: "Failed to load forward targets" });
  }
});

/**
 * The price the customer is quoted, markup applied. Shared by the caption and
 * by the badge burned into the photo — they have to be the same number, or a
 * forward shows one price on the image and another in the text.
 */
function finalPriceFor(price: number, markup: number | undefined): number {
  return markup ? Math.round(price * (1 + markup / 100)) : price;
}

function captionFor(title: string | null, price: number | null, markup: number | undefined, withPrice: boolean, note: string | undefined): string {
  const name = title || "Product";
  if (!withPrice || price === null) return note ? `${name}\n${note}` : name;
  const base = `${name}\n${finalPriceFor(price, markup)} DH`;
  return note ? `${base}\n${note}` : base;
}

// POST /api/products/forward
router.post("/api/products/forward", async (req: Request, res: Response) => {
  try {
    const { ids, jid, withPrice, markup, note, confirm } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((i: unknown) => typeof i === "number")) {
      res.status(400).json({ error: "ids must be a non-empty array of numbers" });
      return;
    }
    if (typeof jid !== "string" || !jid.includes("@")) {
      res.status(400).json({ error: "jid is required" });
      return;
    }

    const products = ids.map((id: number) => db.getProduct(id)).filter((p): p is db.ProductRow => !!p);
    if (products.length === 0) { res.status(404).json({ error: "no matching products" }); return; }

    const captions = products.map((p) => captionFor(p.title, p.price, markup, !!withPrice, note));

    if (confirm !== true) {
      res.status(400).json({
        error: "confirmation required",
        preview: { count: products.length, target: jid, captions },
      });
      return;
    }

    let sent = 0;
    const errors: { id: number; message: string }[] = [];
    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      try {
        const absPath = path.join(mediaDir(), p.media_file);
        if (!p.media_file || !fs.existsSync(absPath)) throw new Error("media file missing");
        // With a price, send the photo that HAS the price on it. A caption is
        // dropped the moment the customer forwards the photo on, and an album
        // shares one caption between all of its images; the burned-in badge is
        // the only copy of the price that travels with the product.
        let toSend = absPath;
        if (withPrice && p.price !== null) {
          const badged = await ensurePricedImage(
            mediaDir(),
            path.basename(p.media_file),
            finalPriceFor(p.price, markup),
            p.currency || "DH"
          );
          // null means sharp could not read it — send the original rather than
          // dropping the product out of the batch.
          if (badged) toSend = badged;
        }
        await sendWhatsAppImage(jid, toSend, captions[i]);
        sent++;
      } catch (err: any) {
        errors.push({ id: p.id, message: err?.message || "send failed" });
      }
      if (i < products.length - 1) await sleep(FORWARD_SLEEP_MS);
    }

    res.json({ sent, failed: errors.length, errors });
  } catch (err) {
    console.error("products forward error:", err);
    res.status(500).json({ error: "Failed to forward products" });
  }
});

  return router;
}

// Boot-time + periodic sync so the catalog never stays empty because
// nobody clicked "Sync" — see startProductsSync() doc above.
startProductsSync();

export default buildProductsRouter();
