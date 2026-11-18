import { pageOf } from "./paging";
import type { Overlay, OpsStore, StateRow } from "./ops-store";
import { scrub } from "./ops-map";

/**
 * GodHome incidents to the X5 and X6 contract. Counts are GodHome's own (never recounted from `items`, which
 * GodHome caps at 200 and which also hold agent incidents). Contract decisions, spec.md section 5:
 * `recovering` is an additive state, `deploy` an additive kind, agent incidents are listed only for
 * `kind=agent` because GodHome keeps them out of `counts.open`.
 */

export const INCIDENT_ID = /^i_[0-9a-f]{12}$/;
export const INCIDENT_KINDS = ["check", "review", "deploy", "agent"] as const;
export const INCIDENT_STATES = ["open", "resolved", "muted", "all"] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];
export type IncidentStateFilter = (typeof INCIDENT_STATES)[number];

const MAX_TITLE = 160;
const MAX_SUBTITLE = 120;
const MAX_PROJECT = 64;
const MAX_URL = 200;

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** A finite, non-negative number, else 0. */
const cnt = (v: unknown): number => Math.max(0, num(v) ?? 0);
const text = (v: unknown, max: number): string => (typeof v === "string" ? scrub(v).slice(0, max) : "");
const iso = (v: unknown): string | null => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

export interface Counts { open: number; critical: number; warning: number; notice: number; resolved: number; acked: number; muted: number }

export interface IncidentView {
  id: string;
  kind: IncidentKind;
  title: string;
  subtitle: string;
  severity: "critical" | "warning" | "notice";
  state: "open" | "recovering" | "resolved";
  project: string;
  check?: string;
  firstAt: string | null;
  lastAt: string | null;
  resolvedAt?: string;
  durationMs: number;
  flaps: number;
  flapping: boolean;
  count: number;
  url?: string;
  acked: boolean;
  mutedUntil?: string;
  reopened: boolean;
  actions: string[];
}

/**
 * The incident counts for X5 and `GET /counts`: GodHome's own numbers minus what the overlay hides. Never
 * recounted from `items` (GodHome caps them at 200): each hidden item that GodHome counts as open (every
 * kind but agent, state open or recovering) is subtracted from `open` and its severity, floored at 0. A
 * muted or manually resolved incident leaves the open counts; a resolved one is added to `resolved`; `acked`
 * and `muted` count the listed open items that carry the flag. Without an overlay these two are 0.
 */
export function adjustedCounts(summary: unknown, overlay?: Overlay, now = Date.now()): Counts {
  if (!isObj(summary)) throw new TypeError("summary is not an object");
  const inc = isObj(summary.incidents) ? summary.incidents : {};
  const c = isObj(inc.counts) ? inc.counts : {};
  const out: Counts = { open: cnt(c.open), critical: cnt(c.critical), warning: cnt(c.warning), notice: cnt(c.notice), resolved: cnt(c.resolved), acked: 0, muted: 0 };
  if (!overlay) return out;
  for (const i of sourceItems(summary)) {
    if (i.kind === "agent" || (i.state !== "open" && i.state !== "recovering")) continue;
    const o = overlayOf(i, overlay);
    if (!o.resolved && o.mutedUntil === undefined) {
      if (o.acked) out.acked++;
      continue;
    }
    const sev: "critical" | "warning" | "notice" = i.severity === "critical" || i.severity === "warning" ? i.severity : "notice";
    out.open = Math.max(0, out.open - 1);
    out[sev] = Math.max(0, out[sev] - 1);
    if (o.resolved) out.resolved++;
    else out.muted++;
  }
  return out;
}

/**
 * For X1's `needsYou`: true for an entry that is the same thing as an incident the overlay hides (muted or
 * manually resolved). GodHome's needs-you rows carry no incident id, so the match is project plus title, or a
 * non-empty url.
 */
export function needsYouHidden(summary: unknown, overlay: Overlay): (n: { title?: unknown; project?: unknown; url?: unknown }) => boolean {
  const hidden = sourceItems(summary).filter((i) => {
    const o = overlayOf(i, overlay);
    return o.resolved || o.mutedUntil !== undefined;
  });
  return (n) => hidden.some((i) => (n.title === i.title && n.project === i.project) || (typeof n.url === "string" && n.url !== "" && n.url === i.url));
}

/** What the overlay says about one GodHome item. */
interface ItemOverlay {
  acked: boolean;
  /** Epoch ms of a running mute on the item's key. */
  mutedUntil?: number;
  /** Hidden by a manual resolve that GodHome has not contradicted with a later `lastAt`. */
  resolved: boolean;
  resolvedAt?: number;
  /** A manual resolve that a later `lastAt` overrode. */
  reopened: boolean;
}

function overlayOf(item: Record<string, any>, ov: Overlay | undefined): ItemOverlay {
  const none: ItemOverlay = { acked: false, resolved: false, reopened: false };
  // GodHome closed it itself: the overlay never fights that.
  if (!ov || item.state === "resolved") return none;
  const row: StateRow | undefined = ov.states.get(String(item.id));
  const lastAt = lastAtMs(item);
  const hidden = row?.resolvedLastAt != null && lastAt <= row.resolvedLastAt;
  if (hidden) return { acked: false, resolved: true, resolvedAt: row!.resolvedAt ?? undefined, reopened: false };
  const mutedUntil = ov.mutes.get(muteKey(item));
  return { acked: row?.ackedAt != null, resolved: false, reopened: row?.resolvedLastAt != null, ...(mutedUntil !== undefined ? { mutedUntil } : {}) };
}

/**
 * The key a mute sticks to. Check incidents are `check:<name>:<firstT>`, so every flap episode has a new
 * id; the key is `check:<ref>:<target>` instead, with the target parsed from the title per ref. Other kinds
 * key on the GodHome id.
 */
export function muteKey(item: Record<string, any>): string {
  if (item.kind !== "check") return String(item.id ?? "");
  const title = typeof item.title === "string" ? item.title : "";
  const ref = typeof item.check === "string" ? item.check : title.split(":")[0];
  const grab = (re: RegExp): string => (re.exec(title)?.[1] ?? "").slice(0, 200);
  const target =
    ref === "docker" ? grab(/^docker: (\S+)/)
    : ref === "unit" ? grab(/^unit: (\S+)/)
    : ref === "pm2" ? grab(/^pm2: (\S+)/)
    : ref === "site" ? grab(/^site: (\S+)/)
    : ref === "disk" ? grab(/^disk: (\S+)/)
    : ref === "backup" ? grab(/^backup: (\S+)/)
    : "";
  return `check:${ref}:${target}`;
}

/** `url` is kept only for https://github.com/... without credentials or a port (GodHome's safeHref, stricter). */
function githubUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || u.hostname !== "github.com" || u.username || u.password || u.port) return undefined;
    return u.href.length <= MAX_URL ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What the device may do with an incident, from its state, the overlay and its caps. `unack` and `unmute`
 * are served by the reopen route (it clears ack, resolve and mute). `fixTask` is offered when the incident's project has a mission config (`fixProjects`); `restart` when `restartable` says the allowlist matches and the device holds ops:service.
 */
function actionsFor(state: IncidentView["state"], caps: readonly string[], o: ItemOverlay, fixTask: boolean, restart: boolean): string[] {
  const out: string[] = [];
  if (caps.includes("ops:write")) {
    if (o.resolved) out.push("reopen");
    else if (state !== "resolved") out.push(...(o.mutedUntil !== undefined ? ["unmute", "resolve"] : [o.acked ? "unack" : "ack", "mute", "resolve"]), ...(fixTask ? ["fixTask"] : []));
  }
  // A restart needs ops:service and an allowlisted target (T4.2); never for a closed incident.
  if (restart && caps.includes("ops:service") && state !== "resolved") out.push("restart");
  return out;
}

export function mapIncident(item: Record<string, any>, opaqueId: string, caps: readonly string[], ov?: Overlay, fixProjects?: ReadonlySet<string>, restartable?: (item: Record<string, any>) => boolean): IncidentView {
  const o = overlayOf(item, ov);
  const state = o.resolved ? "resolved" : item.state === "recovering" || item.state === "resolved" ? item.state : "open";
  const severity = item.severity === "critical" || item.severity === "warning" ? item.severity : "notice";
  const check = text(item.check, 16);
  const resolvedAt = o.resolved ? (o.resolvedAt !== undefined ? new Date(o.resolvedAt).toISOString() : null) : iso(item.resolvedAt);
  const url = githubUrl(item.url);
  return {
    id: opaqueId, kind: item.kind, title: text(item.title, MAX_TITLE), subtitle: text(item.subtitle, MAX_SUBTITLE), severity, state,
    project: text(item.project, MAX_PROJECT),
    ...(check ? { check } : {}),
    firstAt: iso(item.firstAt), lastAt: iso(item.lastAt),
    ...(resolvedAt ? { resolvedAt } : {}),
    durationMs: cnt(item.durationMs), flaps: cnt(item.flaps), flapping: item.flapping === true, count: cnt(item.count),
    ...(url ? { url } : {}),
    acked: o.acked,
    ...(o.mutedUntil !== undefined ? { mutedUntil: new Date(o.mutedUntil).toISOString() } : {}),
    reopened: o.reopened, actions: actionsFor(state, caps, o, fixProjects?.has(text(item.project, MAX_PROJECT)) ?? false, restartable?.(item) ?? false),
  };
}

export interface IncidentQuery {
  state: IncidentStateFilter;
  kind?: IncidentKind;
  project?: string;
  /** Epoch ms: keep incidents whose newest of lastAt and resolvedAt is later. */
  since?: number;
  /** Epoch ms: keep incidents whose lastAt is earlier (the `next` cursor of the previous page). */
  before?: number;
  limit: number;
}

/** Which `state=` list an item belongs to once the overlay is applied. */
function bucketOf(item: Record<string, any>, ov: Overlay): "open" | "resolved" | "muted" | "other" {
  if (item.state === "resolved") return "resolved";
  if (item.state !== "open" && item.state !== "recovering") return "other";
  const o = overlayOf(item, ov);
  if (o.resolved) return "resolved";
  return o.mutedUntil !== undefined ? "muted" : "open";
}

/** GodHome's items, deduplicated on id (first wins), unknown kinds and id-less rows dropped, newest `lastAt` first. */
function sourceItems(summary: unknown): Record<string, any>[] {
  if (!isObj(summary)) throw new TypeError("summary is not an object");
  const inc = isObj(summary.incidents) ? summary.incidents : {};
  const seen = new Set<string>();
  const out: Record<string, any>[] = [];
  for (const i of Array.isArray(inc.items) ? inc.items : []) {
    if (!isObj(i) || typeof i.id !== "string" || !i.id || seen.has(i.id) || !(INCIDENT_KINDS as readonly string[]).includes(i.kind)) continue;
    seen.add(i.id);
    out.push(i);
  }
  const at = (i: Record<string, any>) => (typeof i.lastAt === "string" ? Date.parse(i.lastAt) : 0) || 0;
  return out.sort((a, b) => at(b) - at(a) || (a.id < b.id ? -1 : 1));
}

const lastAtMs = (i: Record<string, any>) => (typeof i.lastAt === "string" ? Date.parse(i.lastAt) : 0) || 0;
const newestMs = (i: Record<string, any>) => Math.max(lastAtMs(i), (typeof i.resolvedAt === "string" ? Date.parse(i.resolvedAt) : 0) || 0);

/**
 * The X5 body. `state=open` returns open and recovering items of every kind but agent, which is exactly what
 * GodHome's `counts.open` counts; agent incidents come only with `kind=agent`. A page never splits a run of
 * equal `lastAt`, so the ISO `next` cursor cannot skip an incident.
 */
export function listIncidents(summary: unknown, q: IncidentQuery, ids: OpsStore, caps: readonly string[], now = Date.now(), fixProjects?: ReadonlySet<string>, restartable?: (item: Record<string, any>) => boolean): {
  items: IncidentView[]; counts: Counts; mttrMs: number | null; next: string | null;
} {
  const overlay = ids.overlay(now);
  const counts = adjustedCounts(summary, overlay, now);
  const inc = (summary as Record<string, any>).incidents;
  const mttrMs = isObj(inc) && isObj(inc.mttr) ? num(inc.mttr.meanMs) : null;
  const wanted = sourceItems(summary).filter((i) => {
    if (q.kind === "agent" ? i.kind !== "agent" : i.kind === "agent" || (q.kind !== undefined && i.kind !== q.kind)) return false;
    if (q.project !== undefined && text(i.project, MAX_PROJECT) !== q.project) return false;
    if (q.since !== undefined && newestMs(i) <= q.since) return false;
    if (q.before !== undefined && lastAtMs(i) >= q.before) return false;
    if (q.state === "all") return true;
    return bucketOf(i, overlay) === q.state;
  });
  let take = Math.min(q.limit, wanted.length);
  while (take < wanted.length && lastAtMs(wanted[take]) === lastAtMs(wanted[take - 1])) take++;
  const { next } = pageOf(wanted.slice(0, take + 1), take, lastAtMs);
  const page = wanted.slice(0, take);
  return { items: page.map((i) => mapIncident(i, ids.opaqueId(i.id, now), caps, overlay, fixProjects, restartable)), counts, mttrMs, next };
}

/** GodHome's raw item behind a GodHome id, or null when it has left the list. */
export function findSourceItem(summary: unknown, sourceId: string): Record<string, any> | null {
  return sourceItems(summary).find((i) => i.id === sourceId) ?? null;
}

/** True when the incident is closed: by GodHome, or by hand and not contradicted by a later `lastAt`. */
export function incidentResolved(item: Record<string, any>, ids: OpsStore, now: number): boolean {
  return item.state === "resolved" || overlayOf(item, ids.overlay(now)).resolved;
}

// A single-segment absolute path (`/tmp`) that scrub() leaves behind; URLs and relative paths do not match.
const LONE_PATH = /(?<![\w:/.~-])\/[^\s/'"`()<>[\]{},;]+/g;
const noPaths = (v: string): string => scrub(v).replace(LONE_PATH, "...");
const MAX_NOTE = 500;

/** The owner's note for a fix task: redacted, with every absolute path removed, at most 500 characters. */
export function fixNote(note: string): string {
  return noPaths(note).trim().slice(0, MAX_NOTE);
}

function duration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  return m > 0 ? `${m} min` : "under a minute";
}

/**
 * The task text for a fix proposal: title, project, kind, check and how long it has been open. Never GodHome's
 * log output, working directories, ids or any absolute path; the title and the note go through redact and a path scrub.
 */
export function fixPrompt(item: Record<string, any>, note?: string): string {
  const check = text(item.check, 16);
  const clean = note === undefined ? "" : fixNote(note);
  return [
    "Fix this production incident.",
    `Incident: ${noPaths(text(item.title, MAX_TITLE))}`,
    `Project: ${text(item.project, MAX_PROJECT)}`,
    `Kind: ${String(item.kind)}${check ? ` (${check})` : ""}`,
    `Open for: ${duration(cnt(item.durationMs))}`,
    ...(clean ? [`Note from the owner: ${clean}`] : []),
    "Find the root cause and fix it. Do not paste logs into the reply.",
  ].join("\n");
}

export const MUTE_MINUTES = [60, 240, 1440, 10080] as const;
/** Critical incidents mute for an hour or four, never a day or a week. */
export const CRITICAL_MUTE_MINUTES = [60, 240] as const;
export type IncidentWrite = "ack" | "mute" | "resolve" | "reopen";

export type WriteOutcome = { ok: true } | { ok: false; status: 400 | 409; code: "bad_request" | "conflict"; message: string };

/**
 * Applies ack, mute, resolve or reopen of one GodHome item to the overlay. Refuses (409) to touch an incident
 * that is already resolved, by GodHome or by hand; reopen is always allowed and clears ack, resolve and the
 * mute of the incident's key. `minutes` is validated by the caller; the critical-severity limit is checked here
 * because severity comes from GodHome.
 */
export function applyIncidentWrite(
  action: IncidentWrite, item: Record<string, any>, opaqueId: string, ids: OpsStore, deviceId: string, now: number, minutes?: number,
): WriteOutcome {
  if (action === "reopen") {
    ids.clearState(opaqueId);
    ids.unmute(muteKey(item));
    return { ok: true };
  }
  const o = overlayOf(item, ids.overlay(now));
  if (item.state === "resolved") return { ok: false, status: 409, code: "conflict", message: "Incident is already resolved" };
  if (action === "resolve") {
    if (!o.resolved) ids.resolve(opaqueId, String(item.id), String(item.kind), lastAtMs(item), deviceId, now);
    return { ok: true };
  }
  if (o.resolved) return { ok: false, status: 409, code: "conflict", message: "Incident is resolved; reopen it first" };
  if (action === "ack") {
    ids.ack(opaqueId, String(item.id), String(item.kind), deviceId, now);
    return { ok: true };
  }
  if (item.severity === "critical" && !(CRITICAL_MUTE_MINUTES as readonly number[]).includes(minutes ?? -1)) {
    return { ok: false, status: 400, code: "bad_request", message: "A critical incident can be muted for 60 or 240 minutes only" };
  }
  ids.mute(muteKey(item), now + (minutes ?? 0) * 60_000, deviceId, now);
  return { ok: true };
}

/** One incident by the opaque id this store issued, or null when it was never issued or has left GodHome's list. */
export function findIncident(summary: unknown, opaqueId: string, ids: OpsStore, caps: readonly string[], now = Date.now(), fixProjects?: ReadonlySet<string>, restartable?: (item: Record<string, any>) => boolean): IncidentView | null {
  const source = ids.sourceId(opaqueId);
  if (source === null) return null;
  const hit = sourceItems(summary).find((i) => i.id === source);
  return hit ? mapIncident(hit, opaqueId, caps, ids.overlay(now), fixProjects, restartable) : null;
}
