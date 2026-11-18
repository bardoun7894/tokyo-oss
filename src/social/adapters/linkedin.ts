/**
 * LinkedIn adapter — versioned Videos + Posts API.
 *
 * Three calls: initializeUpload gives back byte ranges and upload URLs, each
 * range is PUT and answers with an ETag, finalizeUpload stitches them, then
 * the Posts API attaches the video urn to an actual feed post.
 *
 * Author can be a person or an organization. Personal posting needs the
 * "Share on LinkedIn" product (w_member_social). Posting as a company page
 * additionally needs Community Management API approval — set
 * LINKEDIN_AUTHOR_URN=urn:li:organization:<id> once that is granted.
 */

import { apiJson, apiRaw, truncate, normalizeCode } from "../http";
import { getAccount, saveAccount } from "../store";
import { readChunk } from "../media";
import { CAPTION_LIMIT, type Adapter, type Preset, type PublishInput, type PublishResult } from "../types";

const REST = "https://api.linkedin.com/rest";
const VERSION = process.env.LINKEDIN_API_VERSION || "202405";
export const LINKEDIN_SCOPES = "openid profile w_member_social";

const clientId = () => process.env.LINKEDIN_CLIENT_ID || "";
const clientSecret = () => process.env.LINKEDIN_CLIENT_SECRET || "";

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "LinkedIn-Version": VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
    "Content-Type": "application/json",
  };
}

export function linkedinAuthUrl(redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId(),
    redirect_uri: redirectUri,
    scope: LINKEDIN_SCOPES,
    state,
  });
  return `https://www.linkedin.com/oauth/v2/authorization?${q}`;
}

export async function linkedinExchangeCode(code: string, redirectUri: string): Promise<void> {
  const tok = await apiJson<{ access_token: string; expires_in: number; refresh_token?: string }>(
    "LinkedIn token",
    "https://www.linkedin.com/oauth/v2/accessToken",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: normalizeCode(code),
        client_id: clientId(),
        client_secret: clientSecret(),
        redirect_uri: redirectUri,
      }),
    }
  );

  // OIDC userinfo gives the member id needed to build the author urn.
  let authorUrn = process.env.LINKEDIN_AUTHOR_URN || "";
  let name: string | undefined;
  try {
    const me = await apiJson<{ sub: string; name?: string }>("LinkedIn userinfo", "https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    if (!authorUrn) authorUrn = `urn:li:person:${me.sub}`;
    name = me.name;
  } catch {
    /* organization-only tokens have no userinfo; LINKEDIN_AUTHOR_URN covers it */
  }

  saveAccount("linkedin", {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token ?? null,
    expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
    account_id: authorUrn,
    account_kind: authorUrn.includes("organization") ? "business" : "personal",
    label: name || "LinkedIn",
  });
}

function authorUrn(): string {
  return process.env.LINKEDIN_AUTHOR_URN || getAccount("linkedin")?.account_id || "";
}

function token(): string {
  return getAccount("linkedin")?.access_token || process.env.LINKEDIN_ACCESS_TOKEN || "";
}

/**
 * The Posts API treats a set of punctuation as markup in `commentary`;
 * an unescaped one is a 422, so escape them all.
 */
function escapeCommentary(text: string): string {
  return text.replace(/[\\<>#~_|{}@\[\]()*]/g, (c) => `\\${c}`);
}

export const linkedinAdapter: Adapter = {
  platform: "linkedin",
  requiresPublicUrl: false,

  isConfigured() {
    return Boolean(token() && authorUrn());
  },

  missing() {
    if (!token()) return "not connected — /social connect linkedin";
    return "LINKEDIN_AUTHOR_URN missing (urn:li:person:… or urn:li:organization:…)";
  },

  supports(_preset: Preset) {
    return true;
  },

  async publish(input: PublishInput, log): Promise<PublishResult> {
    const tk = token();
    const owner = authorUrn();
    const size = input.asset.sizeBytes;

    log("initializing upload");
    const init = await apiJson<{
      value: {
        video: string;
        uploadToken: string;
        uploadInstructions: Array<{ uploadUrl: string; firstByte: number; lastByte: number }>;
      };
    }>("LinkedIn init", `${REST}/videos?action=initializeUpload`, {
      method: "POST",
      headers: headers(tk),
      body: JSON.stringify({
        initializeUploadRequest: {
          owner,
          fileSizeBytes: size,
          uploadCaptions: false,
          uploadThumbnail: false,
        },
      }),
    });

    const parts: string[] = [];
    const instructions = init.value.uploadInstructions;
    for (let i = 0; i < instructions.length; i++) {
      const { uploadUrl, firstByte, lastByte } = instructions[i];
      const buf = readChunk(input.asset.path, firstByte, lastByte - firstByte + 1);
      const res = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(buf.length) },
        body: buf,
      });
      if (!res.ok) throw new Error(`LinkedIn upload ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const etag = res.headers.get("etag");
      if (!etag) throw new Error("LinkedIn upload returned no ETag for a part");
      parts.push(etag.replace(/"/g, ""));
      log(`uploaded ${Math.round(((i + 1) / instructions.length) * 100)}%`);
    }

    log("finalizing video");
    await fetch(`${REST}/videos?action=finalizeUpload`, {
      method: "POST",
      headers: headers(tk),
      body: JSON.stringify({
        finalizeUploadRequest: {
          video: init.value.video,
          uploadToken: init.value.uploadToken || "",
          uploadedPartIds: parts,
        },
      }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`LinkedIn finalize ${r.status}: ${(await r.text()).slice(0, 300)}`);
    });

    log("creating post");
    const { headers: resHeaders } = await apiRaw("LinkedIn post", `${REST}/posts`, {
      method: "POST",
      headers: headers(tk),
      body: JSON.stringify({
        author: owner,
        commentary: escapeCommentary(truncate(input.caption, CAPTION_LIMIT.linkedin)),
        visibility: input.privacy === "private" ? "CONNECTIONS" : "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        content: { media: { title: truncate(input.title, 200), id: init.value.video } },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      }),
    });

    const postUrn = resHeaders.get("x-restli-id") || undefined;
    return {
      platform: "linkedin",
      ok: true,
      id: postUrn,
      url: postUrn ? `https://www.linkedin.com/feed/update/${postUrn}/` : undefined,
    };
  },
};

/**
 * Text-only post — the same Posts API call the video path ends with, minus the
 * `content` block. This is what the AI-news automation uses; there is no media
 * to initialize, upload or finalize, so it is a single request.
 *
 * Returns the post URN and the public feed URL.
 */
export async function linkedinPostText(
  text: string,
  privacy: "public" | "private" = "public"
): Promise<{ id?: string; url?: string }> {
  const tk = token();
  const owner = authorUrn();
  if (!tk) throw new Error("LinkedIn not connected — run /social connect linkedin");
  if (!owner) throw new Error("LINKEDIN_AUTHOR_URN missing (urn:li:person:… or urn:li:organization:…)");

  const { headers: resHeaders } = await apiRaw("LinkedIn text post", `${REST}/posts`, {
    method: "POST",
    headers: headers(tk),
    body: JSON.stringify({
      author: owner,
      commentary: escapeCommentary(truncate(text, CAPTION_LIMIT.linkedin)),
      visibility: privacy === "private" ? "CONNECTIONS" : "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
  });

  const postUrn = resHeaders.get("x-restli-id") || undefined;
  return { id: postUrn, url: postUrn ? `https://www.linkedin.com/feed/update/${postUrn}/` : undefined };
}

/** True when a text post could go out right now. */
export function linkedinTextReady(): boolean {
  return Boolean(token() && authorUrn());
}
