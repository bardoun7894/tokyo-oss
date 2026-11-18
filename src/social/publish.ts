/**
 * Tokyo social publisher — the fan-out.
 *
 * Takes one job, works out which platforms are actually eligible (preset →
 * switch → credentials), exposes the file publicly if any of them pull by URL,
 * then publishes. One platform failing never stops the others.
 */

import { ADAPTERS } from "./adapters";
import { expose, unexpose, publicHostingReady } from "./media";
import { getJob, getTargets, setJobStatus, setTargets, updateTarget, isSwitchOn } from "./store";
import {
  PRESET_PLATFORMS,
  PRESET_RULES,
  PLATFORM_LABEL,
  type MediaAsset,
  type Platform,
  type Preset,
  type PublishResult,
} from "./types";

export interface Eligibility {
  selected: Platform[];
  skipped: Array<{ platform: Platform; reason: string }>;
}

/**
 * Which platforms a preset would actually publish to right now.
 * `explicit` overrides the switches (the per-job toggles in the keyboard).
 */
export function resolvePlatforms(preset: Preset, explicit?: Platform[]): Eligibility {
  const selected: Platform[] = [];
  const skipped: Eligibility["skipped"] = [];

  for (const platform of PRESET_PLATFORMS[preset]) {
    const adapter = ADAPTERS[platform];
    if (explicit && !explicit.includes(platform)) continue;
    if (!explicit && !isSwitchOn(platform, preset)) {
      skipped.push({ platform, reason: "switched off" });
      continue;
    }
    if (!adapter.supports(preset)) {
      skipped.push({ platform, reason: `does not take ${preset}` });
      continue;
    }
    if (!adapter.isConfigured()) {
      skipped.push({ platform, reason: adapter.missing() });
      continue;
    }
    if (adapter.requiresPublicUrl && !publicHostingReady()) {
      skipped.push({ platform, reason: "needs SOCIAL_PUBLIC_BASE + a served public dir" });
      continue;
    }
    selected.push(platform);
  }
  return { selected, skipped };
}

/** Soft checks so the user hears about a bad fit before the platform rejects it. */
export function presetWarnings(asset: MediaAsset, preset: Preset): string[] {
  const rules = PRESET_RULES[preset];
  const out: string[] = [];
  if (asset.durationSec > rules.maxSeconds) {
    out.push(
      `clip is ${Math.round(asset.durationSec)}s — over the ${rules.maxSeconds}s the ${preset} preset expects`
    );
  }
  if (rules.wantsVertical && asset.width >= asset.height) {
    out.push("clip is not vertical — Shorts/Reels placements may not pick it up");
  }
  return out;
}

export interface ProgressEvent {
  platform: Platform;
  phase: "start" | "log" | "done" | "fail";
  message?: string;
  result?: PublishResult;
}

/**
 * Run a stored job. Returns every result, successes and failures alike.
 * `onProgress` is fire-and-forget — a slow Telegram edit never blocks upload.
 */
export async function runJob(
  jobId: number,
  onProgress: (e: ProgressEvent) => void = () => {}
): Promise<PublishResult[]> {
  const job = getJob(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  const platforms = getTargets(jobId).map((t) => t.platform);
  if (!platforms.length) throw new Error("no target platforms selected");

  const asset: MediaAsset = {
    path: job.media_path,
    mime: "video/mp4",
    sizeBytes: job.size_bytes || 0,
    durationSec: job.duration_sec || 0,
    width: job.width || 0,
    height: job.height || 0,
  };

  const needsPublic = platforms.some((p) => ADAPTERS[p].requiresPublicUrl);
  if (needsPublic) asset.publicUrl = expose(asset);

  setJobStatus(jobId, "running");
  const input = {
    asset,
    preset: job.preset,
    caption: job.caption || "",
    title: job.title || (job.caption || "").split("\n")[0] || "Untitled",
    privacy: (job.privacy === "private" ? "private" : "public") as "public" | "private",
  };

  const results: PublishResult[] = [];
  // Two at a time: enough to overlap the slow polling waits, gentle enough
  // that two platforms are never pulling the same file at full tilt.
  const queue = [...platforms];
  const worker = async () => {
    while (queue.length) {
      const platform = queue.shift()!;
      updateTarget(jobId, platform, { status: "running" });
      onProgress({ platform, phase: "start" });
      try {
        const result = await ADAPTERS[platform].publish(input, (line) =>
          onProgress({ platform, phase: "log", message: line })
        );
        updateTarget(jobId, platform, {
          status: "done",
          remote_id: result.id,
          url: result.url,
          warning: result.warning,
        });
        results.push(result);
        onProgress({ platform, phase: "done", result });
      } catch (err: any) {
        const message = String(err?.message || err).slice(0, 500);
        updateTarget(jobId, platform, { status: "failed", error: message });
        const result: PublishResult = { platform, ok: false, error: message };
        results.push(result);
        onProgress({ platform, phase: "fail", message, result });
        console.error(`[social] ${PLATFORM_LABEL[platform]} failed:`, err);
      }
    }
  };
  await Promise.all([worker(), worker()]);

  if (asset.publicUrl) unexpose(asset.publicUrl);
  setJobStatus(jobId, results.every((r) => r.ok) ? "done" : results.some((r) => r.ok) ? "done" : "failed");
  return results;
}

/** Convenience for callers that build the job themselves. */
export function assignTargets(jobId: number, platforms: Platform[]): void {
  setTargets(jobId, platforms);
}
