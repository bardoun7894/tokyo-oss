/**
 * Format a duration in minutes as a human-readable string.
 * Examples: 0 -> "0m", 35 -> "35m", 125 -> "2h 5m"
 */
export function fmtMin(m: number | null | undefined): string {
  if (!m) return "0m";
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
}

/**
 * Convert a time string "HH:MM" to minutes since midnight.
 */
export function timeToMin(t: string | null | undefined): number {
  if (!t) return 0;
  const parts = t.split(":").map(Number);
  return parts[0] * 60 + parts[1];
}

/**
 * Get the current time as minutes since midnight.
 */
export function nowMin(): number {
  const n = new Date();
  return n.getHours() * 60 + n.getMinutes();
}

/**
 * Escape HTML special characters.
 * In React this is rarely needed since JSX auto-escapes,
 * but kept for any raw string handling scenarios.
 */
export function esc(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Clamp a number between min and max (inclusive).
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Convert minutes to a percentage position on a timeline bar,
 * given the bar's start and end in minutes.
 */
export function minutesToPct(
  minutes: number,
  barStart: number,
  barEnd: number,
): number {
  const span = barEnd - barStart;
  if (span <= 0) return 0;
  return clamp(((minutes - barStart) / span) * 100, 0, 100);
}
