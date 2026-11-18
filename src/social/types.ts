/**
 * Tokyo social publisher — shared types.
 *
 * One video in, many platforms out. Two "places" (presets):
 *   short — vertical clip: TikTok, IG Reels, YT Shorts, FB Reels, LinkedIn
 *   video — long-form:     YouTube, Facebook video, LinkedIn, IG feed video
 */

export type Platform = "youtube" | "tiktok" | "instagram" | "facebook" | "linkedin";
export type Preset = "short" | "video";
export type TargetStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type JobStatus = "draft" | "scheduled" | "running" | "done" | "failed" | "cancelled";

export const PLATFORMS: Platform[] = ["youtube", "tiktok", "instagram", "facebook", "linkedin"];

export const PLATFORM_LABEL: Record<Platform, string> = {
  youtube: "YouTube",
  tiktok: "TikTok",
  instagram: "Instagram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
};

export const PLATFORM_EMOJI: Record<Platform, string> = {
  youtube: "▶️",
  tiktok: "🎵",
  instagram: "📸",
  facebook: "📘",
  linkedin: "💼",
};

/** Which platforms each preset fans out to, in publish order. */
export const PRESET_PLATFORMS: Record<Preset, Platform[]> = {
  short: ["tiktok", "instagram", "youtube", "facebook", "linkedin"],
  video: ["youtube", "facebook", "linkedin", "instagram", "tiktok"],
};

export const PRESET_LABEL: Record<Preset, string> = {
  short: "🎬 SHORT (vertical clip)",
  video: "📺 VIDEO (long-form)",
};

/**
 * Soft rules per preset. Violations produce warnings, not hard failures —
 * the platform is the real authority and its error is more useful than ours.
 */
export const PRESET_RULES: Record<Preset, { maxSeconds: number; wantsVertical: boolean }> = {
  short: { maxSeconds: 180, wantsVertical: true },
  video: { maxSeconds: 12 * 3600, wantsVertical: false },
};

export interface MediaAsset {
  /** Absolute path on the Tokyo host. */
  path: string;
  /** Public https URL, set only while the asset is exposed for URL-pull platforms. */
  publicUrl?: string;
  mime: string;
  sizeBytes: number;
  durationSec: number;
  width: number;
  height: number;
}

export interface PublishInput {
  asset: MediaAsset;
  preset: Preset;
  /** Body text / description. Used verbatim per platform, trimmed to each limit. */
  caption: string;
  /** Short headline. Falls back to the first line of the caption. */
  title: string;
  privacy: "public" | "private";
}

export interface PublishResult {
  platform: Platform;
  ok: boolean;
  /** Platform-side id (video id, media id, post urn). */
  id?: string;
  url?: string;
  error?: string;
  /** Non-fatal note, e.g. "posted to TikTok drafts (app not audited)". */
  warning?: string;
}

export interface Adapter {
  platform: Platform;
  /** True when credentials for this platform are present and usable. */
  isConfigured(): boolean;
  /** Human-readable reason when isConfigured() is false. */
  missing(): string;
  /** Needs the asset reachable over a public https URL (IG, FB). */
  requiresPublicUrl: boolean;
  supports(preset: Preset): boolean;
  publish(input: PublishInput, log: (line: string) => void): Promise<PublishResult>;
}

/** Caption ceilings per platform, applied before upload. */
export const CAPTION_LIMIT: Record<Platform, number> = {
  youtube: 5000,
  tiktok: 2200,
  instagram: 2200,
  facebook: 5000,
  linkedin: 3000,
};
