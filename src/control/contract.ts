// The Control API contract (plan.md "API reference"). Every enum and every response view lives here,
// so a route cannot serialise a value the Flutter app does not know.

export const HOSTS = ["mac", "server"] as const;
export const OFFER_KINDS = ["action", "deploy", "mission"] as const;
export const OFFER_STATES = ["pending", "approved", "declined", "expired"] as const;
export const OFFER_CHANNELS = ["telegram", "app", "terminal", "whatsapp"] as const;
export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "stopped"] as const;
export const RUN_SOURCES = ["tokyo", "jdelegate", "herdr", "server-agent"] as const;
export const HARNESSES = ["claude", "codex", "gemini", "opencode"] as const;
export const TIERS = ["trivial", "simple", "medium", "hard"] as const;
export const GAP_SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
export const GAP_SOURCES = ["readiness-audit", "defects"] as const;
export const LOG_KINDS = ["assistant", "tool", "result", "system"] as const;
export const NEXT_ACTIONS = ["write-specs", "fix-defects", "implement-open-tasks", "research-features", "verdict", "needs-llm"] as const;
export const ERROR_CODES = ["unauthorized", "bad_request", "not_found", "conflict", "report_only", "rate_limited", "unavailable", "forbidden", "not_registered"] as const;

export type Host = (typeof HOSTS)[number];
export type OfferKind = (typeof OFFER_KINDS)[number];
export type OfferState = (typeof OFFER_STATES)[number];
export type OfferChannel = (typeof OFFER_CHANNELS)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];
export type RunSource = (typeof RUN_SOURCES)[number];
export type Harness = (typeof HARNESSES)[number];
export type Tier = (typeof TIERS)[number];
export type GapSeverity = (typeof GAP_SEVERITIES)[number];
export type GapSource = (typeof GAP_SOURCES)[number];
export type LogKind = (typeof LOG_KINDS)[number];
export type NextAction = (typeof NEXT_ACTIONS)[number];
export type ErrorCode = (typeof ERROR_CODES)[number];

function pick<T extends string>(set: readonly T[], v: unknown): T | null {
  return typeof v === "string" && (set as readonly string[]).includes(v) ? (v as T) : null;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const isoOrNull = (ms: number | null | undefined): string | null => (typeof ms === "number" ? iso(ms) : null);

// --- normalisers ---

export function normHost(v: unknown): Host | null {
  return v === "laptop" ? "mac" : pick(HOSTS, v);
}

export function normRunStatus(v: unknown): RunStatus | null {
  if (v === "ok") return "succeeded";
  if (v === "error") return "failed";
  return pick(RUN_STATUSES, v);
}

export const normSeverity = (v: unknown): GapSeverity => pick(GAP_SEVERITIES, v) ?? "P2";
export const normGapSource = (v: unknown): GapSource => pick(GAP_SOURCES, v) ?? "readiness-audit";
export const normChannel = (v: unknown): OfferChannel | null => pick(OFFER_CHANNELS, v);

const DECLINE_BUTTONS = new Set(["skip", "reject", "decline"]);

export function stateForButton(button: string): "approved" | "declined" {
  return DECLINE_BUTTONS.has(button) ? "declined" : "approved";
}

/** Maps an internal offer (action: pending|answered|superseded|expired) to the API state. */
export function stateForOffer(o: { state: string; answeredButton?: string | null }): OfferState {
  if (o.state === "pending") return "pending";
  if (o.state === "answered") return stateForButton(o.answeredButton ?? "");
  return pick(OFFER_STATES, o.state) ?? "expired";
}

// --- error bodies ---

export function errorBody(code: ErrorCode, message: string) {
  return { error: { code, message } };
}

/** The one flat 409 of route 9 and 15. */
export function alreadyBody(channel: string | null, at: number) {
  return { error: "already" as const, answeredBy: { channel, at: iso(at) } };
}

// --- views ---

export interface Button { id: string; label: string }
export const DEPLOY_BUTTONS: Button[] = [{ id: "deploy", label: "Deploy" }, { id: "skip", label: "Not now" }];
export const MISSION_BUTTONS: Button[] = [{ id: "approve", label: "Approve" }, { id: "skip", label: "Skip" }];

export interface RunRow {
  id: string; project: string; source: string; status: string; model: string | null; harness: string | null;
  worker: string | null; tier: string | null; promptPreview: string; startedAt: number; endedAt: number | null;
  exitCode: number | null; host: string; offerId: string | null; workspace?: string | null;
}

export function viewRun(r: RunRow) {
  return {
    id: r.id,
    project: r.project,
    source: pick(RUN_SOURCES, r.source) ?? "tokyo",
    status: normRunStatus(r.status) ?? "failed",
    model: r.model ?? null,
    harness: pick(HARNESSES, r.harness),
    worker: r.worker ?? null,
    tier: pick(TIERS, r.tier),
    promptPreview: (r.promptPreview ?? "").slice(0, 200),
    startedAt: iso(r.startedAt),
    endedAt: isoOrNull(r.endedAt),
    exitCode: r.exitCode ?? null,
    host: normHost(r.host) ?? "server",
    offerId: r.offerId ?? null,
  };
}

export function viewGap(g: { code: string; text: string; severity?: unknown; source?: unknown }) {
  return { code: g.code, text: g.text, severity: normSeverity(g.severity), source: normGapSource(g.source) };
}

export function viewLogEvent(e: { t: number; kind: string; text: string; tool?: string | null }) {
  return { t: iso(e.t), kind: pick(LOG_KINDS, e.kind) ?? "system", text: (e.text ?? "").slice(0, 2000), tool: e.tool ?? null };
}

export interface OfferRow {
  id: string; kind: string; project: string; title: string; body: string; from: string | null; state: string;
  missionId: string | null; buttons: { id: string; label: string }[]; createdAt: number; expiresAt: number;
  answeredButton: string | null; channel: string | null; answeredAt: number | null;
  /** Deploy offers only: the Control run id of the deploy run, once approved. */
  runId?: string;
}

export function viewOffer(o: OfferRow) {
  const state = stateForOffer(o);
  return {
    id: o.id,
    kind: pick(OFFER_KINDS, o.kind) ?? "action",
    project: o.project,
    title: o.title,
    body: (o.body ?? "").slice(0, 1500),
    from: o.from ?? null,
    state,
    missionId: o.missionId ?? null,
    buttons: (o.buttons ?? []).map((b) => ({ id: b.id, label: b.label })),
    createdAt: iso(o.createdAt),
    expiresAt: iso(o.expiresAt),
    answeredButton: o.answeredButton ?? null,
    channel: state === "pending" || state === "expired" ? null : normChannel(o.channel),
    answeredAt: isoOrNull(o.answeredAt),
    ...(o.runId ? { runId: o.runId } : {}),
  };
}

export function viewProject(p: { name: string; host: string; customer: boolean; completeness: number; nextAction: string }) {
  return {
    name: p.name,
    host: normHost(p.host) ?? "server",
    customer: !!p.customer,
    completeness: Math.max(0, Math.min(4, Math.round(Number(p.completeness) || 0))),
    nextAction: pick(NEXT_ACTIONS, p.nextAction) ?? "needs-llm",
  };
}
