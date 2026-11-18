import type { Adapter, Platform } from "../types";
import { youtubeAdapter } from "./youtube";
import { tiktokAdapter } from "./tiktok";
import { instagramAdapter } from "./instagram";
import { facebookAdapter } from "./facebook";
import { linkedinAdapter } from "./linkedin";

export const ADAPTERS: Record<Platform, Adapter> = {
  youtube: youtubeAdapter,
  tiktok: tiktokAdapter,
  instagram: instagramAdapter,
  facebook: facebookAdapter,
  linkedin: linkedinAdapter,
};

export { youtubeAdapter, tiktokAdapter, instagramAdapter, facebookAdapter, linkedinAdapter };
