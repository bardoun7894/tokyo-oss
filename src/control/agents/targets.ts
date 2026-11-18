import type { Exec } from "../ops-restart";

/** The two run variants claude-runner knows. */
export const VARIANTS = ["kb-dev", "tech-company"] as const;
export type Variant = (typeof VARIANTS)[number];

export interface TargetProject { name: string; location: "server" | "laptop" }

export interface TargetsDeps {
  /** Tokyo's project registry. */
  projects(): readonly TargetProject[];
  /** Customer and report-only projects get no run from the app (as write-spec). */
  isReportOnly(name: string): boolean;
  /** Whether the Mac answers; asked only when a Mac project is listed. */
  macOnline(): Promise<boolean>;
}

export interface Target { name: string; host: "server" | "mac"; macOnline?: boolean; variants: Variant[] }

/** The project the app may start a run in, or null (unknown, or report-only). */
export function resolveTarget(d: TargetsDeps, name: string): TargetProject | null {
  const p = d.projects().find((x) => x.name === name);
  return p && !d.isReportOnly(p.name) ? p : null;
}

/** G1: every startable project with its host; a Mac project says whether the Mac is up. A probe that throws reads as offline. */
export async function listTargets(d: TargetsDeps): Promise<Target[]> {
  const startable = d.projects().filter((p) => !d.isReportOnly(p.name));
  let mac: boolean | undefined;
  if (startable.some((p) => p.location === "laptop")) mac = await d.macOnline().catch(() => false);
  return startable.map((p) => p.location === "laptop"
    ? { name: p.name, host: "mac" as const, macOnline: mac === true, variants: [...VARIANTS] }
    : { name: p.name, host: "server" as const, variants: [...VARIANTS] });
}

const MAC_PROBE = ["ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", "mac", "echo", "ok"] as const;
const MAC_CACHE_MS = 30_000;

/** The same probe claude-runner uses (`ssh mac echo ok`), as a fixed argv through the injected exec and cached for 30 s. */
export function macReach(exec: Exec, now: () => number = Date.now): () => Promise<boolean> {
  let last: { at: number; up: boolean } | null = null;
  return async () => {
    if (last && now() - last.at < MAC_CACHE_MS) return last.up;
    const [file, ...args] = MAC_PROBE;
    let up = false;
    try {
      const r = await exec(file, args, { timeoutMs: 7_000 });
      up = r.code === 0 && !r.timedOut;
    } catch {
      up = false;
    }
    last = { at: now(), up };
    return up;
  };
}
