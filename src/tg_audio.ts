/**
 * Telegram audio transcription helper.
 *
 * Provides the shared transcribeTelegramAudio() helper used by all audio-type
 * message handlers (voice, audio, video_note, document).
 *
 * Dependencies (chat, transcribe) are injected via module-level setters so the
 * test suite can mock them without booting the full bot.
 */

import * as db from "./db";
// voice-coach disabled
// import { coachInstant } from "./voice_coach";
import type { Context } from "grammy";
import { saveTranscriptFile } from "./notify";
import { matchProject } from "./project-registry";

// ---------------------------------------------------------------------------
// Dependency injection points (set by index.ts at startup)
// ---------------------------------------------------------------------------

type ChatFn = (text: string, bot: any, chatId: number) => Promise<string>;
type TranscribeResultLike = { text: string; durationSeconds?: number | null } | string | null;
type TranscribeFn = (buffer: Buffer, ext: string, lang?: string) => Promise<TranscribeResultLike>;
type SendSplitFn = (ctx: any, text: string) => Promise<void>;

let _chat: ChatFn | null = null;
let _transcribe: TranscribeFn | null = null;
let _sendSplit: SendSplitFn | null = null;
let _bot: any = null;
let _botToken: string = "";

export function initTgAudio(opts: {
  chat: ChatFn;
  transcribe: TranscribeFn;
  sendSplit: SendSplitFn;
  bot: any;
  botToken: string;
}) {
  _chat = opts.chat;
  _transcribe = opts.transcribe;
  _sendSplit = opts.sendSplit;
  _bot = opts.bot;
  _botToken = opts.botToken;
}

// ---------------------------------------------------------------------------
// Ext resolution helpers
// ---------------------------------------------------------------------------

const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "wav", "flac", "ogg", "opus", "mp4"]);

/**
 * Resolve a transcription ext string from mime_type or filename.
 * Returns one of: mp3 | m4a | wav | flac | ogg | opus | mp4
 * Default fallback is "mp3".
 */
export function resolveAudioExt(mimeType: string | undefined, fileName: string | undefined): string {
  // First try mime_type
  if (mimeType) {
    const mime = mimeType.toLowerCase();
    if (mime === "audio/mpeg") return "mp3";
    if (mime === "audio/mp4" || mime === "audio/x-m4a") return "m4a";
    if (mime === "audio/wav" || mime === "audio/x-wav") return "wav";
    if (mime === "audio/flac" || mime === "audio/x-flac") return "flac";
    if (mime === "audio/ogg") return "ogg";
    if (mime === "audio/opus") return "ogg";  // opus in ogg container
    // Generic audio/* — try extension next
  }

  // Fall back to filename extension
  if (fileName) {
    const dot = fileName.lastIndexOf(".");
    if (dot !== -1) {
      const ext = fileName.slice(dot + 1).toLowerCase();
      if (ext === "mp3") return "mp3";
      if (ext === "m4a") return "m4a";
      if (ext === "wav") return "wav";
      if (ext === "flac") return "flac";
      if (ext === "ogg") return "ogg";
      if (ext === "opus") return "ogg";
      if (ext === "mp4") return "mp4";
    }
  }

  return "mp3";  // default
}

/**
 * Returns true if a document should be handled as audio.
 * Checks mime_type prefix first; falls back to filename extension.
 */
export function isAudioDocument(mimeType: string | undefined, fileName: string | undefined): boolean {
  if (mimeType) {
    // If mime is present and it IS audio, accept. If present and NOT audio, reject (don't
    // fall through to filename check — mime_type is authoritative when provided).
    return mimeType.toLowerCase().startsWith("audio/");
  }
  if (fileName) {
    const dot = fileName.lastIndexOf(".");
    if (dot !== -1) {
      const ext = fileName.slice(dot + 1).toLowerCase();
      if (AUDIO_EXTENSIONS.has(ext)) return true;
    }
  }
  return false;
}

/**
 * Escape Markdown special characters in the transcript portion of a reply.
 * This prevents broken Markdown when transcript contains _, *, `, [, ], (, ).
 *
 * We only escape the transcript — the surrounding template uses controlled
 * Markdown (🎤 _text_\n\n) so we escape within the transcript content only.
 */
function escapeMarkdown(text: string): string {
  // Escape characters that can break Markdown v1 (Telegram's parse_mode=Markdown)
  return text.replace(/[_*`[\]()]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Core helper
// ---------------------------------------------------------------------------

/**
 * Returns true if an audio file exceeds the max transcription duration.
 * Exported so tests can verify the guard without importing index.ts.
 */
export function isAudioTooLong(durationSeconds: number, maxSeconds = 600): boolean {
  return durationSeconds > maxSeconds;
}

/**
 * Shared transcription + reply flow for all Telegram audio message types.
 *
 * @param ctx   - grammY Context
 * @param ext   - audio format extension (e.g. "ogg", "mp3", "mp4")
 *
 * Flow:
 *   1. Reply "🎤 Transcribing..." status
 *   2. Call ctx.getFile() to get the Telegram file path
 *   3. Fetch file buffer via Telegram file API
 *   4. Call transcribe(buffer, ext)
 *   5. On null → error reply; on text → chat(text) → sendSplit with 🎤 header
 */
export async function transcribeTelegramAudio(ctx: any, ext: string): Promise<void> {
  // Use injected deps if available, otherwise fall back to globals (test mode)
  const transcribeFn: TranscribeFn = _transcribe ?? (globalThis as any).__mockTranscribe;
  const chatFn: ChatFn = _chat ?? (globalThis as any).__mockChat;

  const sendSplitFn: SendSplitFn = _sendSplit ?? (async (c: any, text: string) => {
    await c.reply(text, { parse_mode: "Markdown" }).catch(() => c.reply(text));
  });

  if (!_transcribe ? false : !require("./stt").isTranscriptionEnabled()) {
    await ctx.reply("Transcription is turned off.");
    return;
  }
  await ctx.reply("🎤 Transcribing...");

  try {
    const file = await ctx.getFile();
    const botToken = _botToken || (globalThis as any).__mockBotToken || "";
    const fileUrl = botToken
      ? `https://api.telegram.org/file/bot${botToken}/${file.file_path}`
      : `https://api.telegram.org/file/bot_test/${file.file_path}`;

    const fileResponse = await fetch(fileUrl);
    const buffer = Buffer.from(await fileResponse.arrayBuffer());

    const rawResult = await transcribeFn(buffer, ext);
    const transcribedText = rawResult && typeof rawResult === "object" ? rawResult.text : rawResult as string | null;
    const durationSec: number | null = rawResult && typeof rawResult === "object" ? (rawResult as any).durationSeconds ?? null : null;

    if (!transcribedText?.trim()) {
      await ctx.reply("Couldn't transcribe the audio. Try again?");
      return;
    }

    // Per-project transcript save (fire-and-forget)
    const senderName = ctx.from?.first_name || ctx.from?.username || "telegram";
    const project = matchProject(senderName)?.name ?? "telegram";
    const jid = `tg:${ctx.chat.id}`;

    // Persist into whatsapp_messages + fire coach (same pipeline as WA voice notes)
    try {
      const wordCount = transcribedText.trim().split(/\s+/).filter(Boolean).length;
      const wpm = durationSec ? wordCount / (durationSec / 60) : null;
      const result = db.saveWAMessage({
        jid,
        sender: String(ctx.from?.id ?? ""),
        sender_name: senderName,
        content: "[TG Audio]",
        message_type: "audio",
        from_me: true,
        is_group: false,
        timestamp: Math.floor(Date.now() / 1000),
      });
      const dbId = (result as any).lastInsertRowid as number;
      db.updateWATranscriptionWithDuration(dbId, transcribedText, durationSec, wpm);
      // voice-coach disabled — coachInstant call removed
    } catch (err: any) {
      console.error("[voice-coach] TG persist failed:", err.message);
    }
    saveTranscriptFile(jid, senderName, project, transcribedText).catch((err: any) =>
      console.error("TG transcript file save failed:", err)
    );

    const response = await chatFn(transcribedText, _bot, ctx.chat.id);
    const escapedTranscript = escapeMarkdown(transcribedText);
    await sendSplitFn(ctx, `🎤 _${escapedTranscript}_\n\n${response}`);
  } catch (err) {
    console.error("Audio transcription error:", err);
    await ctx.reply("Failed to process audio message. Try again?");
  }
}
