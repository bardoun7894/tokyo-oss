/**
 * Tokyo social publisher — the hands-off half.
 *
 * Two cron ticks, one minute apart from nothing:
 *
 *   queue   — anything dropped into social-media/queue/ gets published with the
 *             saved switch defaults and reported to Telegram. No interaction.
 *   due     — jobs parked with the 🕐 Schedule button go out at their time.
 *
 * A file is only picked up once its size has stopped changing, so an scp or
 * rsync still in flight is never grabbed half-written.
 */

import fs from "fs";
import path from "path";
import cron from "node-cron";
import type { Bot } from "grammy";
import { WORK_DIR, probe, ensureDirs } from "./media";
import { createJob, setTargets, listSwitches, dueJobs, getJob, setJobStatus } from "./store";
import { publishJob, formatWhen } from "./commands";
import { PRESET_PLATFORMS, type Preset } from "./types";

export const QUEUE_DIR = path.join(WORK_DIR, "queue");
const VIDEO_RE = /\.(mp4|mov|m4v|webm)$/i;

/** filename → size seen on the previous tick, to spot a file still being written. */
const sizeLastTick = new Map<string, number>();
let queueBusy = false;
let dueBusy = false;

function notifyChat(): number {
  return Number(process.env.SOCIAL_NOTIFY_CHAT || process.env.TELEGRAM_USER_ID || 0);
}

/**
 * A sidecar `.txt` next to the video carries the caption. Flags may sit on the
 * first line: `--short`, `--video`, `--private`.
 */
function readSidecar(videoPath: string): { caption: string; preset?: Preset; privacy: "public" | "private" } {
  const txt = videoPath.replace(VIDEO_RE, ".txt");
  if (!fs.existsSync(txt)) return { caption: "", privacy: "public" };

  const raw = fs.readFileSync(txt, "utf8");
  const lines = raw.split(/\r?\n/);
  let preset: Preset | undefined;
  let privacy: "public" | "private" = "public";

  if (/^\s*--/.test(lines[0] || "")) {
    const flags = lines.shift()!;
    if (/--short\b/.test(flags)) preset = "short";
    if (/--video\b/.test(flags)) preset = "video";
    if (/--private\b/.test(flags)) privacy = "private";
  }
  return { caption: lines.join("\n").trim(), preset, privacy };
}

function guessPreset(durationSec: number, width: number, height: number): Preset {
  return height > width && durationSec <= 180 ? "short" : "video";
}

async function processQueueFile(bot: Bot, filePath: string): Promise<void> {
  const chatId = notifyChat();
  const sidecar = readSidecar(filePath);

  // Move it out of the queue before anything else, so a slow publish cannot be
  // picked up a second time by the next tick.
  const moved = path.join(WORK_DIR, `queued-${Date.now()}-${path.basename(filePath)}`);
  fs.renameSync(filePath, moved);
  const txt = filePath.replace(VIDEO_RE, ".txt");
  if (fs.existsSync(txt)) fs.unlinkSync(txt);

  const asset = await probe(moved);
  const preset = sidecar.preset || guessPreset(asset.durationSec, asset.width, asset.height);
  const caption = sidecar.caption || path.basename(filePath).replace(VIDEO_RE, "").replace(/[-_]+/g, " ");

  const jobId = createJob({
    preset,
    title: caption.split("\n")[0]?.slice(0, 100) || "Untitled",
    caption,
    mediaPath: moved,
    durationSec: asset.durationSec,
    width: asset.width,
    height: asset.height,
    sizeBytes: asset.sizeBytes,
    privacy: sidecar.privacy,
    source: "queue",
  });
  setTargets(
    jobId,
    PRESET_PLATFORMS[preset].filter((p) => listSwitches(preset)[p])
  );

  console.log(`[social] queue picked up ${path.basename(filePath)} → job #${jobId} (${preset})`);
  if (chatId) {
    await bot.api
      .sendMessage(chatId, `📥 Queue picked up \`${path.basename(filePath)}\` → share #${jobId} (${preset})`, {
        parse_mode: "Markdown",
      })
      .catch(() => {});
    await publishJob(bot.api, chatId, jobId);
  } else {
    console.warn("[social] no SOCIAL_NOTIFY_CHAT / TELEGRAM_USER_ID — publishing without a report");
  }
}

async function queueTick(bot: Bot): Promise<void> {
  if (queueBusy) return;
  if (!fs.existsSync(QUEUE_DIR)) return;

  const ready: string[] = [];
  const seen = new Set<string>();
  for (const name of fs.readdirSync(QUEUE_DIR)) {
    if (!VIDEO_RE.test(name)) continue;
    const full = path.join(QUEUE_DIR, name);
    let size: number;
    try {
      size = fs.statSync(full).size;
    } catch {
      continue;
    }
    seen.add(name);
    if (size > 0 && sizeLastTick.get(name) === size) ready.push(full);
    sizeLastTick.set(name, size);
  }
  for (const name of [...sizeLastTick.keys()]) if (!seen.has(name)) sizeLastTick.delete(name);
  if (!ready.length) return;

  queueBusy = true;
  try {
    for (const file of ready) {
      sizeLastTick.delete(path.basename(file));
      try {
        await processQueueFile(bot, file);
      } catch (err: any) {
        console.error(`[social] queue file ${file} failed:`, err);
        const chatId = notifyChat();
        if (chatId) {
          await bot.api
            .sendMessage(chatId, `Queue file \`${path.basename(file)}\` failed: ${err.message}`, {
              parse_mode: "Markdown",
            })
            .catch(() => {});
        }
      }
    }
  } finally {
    queueBusy = false;
  }
}

async function dueTick(bot: Bot): Promise<void> {
  if (dueBusy) return;
  const due = dueJobs();
  if (!due.length) return;

  dueBusy = true;
  try {
    for (const job of due) {
      // Claim it first — a long upload must not be started twice.
      setJobStatus(job.id, "running");
      const chatId = job.chat_id || notifyChat();
      console.log(`[social] scheduled job #${job.id} firing (was due ${formatWhen(job.scheduled_at!)})`);
      try {
        if (!fs.existsSync(job.media_path)) throw new Error("the media file is gone (swept?)");
        await publishJob(bot.api, chatId, job.id);
      } catch (err: any) {
        setJobStatus(job.id, "failed");
        console.error(`[social] scheduled job #${job.id} failed:`, err);
        if (chatId) {
          await bot.api.sendMessage(chatId, `Scheduled share #${job.id} failed: ${err.message}`).catch(() => {});
        }
      }
    }
  } finally {
    dueBusy = false;
  }
}

export function startSocialAutomation(bot: Bot): void {
  ensureDirs();
  fs.mkdirSync(QUEUE_DIR, { recursive: true });

  cron.schedule("* * * * *", () => {
    queueTick(bot).catch((err) => console.error("[social] queue tick:", err));
  });
  cron.schedule("* * * * *", () => {
    dueTick(bot).catch((err) => console.error("[social] due tick:", err));
  });

  // A job whose time passed while Tokyo was down should still go out.
  const overdue = dueJobs();
  if (overdue.length) {
    console.log(`[social] ${overdue.length} scheduled job(s) overdue after restart — firing`);
    dueTick(bot).catch((err) => console.error("[social] overdue catch-up:", err));
  }

  console.log(`⏱ Social automation on — queue: ${QUEUE_DIR}`);
}
