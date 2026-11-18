/**
 * notify.ts — lightweight owner-notification helpers
 *
 * Sends a plain-text DM to the Telegram owner without importing the bot
 * instance from index.ts, avoiding circular-import issues.
 *
 * The Telegram Bot API is called directly via fetch so this module is
 * importable from anywhere in the tree (including whatsapp.ts).
 *
 * Side-effect: also saves a per-project markdown transcript to disk.
 *
 * Environment variables:
 *   TELEGRAM_BOT_TOKEN   — required for TG sends (already validated in index.ts)
 *   TELEGRAM_USER_ID     — owner chat id; if unset, TG send is skipped
 *   TOKYO_TRANSCRIPT_DIR — base directory for transcript files
 *                          (default: /root/tokyo/transcripts)
 */

import * as fs from "fs";
import * as path from "path";
import { matchProject } from "./project-registry";

const DEFAULT_TRANSCRIPT_DIR = "/root/tokyo/transcripts";
const MAX_TG_TRANSCRIPT = 3500; // Telegram 4096 limit minus header headroom

/**
 * Handle a freshly transcribed WhatsApp audio message:
 *   1. Append to a per-project markdown file (one file per UTC day).
 *   2. Send a plain-text DM to the owner's Telegram chat.
 *
 * Both side effects are fire-and-swallow: a disk or network failure here
 * must NEVER break the main WA message processing pipeline.
 */
export async function handleTranscribedAudio(
  jid: string,
  senderName: string,
  transcript: string,
): Promise<void> {
  const project = matchProject(senderName)?.name ?? "unfiled";

  await Promise.all([
    saveTranscriptFile(jid, senderName, project, transcript),
    sendOwnerDM(senderName, project, transcript),
  ]);
}

// ---------------------------------------------------------------------------
// Per-project markdown save
// ---------------------------------------------------------------------------

export async function saveTranscriptFile(
  jid: string,
  senderName: string,
  project: string,
  transcript: string,
): Promise<void> {
  try {
    const baseDir = process.env.TOKYO_TRANSCRIPT_DIR || DEFAULT_TRANSCRIPT_DIR;
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const timeStr = now.toISOString().slice(11, 19); // HH:MM:SS (UTC)

    const projectDir = path.join(baseDir, project);
    await fs.promises.mkdir(projectDir, { recursive: true });

    const filePath = path.join(projectDir, `${dateStr}.md`);

    // Check whether the file already exists — if not, prepend H1 date header
    let header = "";
    try {
      await fs.promises.access(filePath);
      // File exists — no header needed
    } catch {
      // File does not exist yet
      header = `# ${dateStr}\n\n`;
    }

    const entry = `${header}## ${timeStr} — ${senderName}\n_JID: ${jid}_\n\n${transcript}\n\n---\n\n`;
    await fs.promises.appendFile(filePath, entry, "utf8");
  } catch (err) {
    console.error("WA transcript file save failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Telegram DM to owner
// ---------------------------------------------------------------------------

async function sendOwnerDM(
  senderName: string,
  project: string,
  transcript: string,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_USER_ID;

  if (!chatId) {
    console.warn("TELEGRAM_USER_ID not set — WA transcript TG forward disabled.");
    return;
  }

  // Truncate transcript if needed
  let body = transcript;
  if (body.length > MAX_TG_TRANSCRIPT) {
    body = body.slice(0, MAX_TG_TRANSCRIPT) + "... (truncated)";
  }

  const text = `🎙️ ${senderName} → ${project}\n\n${body}`;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    console.error("WA transcript TG forward failed:", err);
  }
}
