/**
 * Content Studio — bridge to the social module.
 *
 * runJob publishes one title + caption to every target of a job. To give each
 * platform its own copy, the studio creates one social job per platform. The
 * eligibility check, the adapters, the scheduler tick and the status rows are
 * all the social module's own — nothing here talks to a platform.
 */

import fs from "fs";
import path from "path";
import { WORK_DIR } from "../social/media";
import { resolvePlatforms, runJob, type Eligibility } from "../social/publish";
import { createJob, scheduleJob, setJobStatus, setTargets } from "../social/store";
import type { Platform, Preset } from "../social/types";
import { composeForJob } from "./ai";
import { getCaptions, linkJob, listPublications, syncItem, updateItem } from "./store";
import type { ContentItem } from "./types";

/** Where dashboard uploads live. Deliberately NOT the auto-publishing queue folder. */
export const UPLOAD_DIR = path.resolve(process.env.CONTENT_UPLOAD_DIR || path.join(WORK_DIR, "uploads"));
const QUEUE_DIR = path.resolve(WORK_DIR, "queue");
if (UPLOAD_DIR === QUEUE_DIR || UPLOAD_DIR.startsWith(QUEUE_DIR + path.sep)) {
  throw new Error(`[content] refusing upload dir inside the auto-publish queue: ${UPLOAD_DIR}`);
}

export function presetFor(item: ContentItem): Preset {
  return item.format === "short" ? "short" : "video";
}

function notifyChat(): number {
  return Number(process.env.SOCIAL_NOTIFY_CHAT || process.env.TELEGRAM_USER_ID || 0);
}

/** Which of the requested platforms would really publish right now, and why the rest would not. */
export function preflight(item: ContentItem, platforms: Platform[]): Eligibility & { problems: string[] } {
  const problems: string[] = [];
  if (!item.video_path) problems.push("no video uploaded");
  else if (!fs.existsSync(item.video_path)) problems.push("the video file is gone from disk");
  if (!platforms.length) problems.push("select at least one platform");
  const eligibility = platforms.length ? resolvePlatforms(presetFor(item), platforms) : { selected: [], skipped: [] };
  return { ...eligibility, problems };
}

function createPlatformJobs(
  item: ContentItem,
  platforms: Platform[],
  privacy: "public" | "private",
  kind: "now" | "scheduled"
): Array<{ platform: Platform; jobId: number }> {
  const captions = getCaptions(item.id);
  const jobs: Array<{ platform: Platform; jobId: number }> = [];
  for (const platform of platforms) {
    const { title, caption } = composeForJob(item, platform, captions[platform]);
    const jobId = createJob({
      preset: presetFor(item),
      title,
      caption,
      mediaPath: item.video_path!,
      durationSec: item.duration_sec || 0,
      width: item.width || 0,
      height: item.height || 0,
      sizeBytes: item.video_size || 0,
      privacy,
      source: "dashboard",
    });
    setTargets(jobId, [platform]);
    linkJob(item.id, jobId, platform, kind);
    jobs.push({ platform, jobId });
  }
  return jobs;
}

const publishing = new Set<number>();

export function isPublishing(itemId: number): boolean {
  return publishing.has(itemId) || listPublications(itemId).some((p) => p.job_status === "running");
}

/**
 * Create the jobs and start publishing in the background. Returns as soon as
 * the jobs exist; the dashboard polls the item for per-platform status.
 */
export function publishNow(
  item: ContentItem,
  platforms: Platform[],
  privacy: "public" | "private"
): { jobs: Array<{ platform: Platform; jobId: number }>; skipped: Eligibility["skipped"] } {
  const check = preflight(item, platforms);
  if (check.problems.length) throw new Error(check.problems.join("; "));
  if (!check.selected.length) throw new Error("none of the selected platforms can publish right now");
  if (isPublishing(item.id)) throw new Error("this item is already publishing");

  const jobs = createPlatformJobs(item, check.selected, privacy, "now");
  publishing.add(item.id);
  void (async () => {
    try {
      for (const { platform, jobId } of jobs) {
        try {
          await runJob(jobId);
        } catch (err) {
          console.error(`[content] item #${item.id} ${platform} job #${jobId} failed:`, err);
          setJobStatus(jobId, "failed");
        }
      }
    } finally {
      publishing.delete(item.id);
      syncItem(item.id);
    }
  })();
  return { jobs, skipped: check.skipped };
}

/** Park one job per platform with the social scheduler, which fires them on its minute tick. */
export function scheduleItem(
  item: ContentItem,
  platforms: Platform[],
  whenMs: number,
  privacy: "public" | "private"
): { jobs: Array<{ platform: Platform; jobId: number }>; skipped: Eligibility["skipped"] } {
  if (!Number.isFinite(whenMs) || whenMs < Date.now() + 60_000) {
    throw new Error("pick a time at least a minute from now");
  }
  const check = preflight(item, platforms);
  if (check.problems.length) throw new Error(check.problems.join("; "));
  if (!check.selected.length) throw new Error("none of the selected platforms can publish");
  const chatId = notifyChat();
  if (!chatId) throw new Error("SOCIAL_NOTIFY_CHAT / TELEGRAM_USER_ID is not set — the scheduler reports there");

  const jobs = createPlatformJobs(item, check.selected, privacy, "scheduled");
  for (const { jobId } of jobs) scheduleJob(jobId, whenMs, chatId);
  updateItem(item.id, { stage: "scheduled", scheduled_at: whenMs });
  return { jobs, skipped: check.skipped };
}

/** Cancel every still-scheduled job of the item. Returns how many were cancelled. */
export function cancelSchedule(itemId: number): number {
  let n = 0;
  for (const p of listPublications(itemId)) {
    if (p.job_status !== "scheduled") continue;
    setJobStatus(p.job_id, "cancelled");
    n++;
  }
  syncItem(itemId);
  return n;
}
