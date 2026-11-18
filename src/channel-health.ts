/**
 * In-memory Telegram channel health, read by GodHome through the loopback
 * status endpoint. We only ever keep the last 200 error timestamps plus the
 * most recent ok/error point, so memory use stays bounded regardless of how
 * chatty the bot is.
 *
 * Never store payloads, chat ids or tokens here — only the method name and a
 * truncated description.
 */

interface ErrorRecord {
  method: string;
  msg: string;
  t: number;
}

const MAX_ERRORS = 200;

let lastOkAt: number | null = null;
let lastErrorAt: number | null = null;
let lastError: string | null = null;
let lastErrorMethod: string | null = null;
let errors: ErrorRecord[] = [];
// Blocked only ever looks at send* calls: a 403 "bot was blocked by the user"
// means the bot cannot reach the owner, so it is the one health state that
// matters.
let lastSendOkAt: number | null = null;
let lastBlockedAt: number | null = null;

/**
 * Pull the human-readable message out of a grammy error (or anything else we
 * get). Prefer `description` (grammy sets it on its HttpError-adjacent
 * errors), then `message`, then String(). Never tighter-coupled to a specific
 * SDK shape than necessary.
 */
function extractMessage(err: unknown): string {
  let m: string;
  if (err && typeof err === "object") {
    const e = err as { description?: unknown; message?: unknown };
    if (typeof e.description === "string") m = e.description;
    else if (typeof e.message === "string") m = e.message;
    else m = String(err);
  } else {
    m = String(err);
  }
  return m.slice(0, 200);
}

/** True when Telegram is telling us the user blocked the bot. */
function isBlockedMessage(err: unknown): boolean {
  return /blocked by the user/.test(extractMessage(err));
}

export function recordTelegramOk(method: string, now?: number): void {
  const t = now ?? Date.now();
  lastOkAt = t;
  if (method.startsWith("send")) lastSendOkAt = t;
}

export function recordTelegramError(method: string, err: unknown, now?: number): void {
  const t = now ?? Date.now();
  const msg = extractMessage(err);
  lastErrorAt = t;
  lastError = msg;
  lastErrorMethod = method;
  errors.push({ method, msg, t });
  if (errors.length > MAX_ERRORS) errors = errors.slice(-MAX_ERRORS);
  if (method.startsWith("send") && isBlockedMessage(err)) lastBlockedAt = t;
}

export function telegramHealth(now?: number): {
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  lastErrorMethod: string | null;
  blocked: boolean;
  errorsLastHour: number;
} {
  const t = now ?? Date.now();
  const cutoff = t - 3600_000;
  let errorsLastHour = 0;
  for (const e of errors) if (e.t >= cutoff) errorsLastHour++;
  // A send* call failed with 403 "blocked" and no successful send* followed.
  const blocked =
    lastBlockedAt !== null && (lastSendOkAt === null || lastBlockedAt > lastSendOkAt);
  return {
    lastOkAt,
    lastErrorAt,
    lastError,
    lastErrorMethod,
    blocked,
    errorsLastHour,
  };
}

/** Tests only — forget every recorded event. */
export function __resetChannelHealth(): void {
  lastOkAt = null;
  lastErrorAt = null;
  lastError = null;
  lastErrorMethod = null;
  errors = [];
  lastSendOkAt = null;
  lastBlockedAt = null;
}