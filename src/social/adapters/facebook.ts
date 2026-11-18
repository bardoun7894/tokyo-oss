/**
 * Facebook Page adapter — Graph API.
 *
 * SHORT goes through the three-phase Reels endpoint, VIDEO through the plain
 * Page video endpoint. Both let Facebook pull the file from a public URL
 * instead of streaming bytes through Tokyo, so `requiresPublicUrl` is true.
 *
 * Setup: a Meta app with a Page access token that has pages_manage_posts +
 * pages_read_engagement. Put FACEBOOK_PAGE_ID and FACEBOOK_PAGE_TOKEN in .env
 * (or connect via /social connect facebook).
 */

import { apiJson, pollUntil, truncate } from "../http";
import { getAccount } from "../store";
import { CAPTION_LIMIT, type Adapter, type Preset, type PublishInput, type PublishResult } from "../types";

export const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || "v21.0"}`;

export function facebookPageId(): string {
  return getAccount("facebook")?.account_id || process.env.FACEBOOK_PAGE_ID || "";
}

export function facebookToken(): string {
  return getAccount("facebook")?.access_token || process.env.FACEBOOK_PAGE_TOKEN || "";
}

export const facebookAdapter: Adapter = {
  platform: "facebook",
  requiresPublicUrl: true,

  isConfigured() {
    return Boolean(facebookPageId() && facebookToken());
  },

  missing() {
    if (!facebookPageId()) return "FACEBOOK_PAGE_ID missing";
    return "no Page access token — /social connect facebook";
  },

  supports(_preset: Preset) {
    return true;
  },

  async publish(input: PublishInput, log): Promise<PublishResult> {
    const pageId = facebookPageId();
    const token = facebookToken();
    const url = input.asset.publicUrl;
    if (!url) throw new Error("Facebook needs the clip on a public URL — set SOCIAL_PUBLIC_BASE");

    const description = truncate(input.caption, CAPTION_LIMIT.facebook);

    if (input.preset === "video") {
      log("posting Page video");
      const res = await apiJson<{ id: string }>("Facebook video", `${GRAPH}/${pageId}/videos`, {
        method: "POST",
        body: new URLSearchParams({
          file_url: url,
          title: truncate(input.title, 255),
          description,
          access_token: token,
        }),
      });
      return {
        platform: "facebook",
        ok: true,
        id: res.id,
        url: `https://www.facebook.com/${pageId}/videos/${res.id}`,
      };
    }

    // --- Reels: start → upload → finish ---
    log("starting reel upload session");
    const start = await apiJson<{ video_id: string; upload_url: string }>(
      "Facebook reel start",
      `${GRAPH}/${pageId}/video_reels`,
      {
        method: "POST",
        body: new URLSearchParams({ upload_phase: "start", access_token: token }),
      }
    );

    log("handing the file URL to Facebook");
    await apiJson("Facebook reel upload", start.upload_url, {
      method: "POST",
      headers: {
        Authorization: `OAuth ${token}`,
        file_url: url,
      },
    });

    log("publishing reel");
    await apiJson("Facebook reel finish", `${GRAPH}/${pageId}/video_reels`, {
      method: "POST",
      body: new URLSearchParams({
        upload_phase: "finish",
        video_id: start.video_id,
        video_state: input.privacy === "private" ? "DRAFT" : "PUBLISHED",
        description,
        access_token: token,
      }),
    });

    // Finish returns immediately; the reel is only live once encoding settles.
    try {
      await pollUntil(
        async () => {
          const s = await apiJson<{ status?: { video_status?: string; uploading_phase?: { status?: string } } }>(
            "Facebook reel status",
            `${GRAPH}/${start.video_id}?fields=status&access_token=${encodeURIComponent(token)}`
          );
          const st = s.status?.video_status;
          if (st === "ready" || st === "published") return st;
          if (st === "error") throw new Error("Facebook reported an encoding error");
          return undefined;
        },
        { timeoutMs: 5 * 60_000, intervalMs: 6000 }
      );
    } catch (err: any) {
      return {
        platform: "facebook",
        ok: true,
        id: start.video_id,
        url: `https://www.facebook.com/reel/${start.video_id}`,
        warning: `published, still encoding (${err.message})`,
      };
    }

    return {
      platform: "facebook",
      ok: true,
      id: start.video_id,
      url: `https://www.facebook.com/reel/${start.video_id}`,
    };
  },
};
