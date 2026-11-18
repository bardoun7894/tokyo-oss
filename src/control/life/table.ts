import type { Cap } from "../store";

// The life allowlist (spec FR3, plan section 2): the method and path pairs of the dashboard API that the Control app may reach through the
// gateway. The rows are the frozen table of `specs/012-full-control/research-life.md` (T0.4), row by row; table.test.ts compares them.
// Anything not listed here, including the excluded routes (settings/kie-key, auth/password, auth/login, whatsapp/connect, groupchat/open,
// the internal service routes and the dashboard shell), has no row and answers 404 without reaching a handler.

export type LifeMethod = "GET" | "POST" | "PATCH" | "DELETE";
/** `none`, or CS: the app shows the confirm sheet first (FR6). */
export type ConfirmClass = "none" | "CS";
/** R global reads; W writes 30/min; P paid 5 per 10 min; B byte upload (W plus the size cap). */
export type RateClass = "R" | "W" | "P" | "B";

export interface LifeRow {
  /** `L<n>` of research-life.md; the audit action is `life.<METHOD>.<id>`. */
  id: string;
  method: LifeMethod;
  /** Dashboard path without `/api`; `:name` is one path segment. */
  pattern: string;
  /** `life:read` for GET, `life:write` otherwise. */
  cap: Extract<Cap, "life:read" | "life:write">;
  confirm: ConfirmClass;
  paid: boolean;
  /** Largest request body in bytes: 0 for a read, 64 KiB for JSON, the raw cap for an upload. */
  bodyLimit: number;
  rate: RateClass;
  /** `bytes`: a file is the reply (L8). `upload`: a raw body is the request (L80, L96). Both are handled in media.ts. */
  kind?: "bytes" | "upload";
  /** The whole path, anchored. */
  regex: RegExp;
  /** Only `POST /settings`: the keys the app may write. */
  settingsKeys?: SettingsKeys;
}

export interface SettingsKeys {
  /** Written without a sheet. */
  safe: readonly string[];
  /** Written after the confirm sheet: each changes what Tokyo sends or spends. */
  confirm: readonly string[];
  /** Never written from the app: they make Tokyo send job applications. */
  excluded: readonly string[];
}

const MODULE_KEYS = [
  "TASKS", "WORK", "HABITS", "DEEN", "FINANCE", "SHOP", "PROJECTS", "GOALS", "JOURNAL", "SCHEDULE",
  "WHATSAPP", "INSTAGRAM", "CHAT", "MEDIA", "TRANSCRIPTS", "CONTENT", "TRENDS", "ANALYTICS", "SERVER",
].map((m) => `MODULE_${m}`);

export const SETTINGS_KEYS: SettingsKeys = Object.freeze({
  safe: Object.freeze(["PROFILE_NAME", "PRAYER_CITY", "PRAYER_COUNTRY", "PRAYER_METHOD", "JEV_ENABLED", "AREAS_ENABLED", "JOBHUNT_MIN_SCORE", ...MODULE_KEYS]),
  confirm: Object.freeze(["TRANSCRIBE_ENABLED", "WA_AUTO_REPLIES", "SHOP_AI_REPLIES", "SHOP_PRICE_MULTIPLIER"]),
  excluded: Object.freeze(["JOBHUNT_DRY_RUN", "JOBHUNT_DAILY_CAP", "JOBHUNT_AUTOSEND_SCORE"]),
});

/** How the gateway treats a `POST /settings` key; a key that is not a live setting is `unknown`. */
export function settingKeyClass(key: string): "safe" | "confirm" | "excluded" | "unknown" {
  if (SETTINGS_KEYS.safe.includes(key)) return "safe";
  if (SETTINGS_KEYS.confirm.includes(key)) return "confirm";
  if (SETTINGS_KEYS.excluded.includes(key)) return "excluded";
  return "unknown";
}

const JSON_BODY = 64 * 1024;
const MB = 1024 * 1024;

/** One path segment of a parameter: not empty, not `.` or `..` (also as %2e), and no escaped slash, backslash or NUL (a jid is sent as `%40`). */
const PARAM = "(?!(?:\\.|%2[eE])+(?:/|$))(?:[^/%]|%(?!2[fF]|5[cC]|00)[0-9A-Fa-f]{2}){1,200}";

function compile(pattern: string): RegExp {
  const parts = pattern.split("/").slice(1).map((seg) => (seg.startsWith(":") ? PARAM : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  return new RegExp("^/" + parts.join("/") + "$");
}

type Spec = [id: string, method: LifeMethod, pattern: string, confirm: ConfirmClass, rate: RateClass, bodyLimit?: number];
const J = JSON_BODY;
const KINDS: Record<string, "bytes" | "upload"> = { L8: "bytes", L80: "upload", L96: "upload" };

// id, method, pattern, confirm, rate, body limit (reads have none).
const SPECS: Spec[] = [
  ["L1", "GET", "/overview", "none", "R"],
  ["L2", "GET", "/goals", "none", "R"],
  ["L3", "GET", "/obligations", "none", "R"],
  ["L4", "GET", "/tasks-bulk/suggestions", "none", "R"],
  ["L5", "GET", "/habits/history", "none", "R"],
  ["L6", "GET", "/calendar", "none", "R"],
  ["L7", "GET", "/calendar/:date", "none", "R"],
  ["L8", "GET", "/media/:filename", "none", "R"],
  ["L9", "GET", "/projects", "none", "R"],
  ["L10", "GET", "/work/log", "none", "R"],
  ["L11", "GET", "/weekly-trends", "none", "R"],
  ["L12", "GET", "/adhkar/history", "none", "R"],
  ["L13", "GET", "/quran/history", "none", "R"],
  ["L14", "GET", "/journal", "none", "R"],
  ["L15", "GET", "/shop", "none", "R"],
  ["L16", "GET", "/products", "none", "R"],
  ["L17", "GET", "/products/stats", "none", "R"],
  ["L18", "GET", "/products/batches", "none", "R"],
  ["L19", "GET", "/products/batches/:batchId", "none", "R"],
  ["L20", "GET", "/products/forward-targets", "none", "R"],
  ["L21", "GET", "/project-repos", "none", "R"],
  ["L22", "GET", "/content/platforms", "none", "R"],
  ["L23", "GET", "/content/items", "none", "R"],
  ["L24", "GET", "/content/items/:id", "none", "R"],
  ["L25", "GET", "/content/calendar", "none", "R"],
  ["L26", "GET", "/whatsapp/media/chats", "none", "R"],
  ["L27", "GET", "/whatsapp/media", "none", "R"],
  ["L28", "GET", "/instagram", "none", "R"],
  ["L29", "GET", "/instagram/rules", "none", "R"],
  ["L30", "GET", "/whatsapp/status", "none", "R"],
  ["L31", "GET", "/whatsapp/chats", "none", "R"],
  ["L32", "GET", "/whatsapp/messages/:jid", "none", "R"],
  ["L33", "GET", "/conversations", "none", "R"],
  ["L34", "GET", "/chat-analyzer/sentiment", "none", "R"],
  ["L35", "GET", "/chat-analyzer/habits", "none", "R"],
  ["L36", "GET", "/transcripts", "none", "R"],
  ["L37", "GET", "/transcripts/pending", "none", "R"],
  ["L38", "GET", "/server", "none", "R"],
  ["L39", "GET", "/settings", "none", "R"],
  ["L40", "GET", "/settings/auto-transcribe", "none", "R"],
  ["L41", "GET", "/settings/model", "none", "R"],
  ["L42", "POST", "/tasks", "none", "W", J],
  ["L43", "POST", "/tasks/:id/complete", "none", "W", J],
  ["L44", "POST", "/tasks/:id/edit", "none", "W", J],
  ["L45", "POST", "/tasks/:id/start", "none", "W", J],
  ["L46", "DELETE", "/tasks/:id", "CS", "W", J],
  ["L47", "POST", "/tasks/:id/subtasks", "none", "W", J],
  ["L48", "POST", "/tasks/:id/subtasks/:sid/complete", "none", "W", J],
  ["L49", "POST", "/tasks-bulk/complete", "CS", "W", J],
  ["L50", "POST", "/tasks-bulk/delete", "CS", "W", J],
  ["L51", "POST", "/habits/:id/check", "none", "W", J],
  ["L52", "POST", "/habits", "none", "W", J],
  ["L53", "DELETE", "/habits/:id", "CS", "W", J],
  ["L54", "POST", "/goals", "none", "W", J],
  ["L55", "POST", "/goals/:id/update", "none", "W", J],
  ["L56", "DELETE", "/goals/:id", "CS", "W", J],
  ["L57", "POST", "/work/start", "none", "W", J],
  ["L58", "POST", "/work/stop", "none", "W", J],
  ["L59", "POST", "/work/break", "none", "W", J],
  ["L60", "POST", "/obligations", "none", "W", J],
  ["L61", "POST", "/obligations/:id/pay", "none", "W", J],
  ["L62", "PATCH", "/obligations/:id", "none", "W", J],
  ["L63", "POST", "/obligations/:id/archive", "none", "W", J],
  ["L64", "DELETE", "/obligations/payments/:id", "CS", "W", J],
  ["L65", "DELETE", "/obligations/:id", "CS", "W", J],
  ["L66", "POST", "/adhkar/:type", "none", "W", J],
  ["L67", "POST", "/quran", "none", "W", J],
  ["L68", "POST", "/journal", "none", "W", J],
  ["L69", "POST", "/products/sync", "CS", "W", J],
  ["L70", "PATCH", "/products/:id", "none", "W", J],
  ["L71", "POST", "/products/batches/:batchId/assign", "none", "W", J],
  ["L72", "POST", "/products/forward", "CS", "W", J],
  ["L73", "POST", "/project-repos/sync", "CS", "W", J],
  ["L74", "POST", "/project-repos/:id", "none", "W", J],
  ["L75", "POST", "/content/items", "none", "W", J],
  ["L76", "POST", "/content/items/:id", "none", "W", J],
  ["L77", "DELETE", "/content/items/:id", "CS", "W", J],
  ["L78", "POST", "/content/items/:id/captions", "none", "W", J],
  ["L79", "POST", "/content/items/:id/captions/draft", "CS", "P", J],
  ["L80", "POST", "/content/items/:id/upload", "none", "B", 4096 * MB],
  ["L81", "DELETE", "/content/items/:id/video", "CS", "W", J],
  ["L82", "POST", "/content/items/:id/preflight", "none", "W", J],
  ["L83", "POST", "/content/items/:id/publish", "CS", "W", J],
  ["L84", "POST", "/content/items/:id/schedule", "CS", "W", J],
  ["L85", "POST", "/content/items/:id/unschedule", "none", "W", J],
  ["L86", "POST", "/whatsapp/media/delete", "CS", "W", J],
  ["L87", "POST", "/instagram/settings", "CS", "W", J],
  ["L88", "POST", "/instagram/surface", "none", "W", J],
  ["L89", "POST", "/instagram/rules", "none", "W", J],
  ["L90", "POST", "/instagram/rules/:id/toggle", "none", "W", J],
  ["L91", "DELETE", "/instagram/rules/:id", "CS", "W", J],
  ["L92", "POST", "/instagram/test", "CS", "P", J],
  ["L93", "POST", "/whatsapp/send", "CS", "W", J],
  ["L94", "POST", "/chat-analyzer/classify", "CS", "P", J],
  ["L95", "POST", "/transcripts/:id/transcribe", "CS", "P", J],
  ["L96", "POST", "/transcripts/upload", "CS", "P", 25 * MB],
  ["L97", "POST", "/settings", "none", "W", J],
  ["L98", "POST", "/settings/auto-transcribe", "none", "W", J],
  ["L99", "POST", "/settings/model", "CS", "W", J],
];

export const LIFE_ROWS: readonly LifeRow[] = Object.freeze(SPECS.map(([id, method, pattern, confirm, rate, bodyLimit]): LifeRow => ({
  id, method, pattern, confirm, rate,
  cap: method === "GET" ? "life:read" : "life:write",
  paid: rate === "P",
  bodyLimit: bodyLimit ?? 0,
  regex: compile(pattern),
  ...(id === "L97" ? { settingsKeys: SETTINGS_KEYS } : {}),
  ...(KINDS[id] ? { kind: KINDS[id] } : {}),
})));

const paramCount = (pattern: string): number => pattern.split("/").filter((s) => s.startsWith(":")).length;

/** The row that admits this method and path, or null (the gateway then answers 404). Both are matched exactly; a literal segment beats a parameter. */
export function matchLife(method: string, urlPath: string): LifeRow | null {
  let best: LifeRow | null = null;
  for (const row of LIFE_ROWS) {
    if (row.method !== method || !row.regex.test(urlPath)) continue;
    if (!best || paramCount(row.pattern) < paramCount(best.pattern)) best = row;
  }
  return best;
}
