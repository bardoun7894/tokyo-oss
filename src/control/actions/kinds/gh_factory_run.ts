import { promptAudit } from "../../agents/start";
import { confirmOutcome, rows, runLimit } from "../../gh/common";
import type { ActionKind } from "../confirm";
import type { GhRunKindDeps } from "./gh_graph_run";

const RUN_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

export interface FactoryRunPayload { ticket: string; repo: string; stages?: string; adw?: string }

/** What the audit row of a factory run keeps: the repo, the options, and the ticket's length, hash and redacted preview (never the text). */
export function factoryAudit(p: FactoryRunPayload): string {
  return JSON.stringify({ repo: p.repo, ...(p.stages ? { stages: p.stages } : {}), ...(p.adw ? { adw: p.adw } : {}), ...promptAudit(p.ticket) });
}

/** True when `repo` is one of the repos GodHome's factory lists now (a fresh read when `fresh`). */
export async function repoExists(d: Pick<GhRunKindDeps, "client">, repo: string, fresh: boolean): Promise<"yes" | "no" | "down"> {
  const got = await d.client.read("factory", {}, { fresh }).catch(() => null);
  if (!got || !got.reachable || got.data === null) return "down";
  return rows((got.data as { repos?: unknown }).repos).some((r) => r.name === repo) ? "yes" : "no";
}

/**
 * K30 confirm: starts one SSSF factory run (`POST /factory/run`). It spends tokens and writes to a repo, so it is a fingerprint action
 * with `ops:run`, counted with the other run kinds. The body GodHome gets is rebuilt from the allowlist with `merge:false` (client.ts);
 * the request's own `merge` never reaches the payload. The repo is looked up again, uncached, at confirm time.
 */
export function ghFactoryRunKind(d: GhRunKindDeps): ActionKind {
  return {
    name: "gh_factory_run",
    cap: "ops:run",
    confirmAction: "gh.K30.confirm",
    feed: d.feed,
    check: async (ctx) => {
      const limited = runLimit(d.ops, ctx.device.id, ctx.now());
      if (limited) return limited;
      const p = ctx.payload as FactoryRunPayload | null;
      if (!p) return { status: 409, code: "conflict", message: "This action can no longer be confirmed" };
      const has = await repoExists(d, p.repo, true);
      if (has === "down") return { status: 503, code: "unavailable", message: "GodHome is not reachable" };
      if (has === "no") return { status: 404, code: "not_found", message: "That repo is gone" };
      return null;
    },
    run: async (ctx) => {
      const p = ctx.payload as FactoryRunPayload;
      const body: Record<string, unknown> = { ticket: p.ticket, repo: p.repo, ...(p.stages ? { stages: p.stages } : {}), ...(p.adw ? { adw: p.adw } : {}) };
      const w = await d.client.write("factoryRun", { body }).catch((): { status: "unreachable" } => ({ status: "unreachable" }));
      return confirmOutcome(w, {
        params: factoryAudit(p), feed: `Started a factory run in ${p.repo} from device ${ctx.device.name}`,
        gone: (j) => j?.ok === false,
        extra: (j) => (typeof j?.runId === "string" && RUN_ID.test(j.runId) ? { runId: j.runId } : {}),
      });
    },
  };
}
