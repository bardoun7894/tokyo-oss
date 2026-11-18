/**
 * Timezone-aware date utilities for Tokyo Life OS.
 * All dates stored in SQLite use UTC (datetime('now')).
 * These helpers convert to/from the user's local timezone.
 */

const TZ = process.env.TIMEZONE || "Africa/Casablanca";

/** Get today's date string in local timezone (YYYY-MM-DD) */
export function localToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

/** Get current datetime in local timezone */
export function localNow(): Date {
  const str = new Date().toLocaleString("en-US", { timeZone: TZ });
  return new Date(str);
}

/** Get the timezone offset in hours (e.g., +1 for Casablanca, +3 for Riyadh) */
export function getTzOffsetHours(): number {
  const now = new Date();
  const utc = now.getTime();
  const local = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
  return Math.round((local.getTime() - utc) / 3600000);
}

/** SQLite modifier string for converting UTC to local time (e.g., '+1 hours') */
export function sqliteTzModifier(): string {
  const offset = getTzOffsetHours();
  return `${offset >= 0 ? "+" : ""}${offset} hours`;
}

/** Get day of week (0=Sunday) in local timezone */
export function localDayOfWeek(): number {
  return localNow().getDay();
}

/** Format a date string for display */
export function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "short", day: "numeric", timeZone: TZ });
}

/** Get start of current week (Monday) in local timezone */
export function weekStartDate(): string {
  const now = localNow();
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const start = new Date(now);
  start.setDate(now.getDate() - diff);
  return start.toLocaleDateString("en-CA", { timeZone: TZ });
}

/** Get date N days ago in local timezone */
export function daysAgo(n: number): string {
  const d = localNow();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}

/** Convert a unix timestamp (seconds) to local date string (YYYY-MM-DD) */
export function localDateFromTimestamp(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-CA", { timeZone: TZ });
}
