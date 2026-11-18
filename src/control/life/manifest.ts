import type { Cap } from "../store";
import { LIFE_ROWS, type LifeRow } from "./table";

// L0 (spec FR4): what this device may do in each Life section, so the app draws only what the server allows. Derived from the table
// and the device's caps; nothing in it names a path.

/** The sections of the Life shell, in screen order: Today, Plan, Work and money, Business, Comms, System. */
export const SECTION_IDS = [
  "today", "tasks", "habits", "goals", "schedule", "journal", "deen",
  "work", "money", "finance", "trends", "shop",
  "products", "content", "instagram", "repos",
  "whatsapp", "chat", "analytics", "transcripts", "media",
  "server", "settings",
] as const;
export type SectionId = (typeof SECTION_IDS)[number];

const RANGES: [from: number, to: number, sections: SectionId[]][] = [
  [1, 1, ["today", "tasks", "finance"]], // overview feeds Home, Tasks and Finance
  [2, 2, ["goals"]],
  [3, 3, ["money"]],
  [4, 4, ["tasks"]], // bulk-cleanup suggestions
  [5, 5, ["habits"]],
  [6, 7, ["schedule"]],
  [8, 8, ["media"]], // gallery bytes; Schedule shows the same files through the day's media keys
  [9, 10, ["work"]],
  [11, 11, ["finance", "trends"]],
  [12, 13, ["deen"]],
  [14, 14, ["journal"]],
  [15, 15, ["shop"]],
  [16, 20, ["products"]],
  [21, 21, ["repos"]],
  [22, 25, ["content"]],
  [26, 27, ["media"]],
  [28, 29, ["instagram"]],
  [30, 32, ["whatsapp"]],
  [33, 33, ["chat"]],
  [34, 35, ["analytics"]],
  [36, 37, ["transcripts"]],
  [38, 38, ["server"]],
  [39, 41, ["settings"]],
  [42, 50, ["tasks"]],
  [51, 53, ["habits"]],
  [54, 56, ["goals"]],
  [57, 59, ["work"]],
  [60, 65, ["money"]],
  [66, 67, ["deen"]],
  [68, 68, ["journal"]],
  [69, 72, ["products"]],
  [73, 74, ["repos"]],
  [75, 85, ["content"]],
  [86, 86, ["media"]],
  [87, 92, ["instagram"]],
  [93, 93, ["whatsapp"]],
  [94, 94, ["analytics"]],
  [95, 96, ["transcripts"]],
  [97, 99, ["settings"]],
];

/** The sections a row belongs to (research-life.md, Note column). A write row is in exactly one. */
export const SECTIONS_OF: Readonly<Record<string, readonly SectionId[]>> = (() => {
  const out: Record<string, readonly SectionId[]> = {};
  for (const [from, to, sections] of RANGES) for (let n = from; n <= to; n++) out[`L${n}`] = sections;
  return out;
})();

export interface LifeManifest {
  sections: { id: SectionId; actions: string[] }[];
  /** Whether the upload actions are offered: the nginx upload location exists (Z4) and the device can write. */
  uploads: boolean;
}

const rowNumber = (r: LifeRow): number => Number(r.id.slice(1));

/**
 * The sections this device can use and, in each, the write rows it may call (by row id). A section is there when the device may use at
 * least one of its rows: reads need `life:read`, writes `life:write`. The upload rows are left out while uploads are off.
 */
export function buildManifest(caps: readonly Cap[], uploadsOn: boolean): LifeManifest {
  const canRead = caps.includes("life:read");
  const canWrite = caps.includes("life:write");
  const uploads = uploadsOn && canWrite;
  const usable = LIFE_ROWS.filter((r) => (r.method === "GET" ? canRead : canWrite));
  const sections = SECTION_IDS.map((id) => {
    const rows = usable.filter((r) => SECTIONS_OF[r.id].includes(id));
    const actions = rows.filter((r) => r.method !== "GET" && (uploads || r.kind !== "upload")).sort((a, b) => rowNumber(a) - rowNumber(b)).map((r) => r.id);
    return { id, rows: rows.length, actions };
  }).filter((s) => s.rows > 0).map(({ id, actions }) => ({ id, actions }));
  return { sections, uploads };
}
