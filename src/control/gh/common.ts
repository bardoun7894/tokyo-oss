import { createHash } from "node:crypto";
import type express from "express";
import { requireCap } from "../auth";
import type { ConfirmOutcome, Refusal } from "../actions/confirm";
import { errorBody } from "../contract";
import { scrub } from "../ops-map";
import type { OpsStore } from "../ops-store";
import { clientAddress, rateLimit } from "../rate-limit";
import type { Cap, Device } from "../store";
import { GhInputError, type GhClient, type GhRead, type GhWriteResult } from "./client";
import { GH_ID, type GhIds } from "./ids";

/** What every GodHome module (T5.2..T5.7) is built from. */
export interface GhArea {
  client: Pick<GhClient, "read" | "write">;
  ids: GhIds;
  ops: OpsStore;
  now?: () => number;
  feed?: { add(e: { source: string; text: string; kind?: "info" }): unknown };
}

export const MAX_ROWS = 200;
export const iso = (ms: number): string => new Date(ms).toISOString();

const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g;
const HOSTNAME = /(?:[A-Za-z0-9-]+\.)*(?:ts\.net|sslip\.io)\b|\blocalhost\b/gi;
const PORT_SUFFIX = /\s*\(:\d{1,5}\)|\bport\s*:?\s*\d{1,5}\b|(?<=[A-Za-z]):\d{2,5}\b/gi;

/** A string for the phone: secrets and absolute paths scrubbed (003), addresses and `(:port)` suffixes removed, clamped. */
export function clean(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return scrub(v).replace(PORT_SUFFIX, (m) => (/^port/i.test(m) ? "port" : "")).replace(IPV4, "...").replace(HOSTNAME, "...").slice(0, max);
}

/** The named scalar fields of `src` only: strings cleaned and clamped, numbers (finite) and booleans copied, everything else dropped. */
export function pick(src: unknown, fields: readonly string[], max = 160): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof src !== "object" || src === null) return out;
  const row = src as Record<string, unknown>;
  for (const f of fields) {
    const v = row[f];
    if (typeof v === "string") out[f] = clean(v, max);
    else if (typeof v === "number" && Number.isFinite(v)) out[f] = v;
    else if (typeof v === "boolean") out[f] = v;
  }
  return out;
}

/** The first `MAX_ROWS` object elements of an array (anything else is an empty list). */
export function rows(v: unknown, max = MAX_ROWS): Record<string, unknown>[] {
  return Array.isArray(v) ? (v.filter((x) => typeof x === "object" && x !== null && !Array.isArray(x)).slice(0, max) as Record<string, unknown>[]) : [];
}

/** A name for the phone from a path-like GodHome name: the last segment, at most 60 characters. */
export function baseName(v: unknown, max = 60): string {
  return typeof v === "string" ? clean(v.split("/").filter(Boolean).pop() ?? "", max) : "";
}

export async function settle(...reads: Promise<GhRead>[]): Promise<(GhRead | null)[]> {
  return Promise.all(reads.map((p) => p.catch((e: any) => {
    if (!(e instanceof GhInputError)) console.warn(`[control-api] godhome read: ${String(e?.name ?? "Error").slice(0, 40)}`);
    return null;
  })));
}

/** A read reply: `reachable` is the first read's; the mapper gets each read's data (null when there is none). */
export function readReply(area: GhArea, got: (GhRead | null)[], build: (data: any[]) => object): object {
  const primary = got[0] ?? null;
  const ok = primary !== null && primary.reachable && primary.data !== null;
  return { fetchedAt: iso(primary && primary.fetchedAt ? primary.fetchedAt : (area.now ?? Date.now)()), reachable: ok, ...build(got.map((g) => g?.data ?? null)) };
}

/** One GET route with `ops:read`: the reads, then the mapper. GodHome down is a 200 with `reachable:false`. */
export function readRoute(r: express.Router, area: GhArea, path: string, reads: (req: express.Request) => Promise<GhRead>[], build: (data: any[], req: express.Request) => object, o: { notFound404?: boolean } = {}): void {
  r.get(path, requireCap("ops:read"), async (req, res) => {
    let got: (GhRead | null)[];
    try {
      got = await settle(...reads(req));
    } catch (e: any) {
      return res.status(400).json(errorBody("bad_request", e instanceof GhInputError ? e.message : "Bad request"));
    }
    if (o.notFound404 && got[0]?.notFound) return res.status(404).json(errorBody("not_found", "No such item"));
    res.json(readReply(area, got, (d) => build(d, req)));
  });
}

export interface WriteOutcome { status: number; body: unknown; result: string; detail?: string; params?: string; subject?: string }

export const refuse = (status: 400 | 403 | 404 | 409 | 429 | 503, code: "bad_request" | "forbidden" | "not_found" | "conflict" | "rate_limited" | "unavailable", message: string, extra?: { params?: string; subject?: string }): WriteOutcome =>
  ({ status, body: errorBody(code, message), result: code, detail: message, ...extra });

/** A GodHome write result as an outcome: ok, gone (404, or `gone(json)`), refused (409) or unreachable (503). */
export function fromWrite(w: GhWriteResult, o: { gone?: (json: any) => boolean; params?: string; subject?: string } = {}): WriteOutcome {
  const extra = { params: o.params, subject: o.subject };
  if (w.status === "ok") return o.gone?.(w.json) ? refuse(404, "not_found", "That is already gone", extra) : { status: 200, body: { ok: true }, result: "ok", ...extra };
  if (w.status === "not_found") return refuse(404, "not_found", "That is already gone", extra);
  if (w.status === "rejected") return refuse(409, "conflict", "GodHome refused the request", extra);
  return refuse(503, "unavailable", "GodHome is not reachable", extra);
}

const WRITE_LIMIT = 30;

export interface WriteRouteOpts {
  /** The K number; the audit action is `gh.<code>`. */
  code: string;
  method: "post" | "delete";
  path: string;
  cap: Cap;
  /** Replaces the default 30 per minute per device. `perRoute` counts every device together. */
  limit?: { max: number; windowMs: number; perRoute?: boolean };
  run(req: express.Request, device: Device): Promise<WriteOutcome>;
}

/** One audited write route: cap, rate limit, the run, then one audit row and the reply. */
export function writeRoute(r: express.Router, area: GhArea, o: WriteRouteOpts): void {
  const now = area.now ?? Date.now;
  const lim = o.limit ?? { max: WRITE_LIMIT, windowMs: 60_000 };
  const limiter = rateLimit({ max: lim.max, windowMs: lim.windowMs, key: lim.perRoute ? () => o.code : (req) => (req as express.Request & { deviceId?: string }).deviceId ?? "anon" });
  r[o.method](o.path, requireCap(o.cap), limiter, async (req, res) => {
    const started = performance.now();
    const device = res.locals.device as Device;
    let out: WriteOutcome;
    try {
      out = await o.run(req, device);
    } catch (e: any) {
      if (e instanceof GhInputError) out = refuse(400, "bad_request", e.message);
      else {
        console.warn(`[control-api] gh ${o.code}: ${String(e?.name ?? "Error").slice(0, 40)}`);
        out = refuse(503, "unavailable", "GodHome is not reachable");
      }
    }
    area.ops.audit({
      at: now(), deviceId: device.id, deviceName: device.name, addr: clientAddress(req), action: `gh.${o.code}`, subject: out.subject ?? String(req.params.id ?? ""),
      params: out.params ?? "{}", result: out.result, detail: (out.detail ?? "").slice(0, 200), durMs: Math.round(performance.now() - started),
    });
    res.status(out.status).json(out.body);
  });
}

export const RUN_KINDS = ["gh_graph_run", "gh_trigger_fire", "gh_factory_run"] as const;
export const RUNS_PER_WINDOW = 3;
export const RUN_WINDOW_MS = 10 * 60 * 1000;

/** The shared cap of the three `ops:run` kinds: 3 confirmed runs per 10 minutes per device, counted together. */
export function runLimit(ops: OpsStore, deviceId: string, now: number): Refusal | null {
  const used = RUN_KINDS.flatMap((k) => ops.kindUses(k, now - RUN_WINDOW_MS, deviceId)).sort((a, b) => a - b);
  if (used.length < RUNS_PER_WINDOW) return null;
  return { status: 429, code: "rate_limited", message: "Too many runs from this device; try again later", retryAfterSec: Math.max(1, Math.ceil((used[0]! + RUN_WINDOW_MS - now) / 1000)) };
}

/** An opaque id that never has to be resolved back (events, workers, findings): `g_` + 12 hex of sha256(kind|source). Nothing is stored. */
export function stableId(kind: string, source: string): string {
  return `g_${createHash("sha256").update(`${kind}|${source}`).digest("hex").slice(0, 12)}`;
}

/** A small object of counts (`{done: 1, failed: 2}`): at most 20 keys with plain names and finite numeric values. */
export function numMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) return out;
  for (const [k, n] of Object.entries(v).slice(0, 20)) if (/^[A-Za-z0-9_-]{1,30}$/.test(k) && typeof n === "number" && Number.isFinite(n)) out[k] = n;
  return out;
}

/** An opaque id from the URL as the GodHome id behind it: a 400 outcome for a bad shape, a 404 outcome for an id Tokyo never issued. */
export function resolveOpaque(ids: GhIds, kind: string, id: string): { source: string } | WriteOutcome {
  if (!GH_ID.test(id)) return refuse(400, "bad_request", `id must match ${GH_ID.source}`, { subject: id.slice(0, 40) });
  const source = ids.resolve(kind, id);
  return source === null ? refuse(404, "not_found", "No such item", { subject: id }) : { source };
}

export const isOutcome = (v: { source: string } | WriteOutcome): v is WriteOutcome => "status" in v;

/** The X16 reply of a kind whose action is one GodHome write: `{ok:true}` (plus the extras), or the error with the token spent. */
export function confirmOutcome(w: GhWriteResult, o: { params: string; feed: string; extra?: (json: any) => Record<string, unknown>; gone?: (json: any) => boolean }): ConfirmOutcome {
  if (w.status === "ok" && !o.gone?.(w.json)) return { ok: true, result: "ok", detail: "", params: o.params, body: { ok: true, ...(o.extra?.(w.json) ?? {}) }, feed: o.feed };
  const out = fromWrite(w, { gone: o.gone });
  const code = (out.body as { error: { code: string } }).error.code;
  return { ok: false, result: out.result, detail: out.detail ?? "", params: o.params, status: out.status, body: { error: { code, message: out.detail ?? "" } } };
}
