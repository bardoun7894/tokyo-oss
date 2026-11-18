import express from "express";
import type { Database } from "better-sqlite3";
import { errorBody } from "./contract";
import { pageOf, parsePage } from "./paging";
import { redact } from "./redact";

/**
 * The Telegram feed: every message Tokyo (and the loopback senders) put in the owner's chat, kept so
 * the phone can show it as a timeline. Text is redacted before it is stored; buttons keep their
 * labels only, never their callback data. Rows older than RETENTION_MS or past MAX_ROWS are pruned.
 */

export const FEED_KINDS = ["approval", "deploy", "incident", "error", "run", "money", "info"] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_ROWS = 5000;
export const MAX_TEXT = 4000;
const MAX_BUTTONS = 8;
const MAX_LABEL = 40;
const SOURCE = /^[A-Za-z0-9._-]{1,32}$/;

export interface FeedItem {
  id: number; at: number; source: string; kind: FeedKind; text: string; buttons: string[]; edited: boolean;
}

interface FeedRow { id: number; at: number; source: string; kind: string; text: string; buttons: string; edited: number }

const toItem = (r: FeedRow): FeedItem => ({
  id: r.id, at: r.at, source: r.source, kind: (FEED_KINDS as readonly string[]).includes(r.kind) ? (r.kind as FeedKind) : "info",
  text: r.text, buttons: JSON.parse(r.buttons || "[]"), edited: r.edited === 1,
});

/** A label from the text: cheap keyword rules, first match wins. Buttons on a card mean it waits on the owner. */
export function classify(text: string, hasButtons: boolean): FeedKind {
  const t = text.toLowerCase();
  if (/\bincident\b|🚨|on-call|outage|\bdown\b|unreachable/.test(t)) return "incident";
  if (/deploy/.test(t)) return "deploy";
  if (hasButtons) return "approval";
  if (/❌|\berror\b|\bfailed\b|failure|exception|crash/.test(t)) return "error";
  if (/\bmission\b|\brun\b|finished|✅|agent|worker/.test(t)) return "run";
  if (/\bdh\b|\bmad\b|\$\d|sale|income|expense|invoice|credit/.test(t)) return "money";
  return "info";
}

export const cleanText = (text: string): string => redact(text).slice(0, MAX_TEXT);

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&apos;": "'" };

/**
 * The words the owner saw in Telegram, without the formatting marks of `parse_mode`. Code spans keep
 * their content as is; links keep their text; escaped marks become the plain character.
 */
export function plainText(text: string, parseMode?: string): string {
  if (parseMode === "HTML") return text.replace(/<[^>]*>/g, "").replace(/&(lt|gt|amp|quot|apos|#39);/g, (m) => ENTITIES[m]);
  if (parseMode !== "Markdown" && parseMode !== "MarkdownV2") return text;
  const v2 = parseMode === "MarkdownV2";
  const marks = v2 ? /[*_~|]/ : /[*_]/;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length && (v2 ? /[!-~]/ : /[_*`\[]/).test(text[i + 1])) { out += text[++i]; continue; }
    if (text.startsWith("```", i)) {
      const end = text.indexOf("```", i + 3);
      if (end > 0) { out += text.slice(i + 3, end).replace(/^[A-Za-z0-9_+-]*\n/, ""); i = end + 2; continue; }
    }
    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > 0) { out += text.slice(i + 1, end); i = end; continue; }
    }
    if (c === "[") {
      const m = /^\[([^\]]*)\]\(([^)]*)\)/.exec(text.slice(i));
      if (m) { out += plainText(m[1], parseMode); i += m[0].length - 1; continue; }
    }
    if (marks.test(c)) continue;
    out += c;
  }
  return out;
}

/** Labels of an inline keyboard, from grammy's InlineKeyboard or the raw reply_markup. */
export function buttonLabels(markup: any): string[] {
  const rows = markup?.inline_keyboard;
  if (!Array.isArray(rows)) return [];
  const out: string[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const b of row) if (typeof b?.text === "string" && out.length < MAX_BUTTONS) out.push(redact(b.text).slice(0, MAX_LABEL));
  }
  return out;
}

export class FeedStore {
  private added = 0;

  constructor(private db: Database, private now: () => number = Date.now) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS control_feed (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        buttons TEXT NOT NULL DEFAULT '[]',
        message_id INTEGER,
        edited INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_control_feed_at ON control_feed(at);
      CREATE INDEX IF NOT EXISTS idx_control_feed_msg ON control_feed(message_id);
    `);
  }

  add(e: { source: string; text: string; buttons?: string[]; kind?: FeedKind; messageId?: number | null; at?: number }): number {
    const text = cleanText(e.text);
    const buttons = (e.buttons ?? []).slice(0, MAX_BUTTONS);
    const kind = e.kind ?? classify(text, buttons.length > 0);
    const r = this.db.prepare(`INSERT INTO control_feed (at, source, kind, text, buttons, message_id) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(e.at ?? this.now(), SOURCE.test(e.source) ? e.source : "other", kind, text, JSON.stringify(buttons), e.messageId ?? null);
    if (++this.added % 100 === 0) this.prune();
    return Number(r.lastInsertRowid);
  }

  /** An edited message replaces the text of its entry; buttons are replaced only when the edit carries markup. */
  edit(messageId: number, text: string | null, buttons: string[] | null): boolean {
    const row = this.db.prepare(`SELECT id, text FROM control_feed WHERE message_id = ? ORDER BY id DESC LIMIT 1`).get(messageId) as { id: number; text: string } | undefined;
    if (!row) return false;
    const next = text === null ? row.text : cleanText(text);
    if (buttons === null) this.db.prepare(`UPDATE control_feed SET text = ?, edited = 1 WHERE id = ?`).run(next, row.id);
    else this.db.prepare(`UPDATE control_feed SET text = ?, buttons = ?, edited = 1 WHERE id = ?`).run(next, JSON.stringify(buttons.slice(0, MAX_BUTTONS)), row.id);
    return true;
  }

  /** Newest first; one probe row past `limit` tells the caller there is a next page. */
  list(q: { limit: number; before?: number; kind?: FeedKind }): FeedItem[] {
    const where: string[] = [], args: unknown[] = [];
    if (q.before !== undefined) { where.push("at < ?"); args.push(q.before); }
    if (q.kind) { where.push("kind = ?"); args.push(q.kind); }
    const sql = `SELECT id, at, source, kind, text, buttons, edited FROM control_feed ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY at DESC, id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, q.limit + 1) as FeedRow[]).map(toItem);
  }

  prune(): void {
    this.db.prepare(`DELETE FROM control_feed WHERE at < ?`).run(this.now() - RETENTION_MS);
    this.db.prepare(`DELETE FROM control_feed WHERE id NOT IN (SELECT id FROM control_feed ORDER BY id DESC LIMIT ?)`).run(MAX_ROWS);
  }
}

const SEND_METHODS = new Set(["sendMessage", "sendPhoto", "sendDocument", "sendVideo", "sendAudio", "sendVoice", "sendAnimation"]);
const EDIT_METHODS = new Set(["editMessageText", "editMessageCaption", "editMessageReplyMarkup"]);
const MEDIA_LABEL: Record<string, string> = {
  sendPhoto: "[photo]", sendDocument: "[file]", sendVideo: "[video]", sendAudio: "[audio]", sendVoice: "[voice]", sendAnimation: "[gif]",
};

/**
 * For the bot's API transformer: records sends and edits aimed at the owner chat. Other chats (WhatsApp
 * bridges, groups) and every other method are ignored. Never throws, so the send path is unchanged.
 */
export function telegramFeedRecorder(feed: () => FeedStore | null, ownerChatId: string | number | undefined) {
  const owner = ownerChatId === undefined ? null : String(ownerChatId);
  return (method: string, payload: any, result: any): void => {
    try {
      if (!owner || String(payload?.chat_id) !== owner) return;
      const store = feed();
      if (!store) return;
      if (SEND_METHODS.has(method)) {
        const raw = typeof payload?.text === "string" ? payload.text : typeof payload?.caption === "string" ? payload.caption : "";
        const body = plainText(raw, payload?.parse_mode);
        const text = method === "sendMessage" ? body : `${MEDIA_LABEL[method]}${body ? " " + body : ""}`;
        if (!text.trim()) return;
        store.add({ source: "tokyo", text, buttons: buttonLabels(payload?.reply_markup), messageId: typeof result?.message_id === "number" ? result.message_id : null });
      } else if (EDIT_METHODS.has(method) && typeof payload?.message_id === "number") {
        const raw = typeof payload.text === "string" ? payload.text : typeof payload.caption === "string" ? payload.caption : null;
        // Telegram drops the keyboard of an edit that carries none, so no markup means no buttons left.
        store.edit(payload.message_id, raw === null ? null : plainText(raw, payload.parse_mode), buttonLabels(payload.reply_markup));
      }
    } catch (e: any) {
      console.warn(`[feed] not recorded: ${e?.message ?? e}`);
    }
  };
}

const iso = (t: number) => new Date(t).toISOString();

/** GET /feed?limit=&before=&kind= -- the timeline, newest first. */
export function feedRoutes(feed: FeedStore): express.Router {
  const r = express.Router();
  r.get("/feed", (req, res) => {
    const page = parsePage(req, 30);
    if (typeof page === "string") return res.status(400).json(errorBody("bad_request", page));
    const kind = req.query.kind;
    if (kind !== undefined && !(FEED_KINDS as readonly unknown[]).includes(kind)) return res.status(400).json(errorBody("bad_request", `kind must be one of ${FEED_KINDS.join(", ")}`));
    const rows = feed.list({ limit: page.limit, before: page.before, kind: kind as FeedKind | undefined });
    const { page: items, next } = pageOf(rows, page.limit, (i) => i.at);
    res.json({
      items: items.map((i) => ({ id: String(i.id), at: iso(i.at), source: i.source, kind: i.kind, text: i.text, buttons: i.buttons, edited: i.edited })),
      next,
    });
  });
  return r;
}
