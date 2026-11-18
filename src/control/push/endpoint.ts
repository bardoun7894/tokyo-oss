// A UnifiedPush endpoint is exactly `<baseUrl>/up<id>` (+ optional `?up=1`). The raw string is matched, never parsed with
// `new URL`, which would normalise away the very cases that must be rejected (userinfo, `..`, case, trailing junk).

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&");

/** The topic (`up<8..64 chars>`) when `raw` is exactly the configured base URL plus `/up<id>`, else null. */
export function parseEndpoint(raw: unknown, baseUrl: string): string | null {
  if (typeof raw !== "string" || typeof baseUrl !== "string") return null;
  const base = baseUrl.replace(/\/+$/, "");
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(base)) return null;
  const m = new RegExp(`^${escapeRe(base)}/(up[A-Za-z0-9_-]{8,64})(\\?up=1)?$`).exec(raw);
  return m ? m[1] : null;
}
