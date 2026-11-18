import type { AllowEntry, RestartKind } from "../ops-restart";
import type { ServiceState } from "./state";

export interface ServiceRow {
  id: string;
  kind: RestartKind;
  label: string;
  state: ServiceState;
  cooldownLeftS: number;
  actions?: ["restart"];
}

/** Seconds until the per-target cooldown of 003 ends, rounded up; 0 when the target was never restarted or the cooldown is over. */
export function cooldownLeft(lastRestartAt: number | null, cooldownSec: number, now: number): number {
  if (lastRestartAt === null) return 0;
  return Math.max(0, Math.ceil((lastRestartAt + cooldownSec * 1000 - now) / 1000));
}

export interface BuildOptions {
  now: number;
  cooldownLeftS(entry: AllowEntry): number;
  /** The calling device holds `ops:service`. */
  canRestart: boolean;
  kind?: RestartKind;
  state?: ServiceState;
}

/**
 * S1 rows: every loaded allowlist entry, in file order, as the phone sees it. The service name, the unit and the container name stay
 * on the host; the id is the allowlist id the restart route takes. An entry the host did not answer for reads `unknown`.
 */
export function buildServices(entries: readonly AllowEntry[], states: ReadonlyMap<string, ServiceState>, o: BuildOptions): ServiceRow[] {
  const rows: ServiceRow[] = [];
  for (const en of entries) {
    const state = states.get(en.id) ?? "unknown";
    if ((o.kind && en.kind !== o.kind) || (o.state && state !== o.state)) continue;
    rows.push({
      id: en.id, kind: en.kind, label: en.label, state, cooldownLeftS: o.cooldownLeftS(en),
      ...(o.canRestart ? { actions: ["restart"] as ["restart"] } : {}),
    });
  }
  return rows;
}
