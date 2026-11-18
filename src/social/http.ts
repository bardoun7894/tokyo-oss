/** Tokyo social publisher — shared HTTP helpers. */

export class ApiError extends Error {
  constructor(
    public label: string,
    public status: number,
    public body: string
  ) {
    super(`${label} ${status}: ${body.slice(0, 400)}`);
    this.name = "ApiError";
  }
}

/** fetch + JSON parse, throwing an ApiError that carries the platform's own message. */
export async function apiJson<T = any>(
  label: string,
  url: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new ApiError(label, res.status, text);
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/** Same as apiJson but also hands back the response headers (LinkedIn returns ids there). */
export async function apiRaw(
  label: string,
  url: string,
  init?: RequestInit
): Promise<{ body: any; headers: Headers }> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new ApiError(label, res.status, text);
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    /* keep as text */
  }
  return { body, headers: res.headers };
}

/**
 * An OAuth code copied out of the address bar may still be percent-encoded
 * (Google's start with `4%2F`). Decode only when it plainly is, so a code that
 * legitimately contains a stray `%` is left alone instead of throwing.
 */
export function normalizeCode(code: string): string {
  const trimmed = code.trim();
  if (!/%[0-9a-fA-F]{2}/.test(trimmed)) return trimmed;
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll `check` until it returns a value or the deadline passes. */
export async function pollUntil<T>(
  check: () => Promise<T | undefined>,
  { timeoutMs, intervalMs }: { timeoutMs: number; intervalMs: number }
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await check();
    if (last !== undefined) return last;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the platform to finish processing`);
}
