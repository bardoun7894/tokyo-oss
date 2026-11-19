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
  section: "profile" | "features" | "modules" | "ai" | "whatsapp" | "jobhunt";
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
  ["1", "Karachi (South Asia)"], ["17", "JAKIM (Malaysia)"], ["20", "Kemenag (Indonesia)"],
];

export const SETTINGS: SettingDef[] = [
  { key: "PROFILE_NAME", section: "profile", label: "Your name", type: "text", default: "The owner",
    help: "How Tokyo addresses you in its prompts." },
  { key: "PROFILE_COUNTRY", section: "profile", label: "Country", type: "text" },
  { key: "PROFILE_CITY", section: "profile", label: "City", type: "text" },
  { key: "TIMEZONE", section: "profile", label: "Timezone", type: "text", default: "UTC",
    help: "IANA name, e.g. Africa/Cairo, Europe/Paris, America/New_York. Sets when your day starts and ends." },
  { key: "PROFILE_LANGUAGE", section: "profile", label: "Reply language or dialect", type: "text",
    help: "e.g. Egyptian Arabic, Moroccan Darija, French, English. Empty: Tokyo answers in the language you write in." },
  { key: "CURRENCY", section: "profile", label: "Currency", type: "text", default: "USD",
    help: "Shown next to every amount, e.g. EGP, MAD, EUR, USD." },
  { key: "PROFILE_WORK", section: "profile", label: "Your work and expertise", type: "text",
    help: "e.g. \"Accountant in a small firm\", \"Nurse, night shifts\", \"Freelance designer\". Tokyo plans and coaches around it." },
  { key: "PROFILE_GOALS", section: "profile", label: "Your main goals", type: "text",
    help: "One or two lines Tokyo keeps in mind when it plans your day." },

  { key: "FEATURE_WHATSAPP", section: "features", label: "WhatsApp bridge", type: "bool", default: "1", on: "1", off: "0",
    scope: "server", help: "Read and answer WhatsApp from Tokyo. Takes effect after a restart." },
  { key: "FEATURE_PRAYER", section: "features", label: "Prayer times and worship", type: "bool", default: "1", on: "1", off: "0",
    scope: "server", help: "Prayer reminders, adhkar and Quran tracking, and planning around prayer times." },
  { key: "FEATURE_SHOP", section: "features", label: "Shop sales group", type: "bool", default: "1", on: "1", off: "0",
    scope: "server", help: "Logs sales posted in a WhatsApp group. Only active when MYSHOP_GROUP_JIDS is set in .env." },

  { key: "PRAYER_CITY", section: "profile", label: "Prayer city", type: "text",
    help: "Empty: your city above." },
  { key: "PRAYER_COUNTRY", section: "profile", label: "Prayer country", type: "text",
    help: "Empty: your country above." },
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
      if (!(value.trim().length > 0 && value.length <= 200)) return "must be 1 to 200 characters";
      if (key === "TIMEZONE" && !isTimeZone(value.trim())) return "not a known timezone (e.g. Africa/Cairo)";
      return null;
  }
}

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// The date helpers in utils.ts read process.env.TIMEZONE on every call (utils.ts
// cannot import this module: db.ts imports utils.ts). So a saved TIMEZONE is
// mirrored into process.env, at startup and on every save.
const ENV_TIMEZONE = process.env.TIMEZONE;

/** Copies a saved TIMEZONE into process.env. Call after the settings table exists. */
export function applyStoredTimezone(): void {
  try {
    const saved = stored("TIMEZONE");
    if (saved && isTimeZone(saved)) process.env.TIMEZONE = saved;
  } catch {
    // db not ready yet (import cycle or tests): index.ts calls this again after initDatabase().
  }
}
applyStoredTimezone();

/** Saves, or with null removes the override. Validate first. */
export function saveSetting(key: string, value: string | null): void {
  if (value === null) {
    db.prepare("DELETE FROM settings WHERE scope = ? AND key = ?").run(SCOPE, key);
    if (key === "TIMEZONE") {
      if (ENV_TIMEZONE === undefined) delete process.env.TIMEZONE;
      else process.env.TIMEZONE = ENV_TIMEZONE;
    }
    return;
  }
  db.prepare(`
    INSERT INTO settings (scope, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(SCOPE, key, value);
  if (key === "TIMEZONE") process.env.TIMEZONE = value.trim();
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
