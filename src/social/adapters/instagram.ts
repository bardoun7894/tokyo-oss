/**
 * Instagram adapter — Content Publishing API.
 *
 * Instagram never accepts a binary upload: you hand it a public URL, it builds
 * a media container asynchronously, you poll, then you publish the container.
 * Both presets go out as REELS — feed video was folded into Reels in 2022.
 *
 * Setup: an Instagram *Business* or *Creator* account linked to a Facebook
 * Page, and a token with instagram_basic + instagram_content_publish +
 * pages_read_engagement. Set INSTAGRAM_USER_ID (the IG user id, not the handle).
 */

import { apiJson, pollUntil, truncate } from "../http";
import { getAccount } from "../store";
import { GRAPH, facebookToken } from "./facebook";
import { CAPTION_LIMIT, type Adapter, type Preset, type PublishInput, type PublishResult } from "../types";

function igUserId(): string {
  return getAccount("instagram")?.account_id || process.env.INSTAGRAM_USER_ID || "";
}

function igToken(): string {
  // The IG Graph API is driven by the linked Page's token, so fall back to it.
  return getAccount("instagram")?.access_token || process.env.INSTAGRAM_TOKEN || facebookToken();
}

export const instagramAdapter: Adapter = {
  platform: "instagram",
  requiresPublicUrl: true,

  isConfigured() {
    return Boolean(igUserId() && igToken());
  },

  missing() {
    if (!igUserId()) return "INSTAGRAM_USER_ID missing (IG Business account id)";
    return "no access token — /social connect instagram";
  },

  supports(_preset: Preset) {
    return true;
  },

  async publish(input: PublishInput, log): Promise<PublishResult> {
    const userId = igUserId();
    const token = igToken();
    const url = input.asset.publicUrl;
    if (!url) throw new Error("Instagram needs the clip on a public URL — set SOCIAL_PUBLIC_BASE");

    log("creating media container");
    const container = await apiJson<{ id: string }>("Instagram container", `${GRAPH}/${userId}/media`, {
      method: "POST",
      body: new URLSearchParams({
        media_type: "REELS",
        video_url: url,
        caption: truncate(input.caption, CAPTION_LIMIT.instagram),
        share_to_feed: "true",
        access_token: token,
      }),
    });

    log("waiting for Instagram to fetch and transcode");
    await pollUntil(
      async () => {
        const s = await apiJson<{ status_code: string; status?: string }>(
          "Instagram status",
          `${GRAPH}/${container.id}?fields=status_code,status&access_token=${encodeURIComponent(token)}`
        );
        if (s.status_code === "FINISHED") return true;
        if (s.status_code === "ERROR") throw new Error(`Instagram rejected the media: ${s.status || "unknown reason"}`);
        return undefined;
      },
      { timeoutMs: 10 * 60_000, intervalMs: 8000 }
    );

    log("publishing");
    const published = await apiJson<{ id: string }>("Instagram publish", `${GRAPH}/${userId}/media_publish`, {
      method: "POST",
      body: new URLSearchParams({ creation_id: container.id, access_token: token }),
    });

    let permalink: string | undefined;
    try {
      const meta = await apiJson<{ permalink?: string }>(
        "Instagram permalink",
        `${GRAPH}/${published.id}?fields=permalink&access_token=${encodeURIComponent(token)}`
      );
      permalink = meta.permalink;
    } catch {
      /* the post exists either way */
    }

    return {
      platform: "instagram",
      ok: true,
      id: published.id,
      url: permalink,
      warning:
        input.preset === "video" && input.asset.durationSec > 900
          ? "Instagram caps Reels at 15 minutes — anything longer is rejected"
          : undefined,
    };
  },
};
