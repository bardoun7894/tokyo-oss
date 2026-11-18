import { confirmOutcome, rows } from "../../gh/common";
import type { GhIds } from "../../gh/ids";
import type { ActionKind } from "../confirm";
import type { GhRunKindDeps } from "./gh_graph_run";

export const TERMINAL_KIND = "terminal";

/**
 * Sessions the app never kills: Tokyo's own runs (`tokyo-run-<id>` herdr workspaces, which the run waiter polls) and the
 * `tokyo` session itself. Matched on the base name, as the phone sees it.
 */
const PROTECTED_SESSION = /^(?:tokyo-run-.*|tokyo)$/;
export const isProtectedSession = (name: string): boolean => PROTECTED_SESSION.test(name.split("/").filter(Boolean).pop() ?? "");

/** The terminal session behind an opaque id, from a GodHome list: its real name (never sent to the phone), null when it is gone. */
export async function findSession(d: Pick<GhRunKindDeps, "client"> & { ids: GhIds }, opaqueId: string, fresh: boolean): Promise<{ name: string } | "down" | null> {
  const name = d.ids.resolve(TERMINAL_KIND, opaqueId);
  if (name === null) return null;
  const got = await d.client.read("tmuxSessions", {}, { fresh }).catch(() => null);
  if (!got || !got.reachable || got.data === null) return "down";
  return rows((got.data as { sessions?: unknown }).sessions).some((s) => s.name === name) ? { name } : null;
}

/**
 * K36 confirm: kills one terminal session through GodHome. It needs `ops:service` and the fingerprint. The session name is resolved
 * from the opaque id at confirm time against an uncached list, so what is killed is what exists now under that id.
 */
export function terminalKillKind(d: GhRunKindDeps & { ids: GhIds }): ActionKind {
  return {
    name: "terminal_kill",
    cap: "ops:service",
    confirmAction: "gh.K36.confirm",
    feed: d.feed,
    check: async (ctx) => {
      const found = await findSession(d, ctx.token.targetId, true);
      if (found === "down") return { status: 503, code: "unavailable", message: "GodHome is not reachable" };
      if (found === null) return { status: 404, code: "not_found", message: "That session is gone" };
      if (isProtectedSession(found.name)) return { status: 403, code: "forbidden", message: "Tokyo depends on that session; it cannot be killed from the app" };
      ctx.scratch.session = found;
      return null;
    },
    run: async (ctx) => {
      const { name } = ctx.scratch.session as { name: string };
      const w = await d.client.write("terminalKill", { seg: [name] }).catch((): { status: "unreachable" } => ({ status: "unreachable" }));
      return confirmOutcome(w, { params: JSON.stringify({ session: ctx.token.targetId }), feed: `Killed a terminal session from device ${ctx.device.name}`, gone: (j) => j?.ok === false });
    },
  };
}
