/**
 * Content Studio — AI caption drafting.
 *
 * Same model path as src/social/news.ts (Anthropic SDK through the local
 * cli-proxy gateway when CLIPROXY_API_KEY is set). The model returns JSON; every
 * field is then clamped here, so a chatty model can never produce a caption the
 * platform would reject for length.
 */

import { PLATFORM_LABEL, type Platform } from "../social/types";
import {
  CAPTION_FIELDS,
  CAPTION_LIMITS,
  MAX_HASHTAGS,
  YT_SHORTS_SUFFIX,
  type Caption,
  type ContentItem,
} from "./types";

/** "#a b, #c" → "#a #b #c", deduplicated, optionally capped. */
export function normalizeHashtags(raw: string, max?: number): string {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of String(raw || "").split(/[\s,]+/)) {
    const word = part.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
    if (!word) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(`#${word}`);
    if (max && tags.length >= max) break;
  }
  return tags.join(" ");
}

function cut(text: string, limit: number): string {
  const t = String(text || "").trim();
  if (t.length <= limit) return t;
  const slice = t.slice(0, limit - 1);
  const space = slice.lastIndexOf(" ");
  return (space > limit * 0.6 ? slice.slice(0, space) : slice).trimEnd() + "…";
}

/** Body field that hashtags get appended to when publishing. */
export function bodyField(platform: Platform): "description" | "caption" {
  return CAPTION_FIELDS[platform].includes("description") ? "description" : "caption";
}

/** Enforce every limit for one platform's caption. Pure — used for drafts and for publishing. */
export function clampCaption(platform: Platform, c: Caption, format: ContentItem["format"]): Caption {
  const limits = CAPTION_LIMITS[platform];
  const out: Caption = { title: "", description: "", caption: "", hashtags: "" };
  const fields = CAPTION_FIELDS[platform];

  out.hashtags = normalizeHashtags(c.hashtags, MAX_HASHTAGS[platform]);
  if (fields.includes("title")) {
    let titleLimit = limits.title ?? 100;
    if (platform === "youtube" && format === "short") titleLimit -= YT_SHORTS_SUFFIX.length;
    out.title = cut(c.title, titleLimit);
  }
  const body = bodyField(platform);
  const bodyLimit = limits[body] ?? 2200;
  const reserve = out.hashtags ? out.hashtags.length + 2 : 0;
  if (reserve > bodyLimit / 2) out.hashtags = "";
  out[body] = cut(c[body], bodyLimit - (out.hashtags ? reserve : 0));
  return out;
}

/** The title + text a social job for this platform should carry. */
export function composeForJob(
  item: ContentItem,
  platform: Platform,
  raw: Caption
): { title: string; caption: string } {
  const c = clampCaption(platform, raw, item.format);
  const body = bodyField(platform);
  const text = c[body] || item.hook || item.title;
  const caption = [text, c.hashtags].filter(Boolean).join("\n\n");
  const title = c.title || cut(item.title, CAPTION_LIMITS[platform].title ?? 100);
  return { title, caption };
}

function platformBrief(platform: Platform, format: ContentItem["format"]): string {
  const l = CAPTION_LIMITS[platform];
  switch (platform) {
    case "youtube":
      return `youtube: "title" (max ${format === "short" ? 100 - YT_SHORTS_SUFFIX.length : l.title} chars, searchable, no clickbait caps), "description" (2-4 short paragraphs, first line hooks, max ${l.description} chars), "hashtags" (3-5)`;
    case "tiktok":
      return `tiktok: "caption" (1-2 punchy lines, max ${l.caption} chars including hashtags), "hashtags" (3-6)`;
    case "instagram":
      return `instagram: "caption" (hook line, short body, a call to action, max ${l.caption} chars), "hashtags" (5-15, never more than 30)`;
    case "facebook":
      return `facebook: "title" (max ${l.title} chars), "description" (conversational, 1-3 short paragraphs), "hashtags" (2-4)`;
    case "linkedin":
      return `linkedin: "title" (video title, max ${l.title} chars), "caption" (professional first-person post, line breaks between ideas, max ${l.caption} chars), "hashtags" (3-5)`;
  }
}

export function buildPrompt(item: ContentItem, platforms: Platform[]): string {
  const shape = platforms
    .map((p) => `  "${p}": { ${CAPTION_FIELDS[p].map((f) => `"${f}": "..."`).join(", ")} }`)
    .join(",\n");
  return `You write social media copy for the owner, a full-stack developer who publishes videos about building software with AI.

Write the per-platform copy for this ${item.format === "short" ? "short vertical video (under 3 minutes)" : "long-form video"}.

TITLE: ${item.title}
HOOK: ${item.hook || "(none)"}
SCRIPT:
${(item.script || "(no script yet — work from the title and hook)").slice(0, 12000)}
${item.notes ? `\nNOTES:\n${item.notes.slice(0, 2000)}` : ""}

Platforms and what each needs:
${platforms.map((p) => `- ${platformBrief(p, item.format)}`).join("\n")}

Rules:
- Write in the same language as the script (English if unclear).
- Each platform gets copy written for its audience — do not paste the same text everywhere.
- Hashtags go ONLY in "hashtags", space separated, each starting with #. Never put hashtags inside other fields.
- No emoji spam: at most two emoji per field.
- Do not invent facts, numbers or links that are not in the script.

Return ONLY a JSON object, no markdown fence, exactly this shape:
{
${shape}
}`;
}

/** Pull the JSON object out of a model reply and clamp it. Pure — unit-testable. */
export function parseDraft(
  text: string,
  platforms: Platform[],
  format: ContentItem["format"]
): Partial<Record<Platform, Caption>> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI reply had no JSON object");
  let parsed: any;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new Error(`AI reply was not valid JSON: ${(err as Error).message}`);
  }
  const out: Partial<Record<Platform, Caption>> = {};
  for (const p of platforms) {
    const src = parsed?.[p];
    if (!src || typeof src !== "object") continue;
    const str = (v: unknown) => (typeof v === "string" ? v : Array.isArray(v) ? v.join(" ") : "");
    out[p] = clampCaption(
      p,
      {
        title: str(src.title),
        description: str(src.description),
        caption: str(src.caption),
        hashtags: str(src.hashtags),
      },
      format
    );
  }
  if (!Object.keys(out).length) throw new Error("AI reply did not cover any requested platform");
  return out;
}

export async function draftCaptions(
  item: ContentItem,
  platforms: Platform[]
): Promise<Partial<Record<Platform, Caption>>> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({
    apiKey: process.env.CLIPROXY_API_KEY || process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.CLIPROXY_API_KEY ? "http://localhost:8317" : undefined,
  });

  const res = await client.messages.create({
    model: process.env.CONTENT_AI_MODEL || process.env.NEWS_POST_MODEL || "claude-sonnet-5",
    max_tokens: 4000,
    messages: [{ role: "user", content: buildPrompt(item, platforms) }],
  });

  const text = (res.content[0] as any)?.text?.trim();
  if (!text) throw new Error("Claude returned an empty draft");
  return parseDraft(text, platforms, item.format);
}

export { PLATFORM_LABEL };
