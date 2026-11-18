import { scrub } from "../ops-map";

// Push payloads (plan section 5). Built from the event's own fields only, scrubbed, clamped, then put through a
// final gate that rejects the payload instead of sending anything that looks like a path, a secret or a phone number.

export type PushEvent =
  | { type: "approval.new"; id: string; project: string }
  | { type: "deploy.result"; id: string; project: string; outcome: "succeeded" | "failed" | "skipped" }
  | { type: "run.finished"; id: string; project: string }
  | { type: "run.failed"; id: string; project: string; outcome: "failed" | "stopped" }
  | { type: "incident.new"; id: string; level: "critical" | "warning"; title: string }
  | { type: "reminder"; id: string; title: string; section?: ReminderSection }
  | { type: "test"; id: string };

/** The Life section a reminder opens in the app (the payload's `p`). */
export type ReminderSection = "finance" | "deen" | "journal" | "today";

export interface UpPayload { v: 1; t: PushEvent["type"]; id: string; p?: string; o?: string; s?: string; title: string }
export interface NtfyMessage { title: string; message: string; tags: string[]; click: string }
export type GateReason = "size" | "path" | "secret" | "phone";
export type Built<T> = { ok: true; payload: T } | { ok: false; reason: GateReason };

export const MAX_PUSH_TITLE = 80;
const MAX_PUSH_PROJECT = 64;
const MAX_PUSH_BYTES = 1024;

/** How many payloads the gate refused; the text of a refused payload is never kept or logged. */
export class GateCounter { rejected = 0 }

const SECRET = /tk_|sk-|Bearer/;
const PHONE = /\+?\d[\d ().-]{7,}\d/;
const DATE_OR_TIME = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/g;

const clamp = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const clean = (s: string, n: number): string => clamp(scrub(s).replace(/\s+/g, " ").trim(), n);

function gate(p: { title: string; p?: string }, json: string): GateReason | null {
  if (Buffer.byteLength(json) > MAX_PUSH_BYTES) return "size";
  if (json.includes("/")) return "path";
  if (SECRET.test(json)) return "secret";
  // Only the human text can hold a phone number; ids and dates elsewhere are digit runs by design.
  for (const text of [p.title, p.p ?? ""]) if (PHONE.test(text.replace(DATE_OR_TIME, " "))) return "phone";
  return null;
}

function titleOf(e: PushEvent): string {
  switch (e.type) {
    case "approval.new": return `Approval needed: ${e.project}`;
    case "deploy.result": return `Deploy ${e.outcome}: ${e.project}`;
    case "run.finished": return `Run finished: ${e.project}`;
    case "run.failed": return `Run ${e.outcome}: ${e.project}`;
    case "incident.new": return `Incident: ${e.title}`;
    case "reminder": return e.title;
    case "test": return "Test notification";
  }
}

/** The UnifiedPush payload of an event, or the reason the gate refused it. */
export function buildPayload(e: PushEvent, counter?: GateCounter): Built<UpPayload> {
  const project = "project" in e ? clean(e.project, MAX_PUSH_PROJECT) : undefined;
  const payload: Omit<UpPayload, "title"> & { title?: string } = { v: 1, t: e.type, id: e.id };
  if (project !== undefined) payload.p = project;
  else if (e.type === "reminder" && e.section) payload.p = e.section;
  if (e.type === "deploy.result" || e.type === "run.failed") payload.o = e.outcome;
  else if (e.type === "run.finished") payload.o = "succeeded";
  if (e.type === "incident.new") payload.s = e.level;
  payload.title = clean(titleOf({ ...e, ...(project !== undefined ? { project } : {}) } as PushEvent), MAX_PUSH_TITLE);
  const full = payload as UpPayload;
  const reason = gate(full, JSON.stringify(full));
  if (reason) { if (counter) counter.rejected += 1; return { ok: false, reason }; }
  return { ok: true, payload: full };
}

const CLICK = /^controlapp:\/\/open\/(?:offers|runs|incidents)\/[A-Za-z0-9_-]{1,32}$|^controlapp:\/\/open\/(?:reminders(?:\/(?:finance|deen|journal|today))?|settings)$/;

function ntfyExtras(e: PushEvent): { message: string; tags: string[]; click: string } {
  switch (e.type) {
    case "approval.new": return { message: "Open Approvals", tags: ["approval"], click: `controlapp://open/offers/${e.id}` };
    case "deploy.result": return { message: "Open the deploy", tags: ["deploy", e.outcome], click: `controlapp://open/offers/${e.id}` };
    case "run.finished": return { message: "Open the run", tags: ["run", "succeeded"], click: `controlapp://open/runs/${e.id}` };
    case "run.failed": return { message: "Open the run", tags: ["run", e.outcome], click: `controlapp://open/runs/${e.id}` };
    case "incident.new": return { message: "Open the incident", tags: ["incident", e.level], click: `controlapp://open/incidents/${e.id}` };
    case "reminder": return { message: "Open reminders", tags: ["reminder"], click: e.section ? `controlapp://open/reminders/${e.section}` : "controlapp://open/reminders" };
    case "test": return { message: "Push works", tags: ["test"], click: "controlapp://open/settings" };
  }
}

/** The O3 form: ntfy-native title, tags and a `controlapp://` click target. The same gate decides on title and message. */
export function buildNtfy(e: PushEvent, counter?: GateCounter): Built<NtfyMessage> {
  const up = buildPayload(e, counter);
  if (!up.ok) return up;
  const x = ntfyExtras(e);
  const message: NtfyMessage = { title: up.payload.title, message: x.message, tags: x.tags, click: x.click };
  if (!CLICK.test(message.click) || SECRET.test(message.click)) { if (counter) counter.rejected += 1; return { ok: false, reason: "path" }; }
  return { ok: true, payload: message } as Built<NtfyMessage>;
}

/** The outbox body for the configured format: the UP JSON, or the O3 ntfy form as JSON. */
export function serialize(e: PushEvent, format: "up" | "ntfy", counter?: GateCounter): Built<string> {
  const built = format === "ntfy" ? buildNtfy(e, counter) : buildPayload(e, counter);
  return built.ok ? { ok: true, payload: JSON.stringify(built.payload) } : built;
}
