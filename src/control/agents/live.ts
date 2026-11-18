import { scrub } from "../ops-map";
import type { GhIds } from "../gh/ids";
import type { OpsResult } from "../ops-godhome";

/** G3 status values, frozen here (T2.3): herdr's `agent_status`; anything else reads `unknown`. */
export const LIVE_STATUSES = ["working", "idle", "blocked", "done", "unknown"] as const;
export type LiveStatus = (typeof LIVE_STATUSES)[number];

export interface LiveAgent { id: string; label: string; project?: string; status: LiveStatus; lastAt: string }

export const AGENT_KIND = "agent";
const MAX_LABEL = 80;
const MAX_PROJECT = 60;

const text = (v: unknown, max: number): string => (typeof v === "string" ? scrub(v).slice(0, max) : "");

/**
 * GodHome `/herdr/agents` as the phone sees it. Only the name, the workspace label, the status and the poll time are read; `cwd`, `title`,
 * pane, tab and workspace ids are never copied. The id is opaque (`g_...` from the herdr agent name), so the prompt route can resolve
 * it again at confirm time. `lastAt` is the poll time: herdr gives no per-agent time (research V4).
 */
export function mapLiveAgents(body: unknown, ids: GhIds, now: number): LiveAgent[] {
  const agents = (body as { agents?: unknown } | null)?.agents;
  if (!Array.isArray(agents)) return [];
  const polled = typeof (body as any).fetchedAt === "string" && !Number.isNaN(Date.parse((body as any).fetchedAt)) ? new Date((body as any).fetchedAt).toISOString() : new Date(now).toISOString();
  const out: LiveAgent[] = [];
  for (const a of agents) {
    if (typeof a !== "object" || a === null || typeof (a as any).name !== "string" || (a as any).name === "") continue;
    const row = a as Record<string, unknown>;
    const status = (LIVE_STATUSES as readonly unknown[]).includes(row.status) ? (row.status as LiveStatus) : "unknown";
    const project = text(row.workspaceLabel, MAX_PROJECT);
    out.push({
      id: ids.opaque(AGENT_KIND, row.name as string, now),
      label: text(row.name, MAX_LABEL),
      ...(project ? { project } : {}),
      status,
      lastAt: polled,
    });
  }
  return out;
}

/** G3 reply from a GodHome read: an outage or a body without `agents` is `reachable:false`, never an error. */
export function liveReply(got: OpsResult | null, ids: GhIds, now: number): { agents: LiveAgent[]; reachable: boolean } {
  const valid = got !== null && got.data !== null && typeof got.data === "object" && Array.isArray((got.data as any).agents);
  if (!got || !valid) return { agents: [], reachable: false };
  return { agents: mapLiveAgents(got.data, ids, now), reachable: got.reachable };
}
