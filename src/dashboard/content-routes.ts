/**
 * Dashboard API — Content Studio.
 *
 * Plan videos, draft per-platform copy, upload the file, then publish or
 * schedule through the social module. Mounted from routes.ts with one
 * router.use(), like instagram-routes.
 */

import { Router, type Request, type Response } from "express";
import fs from "fs";
import path from "path";
import { ADAPTERS } from "../social/adapters";
import { probe, publicHostingReady } from "../social/media";
import { getAccount } from "../social/store";
import { PLATFORMS, PLATFORM_LABEL, type Platform } from "../social/types";
import { draftCaptions } from "../content/ai";
import { cancelSchedule, isPublishing, preflight, publishNow, scheduleItem, UPLOAD_DIR } from "../content/publish";
import {
  calendarEvents,
  cleanPlatforms,
  createItem,
  deleteItem,
  getCaptions,
  getItem,
  initContentTables,
  isFormat,
  isStage,
  itemsNeedingSync,
  listItems,
  listPublications,
  mediaInUse,
  publicationSummary,
  saveCaptions,
  syncItem,
  updateItem,
  type ItemPatch,
} from "../content/store";
import { CAPTION_FIELDS, CAPTION_LIMITS, STAGES, type Caption } from "../content/types";

initContentTables();

const router = Router();

const VIDEO_EXT = /^\.(mp4|mov|m4v|webm)$/i;
const MAX_UPLOAD_BYTES = Number(process.env.CONTENT_UPLOAD_MAX_MB || 4096) * 1024 * 1024;

function itemId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Bad item id" });
    return null;
  }
  return id;
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" ? v.slice(0, max) : undefined;
}

function privacyOf(v: unknown): "public" | "private" {
  return v === "private" ? "private" : "public";
}

/** Delete an uploaded file, but only one this studio owns and nothing still needs. */
function removeVideoIfUnused(filePath: string | null): void {
  if (!filePath) return;
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(UPLOAD_DIR + path.sep)) return;
  if (mediaInUse(resolved)) return;
  fs.rm(resolved, { force: true }, () => {});
}

function detail(id: number) {
  const item = isPublishing(id) ? getItem(id) : syncItem(id);
  if (!item) return null;
  return {
    item,
    captions: getCaptions(id),
    publications: listPublications(id),
    publishing: isPublishing(id),
    videoExists: Boolean(item.video_path && fs.existsSync(item.video_path)),
  };
}

// --- Platforms / meta ---

router.get("/api/content/platforms", (_req, res) => {
  try {
    res.json({
      stages: STAGES,
      fields: CAPTION_FIELDS,
      limits: CAPTION_LIMITS,
      publicHosting: publicHostingReady(),
      platforms: PLATFORMS.map((p) => {
        const adapter = ADAPTERS[p];
        const account = getAccount(p);
        const configured = adapter.isConfigured();
        return {
          platform: p,
          label: PLATFORM_LABEL[p],
          connected: Boolean(account?.access_token),
          accountLabel: account?.label || account?.account_id || null,
          expiresAt: account?.expires_at || null,
          configured,
          missing: configured ? "" : adapter.missing(),
          requiresPublicUrl: adapter.requiresPublicUrl,
          supportsShort: adapter.supports("short"),
          supportsLong: adapter.supports("video"),
        };
      }),
    });
  } catch (err) {
    console.error("Content platforms error:", err);
    res.status(500).json({ error: "Failed to read platform status" });
  }
});

// --- Items ---

router.get("/api/content/items", (_req, res) => {
  try {
    for (const id of itemsNeedingSync()) if (!isPublishing(id)) syncItem(id);
    const summary = publicationSummary();
    res.json(listItems().map((item) => ({ ...item, publications: summary[item.id] || [] })));
  } catch (err) {
    console.error("Content list error:", err);
    res.status(500).json({ error: "Failed to list content items" });
  }
});

router.post("/api/content/items", (req, res) => {
  const body = req.body ?? {};
  const title = str(body.title, 300)?.trim();
  if (!title) {
    res.status(400).json({ error: "A title is required" });
    return;
  }
  const item = createItem({
    title,
    hook: str(body.hook, 2000),
    script: str(body.script, 100_000),
    notes: str(body.notes, 20_000),
    format: isFormat(body.format) ? body.format : "short",
    stage: isStage(body.stage) && body.stage !== "scheduled" && body.stage !== "posted" ? body.stage : "idea",
    platforms: cleanPlatforms(body.platforms),
  });
  res.json({ ok: true, item });
});

router.get("/api/content/items/:id", (req, res) => {
  const id = itemId(req, res);
  if (id === null) return;
  const d = detail(id);
  if (!d) {
    res.status(404).json({ error: "No such item" });
    return;
  }
  res.json(d);
});

router.post("/api/content/items/:id", (req, res) => {
  const id = itemId(req, res);
  if (id === null) return;
  const current = getItem(id);
  if (!current) {
    res.status(404).json({ error: "No such item" });
    return;
  }
  const body = req.body ?? {};
  const patch: ItemPatch = {};
  const title = str(body.title, 300);
  if (title !== undefined) {
    if (!title.trim()) {
      res.status(400).json({ error: "Title cannot be empty" });
      return;
    }
    patch.title = title.trim();
  }
  if (body.hook !== undefined) patch.hook = str(body.hook, 2000) ?? "";
  if (body.script !== undefined) patch.script = str(body.script, 100_000) ?? "";
  if (body.notes !== undefined) patch.notes = str(body.notes, 20_000) ?? "";
  if (isFormat(body.format)) patch.format = body.format;
  if (body.platforms !== undefined) patch.platforms = cleanPlatforms(body.platforms);
  if (body.stage !== undefined) {
    if (!isStage(body.stage)) {
      res.status(400).json({ error: "Unknown stage" });
      return;
    }
    // "scheduled" means real social jobs exist; it is set by scheduling, not by dragging.
    if (body.stage === "scheduled" && current.stage !== "scheduled") {
      res.status(400).json({ error: "Use Schedule in the item to move it to scheduled" });
      return;
    }
    if (current.stage === "scheduled" && body.stage !== "scheduled" && listPublications(id).some((p) => p.job_status === "scheduled")) {
      res.status(409).json({ error: "Cancel the schedule first" });
      return;
    }
    patch.stage = body.stage;
    if (body.stage !== "posted") patch.posted_at = null;
  }
  if (typeof body.sort === "number" && Number.isFinite(body.sort)) patch.sort = body.sort;
  res.json({ ok: true, item: updateItem(id, patch) });
});

router.delete("/api/content/items/:id", (req, res) => {
  const id = itemId(req, res);
  if (id === null) return;
  const item = getItem(id);
  if (!item) {
    res.status(404).json({ error: "No such item" });
    return;
  }
  if (isPublishing(id)) {
    res.status(409).json({ error: "This item is publishing right now" });
    return;
  }
  const cancelled = cancelSchedule(id);
  deleteItem(id);
  removeVideoIfUnused(item.video_path);
  res.json({ ok: true, cancelled });
});

// --- Captions ---

router.post("/api/content/items/:id/captions", (req, res) => {
  const id = itemId(req, res);
  if (id === null) return;
  if (!getItem(id)) {
    res.status(404).json({ error: "No such item" });
    return;
  }
  const input = req.body?.captions;
  if (!input || typeof input !== "object") {
    res.status(400).json({ error: "captions object required" });
    return;
  }
  const clean: Partial<Record<Platform, Partial<Caption>>> = {};
  for (const p of PLATFORMS) {
    const c = input[p];
    if (!c || typeof c !== "object") continue;
    clean[p] = {
      title: str(c.title, 1000),
      description: str(c.description, 10_000),
      caption: str(c.caption, 10_000),
      hashtags: str(c.hashtags, 2000),
    };
  }
  saveCaptions(id, clean);
  res.json({ ok: true, captions: getCaptions(id) });
});

/** Generates a draft and returns it WITHOUT saving — the editor decides. */
router.post("/api/content/items/:id/captions/draft", async (req, res) => {
  const id = itemId(req, res);
  if (id === null) return;
  const item = getItem(id);
  if (!item) {
    res.status(404).json({ error: "No such item" });
    return;
  }
  const requested = cleanPlatforms(req.body?.platforms);
  const platforms = requested.length ? requested : item.platforms.length ? item.platforms : PLATFORMS;
  try {
    const drafts = await draftCaptions(item, platforms);
    res.json({ ok: true, drafts });
  } catch (err) {
    console.error("Content caption draft error:", err);
    res.status(502).json({ error: `AI draft failed: ${(err as Error).message}` });
  }
});

// --- Video upload ---

/**
 * Raw body upload: `POST /api/content/items/:id/upload?name=clip.mp4` with
 * Content-Type application/octet-stream. express.json() ignores that type, so
 * the request stream reaches here untouched and goes straight to disk.
 */
router.post("/api/content/items/:id/upload", (req, res) => {
  const id = itemId(req, res);
  if (id === null) return;
  const item = getItem(id);
  if (!item) {
    res.status(404).json({ error: "No such item" });
    return;
  }
  if (req.is("application/json")) {
    res.status(400).json({ error: "Send the file as application/octet-stream" });
    return;
  }
  const original = path.basename(String(req.query.name || "video.mp4")).slice(0, 200);
  const ext = path.extname(original).toLowerCase();
  if (!VIDEO_EXT.test(ext)) {
    res.status(400).json({ error: "Only .mp4, .mov, .m4v or .webm" });
    return;
  }
  if (Number(req.headers["content-length"] || 0) > MAX_UPLOAD_BYTES) {
    res.status(413).json({ error: `File is over the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit` });
    return;
  }

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const finalPath = path.join(UPLOAD_DIR, `item-${id}-${Date.now()}${ext}`);
  const partPath = `${finalPath}.part`;
  const out = fs.createWriteStream(partPath);
  let bytes = 0;
  let failed = false;

  const fail = (status: number, message: string) => {
    if (failed) return;
    failed = true;
    req.unpipe(out);
    out.destroy();
    fs.rm(partPath, { force: true }, () => {});
    if (!res.headersSent) res.status(status).json({ error: message });
  };

  req.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_UPLOAD_BYTES) {
      fail(413, "File is over the upload limit");
      req.destroy();
    }
  });
  req.on("close", () => {
    if (!req.complete) fail(400, "Upload interrupted");
  });
  out.on("error", (err) => fail(500, `Could not write the file: ${err.message}`));
  out.on("finish", async () => {
    if (failed) return;
    if (bytes === 0) return fail(400, "Empty upload");
    try {
      fs.renameSync(partPath, finalPath);
    } catch (err) {
      return fail(500, `Could not store the file: ${(err as Error).message}`);
    }
    let asset;
    try {
      asset = await probe(finalPath);
    } catch (err) {
      fs.rm(finalPath, { force: true }, () => {});
      res.status(400).json({ error: `Not a playable video: ${(err as Error).message}` });
      return;
    }
    const fresh = getItem(id);
    if (!fresh) {
      fs.rm(finalPath, { force: true }, () => {});
      res.status(404).json({ error: "Item was deleted during upload" });
      return;
    }
    const previous = fresh.video_path;
    const updated = updateItem(id, {
      video_path: finalPath,
      video_name: original,
      video_size: asset.sizeBytes,
      duration_sec: asset.durationSec,
      width: asset.width,
      height: asset.height,
      ...(fresh.stage === "idea" || fresh.stage === "scripted" ? { stage: "recorded" as const } : {}),
    });
    if (previous && previous !== finalPath) removeVideoIfUnused(previous);
    res.json({ ok: true, item: updated });
  });

  req.pipe(out);
});

router.delete("/api/content/items/:id/video", (req, res) => {
  const id = itemId(req, res);
  if (id === null) return;
  const item = getItem(id);
  if (!item) {
    res.status(404).json({ error: "No such item" });
    return;
  }
  removeVideoIfUnused(item.video_path);
  res.json({
    ok: true,
    item: updateItem(id, { video_path: null, video_name: null, video_size: null, duration_sec: null, width: null, height: null }),
  });
});

// --- Publish / schedule ---

router.post("/api/content/items/:id/preflight", (req, res) => {
  const id = itemId(req, res);
  if (id === null) return;
  const item = getItem(id);
  if (!item) {
    res.status(404).json({ error: "No such item" });
    return;
  }
  res.json(preflight(item, cleanPlatforms(req.body?.platforms)));
});

router.post("/api/content/items/:id/publish", (req, res) => {
  const id = itemId(req, res);
  if (id === null) return;
  const item = getItem(id);
  if (!item) {
    res.status(404).json({ error: "No such item" });
    return;
  }
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: "Publishing needs confirm: true" });
    return;
  }
  try {
    const result = publishNow(item, cleanPlatforms(req.body?.platforms), privacyOf(req.body?.privacy));
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.post("/api/content/items/:id/schedule", (req, res) => {
  const id = itemId(req, res);
  if (id === null) return;
  const item = getItem(id);
  if (!item) {
    res.status(404).json({ error: "No such item" });
    return;
  }
  try {
    const result = scheduleItem(
      item,
      cleanPlatforms(req.body?.platforms),
      Number(req.body?.when),
      privacyOf(req.body?.privacy)
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.post("/api/content/items/:id/unschedule", (req, res) => {
  const id = itemId(req, res);
  if (id === null) return;
  if (!getItem(id)) {
    res.status(404).json({ error: "No such item" });
    return;
  }
  res.json({ ok: true, cancelled: cancelSchedule(id) });
});

// --- Calendar ---

/** `?month=YYYY-MM` — events in that month, padded a week either side for the grid. */
router.get("/api/content/calendar", (req, res) => {
  const m = /^(\d{4})-(\d{2})$/.exec(String(req.query.month || ""));
  const now = new Date();
  const year = m ? Number(m[1]) : now.getFullYear();
  const month = m ? Number(m[2]) - 1 : now.getMonth();
  const from = new Date(year, month, 1).getTime() - 7 * 86400_000;
  const to = new Date(year, month + 1, 1).getTime() + 7 * 86400_000;
  try {
    for (const id of itemsNeedingSync()) if (!isPublishing(id)) syncItem(id);
    res.json({ from, to, events: calendarEvents(from, to) });
  } catch (err) {
    console.error("Content calendar error:", err);
    res.status(500).json({ error: "Failed to build calendar" });
  }
});

export default router;
