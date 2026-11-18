/**
 * TikTok adapter — Content Posting API v2.
 *
 * Two modes, and the difference matters:
 *   direct — the clip goes straight to the profile. Requires the app to have
 *            passed TikTok's content-posting audit.
 *   inbox  — the clip lands in the creator's TikTok drafts for a manual tap.
 *            Works with an unaudited app.
 *
 * Default is `direct` with an automatic fall back to `inbox` when TikTok says
 * the app is unaudited, so an un-reviewed app still publishes something useful
 * instead of erroring out. Pin it with TIKTOK_MODE=direct|inbox.
 */

import { apiJson, truncate, sleep, normalizeCode } from "../http";
import { getAccount, saveAccount } from "../store";
import { readChunk } from "../media";
import { CAPTION_LIMIT, type Adapter, type Preset, type PublishInput, type PublishResult } from "../types";

const API = "https://open.tiktokapis.com/v2";
export const TIKTOK_SCOPES = "user.info.basic,video.publish,video.upload";
/** TikTok requires 5 MB ≤ chunk ≤ 64 MB, and a file under 64 MB in one shot. */
const MAX_SINGLE = 64 * 1024 * 1024;
const CHUNK = 32 * 1024 * 1024;

const clientKey = () => process.env.TIKTOK_CLIENT_KEY || "";
const clientSecret = () => process.env.TIKTOK_CLIENT_SECRET || "";

export function tiktokAuthUrl(redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_key: clientKey(),
    scope: TIKTOK_SCOPES,
    response_type: "code",
    redirect_uri: redirectUri,
    state,
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${q}`;
}

export async function tiktokExchangeCode(code: string, redirectUri: string): Promise<void> {
  const tok = await apiJson<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
    open_id: string;
  }>("TikTok token", `${API}/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: clientKey(),
      client_secret: clientSecret(),
      code: normalizeCode(code),
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  saveAccount("tiktok", {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
    account_id: tok.open_id,
    label: "TikTok creator",
  });
}

async function accessToken(): Promise<string> {
  const acct = getAccount("tiktok");
  if (!acct?.refresh_token) throw new Error("TikTok not connected — run /social connect tiktok");
  if (acct.access_token && acct.expires_at && Date.parse(acct.expires_at) - Date.now() > 60_000) {
    return acct.access_token;
  }
  const tok = await apiJson<{ access_token: string; refresh_token: string; expires_in: number }>(
    "TikTok refresh",
    `${API}/oauth/token/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: clientKey(),
        client_secret: clientSecret(),
        grant_type: "refresh_token",
        refresh_token: acct.refresh_token,
      }),
    }
  );
  saveAccount("tiktok", {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || acct.refresh_token,
    expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
  });
  return tok.access_token;
}

interface CreatorInfo {
  privacy_level_options?: string[];
  max_video_post_duration_sec?: number;
  creator_nickname?: string;
}

async function creatorInfo(token: string): Promise<CreatorInfo> {
  const res = await apiJson<{ data: CreatorInfo }>("TikTok creator_info", `${API}/post/publish/creator_info/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
  });
  return res.data || {};
}

function chunkPlan(size: number): { chunk_size: number; total_chunk_count: number } {
  if (size <= MAX_SINGLE) return { chunk_size: size, total_chunk_count: 1 };
  const total = Math.floor(size / CHUNK);
  return { chunk_size: CHUNK, total_chunk_count: total };
}

async function uploadChunks(uploadUrl: string, filePath: string, size: number, log: (s: string) => void) {
  const { chunk_size, total_chunk_count } = chunkPlan(size);
  for (let i = 0; i < total_chunk_count; i++) {
    const start = i * chunk_size;
    // TikTok wants the trailing remainder folded into the final chunk.
    const end = i === total_chunk_count - 1 ? size - 1 : start + chunk_size - 1;
    const buf = readChunk(filePath, start, end - start + 1);
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(buf.length),
        "Content-Range": `bytes ${start}-${end}/${size}`,
      },
      body: buf,
    });
    if (!res.ok) throw new Error(`TikTok upload ${res.status}: ${(await res.text()).slice(0, 300)}`);
    log(`uploaded ${Math.round(((i + 1) / total_chunk_count) * 100)}%`);
  }
}

async function waitForPublish(token: string, publishId: string): Promise<string | undefined> {
  for (let i = 0; i < 40; i++) {
    await sleep(6000);
    const res = await apiJson<{ data: { status: string; publicaly_available_post_id?: string[]; fail_reason?: string } }>(
      "TikTok status",
      `${API}/post/publish/status/fetch/`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ publish_id: publishId }),
      }
    );
    const d = res.data || ({} as any);
    if (d.status === "PUBLISH_COMPLETE") return d.publicaly_available_post_id?.[0];
    if (d.status === "FAILED") throw new Error(`TikTok publish failed: ${d.fail_reason || "unknown"}`);
  }
  return undefined;
}

export const tiktokAdapter: Adapter = {
  platform: "tiktok",
  requiresPublicUrl: false,

  isConfigured() {
    return Boolean(clientKey() && clientSecret() && getAccount("tiktok")?.refresh_token);
  },

  missing() {
    if (!clientKey() || !clientSecret()) return "TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET in .env";
    return "not connected — /social connect tiktok";
  },

  supports(_preset: Preset) {
    return true;
  },

  async publish(input: PublishInput, log): Promise<PublishResult> {
    const token = await accessToken();
    const size = input.asset.sizeBytes;
    const wantInbox = (process.env.TIKTOK_MODE || "direct").toLowerCase() === "inbox";

    const postToInbox = async (): Promise<PublishResult> => {
      log("uploading to TikTok drafts");
      const init = await apiJson<{ data: { publish_id: string; upload_url: string } }>(
        "TikTok inbox init",
        `${API}/post/publish/inbox/video/init/`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
          body: JSON.stringify({ source_info: { source: "FILE_UPLOAD", video_size: size, ...chunkPlan(size) } }),
        }
      );
      await uploadChunks(init.data.upload_url, input.asset.path, size, log);
      return {
        platform: "tiktok",
        ok: true,
        id: init.data.publish_id,
        warning: "landed in your TikTok drafts — open the app and tap Post (direct posting needs an audited app)",
      };
    };

    if (wantInbox) return postToInbox();

    const info = await creatorInfo(token);
    const options = info.privacy_level_options || [];
    const privacy =
      input.privacy === "private"
        ? "SELF_ONLY"
        : options.includes("PUBLIC_TO_EVERYONE")
          ? "PUBLIC_TO_EVERYONE"
          : options[0] || "SELF_ONLY";

    if (info.max_video_post_duration_sec && input.asset.durationSec > info.max_video_post_duration_sec) {
      throw new Error(
        `clip is ${Math.round(input.asset.durationSec)}s, this TikTok account caps at ${info.max_video_post_duration_sec}s`
      );
    }

    let init;
    try {
      log("opening direct post");
      init = await apiJson<{ data: { publish_id: string; upload_url: string } }>(
        "TikTok init",
        `${API}/post/publish/video/init/`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
          body: JSON.stringify({
            post_info: {
              title: truncate(input.caption || input.title, CAPTION_LIMIT.tiktok),
              privacy_level: privacy,
              disable_duet: false,
              disable_comment: false,
              disable_stitch: false,
              video_cover_timestamp_ms: 1000,
            },
            source_info: { source: "FILE_UPLOAD", video_size: size, ...chunkPlan(size) },
          }),
        }
      );
    } catch (err: any) {
      // An unaudited app gets rejected here; drafts still work, so use them.
      if (/unaudited|audit|scope_not_authorized|access_token_invalid_scope/i.test(err.message)) {
        log("app is not audited for direct posting — falling back to drafts");
        return postToInbox();
      }
      throw err;
    }

    await uploadChunks(init.data.upload_url, input.asset.path, size, log);
    log("waiting for TikTok to finish processing");
    const postId = await waitForPublish(token, init.data.publish_id);

    const handle = info.creator_nickname;
    return {
      platform: "tiktok",
      ok: true,
      id: postId || init.data.publish_id,
      url: postId && handle ? `https://www.tiktok.com/@${handle}/video/${postId}` : undefined,
      warning: privacy !== "PUBLIC_TO_EVERYONE" && input.privacy === "public"
        ? `posted as ${privacy} — this account does not allow public posting through the API yet`
        : undefined,
    };
  },
};
