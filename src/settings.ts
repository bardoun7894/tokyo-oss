// Dashboard-editable settings.
//
// A setting's value comes from the settings table first, then from the .env
// variable of the same name, then from its default. Keys that replace an env
// variable keep that variable's name and string format ("1", "false", ...), so
// swapping `process.env.X` for `setting("X")` at a call site changes nothing
// until someone saves a value from the dashboard.
//
// Rows carry a scope ('owner' here) so the multi-user Tokyo Life app can keep
// the same table with one scope per user.

import db from "./db";

export type SettingType = "bool" | "number" | "text" | "select";

export interface SettingDef {
  key: string;
  section: "profile" | "modules" | "ai" | "whatsapp" | "jobhunt";
  label: string;
  type: SettingType;
  help?: string;
  default?: string;
  /** bool: the strings stored for on / off, matching what the code already reads. */
  on?: string;
  off?: string;
  /** bool whose "on" is any value except `off` (e.g. JOBHUNT_DRY_RUN !== "false"). */
  onUnlessOff?: boolean;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  /** Where the value takes effect, for the UI. */
  scope?: "dashboard" | "server";
}

const SCOPE = "owner";

export const MODULES = [
  ["tasks", "Tasks"], ["work", "Work"], ["habits", "Habits"], ["deen", "Deen"], ["finance", "Finance"],
  ["shop", "Shop"], ["projects", "Projects"], ["goals", "Goals"], ["journal", "Journal"], ["schedule", "Calendar"],
  ["whatsapp", "WhatsApp"], ["instagram", "Instagram"], ["chat", "Chat"], ["media", "Media"],
  ["transcripts", "Transcripts"], ["content", "Content"], ["trends", "Trends"], ["analytics", "Analytics"], ["server", "Server"],
] as const;

const PRAYER_METHODS = [
  ["2", "ISNA (North America)"], ["3", "Muslim World League"], ["4", "Umm Al-Qura (Makkah)"], ["5", "Egyptian Authority"],
  ["21", "Morocco"], ["12", "UOIF (France)"], ["13", "Diyanet (Turkey)"], ["16", "Dubai"],
];

export const SETTINGS: SettingDef[] = [
  { key: "PROFILE_NAME", section: "profile", label: "Your name", type: "text", default: "The owner",
    help: "Used when Jev decides which area of your life an item belongs to." },
  { key: "PRAYER_CITY", section: "profile", label: "Prayer city", type: "text", default: "Riyadh" },
  { key: "PRAYER_COUNTRY", section: "profile", label: "Prayer country", type: "text", default: "Saudi Arabia" },
  { key: "PRAYER_METHOD", section: "profile", label: "Prayer calculation method", type: "select", default: "4",
    options: PRAYER_METHODS.map(([value, label]) => ({ value, label })),
    help: "Changing the city, country or method refetches today's prayer times." },

  ...MODULES.map(([id, label]): SettingDef => ({
    key: `MODULE_${id.toUpperCase()}`, section: "modules", label, type: "bool", default: "1", on: "1", off: "0",
    scope: "dashboard", help: "Show in the sidebar and on Home. The page itself stays reachable by URL.",
  })),

  { key: "JEV_ENABLED", section: "ai", label: "Use Jev for typed decisions", type: "bool", default: "1", on: "1", off: "0",
    help: "Off: every decision (routing, areas, WhatsApp plans) uses its non-Jev path." },
  { key: "AREAS_ENABLED", section: "ai", label: "Sort new tasks and journal entries into work / personal / learn", type: "bool",
    default: "1", on: "1", off: "0", help: "Off: only a known category sets the area; Jev is not asked." },
  { key: "TRANSCRIBE_ENABLED", section: "ai", label: "Transcribe incoming voice notes", type: "bool", default: "0", on: "1", off: "0",
    help: "Master switch. Which contacts are transcribed is set under WhatsApp." },

  { key: "WA_AUTO_REPLIES", section: "whatsapp", label: "Auto-reply to incoming WhatsApp messages", type: "bool", default: "1", on: "1", off: "0",
    help: "Off: Tokyo still reads, logs and forwards to Telegram, but sends nothing back to the contact. Replies you send yourself still go out." },
  { key: "SHOP_AI_REPLIES", section: "whatsapp", label: "AI replies in the shop group", type: "bool", default: "0", on: "1", off: "0" },
  { key: "SHOP_PRICE_MULTIPLIER", section: "whatsapp", label: "Shop price multiplier", type: "number", default: "10", min: 0.01, max: 1000,
    help: "Sale amounts from the shop group are multiplied by this (voice notes quote prices in tens)." },

  { key: "JOBHUNT_DRY_RUN", section: "jobhunt", label: "Dry run (do not send applications)", type: "bool", on: "true", off: "false",
    onUnlessOff: true, help: "Turning this off sends real emails to employers." },
  // Defaults and minimums mirror the job-hunt code, which treats 0 or blank as "use the default".
  { key: "JOBHUNT_DAILY_CAP", section: "jobhunt", label: "Max applications per day", type: "number", default: "25", min: 1, max: 200,
    help: "A ceiling: new sending domains still ramp up from 5 a day." },
  { key: "JOBHUNT_MIN_SCORE", section: "jobhunt", label: "Minimum match score to shortlist", type: "number", default: "24", min: 1, max: 100 },
  { key: "JOBHUNT_AUTOSEND_SCORE", section: "jobhunt", label: "Score to send without review", type: "number", default: "48", min: 1, max: 100 },
];

const BY_KEY = new Map(SETTINGS.map((d) => [d.key, d]));

export function settingDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key);
}

function stored(key: string): string | undefined {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE scope = ? AND key = ?").get(SCOPE, key) as { value: string } | undefined;
    return row?.value;
  } catch (err: any) {
    // A database that has not run initDatabase() yet (tests, one-off scripts) has
    // no overrides. Any other error is real.
    if (/no such table: settings/.test(err?.message ?? "")) return undefined;
    throw err;
  }
}

/** The raw string a caller would have read from process.env, with dashboard overrides applied. */
export function setting(key: string): string | undefined {
  return stored(key) ?? process.env[key] ?? BY_KEY.get(key)?.default;
}

export function settingOn(key: string): boolean {
  const def = BY_KEY.get(key);
  const v = setting(key);
  if (!def || def.type !== "bool") return !!v;
  return def.onUnlessOff ? v !== def.off : v === def.on;
}

export function validateSetting(key: string, value: unknown): string | null {
  const def = BY_KEY.get(key);
  if (!def) return "unknown setting";
  if (value === null) return null; // reset to .env / default
  if (typeof value !== "string") return "value must be a string or null";
  switch (def.type) {
    case "bool":
      return value === def.on || value === def.off ? null : `must be ${def.on} or ${def.off}`;
    case "number": {
      const n = Number(value);
      if (value.trim() === "" || !Number.isFinite(n)) return "must be a number";
      if (def.min !== undefined && n < def.min) return `must be at least ${def.min}`;
      if (def.max !== undefined && n > def.max) return `must be at most ${def.max}`;
      return null;
    }
    case "select":
      return def.options?.some((o) => o.value === value) ? null : "not one of the options";
    case "text":
      return value.trim().length > 0 && value.length <= 200 ? null : "must be 1 to 200 characters";
  }
}

/** Saves, or with null removes the override. Validate first. */
export function saveSetting(key: string, value: string | null): void {
  if (value === null) {
    db.prepare("DELETE FROM settings WHERE scope = ? AND key = ?").run(SCOPE, key);
    return;
  }
  db.prepare(`
    INSERT INTO settings (scope, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(SCOPE, key, value);
}

export function listSettings() {
  return SETTINGS.map((d) => {
    const s = stored(d.key);
    const env = process.env[d.key];
    return {
      ...d,
      value: s ?? env ?? d.default ?? "",
      source: s !== undefined ? "dashboard" : env !== undefined ? "env" : "default",
    };
  });
}
