/**
 * Content Studio — shared types.
 *
 * A content item is one video on its way from idea to posted. Publishing goes
 * through the social module; this layer only plans, drafts and remembers which
 * social jobs belong to which item.
 */

import type { Platform } from "../social/types";

export const STAGES = ["idea", "scripted", "recorded", "edited", "scheduled", "posted"] as const;
export type Stage = (typeof STAGES)[number];

export type Format = "short" | "long";

export interface ContentItemRow {
  id: number;
  title: string;
  hook: string;
  script: string;
  notes: string;
  format: Format;
  stage: Stage;
  platforms: string;
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

export interface ContentItem extends Omit<ContentItemRow, "platforms"> {
  platforms: Platform[];
}

export interface Caption {
  title: string;
  description: string;
  caption: string;
  hashtags: string;
}

export type CaptionField = keyof Caption;

/** Which caption fields each platform actually uses when publishing. */
export const CAPTION_FIELDS: Record<Platform, CaptionField[]> = {
  youtube: ["title", "description", "hashtags"],
  tiktok: ["caption", "hashtags"],
  instagram: ["caption", "hashtags"],
  facebook: ["title", "description", "hashtags"],
  linkedin: ["title", "caption", "hashtags"],
};

/**
 * Ceilings per field. Hashtags are appended to the body field (description or
 * caption), so they count toward that field's limit.
 */
export const CAPTION_LIMITS: Record<Platform, Partial<Record<CaptionField, number>>> = {
  youtube: { title: 100, description: 5000 },
  tiktok: { caption: 2200 },
  instagram: { caption: 2200 },
  facebook: { title: 255, description: 5000 },
  linkedin: { title: 200, caption: 3000 },
};

/** Instagram rejects posts with more than 30 hashtags. */
export const MAX_HASHTAGS: Partial<Record<Platform, number>> = { instagram: 30 };

/** The YouTube adapter appends " #Shorts" to a short's title. */
export const YT_SHORTS_SUFFIX = " #Shorts";

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

export interface CalendarEvent {
  itemId: number;
  title: string;
  format: Format;
  kind: "scheduled" | "posted" | "failed";
  at: number;
  platforms: Platform[];
  urls: Array<{ platform: Platform; url: string }>;
}
