import { redact } from "./redact";
import { pageOf } from "./paging";

/**
 * Pure mappers from GodHome's replies to the ops contract (spec 010, plan section 5). Every mapper reads
 * named fields only and clamps lengths, so a field GodHome adds later (cwd, input, output, env, actor,
 * cost, url) cannot reach the phone. Text that may carry host detail goes through `scrub`.
 */

// A run of two or more absolute path segments that does not continue a word, URL or relative path.
export const ABS_PATH = /(?<![\w:/.~-])(?:\/[^\s/'"`()<>[\]{},;]+){2,}\/?/g;

/** `redact()`, then every absolute path of two or more segments becomes `...`. */
export function scrub(text: string): string {
  return redact(text).replace(ABS_PATH, "...");
}

export const MAX_TITLE = 160;
export const MAX_LABEL = 80;
export const MAX_PROJECT = 64;
const MAX_SERIES = 60;
const MAX_CHECKS = 50;
const MAX_LIST = 20;

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
/** A finite number, else null. Null stays null: a missing success rate is never 0. */
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** A finite number, else 0, for counters. */
const cnt = (v: unknown): number => num(v) ?? 0;
const text = (v: unknown, max: number): string => (typeof v === "string" ? scrub(v).slice(0, max) : "");
const iso = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const series = (v: unknown): (number | null)[] => arr(v).slice(0, MAX_SERIES).map(num);

export interface OverviewBody {
  window: { id: string; from: string | null; to: string | null };
  freshness: { generatedAt: string | null; stale: boolean; staleReason?: string };
  health: { score: number | null; checks: { id: string; label: string; kind: string; ok: boolean }[] };
  kpi: { active: number; stale: number; done: number; failed: number; successRate: number | null; projects: number; avgDurS: number | null };
  series: { success: (number | null)[]; failed: (number | null)[]; started: (number | null)[]; durS: (number | null)[] };
  previous: { finished: number; successRate: number | null; failed: number; started: number; covered: boolean };
  incidents: {
    counts: { open: number; critical: number; warning: number; notice: number; resolved: number; acked: number; muted: number };
    mttrMs: number | null;
  };
  needsYou: { title: string; project: string; since: string | null }[];
  recent: { at: string | null; kind: string; status: string; project: string; title: string; source: string }[];
}

/**
 * GodHome `ops/summary` to the X1 body (without `fetchedAt` and `reachable`, which the route adds).
 * Without `overlay`, `acked` and `muted` are 0 and nothing is hidden. With it (the route passes it), `counts` are
 * the overlay-adjusted ones of X5 and `hideNeeds` drops needs-you rows for incidents the overlay hides.
 */
export function mapOverview(
  summary: unknown,
  windowId: string,
  overlay?: { counts: OverviewBody["incidents"]["counts"]; hideNeeds: (n: Record<string, any>) => boolean },
): OverviewBody {
  if (!isObj(summary)) throw new TypeError("summary is not an object");
  const w = isObj(summary.window) ? summary.window : {};
  const f = isObj(summary.freshness) ? summary.freshness : {};
  const h = isObj(summary.health) ? summary.health : {};
  const a = isObj(summary.agents) ? summary.agents : {};
  const s = isObj(summary.series) ? summary.series : {};
  const p = isObj(summary.previous) ? summary.previous : {};
  const inc = isObj(summary.incidents) ? summary.incidents : {};
  const c = isObj(inc.counts) ? inc.counts : {};
  const m = isObj(inc.mttr) ? inc.mttr : {};

  const withDur = cnt(a.withDur);
  const durS = num(a.durS);
  const staleReason = text(f.staleReason, MAX_LABEL);

  return {
    window: { id: typeof w.id === "string" ? text(w.id, 8) : windowId, from: iso(w.from), to: iso(w.to) },
    freshness: {
      generatedAt: iso(f.generatedAt),
      stale: f.stale === true,
      ...(staleReason ? { staleReason } : {}),
    },
    health: {
      score: num(h.score),
      checks: arr(h.checks).filter(isObj).slice(0, MAX_CHECKS).map((x) => ({
        id: text(x.id, MAX_PROJECT), label: text(x.label, MAX_LABEL), kind: text(x.kind, 16), ok: x.ok === true,
      })),
    },
    kpi: {
      active: cnt(a.active), stale: cnt(a.stale), done: cnt(a.done), failed: cnt(a.failed),
      successRate: num(a.successRate), projects: cnt(a.projects),
      avgDurS: durS !== null && withDur > 0 ? Math.round(durS / withDur) : null,
    },
    series: { success: series(s.success), failed: series(s.failed), started: series(s.started), durS: series(s.durS) },
    previous: {
      finished: cnt(p.finished), successRate: num(p.successRate), failed: cnt(p.failed), started: cnt(p.started), covered: p.covered === true,
    },
    incidents: {
      counts: overlay?.counts ?? {
        open: cnt(c.open), critical: cnt(c.critical), warning: cnt(c.warning), notice: cnt(c.notice), resolved: cnt(c.resolved),
        acked: 0, muted: 0,
      },
      mttrMs: num(m.meanMs),
    },
    needsYou: arr(summary.needsYou).filter(isObj).filter((x) => !overlay?.hideNeeds(x)).slice(0, MAX_LIST).map((x) => ({
      title: text(x.title, MAX_TITLE), project: text(x.project, MAX_PROJECT), since: iso(x.since),
    })),
    recent: arr(summary.recent).filter(isObj).slice(0, MAX_LIST).map((x) => ({
      at: iso(x.at), kind: text(x.kind, 16), status: text(x.status, 16), project: text(x.project, MAX_PROJECT),
      title: text(x.title, MAX_TITLE), source: text(x.source, 24),
    })),
  };
}

// ---- X2: live map -----------------------------------------------------------------------------------------

const STATUS4 = new Set(["healthy", "degraded", "failing", "idle"]);
/** GodHome's Status4 as is; anything else reads as idle rather than reaching the phone as a new word. */
const status4 = (v: unknown): "healthy" | "degraded" | "failing" | "idle" => (typeof v === "string" && STATUS4.has(v) ? (v as any) : "idle");
/** Epoch ms (how the engine stores times) to ISO, else null. */
const isoMs = (v: unknown): string | null => {
  const t = num(v);
  if (t === null) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const secs = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};
const MAX_AGENTS = 60;
const MAX_PROJECTS = 40;
const MAX_KEY = 120;
const MAX_WORKFLOWS = 50;
const MAX_PHASES = 100;

export interface AgentRow {
  key: string; label: string; source: string; status: "healthy" | "degraded" | "failing" | "idle"; active: boolean;
  runs: number; failed: number; avgDurS: number | null; lastAt: string | null;
}
export interface NetworkBody { groups: { project: string; runs: number; agents: AgentRow[] }[]; projects: { id: string; runs: number }[] }

/**
 * GodHome `network` (N19) to the X2 agents body. Each agent appears once, under the project of its busiest
 * edge (ties: lower project id); groups run busiest first (ties: project id). Agent status is GodHome's
 * Status4. There is no `actions` on a row (S8): the map is read-only.
 */
export function mapNetwork(summary: unknown, opts: { project?: string }): NetworkBody {
  if (!isObj(summary)) throw new TypeError("summary is not an object");
  const n = isObj(summary.network) ? summary.network : {};
  const proj = (v: unknown) => text(v, MAX_PROJECT);

  const lastAt = new Map<string, number>();
  for (const i of arr(isObj(summary.agents) ? summary.agents.items : []).filter(isObj)) {
    const t = typeof i.lastAt === "string" ? Date.parse(i.lastAt) : NaN;
    if (typeof i.key === "string" && Number.isFinite(t) && t > (lastAt.get(i.key) ?? -Infinity)) lastAt.set(i.key, t);
  }

  const busiest = new Map<string, { project: string; runs: number }>();
  for (const e of arr(n.edges).filter(isObj)) {
    if (typeof e.agent !== "string") continue;
    const cand = { project: proj(e.project), runs: cnt(e.runs) };
    const cur = busiest.get(e.agent);
    if (!cur || cand.runs > cur.runs || (cand.runs === cur.runs && cand.project < cur.project)) busiest.set(e.agent, cand);
  }

  const projects = arr(n.projects).filter(isObj).slice(0, MAX_PROJECTS).map((p) => ({ id: proj(p.id), runs: cnt(p.runs) }));
  const byProject = new Map<string, AgentRow[]>();
  for (const a of arr(n.agents).filter(isObj).slice(0, MAX_AGENTS)) {
    if (typeof a.key !== "string") continue;
    const at = lastAt.get(a.key);
    const row: AgentRow = {
      key: text(a.key, MAX_KEY), label: text(a.label, MAX_LABEL), source: text(a.source, 24), status: status4(a.status),
      active: a.active === true, runs: cnt(a.runs), failed: cnt(a.failed), avgDurS: secs(a.avgDurS),
      lastAt: at === undefined ? null : new Date(at).toISOString(),
    };
    const project = busiest.get(a.key)?.project ?? "other";
    byProject.set(project, [...(byProject.get(project) ?? []), row]);
  }

  const groups = [...byProject.entries()].map(([project, agents]) => ({
    project,
    runs: projects.find((p) => p.id === project)?.runs ?? agents.reduce((sum, a) => sum + a.runs, 0),
    agents: agents.sort((a, b) => b.runs - a.runs || (a.key < b.key ? -1 : 1)),
  }));
  groups.sort((a, b) => b.runs - a.runs || (a.project < b.project ? -1 : 1));
  return { groups: opts.project === undefined ? groups : groups.filter((g) => g.project === opts.project), projects };
}

export interface EngineBody {
  workflows: { graph: string; lastRunAt: string | null; ok: boolean }[];
  phases: { id: string; status: "healthy" | "degraded" | "failing" | "idle"; calls: number; loop: boolean }[];
}

/**
 * GodHome `runs` plus one `graphs/:name` to the X2 engine body. `workflows` is the newest run of every graph,
 * most recent first. `phases` follows the graph's node order; each status comes from the newest run of that
 * graph only: idle (not in it), failing (its last execution failed), degraded (an earlier execution failed,
 * the last did not), else healthy. `calls` counts the executions in that run; `loop` marks a node that an
 * edge from itself or a later node leads back to. No prompt, input, cwd or output is read.
 */
export function mapEngine(runsBody: unknown, graphBody: unknown, graph: string | undefined): EngineBody {
  if (!isObj(runsBody)) throw new TypeError("runs is not an object");
  const runs = arr(runsBody.runs).filter(isObj).sort((a, b) => (num(b.started) ?? 0) - (num(a.started) ?? 0));

  const newest = new Map<string, Record<string, any>>();
  for (const r of runs) if (typeof r.graph === "string" && !newest.has(r.graph)) newest.set(r.graph, r);
  const workflows = [...newest.entries()]
    .map(([name, r]) => ({ name, at: num(r.ended) ?? num(r.started), r }))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, MAX_WORKFLOWS)
    .map(({ name, at, r }) => ({ graph: text(name, MAX_PROJECT), lastRunAt: isoMs(at), ok: r.ok === true }));

  if (graph === undefined) return { workflows, phases: [] };
  if (!isObj(graphBody)) throw new TypeError("graph is not an object");
  const g = isObj(graphBody.graph) ? graphBody.graph : {};
  const ids: string[] = arr(g.nodes).filter(isObj).map((x) => x.id).filter((x): x is string => typeof x === "string").slice(0, MAX_PHASES);
  const edges = arr(g.edges).filter(isObj);
  const executions = arr(newest.get(graph)?.phases).filter(isObj);
  return {
    workflows,
    phases: ids.map((id, idx) => {
      const ran = executions.filter((p) => p.id === id);
      const status = ran.length === 0 ? "idle"
        : ran[ran.length - 1].state === "failed" ? "failing"
        : ran.some((p) => p.state === "failed") ? "degraded" : "healthy";
      const loop = edges.some((e) => e.to === id && typeof e.from === "string" && ids.indexOf(e.from) >= idx);
      return { id: text(id, MAX_PROJECT), status, calls: ran.length, loop };
    }),
  };
}

// ---- X3 and X4: traces ------------------------------------------------------------------------------------

const MAX_ERROR = 200;
const MAX_ID = 64;

export interface TraceRow {
  id: string; graph: string; ok: boolean; done: boolean; startedAt: string | null; endedAt: string | null; durMs: number; calls: number; phases: number;
}

function traceBase(run: Record<string, any>, nowMs: number) {
  const started = num(run.started);
  const ended = num(run.ended);
  return {
    id: text(run.id, MAX_ID), graph: text(run.graph, MAX_ID), ok: run.ok === true, done: run.done === true,
    startedAt: isoMs(started), endedAt: isoMs(ended),
    durMs: started === null ? 0 : Math.max(0, Math.round((ended ?? nowMs) - started)),
    // A graph that delegates reports its work in subCalls; without it the cost would read zero.
    calls: cnt(run.calls) + cnt(run.subCalls),
  };
}

/** One GodHome run (list shape) to an X3 row. Reads named fields: `input`, `cwd`, `parents` and the rest never pass. */
export function mapTrace(run: unknown, nowMs: number): TraceRow {
  if (!isObj(run)) throw new TypeError("run is not an object");
  return { ...traceBase(run, nowMs), phases: arr(run.phases).length };
}

/** GodHome `runs` to the X3 body: newest first, `before` is an exclusive bound on `started`, `lastRunAt` is the newest end of all runs. */
export function mapTraces(body: unknown, page: { limit: number; before?: number }, nowMs: number): { traces: TraceRow[]; next: string | null; lastRunAt: string | null } {
  if (!isObj(body)) throw new TypeError("runs is not an object");
  const runs = arr(body.runs).filter(isObj).sort((a, b) => (num(b.started) ?? 0) - (num(a.started) ?? 0));
  const ends = runs.map((r) => num(r.ended) ?? num(r.started)).filter((t): t is number => t !== null);
  const lastRunAt = ends.length ? isoMs(Math.max(...ends)) : null;
  const rows = runs.filter((r) => page.before === undefined || (num(r.started) ?? 0) < page.before);
  const { page: items, next } = pageOf(rows.slice(0, page.limit + 1), page.limit, (r) => num(r.started) ?? 0);
  return { traces: items.map((r) => mapTrace(r, nowMs)), next, lastRunAt };
}

export interface TraceDetail extends Omit<TraceRow, "phases"> {
  error?: string;
  phases: { id: string; kind: string; state: string; ok: boolean; ms: number | null; tokens?: number; outputBytes: number }[];
  handoffs: { from: string; to: string; chars: number; latencyMs: number | null; tokens?: number }[];
}

/**
 * GodHome `runs/:id` to the X4 body. Phase `output` becomes `outputBytes` and is dropped; `input`, `cwd`,
 * per-phase `error`, `model` and cost never pass; tokens are the phase total. A handoff is the edge a phase
 * took (`tookEdgeTo`); `chars` is the size of the output it handed over. GodHome records no handoff timing,
 * so `latencyMs` is null (GAP, see spec.md).
 */
export function mapTraceDetail(run: unknown, nowMs: number): TraceDetail {
  if (!isObj(run)) throw new TypeError("run is not an object");
  const error = typeof run.error === "string" ? text(run.error, MAX_ERROR) : "";
  const raw = arr(run.phases).filter(isObj).slice(0, MAX_PHASES);
  const phases = raw.map((p) => {
    const tokens = isObj(p.tokens) ? num(p.tokens.total) : null;
    return {
      id: text(p.id, MAX_PROJECT), kind: text(p.kind, 16), state: text(p.state, 16), ok: p.ok === true, ms: num(p.ms),
      ...(tokens !== null ? { tokens } : {}),
      outputBytes: typeof p.output === "string" ? p.output.length : cnt(p.outputBytes),
    };
  });
  const handoffs = raw.flatMap((p, i) =>
    typeof p.tookEdgeTo === "string"
      ? [{ from: phases[i].id, to: text(p.tookEdgeTo, MAX_PROJECT), chars: phases[i].outputBytes, latencyMs: null, ...("tokens" in phases[i] ? { tokens: phases[i].tokens } : {}) }]
      : [],
  );
  return { ...traceBase(run, nowMs), ...(error ? { error } : {}), phases, handoffs };
}
