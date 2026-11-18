import type { GhIds } from "../../gh/ids";
import { confirmOutcome, rows, runLimit } from "../../gh/common";
import type { ActionKind } from "../confirm";
import type { GhRunKindDeps } from "./gh_graph_run";

export const TRIGGER_KIND = "trigger";

const RUN_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/** The GodHome loop behind an opaque id, from a fresh list: its id and graph, or null when it is gone. */
export async function findTrigger(d: Pick<GhRunKindDeps, "client"> & { ids: GhIds }, opaqueId: string, fresh: boolean): Promise<{ id: string; graph: string } | "down" | null> {
  const source = d.ids.resolve(TRIGGER_KIND, opaqueId);
  if (source === null) return null;
  const got = await d.client.read("triggers", {}, { fresh }).catch(() => null);
  if (!got || !got.reachable || got.data === null) return "down";
  const hit = rows((got.data as { triggers?: unknown }).triggers).find((t) => t.id === source);
  return hit ? { id: source, graph: typeof hit.graph === "string" ? hit.graph : "loop" } : null;
}

/**
 * K22 confirm: fires one GodHome loop now (`POST /triggers/:id/fire`; GodHome still obeys the loop's own run and call brakes). The
 * loop is resolved from its opaque id against a fresh list at confirm time. `ops:run`, counted with the other run kinds.
 */
export function ghTriggerFireKind(d: GhRunKindDeps & { ids: GhIds }): ActionKind {
  return {
    name: "gh_trigger_fire",
    cap: "ops:run",
    confirmAction: "gh.K22.confirm",
    feed: d.feed,
    check: async (ctx) => {
      const limited = runLimit(d.ops, ctx.device.id, ctx.now());
      if (limited) return limited;
      const found = await findTrigger(d, ctx.token.targetId, true);
      if (found === "down") return { status: 503, code: "unavailable", message: "GodHome is not reachable" };
      if (found === null) return { status: 404, code: "not_found", message: "That loop is gone" };
      ctx.scratch.trigger = found;
      return null;
    },
    run: async (ctx) => {
      const t = ctx.scratch.trigger as { id: string; graph: string };
      const w = await d.client.write("triggerFire", { seg: [t.id] }).catch((): { status: "unreachable" } => ({ status: "unreachable" }));
      return confirmOutcome(w, {
        params: JSON.stringify({ loop: ctx.token.targetId }), feed: `Fired loop ${t.graph} from device ${ctx.device.name}`,
        gone: (j) => j?.ok === false,
        extra: (j) => (typeof j?.trigger?.lastRunId === "string" && RUN_ID.test(j.trigger.lastRunId) ? { runId: j.trigger.lastRunId } : {}),
      });
    },
  };
}
