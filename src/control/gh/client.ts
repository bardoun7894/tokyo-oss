/**
 * The Control API's writes to GodHome (spec 012 plan section 1: one `GhClient`). T2.4 creates it with the first write path,
 * `postAgentPrompt`; T5.1 adds the fixed GET table. The bearer token is read per call and never reaches a log line, a result or
 * an error message, and neither does the prompt text. Nothing is retried.
 */
export interface GhClientOptions {
  /** e.g. http://127.0.0.1:8000/api/godhome */
  url: string;
  token: () => string | null;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

/** A request Tokyo refuses before it reaches GodHome (callers validate first, so this is a bug guard). */
export class GhInputError extends Error {}

/** What a GET table read returns: the reply, or the last good one while GodHome fails (same shape as the 003 `OpsResult`). */
export interface GhRead<T = any> {
  /** false when GodHome could not be reached and the last good reply (if any) is older than 6 x the cache time. */
  reachable: boolean;
  data: T | null;
  /** Epoch ms the data was fetched; 0 when there is none. */
  fetchedAt: number;
  /** GodHome answered 404. Not an outage. */
  notFound?: boolean;
}

export interface ReadParams { name?: string; repo?: string; since?: string; limit?: number }

const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_WORLD_LIMIT = 500;
const SEGMENT_MAX = 200;
export const ADWS = ["auto", "sssf", "plan_build_test", "quick_build"] as const;
export const FACTORY_STAGES = ["auto", "plan", "build", "gate", "review", "fusion_plan", "fusion_review"] as const;

/** A GodHome id or name as one path segment: letters, digits, `_`, `.`, `-`, at most 64, never only dots. */
function plain(what: string, v: unknown): string {
  if (typeof v !== "string" || !NAME.test(v) || /^\.+$/.test(v)) throw new GhInputError(`${what} must match ${NAME.source}`);
  return v;
}

/** `plain` for the routes: a GodHome id or name from a URL, or a GhInputError (the route answers 400). */
export const plainName = (what: string, v: unknown): string => plain(what, v);

/** One path segment of a write: not empty, not only dots, no control characters, at most 200 characters; percent-encoded. */
function seg(v: unknown): string {
  if (typeof v !== "string" || v.length < 1 || v.length > SEGMENT_MAX || /^\.+$/.test(v) || /[\u0000-\u001f\u007f]/.test(v)) throw new GhInputError("a path segment is not plain");
  return encodeURIComponent(v);
}

function worldQuery(p: ReadParams): string {
  const q: string[] = [];
  if (p.since !== undefined) {
    if (typeof p.since !== "string" || !ISO.test(p.since) || Number.isNaN(Date.parse(p.since))) throw new GhInputError("since must be ISO-8601");
    q.push(`since=${encodeURIComponent(p.since)}`);
  }
  if (p.limit !== undefined) {
    if (typeof p.limit !== "number" || !Number.isInteger(p.limit) || p.limit < 1 || p.limit > MAX_WORLD_LIMIT) throw new GhInputError(`limit must be an integer 1 to ${MAX_WORLD_LIMIT}`);
    q.push(`limit=${p.limit}`);
  }
  return q.length ? `?${q.join("&")}` : "";
}

/**
 * Every GodHome GET Tokyo may issue (K1..K35): a fixed path per key, parameters checked here. There is no `quota?fresh=1`, no
 * `world/detail`, and the tmux entry is the session list only (no output, send or key). `projectsRefresh` is K8's, with a 60 s floor.
 */
export const GH_READS = {
  fleetServices: () => "/fleet/services",
  fleetSchedules: () => "/fleet/schedules",
  monitor: () => "/monitor",
  network: () => "/network",
  networkAlerts: () => "/network/alerts",
  services: () => "/services",
  projects: () => "/projects",
  projectsRefresh: () => "/projects?refresh=1",
  worldState: () => "/world/state",
  worldEvents: (p: ReadParams) => `/world/events${worldQuery(p)}`,
  control: () => "/control",
  inbox: () => "/inbox",
  hygieneFindings: () => "/hygiene/findings",
  hygieneFixes: () => "/hygiene/fixes",
  playbook: () => "/playbook",
  graphs: () => "/graphs",
  graph: (p: ReadParams) => `/graphs/${plain("graph name", p.name)}`,
  triggers: () => "/triggers",
  factory: () => "/factory",
  factoryRuns: () => "/factory/runs",
  factoryRun: (p: ReadParams) => `/factory/runs/${plain("run id", p.name)}`,
  factoryLaunches: () => "/factory/launches",
  factoryRoster: (p: ReadParams) => `/factory/roster?repo=${encodeURIComponent(plain("repo", p.repo))}`,
  models: () => "/models",
  modelsHealth: () => "/models/health",
  quota: () => "/quota",
  costs: () => "/costs",
  roles: () => "/roles",
  skills: () => "/skills",
  skillsGraph: () => "/skills/graph",
  tmuxSessions: () => "/tmux/sessions",
} as const satisfies Record<string, (p: ReadParams) => string>;
export type GhReadKey = keyof typeof GH_READS;

export interface WriteArgs { seg?: readonly string[]; body?: Record<string, unknown> }
interface WriteSpec {
  method: "POST" | "DELETE";
  /** Number of path segments the caller supplies. */
  segs: number;
  path(s: readonly string[]): string;
  /** The only fields GodHome is ever sent for this write; absent when the write has no body. */
  body?(b: any): Record<string, unknown>;
}

const str = (what: string, v: unknown, max: number, min = 1): string => {
  if (typeof v !== "string" || v.length < min || v.length > max) throw new GhInputError(`${what} must be ${min} to ${max} characters`);
  return v;
};

/**
 * Every GodHome write Tokyo may issue after 004 (research section 3): fixed method and path, bodies rebuilt from allowlists.
 * Not here, by design: tmux send, key, output, resize, interrupt and new session; model probe; hygiene fix; mission answers; graph edits.
 */
export const GH_WRITES = {
  networkRefresh: { method: "POST", segs: 0, path: () => "/network/refresh" },
  servicesRefresh: { method: "POST", segs: 0, path: () => "/services/refresh" },
  sitesRefresh: { method: "POST", segs: 0, path: () => "/control/sites/refresh" },
  inboxDismiss: {
    method: "POST", segs: 0, path: () => "/inbox/dismiss",
    body: (b) => ({ kind: str("kind", b?.kind, 60), title: str("title", b?.title, 300), ...(b?.at !== undefined ? { at: str("at", b.at, 40) } : {}) }),
  },
  lessonApprove: { method: "POST", segs: 1, path: (s) => `/playbook/${seg(s[0])}/approve` },
  lessonReject: { method: "DELETE", segs: 1, path: (s) => `/playbook/${seg(s[0])}` },
  graphRun: { method: "POST", segs: 1, path: (s) => `/graphs/${seg(s[0])}/run` },
  triggerFire: { method: "POST", segs: 1, path: (s) => `/triggers/${seg(s[0])}/fire` },
  triggerReset: { method: "POST", segs: 1, path: (s) => `/triggers/${seg(s[0])}/reset` },
  triggerDelete: { method: "DELETE", segs: 1, path: (s) => `/triggers/${seg(s[0])}` },
  factoryRun: {
    method: "POST", segs: 0, path: () => "/factory/run",
    // `merge` is always false, whatever the request said; `architect`, `builder` and the rest are never forwarded.
    body: (b) => {
      const stages = b?.stages === undefined ? undefined : str("stages", b.stages, 120);
      if (stages !== undefined && !stages.split(",").every((s) => (FACTORY_STAGES as readonly string[]).includes(s))) throw new GhInputError("stages has an unknown stage");
      if (b?.adw !== undefined && !(ADWS as readonly unknown[]).includes(b.adw)) throw new GhInputError("adw is not one of the known workflows");
      return {
        ticket: str("ticket", b?.ticket, 2000), repo: str("repo", b?.repo, SEGMENT_MAX),
        ...(stages !== undefined ? { stages } : {}), ...(b?.adw !== undefined ? { adw: b.adw } : {}), merge: false,
      };
    },
  },
  launchStop: { method: "POST", segs: 1, path: (s) => `/factory/launch/${seg(s[0])}/stop` },
  cardMove: { method: "POST", segs: 2, path: (s) => `/factory/kanban/${seg(s[0])}/${seg(s[1])}/move`, body: (b) => ({ to: str("to", b?.to, SEGMENT_MAX) }) },
  cardDelete: { method: "DELETE", segs: 2, path: (s) => `/factory/kanban/${seg(s[0])}/${seg(s[1])}` },
  modelEnabled: {
    method: "POST", segs: 0, path: () => "/models/enabled",
    body: (b) => {
      const id = str("id", b?.id, SEGMENT_MAX);
      if (!id.includes("/") || typeof b?.enabled !== "boolean") throw new GhInputError("id must be provider/model and enabled a boolean");
      return { id, enabled: b.enabled };
    },
  },
  terminalKill: { method: "POST", segs: 1, path: (s) => `/tmux/sessions/${seg(s[0])}/kill` },
} as const satisfies Record<string, WriteSpec>;
export type GhWriteKey = keyof typeof GH_WRITES;

export type GhWriteResult = { status: "ok"; json: any } | { status: "not_found" } | { status: "rejected" } | { status: "unreachable" };

const READ_TTL_MS = 10_000;
const STALE_FACTOR = 6;
const MAX_CACHE = 200;
const REFRESH_FLOOR_MS = 60_000;

export type PromptResult = { status: "ok" } | { status: "not_found" } | { status: "unreachable" };

const DEFAULT_TIMEOUT_MS = 5_000;
export const MAX_AGENT_TEXT = 2000;
const MAX_AGENT_NAME = 200;

/** A herdr agent name as one URL segment: not empty, not only dots, no control characters, at most 200 characters. */
const plainAgentName = (name: string): boolean => name.length >= 1 && name.length <= MAX_AGENT_NAME && !/^\.+$/.test(name) && !/[\u0000-\u001f\u007f]/.test(name);

export class GhClient {
  private cache = new Map<string, { at: number; json: any }>();
  private inflight = new Map<string, Promise<GhRead>>();
  private lastRefreshAt = -Infinity;

  constructor(private readonly opts: GhClientOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  invalidate(): void {
    this.cache.clear();
  }

  cacheSize(): number {
    return this.cache.size;
  }

  /**
   * A GET from the fixed table, cached for 10 s and shared by concurrent callers. When GodHome fails the last good reply is handed out
   * and counts as reachable until it is 6 x older than the cache time. `fresh` skips the cache (a confirm that must see the present).
   */
  async read(key: GhReadKey, params: ReadParams = {}, o: { fresh?: boolean } = {}): Promise<GhRead> {
    if (!Object.hasOwn(GH_READS, key)) throw new GhInputError("unknown read");
    let k = key;
    if (k === "projectsRefresh") {
      if (this.now() - this.lastRefreshAt < REFRESH_FLOOR_MS) k = "projects";
      else this.lastRefreshAt = this.now();
    }
    const path = GH_READS[k](params);
    if (o.fresh) this.cache.delete(path);
    const hit = this.cache.get(path);
    if (hit && this.now() - hit.at < READ_TTL_MS) return { reachable: true, data: hit.json, fetchedAt: hit.at };
    const running = this.inflight.get(path);
    if (running) return running;
    const p = this.fetchOnce(k, path).finally(() => this.inflight.delete(path));
    this.inflight.set(path, p);
    return p;
  }

  private async fetchOnce(key: string, path: string): Promise<GhRead> {
    const token = this.opts.token();
    if (!token) return this.failed(key, path, "no token");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await (this.opts.fetch ?? fetch)(this.opts.url + path, { headers: { authorization: `Bearer ${token}` }, signal: ctl.signal });
      if (res.status === 404) return { reachable: true, data: null, fetchedAt: this.now(), notFound: true };
      if (res.status !== 200) return this.failed(key, path, `HTTP ${res.status}`);
      const json = await res.json();
      const at = this.now();
      this.cache.delete(path);
      this.cache.set(path, { at, json });
      if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string);
      return { reachable: true, data: json, fetchedAt: at };
    } catch (e: any) {
      // The error name only: a message can carry the request headers.
      return this.failed(key, path, String(e?.name ?? "Error").slice(0, 40));
    } finally {
      clearTimeout(timer);
    }
  }

  private failed(key: string, path: string, why: string): GhRead {
    console.warn(`[control-api] godhome read ${key}: ${why}`);
    const last = this.cache.get(path);
    if (!last) return { reachable: false, data: null, fetchedAt: 0 };
    return { reachable: this.now() - last.at <= READ_TTL_MS * STALE_FACTOR, data: last.json, fetchedAt: last.at };
  }

  /**
   * A GodHome write from the fixed table. 200 is ok (with GodHome's JSON, which may still say `{ok:false}`), 404 not_found, 400 rejected
   * (GodHome refused the input), anything else, a timeout or a missing token unreachable. Nothing is retried; the cached reads are dropped.
   */
  async write(key: GhWriteKey, args: WriteArgs = {}): Promise<GhWriteResult> {
    if (!Object.hasOwn(GH_WRITES, key)) throw new GhInputError("unknown write");
    const spec: WriteSpec = GH_WRITES[key];
    const s = args.seg ?? [];
    if (s.length !== spec.segs) throw new GhInputError("wrong number of path segments");
    const path = spec.path(s);
    const body = spec.body ? spec.body(args.body) : undefined;
    const token = this.opts.token();
    if (!token) {
      console.warn(`[control-api] godhome write ${key}: no token`);
      return { status: "unreachable" };
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await (this.opts.fetch ?? fetch)(this.opts.url + path, {
        method: spec.method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: ctl.signal,
      });
      if (res.status === 200) {
        this.cache.clear();
        let json: any = null;
        try { json = await res.json(); } catch { /* an empty body is still a 200 */ }
        return { status: "ok", json };
      }
      if (res.status === 404) return { status: "not_found" };
      if (res.status === 400) return { status: "rejected" };
      console.warn(`[control-api] godhome write ${key}: HTTP ${res.status}`);
      return { status: "unreachable" };
    } catch (e: any) {
      console.warn(`[control-api] godhome write ${key}: ${String(e?.name ?? "Error").slice(0, 40)}`);
      return { status: "unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * G4's send: `POST /herdr/agents/:name/prompt` with `{text}`, the name as one encoded path segment. 200 is ok, 404 is not_found,
   * anything else (GodHome answers 502 when herdr fails), a timeout or a missing token is unreachable.
   */
  async postAgentPrompt(name: string, text: string): Promise<PromptResult> {
    if (typeof text !== "string" || text.length < 1 || text.length > MAX_AGENT_TEXT) throw new GhInputError(`text must be 1 to ${MAX_AGENT_TEXT} characters`);
    if (!plainAgentName(name)) return { status: "not_found" };
    const token = this.opts.token();
    if (!token) {
      console.warn("[control-api] godhome prompt: no token");
      return { status: "unreachable" };
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await (this.opts.fetch ?? fetch)(`${this.opts.url}/herdr/agents/${encodeURIComponent(name)}/prompt`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: ctl.signal,
      });
      if (res.status === 200) return { status: "ok" };
      if (res.status === 404) return { status: "not_found" };
      console.warn(`[control-api] godhome prompt: HTTP ${res.status}`);
      return { status: "unreachable" };
    } catch (e: any) {
      // The error name only: a message can carry the request headers or the body.
      console.warn(`[control-api] godhome prompt: ${String(e?.name ?? "Error").slice(0, 40)}`);
      return { status: "unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }
}
