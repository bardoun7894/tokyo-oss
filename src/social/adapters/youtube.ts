/**
 * YouTube adapter — Data API v3 resumable upload.
 *
 * A SHORT preset upload is a normal video: YouTube classifies it as a Short
 * itself when the clip is vertical and under 3 minutes, so we only make sure
 * the metadata says so.
 *
 * Setup: create an OAuth client (Web application) in Google Cloud, enable the
 * YouTube Data API v3, then run `/social connect youtube` and paste the code.
 */

import fs from "fs";
import { apiJson, truncate, normalizeCode } from "../http";
import { getAccount, saveAccount } from "../store";
import { CAPTION_LIMIT, type Adapter, type Preset, type PublishInput, type PublishResult } from "../types";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_URL =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
export const YOUTUBE_SCOPES = "https://www.googleapis.com/auth/youtube.upload";
const CHUNK = 8 * 1024 * 1024;

const clientId = () => process.env.YOUTUBE_CLIENT_ID || "";
const clientSecret = () => process.env.YOUTUBE_CLIENT_SECRET || "";

export function youtubeAuthUrl(redirectUri: string): string {
  const q = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: YOUTUBE_SCOPES,
    access_type: "offline",
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

/** Exchange an OAuth code for tokens and persist them. */
export async function youtubeExchangeCode(code: string, redirectUri: string): Promise<void> {
  const body = new URLSearchParams({
    code: normalizeCode(code),
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const tok = await apiJson<{ access_token: string; refresh_token?: string; expires_in: number }>(
    "YouTube token",
    TOKEN_URL,
    { method: "POST", body }
  );
  if (!tok.refresh_token) {
    throw new Error("Google returned no refresh_token — revoke the app at myaccount.google.com/permissions and retry");
  }
  saveAccount("youtube", {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
    label: "YouTube channel",
  });
}

async function accessToken(): Promise<string> {
  const acct = getAccount("youtube");
  const refresh = acct?.refresh_token || process.env.YOUTUBE_REFRESH_TOKEN;
  if (!refresh) throw new Error("YouTube not connected — run /social connect youtube");

  const stillValid =
    acct?.access_token && acct.expires_at && Date.parse(acct.expires_at) - Date.now() > 60_000;
  if (stillValid) return acct!.access_token!;

  const tok = await apiJson<{ access_token: string; expires_in: number }>("YouTube refresh", TOKEN_URL, {
    method: "POST",
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  saveAccount("youtube", {
    access_token: tok.access_token,
    refresh_token: refresh,
    expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
  });
  return tok.access_token;
}

export const youtubeAdapter: Adapter = {
  platform: "youtube",
  requiresPublicUrl: false,

  isConfigured() {
    const acct = getAccount("youtube");
    return Boolean(
      clientId() && clientSecret() && (acct?.refresh_token || process.env.YOUTUBE_REFRESH_TOKEN)
    );
  },

  missing() {
    if (!clientId() || !clientSecret()) return "YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET in .env";
    return "not connected — /social connect youtube";
  },

  supports(_preset: Preset) {
    return true;
  },

  async publish(input: PublishInput, log): Promise<PublishResult> {
    const token = await accessToken();
    const isShort = input.preset === "short";
    const description = truncate(input.caption, CAPTION_LIMIT.youtube);

    const metadata = {
      snippet: {
        // #Shorts in the title is what still nudges the Shorts shelf reliably.
        title: truncate(isShort ? `${input.title} #Shorts` : input.title, 100),
        description,
        categoryId: process.env.YOUTUBE_CATEGORY_ID || "22",
      },
      status: {
        privacyStatus: input.privacy === "private" ? "private" : "public",
        selfDeclaredMadeForKids: false,
      },
    };

    log("opening resumable session");
    const initRes = await fetch(UPLOAD_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Upload-Content-Type": input.asset.mime,
        "X-Upload-Content-Length": String(input.asset.sizeBytes),
      },
      body: JSON.stringify(metadata),
    });
    if (!initRes.ok) {
      throw new Error(`YouTube init ${initRes.status}: ${(await initRes.text()).slice(0, 300)}`);
    }
    const session = initRes.headers.get("location");
    if (!session) throw new Error("YouTube returned no resumable upload URL");

    // One PUT per chunk so a 700 MB long-form upload does not sit in memory.
    const total = input.asset.sizeBytes;
    let offset = 0;
    let final: any = null;
    const fd = fs.openSync(input.asset.path, "r");
    try {
      while (offset < total) {
        const size = Math.min(CHUNK, total - offset);
        const buf = Buffer.alloc(size);
        fs.readSync(fd, buf, 0, size, offset);
        const res = await fetch(session, {
          method: "PUT",
          headers: {
            "Content-Length": String(size),
            "Content-Range": `bytes ${offset}-${offset + size - 1}/${total}`,
          },
          body: buf,
        });
        if (res.status === 308) {
          offset += size;
          log(`uploaded ${Math.round((offset / total) * 100)}%`);
          continue;
        }
        if (!res.ok) throw new Error(`YouTube upload ${res.status}: ${(await res.text()).slice(0, 300)}`);
        final = await res.json();
        offset += size;
      }
    } finally {
      fs.closeSync(fd);
    }

    const id = final?.id;
    if (!id) throw new Error("YouTube accepted the upload but returned no video id");
    return {
      platform: "youtube",
      ok: true,
      id,
      url: `https://youtu.be/${id}`,
      warning:
        isShort && input.asset.height <= input.asset.width
          ? "uploaded, but the clip is not vertical so YouTube may not shelf it as a Short"
          : undefined,
    };
  },
};
