// Which incoming WhatsApp voice notes are transcribed automatically.
// Dev work only by default — clients and contacts whose name matches a project.
// A per-contact setting from the dashboard (Settings > Auto-transcribe) overrides
// that either way. A voice note that is not auto-transcribed keeps its audio and
// waits in Transcripts > Pending.
//
// The shop is deliberately NOT work here (owner's call, 2026-09-20): shop talk is
// personal business, not development. Its one exception is the shop GROUP, whose
// voice notes carry the sales the dashboard logs (shop-group.ts reads
// msg.transcription || msg.content) — turning that off would silently lose every
// sale reported by voice.

export const TRANSCRIBE_SETTINGS = ["default", "on", "off"] as const;
export type TranscribeSetting = (typeof TRANSCRIBE_SETTINGS)[number];

export const CONTACT_CATEGORIES = ["client", "shop", "family", "personal", "other"] as const;
const WORK_CATEGORIES = new Set(["client"]);
/** Never transcribed by the rule, even when the saved name looks like a project. */
const PRIVATE_CATEGORIES = new Set(["family", "personal", "shop"]);

export function isTranscribeSetting(v: unknown): v is TranscribeSetting {
  return typeof v === "string" && (TRANSCRIBE_SETTINGS as readonly string[]).includes(v);
}

export function isWorkContact(c: { category?: string | null; matchesProject?: boolean; isShopGroup?: boolean }): boolean {
  if (c.isShopGroup) return true;
  const category = (c.category ?? "").toLowerCase();
  if (WORK_CATEGORIES.has(category)) return true;
  // An explicit family/personal/shop category beats a project-name match: saved
  // names can carry a project-like prefix ("example.com (Aunt)").
  if (PRIVATE_CATEGORIES.has(category)) return false;
  return !!c.matchesProject;
}

export function shouldAutoTranscribe(c: {
  setting?: string | null;
  category?: string | null;
  matchesProject?: boolean;
  isShopGroup?: boolean;
}): boolean {
  if (c.setting === "on") return true;
  if (c.setting === "off") return false;
  return isWorkContact(c);
}
