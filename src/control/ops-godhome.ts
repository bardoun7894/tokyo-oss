/**
 * GodHome as the read source of the ops routes (X1 to X6): `ops/summary`, `runs`, `runs/:id`, `graphs/:name`.
 * Only these four fixed paths are read (plus the one write, `stopRun`). Each read is cached for ttlMs and shared by concurrent callers
 * (single-flight), so 30 s polling from several screens costs one GodHome call per TTL and key. When GodHome
 * fails, the last good reply is handed out; it still counts as reachable until it is older than ttlMs x 6.
 * Raw replies are returned as is: the mappers in ops-map.ts decide what leaves Tokyo.
 * The bearer token is read per call and never reaches a log line, a result or an error message.
 */
export interface OpsGodhomeOptions {
  /** e.g. http://127.0.0.1:8000/api/godhome */
  url: string;
  token: () => string | null;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface OpsResult<T = any> {
  /** false when GodHome could not be reached and the last good reply (if any) is older than ttlMs x 6. */
  reachable: boolean;
  /** The reply, or the last good one; null when there is none. */
  data: T | null;
  /** Epoch ms the data was fetched; 0 when there is none. */
  fetchedAt: number;
  /** GodHome answered 404: the run or graph does not exist. Not an outage. */
  notFound?: boolean;
}

export type StopResult = { status: "stopped" } | { status: "not_running" } | { status: "unreachable" };

/** A request Tokyo refuses before it reaches GodHome. Routes answer 400 `bad_request`. */
export class OpsInputError extends Error {
  readonly status = 400;
}

export const OPS_WINDOWS = ["24h", "7d", "all"] as const;
export type OpsWindow = (typeof OPS_WINDOWS)[number];
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const DEFAULT_TTL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const STALE_FACTOR = 6;
const MAX_CACHE = 200;
/** GodHome's own cap on `GET /runs`. */
const RUNS_LIMIT = 200;

export const isOpsWindow = (v: unknown): v is OpsWindow => typeof v === "string" && (OPS_WINDOWS as readonly string[]).includes(v);

function checkName(what: string, v: string): string {
  // "." and ".." match the character class but are path segments, not names.
  if (!NAME.test(v) || /^\.+$/.test(v)) throw new OpsInputError(`${what} must match ${NAME.source}`);
  return v;
}

export class OpsGodhome {
  private cache = new Map<string, { at: number; json: any }>();
  private inflight = new Map<string, Promise<OpsResult>>();

  constructor(private readonly opts: OpsGodhomeOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private get ttl(): number {
    return this.opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  async summary(window: string): Promise<OpsResult> {
    if (!isOpsWindow(window)) throw new OpsInputError("window must be 24h, 7d or all");
    return this.read(`/ops/summary?window=${window}`);
  }

  /** G3: herdr's agent list (name, status, workspace label). Mapped in agents/live.ts, which drops the paths and ids. */
  herdrAgents(fresh = false): Promise<OpsResult> {
    // A prompt is confirmed against the agents that exist now, not the ones 10 s ago.
    if (fresh) this.cache.delete("/herdr/agents");
    return this.read("/herdr/agents");
  }

  runs(): Promise<OpsResult> {
    return this.read(`/runs?limit=${RUNS_LIMIT}`);
  }

  async run(id: string): Promise<OpsResult> {
    return this.read(`/runs/${checkName("run id", id)}`);
  }

  async graph(name: string): Promise<OpsResult> {
    return this.read(`/graphs/${checkName("graph name", name)}`);
  }

  /**
   * Stops an engine run, the only write Tokyo makes to GodHome (D9). GodHome answers 200 `{ok:false}` for an
   * unknown, finished or pre-restart run (G10), which is `not_running`. Anything but a 200 with a boolean `ok`
   * is `unreachable`. No body is sent and nothing is retried; the cached run reads are dropped on an answer.
   */
  async stopRun(id: string): Promise<StopResult> {
    const run = checkName("run id", id);
    const token = this.opts.token();
    if (!token) {
      console.warn("[control-api] godhome stop: no token");
      return { status: "unreachable" };
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await (this.opts.fetch ?? fetch)(`${this.opts.url}/runs/${run}/stop`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        signal: ctl.signal,
      });
      const json: any = res.status === 200 ? await res.json() : null;
      if (typeof json?.ok !== "boolean") {
        console.warn(`[control-api] godhome stop: HTTP ${res.status}`);
        return { status: "unreachable" };
      }
      this.cache.delete(`/runs/${run}`);
      this.cache.delete(`/runs?limit=${RUNS_LIMIT}`);
      return { status: json.ok ? "stopped" : "not_running" };
    } catch (e: any) {
      // The error name only: a message can carry the request headers.
      console.warn(`[control-api] godhome stop: ${String(e?.name ?? "Error").slice(0, 40)}`);
      return { status: "unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Callers validate input before this point, so the argument is always one of the fixed paths above. */
  private async read(path: string): Promise<OpsResult> {
    const hit = this.cache.get(path);
    if (hit && this.now() - hit.at < this.ttl) return { reachable: true, data: hit.json, fetchedAt: hit.at };
    const running = this.inflight.get(path);
    if (running) return running;
    const p = this.fetchOnce(path).finally(() => this.inflight.delete(path));
    this.inflight.set(path, p);
    return p;
  }

  private async fetchOnce(path: string): Promise<OpsResult> {
    const token = this.opts.token();
    if (!token) return this.failed(path, "no token");
    // A ref'd timer (AbortSignal.timeout is unref'd, so a fetch waiting only for its abort lets the loop end).
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await (this.opts.fetch ?? fetch)(this.opts.url + path, {
        headers: { authorization: `Bearer ${token}` },
        signal: ctl.signal,
      });
      if (res.status === 404) return { reachable: true, data: null, fetchedAt: this.now(), notFound: true };
      if (res.status !== 200) return this.failed(path, `HTTP ${res.status}`);
      const json = await res.json();
      const at = this.now();
      this.remember(path, at, json);
      return { reachable: true, data: json, fetchedAt: at };
    } catch (e: any) {
      // The error name only: a message can carry the request headers.
      return this.failed(path, String(e?.name ?? "Error").slice(0, 40));
    } finally {
      clearTimeout(timer);
    }
  }

  private remember(path: string, at: number, json: any): void {
    this.cache.delete(path);
    this.cache.set(path, { at, json });
    if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string);
  }

  private failed(path: string, why: string): OpsResult {
    console.warn(`[control-api] godhome ${path.split("?")[0]}: ${why}`);
    const last = this.cache.get(path);
    if (!last) return { reachable: false, data: null, fetchedAt: 0 };
    return { reachable: this.now() - last.at <= this.ttl * STALE_FACTOR, data: last.json, fetchedAt: last.at };
  }
}
