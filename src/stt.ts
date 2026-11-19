/**
 * Speech-to-Text. Three paths, tried in order:
 *
 *   1. agy-stt bridge on this host -- primary since 2026-10-17. Gemini 3.8 Flash through
 *      the Antigravity CLI, run as a sandboxed unprivileged user; writes Arabic dialects in
 *      Arabic script as spoken. Needs AGY_STT_TOKEN (from /etc/agy-stt.env); optional AGY_STT_URL.
 *      Source: crmDemo repo, ops/agy-stt.
 *   2. OpenRouter multimodal (chat/completions, inline audio) -- same model, paid key.
 *      Needs OPENROUTER_API_KEY; optional OPENROUTER_STT_MODEL
 *      (default google/gemini-3.8-flash).
 *   3. Local Whisper service on the user's laptop (Tailscale) -- last resort.
 *
 * Groq Whisper was the fallback until 2026-09-18 and was removed: it is Whisper, so it
 * lost on dialect exactly like the laptop path, while also sending every voice note to
 * a third party.
 *
 * Laptop service contract:
 *
 * POST http://100.64.0.50:8787/transcribe
 *   X-Tokyo-Token: <TRANSCRIBE_TOKEN>
 *   Content-Type: multipart/form-data
 *   file: <audio bytes>
 *   ext:  "ogg" | "mp3" | "m4a" | "wav" | ...
 *   lang: "ar" | "en" | ... (omitted → auto-detect)
 *
 * Response 200: { text: "<transcript>" }
 * Response 401: { error: "unauthorized" }
 * Response 4xx/5xx: { error: "<reason>" }
 */

import { promises as fsp } from "fs";
import { settingOn } from "./settings";
import { replyLanguage } from "./profile";

const DEFAULT_TRANSCRIBE_URL = "http://100.64.0.50:8787/transcribe";
const TIMEOUT_MS = 120_000; // 120 s — Whisper on M-series is fast but not instant
const DEFAULT_AGY_STT_URL = "http://172.17.0.1:8318/stt";
const AGY_BUDGET_SECONDS = 120; // bridge-side limit for all its attempts; the HTTP wait adds a margin
const AGY_LANGUAGE: Record<string, string> = {
  ar: "Arabic (any dialect, written as spoken)",
  fr: "French",
  en: "English",
};

/** The language hint for a voice note: the profile's dialect when it fits the code, else a plain name. */
export function spokenLanguage(code?: string): string | undefined {
  const profile = replyLanguage();
  if (!code) return profile || undefined;
  const c = code.toLowerCase();
  if (c === "ar" && /arab|darija|عرب|دارج/i.test(profile)) return profile;
  return AGY_LANGUAGE[c] ?? code;
}

/**
 * Transcribe through the agy-stt bridge. It re-encodes the audio itself, retries Gemini
 * filter blocks inside its budget, skips silent clips, and answers {text: string|null}.
 */
async function transcribeViaAgy(buffer: Buffer, language?: string): Promise<TranscribeResult | null> {
  const token = process.env.AGY_STT_TOKEN;
  if (!token) return null;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/octet-stream",
    "X-Budget": String(AGY_BUDGET_SECONDS),
  };
  const hint = spokenLanguage(language);
  if (hint) headers["X-Language"] = hint;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (AGY_BUDGET_SECONDS + 15) * 1000);
  try {
    const res = await fetch(process.env.AGY_STT_URL || DEFAULT_AGY_STT_URL, {
      method: "POST",
      headers,
      body: new Uint8Array(buffer),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      console.error(`STT (agy): HTTP ${res.status} -- ${body.slice(0, 200)}`);
      return null;
    }
    const data = await res.json() as { text?: string | null };
    const text = data.text?.trim();
    if (!text) {
      console.error("STT (agy): no speech");
      return null;
    }
    console.log(`STT (agy): "${text.slice(0, 60)}"`);
    return { text, durationSeconds: null };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`STT (agy): request failed -- ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Transcribe an audio buffer via the local Whisper service.
 *
 * Returns the trimmed transcript on success, or null on any failure
 * (network error, non-200 response, empty transcript).
 */
export interface TranscribeResult {
  text: string;
  durationSeconds: number | null;
}

/**
 * `input_audio.format` values we send, keyed by the extension we store media under.
 * OpenRouter documents only mp3 and wav, but ogg is passed through to Gemini and is in
 * fact the better path: transcoding a WhatsApp .ogg down to 16 kHz mono mp3 first
 * measurably degraded the transcript (it turned a name from عبد السلام into أشرف).
 * Send the original bytes.
 */
const OPENROUTER_AUDIO_FORMAT: Record<string, string> = {
  ogg: "ogg",
  opus: "ogg",
  oga: "ogg",
  mp3: "mp3",
  m4a: "m4a",
  mp4: "m4a",
  wav: "wav",
  flac: "flac",
};

/**
 * Multimodal transcription through OpenRouter. Primary path, and the reason is dialect:
 * Whisper garbles Moroccan Darija. Measured on one 10 s clip, 2026-09-18:
 *
 *   whisper.cpp large-v3-turbo  unusable word salad, with and without -l ar
 *   openai/gpt-audio            partly coherent but invents words ("الخياشلة")
 *   openai/gpt-audio-mini       drifts off the content entirely
 *   google/gemini-3.5-flash-lite  garbled, repeats itself
 *   google/gemini-3.8-flash     coherent, stable across runs   <- what we use
 *
 * OpenRouter rather than Google directly because the Google account's own API project is
 * suspended (CONSUMER_SUSPENDED) and the Antigravity CLI's auth is dead with
 * IneligibleTierError -- OpenRouter reaches the same model on a key that works.
 *
 * Reasoning cannot be disabled on this model and is ~95% of the token cost, which is
 * still only about $0.004 per clip -- roughly $4/month at the ~30 voice notes/day this
 * account actually receives. Don't "optimise" it into a lite model; the lite ones were
 * measured above and they garble.
 *
 * No audio duration is returned, so durationSeconds is null here. Nothing consumes it
 * today -- the voice-coach wpm/coherence feature that did is switched off.
 */
async function transcribeViaOpenRouter(
  buffer: Buffer,
  ext: string,
  language?: string,
): Promise<TranscribeResult | null> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;

  const format = OPENROUTER_AUDIO_FORMAT[ext.toLowerCase()];
  if (!format) {
    console.error(`STT (openrouter): unsupported audio extension "${ext}"`);
    return null;
  }

  const model = process.env.OPENROUTER_STT_MODEL || "google/gemini-3.8-flash";
  const hint = spokenLanguage(language);
  const target = hint
    ? `The speaker is using ${hint}.`
    : "The speaker may use any language or dialect (for example Egyptian or Moroccan Arabic, Levantine, Gulf, French, English).";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [{
          role: "user",
          content: [
            {
              type: "text",
              text:
                `Transcribe this voice note verbatim. ${target} ` +
                "Write the transcript in the script the speaker actually used -- Arabic script for any " +
                "Arabic dialect -- and keep dialect words as spoken rather than translating them into " +
                "Modern Standard Arabic. Do not summarise, translate, comment, or add speaker labels. " +
                "Output only the transcript, or nothing at all if there is no intelligible speech.",
            },
            { type: "input_audio", input_audio: { data: buffer.toString("base64"), format } },
          ],
        }],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      console.error(`STT (openrouter): HTTP ${res.status} -- ${body.slice(0, 200)}`);
      return null;
    }

    const data = await res.json() as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };
    if (data.error) {
      console.error(`STT (openrouter): ${data.error.message ?? "unknown error"}`);
      return null;
    }

    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) {
      console.error("STT (openrouter): empty transcript returned");
      return null;
    }

    console.log(`STT (openrouter/${model}): "${text.slice(0, 60)}"`);
    return { text, durationSeconds: null };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`STT (openrouter): request failed -- ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Owner switched transcription off 2026-09-17 (quality). Only TRANSCRIBE_ENABLED=1 turns it back on. */
export function isTranscriptionEnabled(): boolean {
  return settingOn("TRANSCRIBE_ENABLED");
}

/**
 * True when at least one backend is configured. Callers used to spell this out as their
 * own `GROQ_API_KEY || TRANSCRIBE_TOKEN || ...` check, which meant adding a provider here
 * silently did nothing until every caller was updated too. Keep the provider list in this
 * file only.
 */
export function hasTranscriptionBackend(): boolean {
  return Boolean(process.env.AGY_STT_TOKEN || process.env.TRANSCRIBE_TOKEN);
}

export async function transcribe(
  buffer: Buffer,
  ext: string = "ogg",
  language?: string,
): Promise<TranscribeResult | null> {
  if (!isTranscriptionEnabled()) return null;
  // agy first: same Gemini 3.8 Flash as OpenRouter, on the subscription, dialect-aware prompt.
  const viaAgy = await transcribeViaAgy(buffer, language);
  if (viaAgy) return viaAgy;
  return transcribeViaLaptop(buffer, ext, language);
}

async function transcribeViaLaptop(
  buffer: Buffer,
  ext: string = "ogg",
  language?: string,
): Promise<TranscribeResult | null> {
  const url = process.env.TRANSCRIBE_URL || DEFAULT_TRANSCRIBE_URL;
  const token = process.env.TRANSCRIBE_TOKEN || "";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const formData = new FormData();
    const arrayBuf = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
    formData.append(
      "file",
      new File([arrayBuf], `audio.${ext}`, { type: `audio/${ext}` }),
      `audio.${ext}`,
    );
    formData.append("ext", ext);
    if (language) formData.append("lang", language);

    const res = await fetch(url, {
      method: "POST",
      headers: { "X-Tokyo-Token": token },
      body: formData,
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
      console.error(`STT (laptop): HTTP ${res.status} — ${body.error ?? res.statusText}`);
      return null;
    }

    const ctype = res.headers.get("content-type") || "";
    if (!ctype.includes("json")) {
      console.error(`STT (laptop): non-JSON response (${ctype || "no content-type"}) -- not a transcribe service`);
      return null;
    }
    const data = await res.json() as { text?: string; duration_seconds?: number | null };
    const text = data.text?.trim();

    if (!text) {
      console.error("STT (laptop): empty transcript returned");
      return null;
    }

    const durationSeconds = data.duration_seconds ?? null;
    console.log(`STT (laptop): "${text.slice(0, 60)}" dur=${durationSeconds}s`);
    return { text, durationSeconds };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`STT (laptop): request failed — ${msg}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Transcribe and delete the source audio file on success.
 * Used by callers that have the file path available.
 * File is only deleted when transcription succeeds (non-null result).
 */
export async function transcribeAndClean(
  buffer: Buffer,
  filePath: string,
  ext: string = "ogg",
  language?: string,
): Promise<TranscribeResult | null> {
  const result = await transcribe(buffer, ext, language);
  if (result !== null) {
    try {
      await fsp.unlink(filePath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.error(`STT cleanup: could not delete ${filePath} — ${code}`);
      }
    }
  }
  return result;
}
