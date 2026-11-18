import crypto from "crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { errorBody, type ErrorCode } from "../contract";
import { ABS_PATH } from "../ops-map";
import type { OpsStore } from "../ops-store";
import { clientAddress, RateLimiter } from "../rate-limit";
import { redact } from "../redact";
import type { Device } from "../store";
import { defaultMedia, mediaRefusal, uploadRefusal, type MediaOptions } from "./media";
import { matchLife, settingKeyClass, type LifeRow } from "./table";

// The life gateway (spec FR3, plan section 2): the dashboard router is reused as it is, behind a table that admits only the listed
// method and path pairs. Bearer auth is the Control router's; the dashboard's session middleware is never involved.

export interface GatewayDeps {
  /** The dashboard router (or a spy in tests): called with the dashboard's own `/api<path>` url. */
  dashboard: RequestHandler;
  /** Audit rows and idempotent replays (shares the Control db). */
  ops: Pick<OpsStore, "audit" | "findIdem">;
  /** Overrides for the byte routes (media.ts); the defaults are the live media directory, 100 MB and uploads off. */
  media?: Partial<MediaOptions>;
  now?: () => number;
}

const IDEM_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const WRITE_LIMIT = { max: 30, windowMs: 60_000 };
const PAID_LIMIT = { max: 5, windowMs: 10 * 60_000 };
const MAX_MESSAGE = 200;

/** The control error code of a dashboard status. A dashboard 401 is not the app's login failing, so it never becomes `unauthorized`. */
export function errorCodeFor(status: number): ErrorCode {
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status === 401 || status >= 500) return "unavailable";
  return "bad_request";
}

// A path right after `:` or `@`, as in the scp-style git remote `user@host:/root/repo.git`; ABS_PATH leaves it because it must not break URLs.
const REMOTE_PATH = /(?<=[:@])(?:\/[^\s/'"`()<>[\]{},;]+){2,}\/?/g;

// ABS_PATH, but not a `/x/y` that follows a `+`: that is the middle of a base64 run, not a path.
const PATH_NOT_B64 = new RegExp(`(?<!\\+)${ABS_PATH.source}`, "g");
const DATA_URL = /^data:[^,]*,/i;
// A long base64 run: it carries upper case, lower case and digits, and a `/` only about every 64 characters, unlike any path.
const B64_RUN = /[A-Za-z0-9+/]{40,}={0,2}/g;
const isB64Run = (s: string) => /[A-Z]/.test(s) && /[a-z]/.test(s) && /\d/.test(s) && (s.match(/\//g)?.length ?? 0) * 12 <= s.length;

function scrubString(s: string): string {
  if (DATA_URL.test(s)) return s;
  let last = 0;
  let out = "";
  for (const m of s.matchAll(B64_RUN)) {
    if (!isB64Run(m[0])) continue;
    out += scrubPaths(s.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + scrubPaths(s.slice(last));
}

const scrubPaths = (s: string) => s.replace(PATH_NOT_B64, "...").replace(REMOTE_PATH, "...");

/** A copy of a JSON value with every absolute path run in its string values replaced by `...` (plan section 5). Keys are left alone; data urls and base64 runs are not paths. */
export function scrubJson<T>(v: T): T {
  if (typeof v === "string") return scrubString(v) as T;
  if (Array.isArray(v)) return v.map(scrubJson) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubJson(x)])) as T;
  return v;
}

/** WhatsApp pairing material: connecting is out of scope for the app, and a pairing code or QR must never leave the server (L30). */
const WA_PAIRING_KEYS: ReadonlySet<string> = new Set(["qrDataUrl", "pairingCode"]);

/**
 * What a life success body is sent as: `drop` keys removed at any depth, every string value through redact() (data urls are left
 * whole: they are images, not text), then scrubJson for paths.
 */
export function cleanJson<T>(v: T, drop: ReadonlySet<string> = new Set()): T {
  if (typeof v === "string") return (DATA_URL.test(v) ? v : redact(v)) as T;
  if (Array.isArray(v)) return v.map((x) => cleanJson(x, drop)) as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).filter(([k]) => !drop.has(k)).map(([k, x]) => [k, cleanJson(x, drop)])) as T;
  }
  return v;
}

// Plain labels that may appear in the audit: never text the owner typed, an amount, a name or a number.
const SAFE_VALUE_KEYS = new Set(["priority", "category", "area", "type", "status", "kind", "platform", "strategy", "key", "confirm", "enabled", "period"]);
const SAFE_VALUE = /^[A-Za-z0-9_.:-]{1,40}$/;

/**
 * The audited form of a write body: its field names, a few enum-like values, and the length of lists. Message text, titles, amounts,
 * jids and settings values never get in.
 */
export function auditParams(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body) || Buffer.isBuffer(body)) return JSON.stringify({ fields: [] });
  const values: Record<string, string | boolean> = {};
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(body)) {
    if (Array.isArray(v)) counts[k] = v.length;
    else if (SAFE_VALUE_KEYS.has(k) && (typeof v === "boolean" || (typeof v === "string" && SAFE_VALUE.test(v)))) values[k] = v;
  }
  const out: Record<string, unknown> = { fields: Object.keys(body).slice(0, 50) };
  if (Object.keys(values).length) out.values = values;
  if (Object.keys(counts).length) out.counts = counts;
  return redact(JSON.stringify(out));
}

/** A body that is already a control error (the root error handler answers through the same res.json). */
const isEnvelope = (b: unknown): boolean => typeof (b as { error?: { code?: unknown } } | null)?.error === "object";

/** The control envelope of a dashboard error body. */
function envelope(status: number, body: unknown): ReturnType<typeof errorBody> {
  const raw = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : "";
  const message = (raw ? redact(raw).replace(ABS_PATH, "...") : "Request failed").slice(0, MAX_MESSAGE);
  return errorBody(errorCodeFor(status), message);
}

const sha = (s: string): string => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);

/** Mounted at `/life/api`. */
export function lifeGateway(deps: GatewayDeps): RequestHandler {
  const now = deps.now ?? Date.now;
  const writes = new RateLimiter(WRITE_LIMIT);
  const paid = new RateLimiter(PAID_LIMIT);
  const inFlight = new Set<string>();
  const media: MediaOptions = { ...defaultMedia(), ...deps.media };

  const refuse = (res: Response, status: number, code: ErrorCode, message: string): void => { res.status(status).json(errorBody(code, message)); };
  const limited = (res: Response, retryAfterSec: number): void => {
    res.setHeader("Retry-After", String(retryAfterSec));
    refuse(res, 429, "rate_limited", `Too many requests -- retry in ${retryAfterSec}s`);
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    const row: LifeRow | null = matchLife(req.method, req.path);
    if (!row) { refuse(res, 404, "not_found", "Not found"); return; }
    const device = res.locals.device as Device;
    if (!device.caps.includes(row.cap)) { refuse(res, 403, "forbidden", `Device lacks ${row.cap}`); return; }

    const refusal = row.kind === "bytes" ? mediaRefusal(req, media) : uploadRefusal(row, req, media.uploads());
    if (refusal) { refuse(res, refusal.status, refusal.code, refusal.message); return; }

    const isWrite = row.method !== "GET";
    const action = `life.${row.method}.${row.id}`;
    const subject = redact(req.path).slice(0, 200); // matched against the table, so only ids follow the literal segments
    let idemKey: string | null = null;
    let flightKey: string | null = null;
    let fingerprint = subject;

    if (isWrite) {
      const key = req.headers["idempotency-key"];
      if (typeof key !== "string" || !IDEM_KEY.test(key)) { refuse(res, 400, "bad_request", `Idempotency-Key is required and must match ${IDEM_KEY.source}`); return; }
      idemKey = key;
      // The request fingerprint: the same key may only repeat the same route, path and body.
      fingerprint = `${subject}#${sha(JSON.stringify(req.body ?? null))}`;
      const prior = deps.ops.findIdem(action, key);
      if (prior) {
        if (prior.deviceId !== device.id || prior.subject !== fingerprint || prior.response === null) { refuse(res, 409, "conflict", "Idempotency-Key was already used for another request"); return; }
        const stored = JSON.parse(prior.response) as { status: number; body: unknown };
        res.setHeader("Idempotent-Replay", "true");
        res.status(stored.status).json(stored.body);
        return;
      }
      flightKey = `${action}\0${key}`;
      if (inFlight.has(flightKey)) { refuse(res, 409, "conflict", "A request with this Idempotency-Key is still running"); return; }

      if (row.id === "L97") {
        const k = (req.body as { key?: unknown } | undefined)?.key;
        if (typeof k !== "string") { refuse(res, 400, "bad_request", "key required"); return; }
        const cls = settingKeyClass(k);
        if (cls === "excluded") { refuse(res, 403, "forbidden", `${k} cannot be changed from the app`); return; }
        if (cls === "unknown") { refuse(res, 400, "bad_request", "Unknown setting"); return; }
      }

      const t = now();
      const w = writes.hit(device.id, t);
      if (!w.ok) { limited(res, w.retryAfterSec); return; }
      if (row.paid) {
        const p = paid.hit(device.id, t);
        if (!p.ok) { limited(res, p.retryAfterSec); return; }
      }
      inFlight.add(flightKey);
    }

    const started = performance.now();
    let audited = false;
    const writeAudit = (status: number, body: unknown): void => {
      if (!isWrite || audited) return;
      audited = true;
      const ok = status < 400;
      deps.ops.audit({
        at: now(), deviceId: device.id, deviceName: device.name, addr: clientAddress(req), action,
        subject: ok ? fingerprint : subject,
        params: auditParams(req.body), result: ok ? "ok" : `error:${status}`, detail: "", durMs: Math.round(performance.now() - started),
        // Only a success is stored for replay: a failed write may be retried under the same key.
        ...(ok && idemKey ? { idemKey, response: JSON.stringify({ status, body }) } : {}),
      });
    };
    const release = (): void => { if (flightKey) inFlight.delete(flightKey); };
    res.on("close", release);

    const sendJson = res.json.bind(res);
    res.json = ((body?: unknown) => {
      const status = res.statusCode;
      const out = status >= 400 && !isEnvelope(body) ? envelope(status, body) : scrubJson(cleanJson(body, row.id === "L30" ? WA_PAIRING_KEYS : undefined));
      writeAudit(status, out);
      return sendJson(out);
    }) as Response["json"];
    res.on("finish", () => writeAudit(res.statusCode, null));

    // The dashboard sees its own url and none of the gateway's credentials.
    delete req.headers.authorization;
    delete req.headers.cookie;
    req.url = "/api" + req.url;
    deps.dashboard(req, res, (err?: unknown) => {
      req.url = req.url.replace(/^\/api/, "");
      if (err) return next(err);
      if (!res.headersSent) refuse(res, 404, "not_found", "Not found");
    });
  };
}
