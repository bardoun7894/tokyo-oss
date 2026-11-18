import type { OfferRow, RunRow } from "./contract";

/**
 * The on-call monitor (durable-pi's dpi-real-be, tailnet only) as a source of the Control API: its incident agents
 * are runs (`source: "server-agent"`) and its outside-failure alerts are one-button action offers. It serves the
 * contract's shapes at `/api/control` with a bearer token. The lists are cached for a few seconds so the list routes
 * stay synchronous; log, stop and answer are proxied. A monitor that is down only leaves its rows out.
 */
export interface MonitorOptions {
  /** e.g. http://100.64.0.1:4791/api/control */
  url: string;
  token: string;
  now?: () => number;
  ttlMs?: number;
}

export interface MonitorReply { status: number; json: any }

const ID = /^[0-9a-f]{8}$/;
const TIMEOUT_MS = 5000;

const ms = (v: unknown): number | null => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? null : t;
};
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Allow-listed fields only: the monitor's JSON never reaches the phone as is. */
export function monitorRun(r: any): RunRow | null {
  const startedAt = ms(r?.startedAt);
  if (!ID.test(String(r?.id)) || startedAt === null) return null;
  return {
    id: r.id, project: String(r.project ?? "").slice(0, 64), source: "server-agent", status: String(r.status), model: str(r.model),
    harness: str(r.harness), worker: str(r.worker), tier: str(r.tier), promptPreview: String(r.promptPreview ?? "").slice(0, 200),
    startedAt, endedAt: ms(r.endedAt), exitCode: typeof r.exitCode === "number" ? r.exitCode : null, host: "server", offerId: null,
  };
}

export function monitorOffer(o: any): OfferRow | null {
  const createdAt = ms(o?.createdAt), expiresAt = ms(o?.expiresAt);
  if (!ID.test(String(o?.id)) || createdAt === null || expiresAt === null) return null;
  return {
    id: o.id, kind: "action", project: String(o.project ?? "").slice(0, 64), title: String(o.title ?? "").slice(0, 200),
    body: String(o.body ?? "").slice(0, 1500), from: str(o.from), state: String(o.state), missionId: null,
    buttons: [{ id: "skip", label: "Dismiss" }], createdAt, expiresAt, answeredButton: str(o.answeredButton),
    channel: str(o.channel), answeredAt: ms(o.answeredAt),
  };
}

export class Monitor {
  private runs: RunRow[] = [];
  private offers: OfferRow[] = [];
  private loadedAt = -Infinity;
  private loading?: Promise<void>;
  private down = false;

  constructor(private readonly opts: MonitorOptions) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  async call(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = TIMEOUT_MS): Promise<MonitorReply> {
    const res = await fetch(this.opts.url + path, {
      method,
      headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, json };
  }

  /** Reload the lists when the cache is older than the TTL; concurrent callers share one load. */
  refresh(): Promise<void> {
    if (this.now() - this.loadedAt < (this.opts.ttlMs ?? 5000)) return Promise.resolve();
    this.loading ??= this.load().finally(() => { this.loading = undefined; });
    return this.loading;
  }

  /** The next refresh reloads, after an answer or a stop changed the monitor. */
  invalidate() {
    this.loadedAt = -Infinity;
  }

  private async load() {
    try {
      const [runs, offers] = await Promise.all([this.call("GET", "/runs"), this.call("GET", "/offers")]);
      if (runs.status !== 200 || offers.status !== 200) throw Error(`HTTP ${runs.status} / ${offers.status}`);
      this.runs = (runs.json?.runs ?? []).map(monitorRun).filter(Boolean) as RunRow[];
      this.offers = (offers.json?.offers ?? []).map(monitorOffer).filter(Boolean) as OfferRow[];
      if (this.down) console.log("[control-api] monitor reachable again");
      this.down = false;
    } catch (e: any) {
      this.runs = [];
      this.offers = [];
      if (!this.down) console.warn(`[control-api] monitor unavailable: ${e?.message ?? e}`);
      this.down = true;
    }
    this.loadedAt = this.now();
  }

  listRuns(): RunRow[] {
    return this.runs;
  }

  listOffers(): OfferRow[] {
    return this.offers;
  }

  getRun(id: string): RunRow | undefined {
    return this.runs.find((r) => r.id === id);
  }

  getOffer(id: string): OfferRow | undefined {
    return this.offers.find((o) => o.id === id);
  }

  log(id: string, after: string | undefined, wait: number): Promise<MonitorReply> {
    const q = new URLSearchParams({ ...(after !== undefined ? { after } : {}), wait: String(wait) });
    return this.call("GET", `/runs/${id}/log?${q}`, undefined, (wait + 5) * 1000);
  }

  async stop(id: string): Promise<MonitorReply> {
    const r = await this.call("POST", `/runs/${id}/stop`, {});
    this.invalidate();
    return r;
  }

  async answer(id: string, button: string): Promise<MonitorReply> {
    const r = await this.call("POST", `/offers/${id}/answer`, { button, channel: "app" });
    this.invalidate();
    return r;
  }
}
