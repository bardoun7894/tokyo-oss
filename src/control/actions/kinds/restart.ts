import type { OpsStore } from "../../ops-store";
import { GLOBAL_RESTARTS, GLOBAL_WINDOW_MS, restartArgv, runRestart, type AllowEntry, type Exec } from "../../ops-restart";
import type { ActionKind } from "../confirm";

export interface RestartKindDeps {
  /** The validated allowlist, read per call. */
  allowlist(): readonly AllowEntry[];
  exec: Exec;
  sleep: (ms: number) => Promise<void>;
  feed?: { add(e: { source: string; text: string; kind?: "info" }): unknown };
}

/**
 * The 003 restart behind the kind interface (spec 012 T2.1). The token's `targetId` is an allowlist id. The checks and the run are
 * the ones X16 had: allowlist re-check, 3 restarts per 10 minutes overall, the per-target cooldown, then the fixed argv, the state read-back.
 */
export function restartKind(store: OpsStore, d: RestartKindDeps): ActionKind {
  const entryOf = (targetId: string): AllowEntry | undefined => d.allowlist().find((e) => e.id === targetId);
  return {
    name: "restart",
    cap: "ops:service",
    confirmAction: "restart.confirm",
    feed: d.feed,
    check: ({ token, now }) => {
      const entry = entryOf(token.targetId);
      try {
        if (!entry) throw new Error("not listed");
        restartArgv({ kind: entry.kind, name: entry.name });
      } catch {
        return { status: 404, code: "not_found", message: "This target can no longer be restarted from the app" };
      }
      const uses = store.restartUses(now() - GLOBAL_WINDOW_MS);
      if (uses.length >= GLOBAL_RESTARTS) {
        return { status: 429, code: "rate_limited", message: "Too many restarts; try again later", retryAfterSec: Math.max(1, Math.ceil((uses[0]! + GLOBAL_WINDOW_MS - now()) / 1000)) };
      }
      const last = store.lastRestartAt(entry!.id);
      if (last !== null && now() - last < entry!.cooldownSec * 1000) {
        return { status: 429, code: "rate_limited", message: "This target was restarted a moment ago", retryAfterSec: Math.max(1, Math.ceil((last + entry!.cooldownSec * 1000 - now()) / 1000)) };
      }
      return null;
    },
    run: async ({ token, device, now }) => {
      const entry = entryOf(token.targetId)!;
      let out: { ok: boolean; state: "active" | "inactive" | "failed" | "unknown" };
      try {
        out = await runRestart({ kind: entry.kind, name: entry.name }, { exec: d.exec, sleep: d.sleep });
      } catch (e: any) {
        console.warn(`[control-api] ops restart exec: ${String(e?.name ?? "Error").slice(0, 40)}`);
        out = { ok: false, state: "failed" };
      }
      return {
        ok: out.ok, result: out.ok ? "ok" : "failed", detail: out.state,
        body: { fetchedAt: new Date(now()).toISOString(), reachable: true, ok: out.ok, state: out.state, label: entry.label },
        feed: `Restarted ${entry.kind} ${entry.name} from device ${device.name}, ${out.ok ? "ok" : "failed"}`,
      };
    },
  };
}
