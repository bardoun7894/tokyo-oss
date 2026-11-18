/**
 * Content Studio — persistence.
 *
 * Three tables of its own. The link to the social module is content_publications:
 * one row per social job this studio created (one job per platform, so each
 * platform can carry its own title and caption). Status and links are always
 * read live from social_jobs / social_job_targets, never copied.
 */

import db from "../db";
import { PLATFORMS, type Platform } from "../social/types";
import {
  STAGES,
  type CalendarEvent,
  type Caption,
  type ContentItem,
  type ContentItemRow,
  type Format,
  type Publication,
  type Stage,
} from "./types";

export function initContentTables(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_items (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT NOT NULL,
      hook         TEXT NOT NULL DEFAULT '',
      script       TEXT NOT NULL DEFAULT '',
      notes        TEXT NOT NULL DEFAULT '',
      format       TEXT NOT NULL DEFAULT 'short' CHECK(format IN ('short','long')),
      stage        TEXT NOT NULL DEFAULT 'idea' CHECK(stage IN ('idea','scripted','recorded','edited','scheduled','posted')),
      platforms    TEXT NOT NULL DEFAULT '[]',
      video_path   TEXT,
      video_name   TEXT,
      video_size   INTEGER,
      duration_sec REAL,
      width        INTEGER,
      height       INTEGER,
      scheduled_at INTEGER,
      posted_at    INTEGER,
      sort         REAL NOT NULL DEFAULT 0,
      created_at   TEXT DEFAULT (datetime('now')),
      updated_at   TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_content_items_stage ON content_items(stage, sort);

    CREATE TABLE IF NOT EXISTS content_captions (
      item_id     INTEGER NOT NULL,
      platform    TEXT NOT NULL,
      title       TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      caption     TEXT NOT NULL DEFAULT '',
      hashtags    TEXT NOT NULL DEFAULT '',
      updated_at  TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (item_id, platform)
    );

    CREATE TABLE IF NOT EXISTS content_publications (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id    INTEGER NOT NULL,
      job_id     INTEGER NOT NULL UNIQUE,
      platform   TEXT NOT NULL,
      kind       TEXT NOT NULL DEFAULT 'now' CHECK(kind IN ('now','scheduled')),
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_content_pubs_item ON content_publications(item_id);
  `);
}

export function isStage(v: unknown): v is Stage {
  return typeof v === "string" && (STAGES as readonly string[]).includes(v);
}

export function isFormat(v: unknown): v is Format {
  return v === "short" || v === "long";
}

export function isPlatform(v: unknown): v is Platform {
  return typeof v === "string" && (PLATFORMS as string[]).includes(v);
}

export function cleanPlatforms(v: unknown): Platform[] {
  if (!Array.isArray(v)) return [];
  return PLATFORMS.filter((p) => v.includes(p));
}

function toItem(row: ContentItemRow): ContentItem {
  let platforms: Platform[] = [];
  try {
    platforms = cleanPlatforms(JSON.parse(row.platforms));
  } catch {
    /* corrupt JSON reads as no platforms */
  }
  return { ...row, platforms };
}

/** SQLite datetime('now') text (UTC) → epoch ms. */
export function sqliteUtcToMs(text: string | null): number | null {
  if (!text) return null;
  const ms = Date.parse(text.replace(" ", "T") + "Z");
  return Number.isFinite(ms) ? ms : null;
}

// --- Items ---

export function listItems(): ContentItem[] {
  const rows = db
    .prepare(`SELECT * FROM content_items ORDER BY sort ASC, id ASC`)
    .all() as ContentItemRow[];
  return rows.map(toItem);
}

export function getItem(id: number): ContentItem | undefined {
  const row = db.prepare(`SELECT * FROM content_items WHERE id = ?`).get(id) as ContentItemRow | undefined;
  return row ? toItem(row) : undefined;
}

export function createItem(input: {
  title: string;
  hook?: string;
  script?: string;
  notes?: string;
  format?: Format;
  stage?: Stage;
  platforms?: Platform[];
}): ContentItem {
  const res = db
    .prepare(
      `INSERT INTO content_items (title, hook, script, notes, format, stage, platforms, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.title,
      input.hook ?? "",
      input.script ?? "",
      input.notes ?? "",
      input.format ?? "short",
      input.stage ?? "idea",
      JSON.stringify(input.platforms ?? []),
      Date.now()
    );
  return getItem(Number(res.lastInsertRowid))!;
}

export interface ItemPatch {
  title?: string;
  hook?: string;
  script?: string;
  notes?: string;
  format?: Format;
  stage?: Stage;
  platforms?: Platform[];
  video_path?: string | null;
  video_name?: string | null;
  video_size?: number | null;
  duration_sec?: number | null;
  width?: number | null;
  height?: number | null;
  scheduled_at?: number | null;
  posted_at?: number | null;
  sort?: number;
}

const PATCHABLE: Array<keyof ItemPatch> = [
  "title",
  "hook",
  "script",
  "notes",
  "format",
  "stage",
  "platforms",
  "video_path",
  "video_name",
  "video_size",
  "duration_sec",
  "width",
  "height",
  "scheduled_at",
  "posted_at",
  "sort",
];

export function updateItem(id: number, patch: ItemPatch): ContentItem | undefined {
  const current = getItem(id);
  if (!current) return undefined;

  const values: Record<string, unknown> = {};
  for (const key of PATCHABLE) {
    if (patch[key] === undefined) continue;
    values[key] = key === "platforms" ? JSON.stringify(patch.platforms) : patch[key];
  }
  // A card moved to another column lands at the bottom of it.
  if (patch.stage && patch.stage !== current.stage && patch.sort === undefined) values.sort = Date.now();
  // Moving a card to "posted" by hand still gives the calendar a date.
  if (patch.stage === "posted" && current.posted_at == null && patch.posted_at === undefined) {
    values.posted_at = Date.now();
  }

  const keys = Object.keys(values);
  if (keys.length) {
    const set = keys.map((k) => `${k} = @${k}`).join(", ");
    db.prepare(`UPDATE content_items SET ${set}, updated_at = datetime('now') WHERE id = @id`).run({
      ...values,
      id,
    });
  }
  return getItem(id);
}

export function deleteItem(id: number): boolean {
  const tx = db.transaction((itemId: number) => {
    db.prepare(`DELETE FROM content_captions WHERE item_id = ?`).run(itemId);
    db.prepare(`DELETE FROM content_publications WHERE item_id = ?`).run(itemId);
    return db.prepare(`DELETE FROM content_items WHERE id = ?`).run(itemId).changes > 0;
  });
  return tx(id);
}

/**
 * True when a social job that has not finished yet still points at this file,
 * so replacing or deleting an item's video must leave it on disk.
 */
export function mediaInUse(mediaPath: string): boolean {
  try {
    const row = db
      .prepare(
        `SELECT 1 FROM social_jobs WHERE media_path = ? AND status IN ('draft','scheduled','running') LIMIT 1`
      )
      .get(mediaPath);
    return Boolean(row);
  } catch {
    return true; // no social tables — err on the side of keeping the file
  }
}

// --- Captions ---

export function emptyCaption(): Caption {
  return { title: "", description: "", caption: "", hashtags: "" };
}

export function getCaptions(itemId: number): Record<Platform, Caption> {
  const out = {} as Record<Platform, Caption>;
  for (const p of PLATFORMS) out[p] = emptyCaption();
  const rows = db
    .prepare(`SELECT platform, title, description, caption, hashtags FROM content_captions WHERE item_id = ?`)
    .all(itemId) as Array<Caption & { platform: string }>;
  for (const r of rows) {
    if (!isPlatform(r.platform)) continue;
    out[r.platform] = { title: r.title, description: r.description, caption: r.caption, hashtags: r.hashtags };
  }
  return out;
}

export function saveCaptions(itemId: number, captions: Partial<Record<Platform, Partial<Caption>>>): void {
  const upsert = db.prepare(
    `INSERT INTO content_captions (item_id, platform, title, description, caption, hashtags, updated_at)
     VALUES (@item_id, @platform, @title, @description, @caption, @hashtags, datetime('now'))
     ON CONFLICT(item_id, platform) DO UPDATE SET
       title = excluded.title, description = excluded.description,
       caption = excluded.caption, hashtags = excluded.hashtags, updated_at = datetime('now')`
  );
  const current = getCaptions(itemId);
  const tx = db.transaction(() => {
    for (const p of PLATFORMS) {
      const patch = captions[p];
      if (!patch) continue;
      const next = { ...current[p] };
      for (const f of ["title", "description", "caption", "hashtags"] as const) {
        if (typeof patch[f] === "string") next[f] = patch[f]!;
      }
      upsert.run({ item_id: itemId, platform: p, ...next });
    }
  });
  tx();
}

// --- Publications (links to social jobs) ---

export function linkJob(itemId: number, jobId: number, platform: Platform, kind: "now" | "scheduled"): void {
  db.prepare(
    `INSERT OR IGNORE INTO content_publications (item_id, job_id, platform, kind) VALUES (?, ?, ?, ?)`
  ).run(itemId, jobId, platform, kind);
}

const PUBLICATION_SELECT = `
  SELECT p.id, p.item_id, p.job_id, p.platform, p.kind, p.created_at,
         j.status AS job_status, j.scheduled_at, j.finished_at,
         t.status AS target_status, t.url, t.error, t.warning
    FROM content_publications p
    LEFT JOIN social_jobs j ON j.id = p.job_id
    LEFT JOIN social_job_targets t ON t.job_id = p.job_id AND t.platform = p.platform`;

export function listPublications(itemId: number): Publication[] {
  return db
    .prepare(`${PUBLICATION_SELECT} WHERE p.item_id = ? ORDER BY p.id DESC`)
    .all(itemId) as Publication[];
}

export function isPublicationActive(p: Publication): boolean {
  // A 'draft' job with a pending target is either next in an in-process publish
  // run (the router skips syncing those items) or orphaned by a restart; neither
  // should pin the item's stage forever.
  return p.job_status === "scheduled" || p.job_status === "running" || p.target_status === "running";
}

/**
 * Bring an item's stage in line with its social jobs: a platform that posted
 * moves the item to "posted"; a schedule whose jobs are all gone or cancelled
 * drops it back to "edited".
 */
export function syncItem(itemId: number): ContentItem | undefined {
  const item = getItem(itemId);
  if (!item) return undefined;
  const pubs = listPublications(itemId);
  if (!pubs.length) return item;

  const posted = pubs.filter((p) => p.target_status === "done");
  const stillScheduled = pubs.filter((p) => p.job_status === "scheduled");
  const active = pubs.some(isPublicationActive);

  if (posted.length && !active && item.stage !== "posted") {
    const times = posted.map((p) => sqliteUtcToMs(p.finished_at)).filter((t): t is number => t !== null);
    return updateItem(itemId, {
      stage: "posted",
      posted_at: times.length ? Math.max(...times) : Date.now(),
      scheduled_at: null,
    });
  }
  if (item.stage === "scheduled" && !stillScheduled.length && !active && !posted.length) {
    return updateItem(itemId, { stage: "edited", scheduled_at: null });
  }
  if (stillScheduled.length) {
    const next = Math.min(...stillScheduled.map((p) => p.scheduled_at || Infinity));
    if (Number.isFinite(next) && next !== item.scheduled_at) return updateItem(itemId, { scheduled_at: next });
  }
  return item;
}

/** Items whose social jobs could still change state — cheap to resync on read. */
export function itemsNeedingSync(): number[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT p.item_id FROM content_publications p
         JOIN content_items i ON i.id = p.item_id
        WHERE i.stage != 'posted'`
    )
    .all() as Array<{ item_id: number }>;
  return rows.map((r) => r.item_id);
}

/** Per-item summary for board cards: platform → latest target status. */
export function publicationSummary(): Record<number, Array<{ platform: Platform; status: string; url: string | null }>> {
  const rows = db.prepare(`${PUBLICATION_SELECT} ORDER BY p.id DESC`).all() as Publication[];
  const out: Record<number, Array<{ platform: Platform; status: string; url: string | null }>> = {};
  for (const r of rows) {
    const list = (out[r.item_id] ||= []);
    if (list.some((x) => x.platform === r.platform)) continue; // newest wins
    const status = r.job_status === "scheduled" || r.job_status === "cancelled" ? r.job_status : r.target_status || r.job_status || "unknown";
    list.push({ platform: r.platform, status, url: r.url });
  }
  return out;
}

// --- Calendar ---

export function calendarEvents(fromMs: number, toMs: number): CalendarEvent[] {
  const rows = db
    .prepare(
      `${PUBLICATION_SELECT.replace("SELECT p.id,", "SELECT i.title AS item_title, i.format AS item_format, i.posted_at AS item_posted_at, p.id,")}
       JOIN content_items i ON i.id = p.item_id`
    )
    .all() as Array<Publication & { item_title: string; item_format: Format; item_posted_at: number | null }>;

  const groups = new Map<string, CalendarEvent>();
  const add = (
    r: { item_id: number; item_title: string; item_format: Format },
    kind: CalendarEvent["kind"],
    at: number,
    platform: Platform | null,
    url: string | null
  ) => {
    if (at < fromMs || at >= toMs) return;
    // Jobs of one publish/schedule action share a minute; group them into one chip.
    const key = `${r.item_id}:${kind}:${Math.floor(at / 60_000)}`;
    let ev = groups.get(key);
    if (!ev) {
      ev = { itemId: r.item_id, title: r.item_title, format: r.item_format, kind, at, platforms: [], urls: [] };
      groups.set(key, ev);
    }
    if (platform && !ev.platforms.includes(platform)) ev.platforms.push(platform);
    if (platform && url) ev.urls.push({ platform, url });
  };

  const itemsWithEvents = new Set<number>();
  for (const r of rows) {
    if (r.job_status === "scheduled" && r.scheduled_at) {
      add(r, "scheduled", r.scheduled_at, r.platform, null);
      itemsWithEvents.add(r.item_id);
    } else if (r.target_status === "done") {
      add(r, "posted", sqliteUtcToMs(r.finished_at) ?? r.item_posted_at ?? Date.now(), r.platform, r.url);
      itemsWithEvents.add(r.item_id);
    } else if (r.target_status === "failed" || r.job_status === "failed") {
      const at = sqliteUtcToMs(r.finished_at) ?? r.scheduled_at;
      if (at) add(r, "failed", at, r.platform, null);
    }
  }

  // Items marked posted by hand (no studio publication) still show on their day.
  const manual = db
    .prepare(`SELECT id, title, format, posted_at FROM content_items WHERE stage = 'posted' AND posted_at IS NOT NULL`)
    .all() as Array<{ id: number; title: string; format: Format; posted_at: number }>;
  for (const m of manual) {
    if (itemsWithEvents.has(m.id)) continue;
    add({ item_id: m.id, item_title: m.title, item_format: m.format }, "posted", m.posted_at, null, null);
  }

  return [...groups.values()].sort((a, b) => a.at - b.at);
}
