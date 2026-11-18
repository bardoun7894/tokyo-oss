// Area: which part of life an item belongs to -- work, personal, or learn.
// Jev decides it. When Jev is off, fails, or is unsure, the item's existing
// category decides if it maps cleanly, otherwise the area stays null
// ("unsorted") rather than being guessed.

import { jevChoice } from "./jev";

export const AREAS = ["work", "personal", "learn"] as const;
export type Area = (typeof AREAS)[number];

const CRITERIA: Record<Area, string> = {
  work:
    "Anything done for a client or the business: building, fixing, designing, testing or releasing apps and websites, " +
    "app store uploads, sending source code, prices, payments, invoices, client meetings and follow-ups, the shop and its stock, job hunting.",
  personal:
    "Private life with no client or business involved: family, health, home, faith and prayer, " +
    "personal errands and purchases, friends.",
  learn:
    "Improving his own skills, not work done for someone else: courses, reading, tutorials, research, practising.",
};


// Categories used across Tokyo (tasks, journal, WhatsApp plans) that map to one area.
// Only a fallback: categories are often set loosely upstream, so Jev never sees them.
const CATEGORY_AREA: Record<string, Area> = {
  client: "work", shop: "work", admin: "work", work: "work", dev: "work", business: "work", job: "work",
  personal: "personal", family: "personal", health: "personal", deen: "personal", home: "personal",
  learn: "learn", learning: "learn", study: "learn", course: "learn", reading: "learn",
};

export function areaFromCategory(category: string | null | undefined): Area | null {
  if (!category) return null;
  return CATEGORY_AREA[category.trim().toLowerCase()] ?? null;
}

export function isArea(v: unknown): v is Area {
  return typeof v === "string" && (AREAS as readonly string[]).includes(v);
}

// Some WhatsApp-made task titles end in " — personal — medium": the category and
// priority pasted into the title. Jev reads that literally, so it is cut off.
const TITLE_TAG = /\s*[—-]\s*(client|shop|personal|admin)(\s*[—-]\s*(low|medium|high|urgent))?\s*$/i;

export async function decideArea(
  item: { kind: "task" | "journal"; text: string; category?: string | null; projectId?: number | null },
): Promise<Area | null> {
  // Projects are client projects; no model needed.
  if (item.projectId) return "work";
  const { setting, settingOn } = require("./settings") as typeof import("./settings");
  if (!settingOn("AREAS_ENABLED")) return areaFromCategory(item.category);
  const name = setting("PROFILE_NAME") || "the user";
  const jev = await jevChoice<Area>(
    { item_kind: item.kind, text: item.text.split("\n").map((l) => l.replace(TITLE_TAG, "")).join("\n").slice(0, 4000) },
    `Which area of ${name}'s life this item belongs to. ${name} is a freelance developer who also runs a shop.`,
    CRITERIA,
    0.7,
  );
  return jev?.choice ?? areaFromCategory(item.category);
}
