// The user's currency label (Settings → Profile → Currency). useSettings() fills it
// when settings load; until then amounts show the server default.
let current = "USD";

export function setCurrency(value: string | undefined): void {
  if (value && value.trim()) current = value.trim();
}

/** Label shown next to amounts, e.g. "EGP". */
export function cur(): string {
  return current;
}
