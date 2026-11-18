import { redact } from "./redact";

/**
 * GodHome (the server dashboard, tailnet only) as a read source of the Control API. Only a fixed list of
 * read routes is called, and every reply is mapped field by field into the shapes below: GodHome's own JSON
 * carries prompts, working directories and env, and none of it reaches the phone as is. A GodHome that is
 * down only leaves its sections empty (`reachable: false`).
 */
export interface GodhomeOptions {
  /** e.g. http://127.0.0.1:8000/api/godhome */
  url: string;
  token: () => string | null;
  now?: () => number;
  ttlMs?: number;
  fetch?: typeof fetch;
}

export interface ServiceRow { name: string; kind: string; up: boolean; status: string; since: string | null }
export interface QuotaRow { id: string; label: string; state: string; headline: string; detail: string }
export interface CostsRow { jevToday: number; jevWeek: number; jevMonth: number }
export interface GraphRunRow { id: string; graph: string; project: string; status: "running" | "succeeded" | "failed"; startedAt: string | null; endedAt: string | null; error: string | null; calls: number }
export interface LaunchRow { id: string; project: string; status: "running" | "succeeded" | "failed"; startedAt: string | null; summary: string }
export interface HerdrAgentRow { name: string; state: string; project: string }

export interface GodhomeSystem { reachable: boolean; services: ServiceRow[]; quota: QuotaRow[]; costs: CostsRow | null }
export interface GodhomeAgents { reachable: boolean; herdr: HerdrAgentRow[]; graphRuns: GraphRunRow[]; launches: LaunchRow[] }

const TIMEOUT_MS = 5000;
const s = (v: unknown, max = 80): string => (typeof v === "string" ? redact(v).slice(0, max) : "");
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const isoMs = (v: unknown): string | null => (typeof v === "number" && v > 0 ? new Date(v).toISOString() : null);
/** The last path segment only: a working directory names the project, the rest of the path stays here. */
export const baseName = (p: unknown): string => (typeof p === "string" ? (p.replace(/\/+$/, "").split("/").pop() ?? "").slice(0, 64) : "");

export function mapService(x: any): ServiceRow | null {
  if (typeof x?.name !== "string") return null;
  return { name: s(x.name, 64), kind: s(x.kind, 16), up: x.active === true, status: s(x.status, 40), since: typeof x.since === "string" ? s(x.since, 40) : null };
}

export function mapQuota(x: any): QuotaRow | null {
  if (typeof x?.id !== "string") return null;
  return { id: s(x.id, 64), label: s(x.label, 64), state: s(x.state, 16), headline: s(x.headline, 40), detail: s(x.detail, 120) };
}

export function mapCosts(x: any): CostsRow | null {
  if (!x?.jev) return null;
  return { jevToday: n(x.jev.today), jevWeek: n(x.jev.d7), jevMonth: n(x.jev.d30) };
}

export function mapGraphRun(x: any): GraphRunRow | null {
  if (typeof x?.id !== "string" || typeof x?.graph !== "string") return null;
  const status = x.done !== true ? "running" : x.ok === true ? "succeeded" : "failed";
  return {
    id: s(x.id, 80), graph: s(x.graph, 64), project: baseName(x.cwd), status, startedAt: isoMs(x.started), endedAt: isoMs(x.ended),
    error: typeof x.error === "string" ? s(x.error, 200) : null, calls: n(x.calls),
  };
}

export function mapLaunch(x: any): LaunchRow | null {
  if (typeof x?.key !== "string") return null;
  const status = x.exited === null || x.exited === undefined ? "running" : x.exited === 0 ? "succeeded" : "failed";
  const out = typeof x.output === "string" ? x.output : "";
  // The last report line ("▶ report → .../runs/<id>  (PASS)") without its path.
  const last = out.trim().split("\n").filter((l: string) => l.trim()).pop() ?? "";
  return { id: s(x.runId ?? x.key, 64), project: baseName(out.match(/repo=(\S+)/)?.[1]), status, startedAt: isoMs(x.started), summary: s(last.replace(/\/\S+/g, "…"), 160) };
}

export function mapHerdrAgent(x: any): HerdrAgentRow | null {
  const name = x?.name ?? x?.label ?? x?.id;
  if (typeof name !== "string") return null;
  return { name: s(name, 64), state: s(x.state ?? x.status, 24), project: baseName(x.cwd) };
}

const list = <T>(v: unknown, map: (x: any) => T | null, max: number): T[] =>
  (Array.isArray(v) ? v : []).map(map).filter((x): x is T => x !== null).slice(0, max);

export class Godhome {
  private cache = new Map<string, { at: number; json: any }>();

  constructor(private readonly opts: GodhomeOptions) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  /** GET one read route; cached for ttlMs; null when GodHome or its token is missing. */
  private async get(path: string): Promise<any | null> {
    const hit = this.cache.get(path);
    if (hit && this.now() - hit.at < (this.opts.ttlMs ?? 10_000)) return hit.json;
    const token = this.opts.token();
    if (!token) return null;
    try {
      const res = await (this.opts.fetch ?? fetch)(this.opts.url + path, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status !== 200) throw Error(`HTTP ${res.status}`);
      const json = await res.json();
      this.cache.set(path, { at: this.now(), json });
      return json;
    } catch (e: any) {
      console.warn(`[control-api] godhome ${path}: ${e?.message ?? e}`);
      return null;
    }
  }

  async system(): Promise<GodhomeSystem> {
    const [services, quota, costs] = await Promise.all([this.get("/fleet/services"), this.get("/quota"), this.get("/costs")]);
    return {
      reachable: services !== null || quota !== null || costs !== null,
      services: list(services?.services, mapService, 50),
      quota: list(quota?.providers, mapQuota, 30),
      costs: mapCosts(costs),
    };
  }

  async agents(): Promise<GodhomeAgents> {
    const [herdr, runs, launches] = await Promise.all([this.get("/herdr/agents"), this.get("/runs"), this.get("/factory/launches")]);
    const graphRuns = list(runs?.runs, mapGraphRun, 200)
      .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "")).slice(0, 20);
    const launchRows = list(launches?.launches, mapLaunch, 200)
      .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "")).slice(0, 20);
    return {
      reachable: herdr !== null || runs !== null || launches !== null,
      herdr: list(herdr?.agents, mapHerdrAgent, 50),
      graphRuns,
      launches: launchRows,
    };
  }
}
