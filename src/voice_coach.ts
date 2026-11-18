/**
 * Voice Coach — scores outgoing audio transcriptions for coherence
 * Packet B (006-voice-coach)
 */

import Anthropic from "@anthropic-ai/sdk";
import * as db from "./db";
import type { UnscoredAudioRow } from "./db";

const COACH_MODEL = "claude-haiku-4-5-20251001";

function getCoachClient(): Anthropic {
  return new Anthropic({
    apiKey: process.env.CLIPROXY_API_KEY || process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.CLIPROXY_API_KEY ? "http://localhost:8317" : undefined,
  });
}

function buildCoachPrompt(transcription: string, wpm: number | null): string {
  const wpmLine = wpm != null
    ? `Speaking rate: ${Math.round(wpm)} words per minute (typical natural speech is 120–160 WPM; >200 is fast).`
    : `Speaking rate: unknown (duration unavailable).`;
  return `You are a speech coach for a multilingual user (Arabic MSA + Moroccan darija + English).
Judge whether the following transcription forms a coherent utterance ("جملة مفيدة") or is
broken due to the speaker talking too fast and garbling the STT output.

Transcription: "${transcription}"
${wpmLine}

Reply with a single JSON object, no prose:
{"coherence": "good" | "partial" | "broken", "reason": "<one short sentence in the same language as the transcription>"}

- "good" = complete, understandable sentence, grammar mostly intact.
- "partial" = mostly understandable but has fragments, missing words, or awkward breaks.
- "broken" = mostly unintelligible, fragmented, nonsensical code-switching.
When flagging "partial" or "broken" and WPM > 180, mention speed in the reason.`;
}

interface CoachVerdict {
  coherence: "good" | "partial" | "broken";
  reason: string;
}

function parseCoachResponse(raw: string): CoachVerdict {
  try {
    // Extract JSON even if wrapped in fences or prose
    const match = raw.match(/\{[\s\S]*?\}/);
    if (!match) throw new Error("no JSON object found");
    const parsed = JSON.parse(match[0]) as { coherence?: string; reason?: string };
    const coherence = parsed.coherence as "good" | "partial" | "broken";
    if (!["good", "partial", "broken"].includes(coherence)) {
      throw new Error(`invalid coherence: ${coherence}`);
    }
    const reason = (parsed.reason || "").slice(0, 500);
    return { coherence, reason };
  } catch (_e) {
    return { coherence: "partial", reason: "coach-parse-fail" };
  }
}

async function scoreOne(row: UnscoredAudioRow): Promise<CoachVerdict> {
  const client = getCoachClient();
  const prompt = buildCoachPrompt(row.transcription, row.wpm ?? null);

  const response = await client.messages.create({
    model: COACH_MODEL,
    max_tokens: 256,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  return parseCoachResponse(raw);
}

export async function coachInstant(id: number): Promise<void> {
  const row = db.getCoachRow(id);
  if (!row || !row.transcription) return;
  let verdict: CoachVerdict;
  try {
    verdict = await scoreOne(row);
  } catch (err: any) {
    console.error(`[voice-coach] instant scoreOne failed id=${id}: ${err.message}`);
    verdict = { coherence: "partial", reason: "coach-error" };
  }
  const now = Math.floor(Date.now() / 1000);
  db.markCoachVerdict(id, verdict.coherence, verdict.reason, now);
  console.log(`[voice-coach] instant id=${id} coherence=${verdict.coherence}`);

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_USER_ID;
  if (!token || !chatId) return;

  const cohEmoji = verdict.coherence === "good" ? "✅" : verdict.coherence === "partial" ? "⚠️" : "❌";
  let pace: "unknown" | "too_slow" | "slow" | "ok" | "fast" | "too_fast" = "unknown";
  let paceEmoji = "❔";
  let paceHint = "";
  if (row.wpm != null) {
    const w = row.wpm;
    if (w < 100) { pace = "too_slow"; paceEmoji = "🐢"; paceHint = "too slow — aim for 130–150"; }
    else if (w < 110) { pace = "slow"; paceEmoji = "🔵"; paceHint = "a bit slow — 130–150 is ideal"; }
    else if (w <= 170) { pace = "ok"; paceEmoji = "🟢"; paceHint = "good pace"; }
    else if (w <= 200) { pace = "fast"; paceEmoji = "🟠"; paceHint = "fast — slow down a bit"; }
    else { pace = "too_fast"; paceEmoji = "🔴"; paceHint = "too fast — garbles STT"; }
  }
  // Only speak up when there is a real problem — stay silent on good + ok pace so
  // the task response (from chatFn) is not drowned out by coach chatter.
  const cohProblem = verdict.coherence !== "good";
  const paceProblem = pace === "too_slow" || pace === "too_fast";
  if (!cohProblem && !paceProblem) {
    console.log(`[voice-coach] silent id=${id} — no issues to report`);
    return;
  }

  const wpmStr = row.wpm != null ? `${Math.round(row.wpm)} wpm` : "wpm unknown";
  const excerpt = (row.transcription || "").slice(0, 180);
  const header = cohProblem && paceProblem
    ? `${cohEmoji} ${verdict.coherence}  ${paceEmoji} ${pace} (${wpmStr})`
    : cohProblem
      ? `${cohEmoji} ${verdict.coherence} (${wpmStr})`
      : `${paceEmoji} ${pace} (${wpmStr})`;
  const text = `${header}\n${paceHint ? paceHint + "\n" : ""}${verdict.reason}`;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err: any) {
    console.error(`[voice-coach] instant TG send failed: ${err.message}`);
  }
}
