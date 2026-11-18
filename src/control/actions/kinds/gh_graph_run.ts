import type { GhClient } from "../../gh/client";
import { confirmOutcome, runLimit } from "../../gh/common";
import type { OpsStore } from "../../ops-store";
import type { ActionKind } from "../confirm";

export interface GhRunKindDeps {
  ops: OpsStore;
  client: Pick<GhClient, "read" | "write">;
  feed?: { add(e: { source: string; text: string; kind?: "info" }): unknown };
}

const RUN_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * K20 confirm: starts one GodHome workflow graph (`POST /graphs/:name/run`, no input). A graph run is a real model call, so it is a
 * fingerprint action with `ops:run`, counted with the other two run kinds (3 per 10 minutes per device). The graph is looked up
 * again, uncached, when the token is confirmed; the name was fixed at prepare.
 */
export function ghGraphRunKind(d: GhRunKindDeps): ActionKind {
  return {
    name: "gh_graph_run",
    cap: "ops:run",
    confirmAction: "gh.K20.confirm",
    feed: d.feed,
    check: async (ctx) => {
      const limited = runLimit(d.ops, ctx.device.id, ctx.now());
      if (limited) return limited;
      const got = await d.client.read("graph", { name: ctx.token.targetId }, { fresh: true }).catch(() => null);
      if (!got || !got.reachable) return { status: 503, code: "unavailable", message: "GodHome is not reachable" };
      if (got.notFound || got.data === null) return { status: 404, code: "not_found", message: "That graph is gone" };
      return null;
    },
    run: async (ctx) => {
      const name = ctx.token.targetId;
      const w = await d.client.write("graphRun", { seg: [name] }).catch((): { status: "unreachable" } => ({ status: "unreachable" }));
      return confirmOutcome(w, {
        params: JSON.stringify({ graph: name }), feed: `Started graph ${name} from device ${ctx.device.name}`,
        gone: (j) => j?.ok === false,
        extra: (j) => (typeof j?.runId === "string" && RUN_ID.test(j.runId) ? { runId: j.runId } : {}),
      });
    },
  };
}
