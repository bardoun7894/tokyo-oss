export type Platform = "youtube" | "tiktok" | "instagram" | "facebook" | "linkedin";
export type Stage = "idea" | "scripted" | "recorded" | "edited" | "scheduled" | "posted";
export type Format = "short" | "long";
export type CaptionField = "title" | "description" | "caption" | "hashtags";

export const PLATFORMS: Platform[] = ["youtube", "tiktok", "instagram", "facebook", "linkedin"];
export const STAGES: Stage[] = ["idea", "scripted", "recorded", "edited", "scheduled", "posted"];

export const PLATFORM_LABEL: Record<Platform, string> = {
  youtube: "YouTube",
  tiktok: "TikTok",
  instagram: "Instagram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
};

export const PLATFORM_SHORT: Record<Platform, string> = {
  youtube: "YT",
  tiktok: "TT",
  instagram: "IG",
  facebook: "FB",
  linkedin: "IN",
};

export const STAGE_LABEL: Record<Stage, string> = {
  idea: "Idea",
  scripted: "Scripted",
  recorded: "Recorded",
  edited: "Edited",
  scheduled: "Scheduled",
  posted: "Posted",
};

export interface Caption {
  title: string;
  description: string;
  caption: string;
  hashtags: string;
}

export interface ContentItem {
  id: number;
  title: string;
  hook: string;
  script: string;
  notes: string;
  format: Format;
  stage: Stage;
  platforms: Platform[];
  video_path: string | null;
  video_name: string | null;
  video_size: number | null;
  duration_sec: number | null;
  width: number | null;
  height: number | null;
  scheduled_at: number | null;
  posted_at: number | null;
  sort: number;
  created_at: string;
  updated_at: string;
}

export interface BoardItem extends ContentItem {
  publications: Array<{ platform: Platform; status: string; url: string | null }>;
}

export interface Publication {
  id: number;
  item_id: number;
  job_id: number;
  platform: Platform;
  kind: "now" | "scheduled";
  created_at: string;
  job_status: string | null;
  scheduled_at: number | null;
  finished_at: string | null;
  target_status: string | null;
  url: string | null;
  error: string | null;
  warning: string | null;
}

export interface ItemDetail {
  item: ContentItem;
  captions: Record<Platform, Caption>;
  publications: Publication[];
  publishing: boolean;
  videoExists: boolean;
}

export interface PlatformStatus {
  platform: Platform;
  label: string;
  connected: boolean;
  accountLabel: string | null;
  expiresAt: string | null;
  configured: boolean;
  missing: string;
  requiresPublicUrl: boolean;
  supportsShort: boolean;
  supportsLong: boolean;
}

export interface PlatformsMeta {
  stages: Stage[];
  fields: Record<Platform, CaptionField[]>;
  limits: Record<Platform, Partial<Record<CaptionField, number>>>;
  publicHosting: boolean;
  platforms: PlatformStatus[];
}

export interface CalendarEvent {
  itemId: number;
  title: string;
  format: Format;
  kind: "scheduled" | "posted" | "failed";
  at: number;
  platforms: Platform[];
  urls: Array<{ platform: Platform; url: string }>;
}

export function humanSize(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function humanDuration(sec: number | null): string {
  if (!sec) return "";
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  return m ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

export function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
