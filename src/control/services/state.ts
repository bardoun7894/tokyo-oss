import type { AllowEntry, Exec, ExecResult, RestartKind } from "../ops-restart";

export type ServiceState = "active" | "inactive" | "failed" | "unknown";
export const SERVICE_STATES: readonly ServiceState[] = ["active", "inactive", "failed", "unknown"];
export const STATE_TTL_MS = 15_000;
const READ_TIMEOUT_MS = 10_000;

// --- parsers: the same mapping as 003's post-restart read (ops-restart.ts parseState), over a whole listing ---

/** `docker ps -a --format '{{.Names}}\t{{.State}}'`: one container per line. */
export function parseDocker(stdout: string): Map<string, ServiceState> {
  const out = new Map<string, ServiceState>();
  for (const line of stdout.split("\n")) {
    const [name, word] = line.split("\t");
    if (!name || word === undefined) continue;
    const w = word.trim();
    out.set(name, w === "running" ? "active" : w === "exited" || w === "created" || w === "paused" ? "inactive" : w === "dead" ? "failed" : "unknown");
  }
  return out;
}

/** `pm2 jlist` may print notices before the JSON. Only `name` and `pm2_env.status` are read; the environment in the same output goes nowhere. */
export function parsePm2(stdout: string): Map<string, ServiceState> {
  const out = new Map<string, ServiceState>();
  for (const m of stdout.matchAll(/(^|\n)\[/g)) {
    let list: unknown;
    try { list = JSON.parse(stdout.slice(m.index! + m[1]!.length)); } catch { continue; }
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      if (typeof p?.name !== "string") continue;
      const s = p.pm2_env?.status;
      out.set(p.name, s === "online" ? "active" : s === "stopped" || s === "stopping" ? "inactive" : s === "errored" ? "failed" : "unknown");
    }
    break;
  }
  return out;
}

/** `systemctl show -p Id,ActiveState <units>`: one block of `Key=value` lines per unit, separated by a blank line. */
export function parseSystemd(stdout: string): Map<string, ServiceState> {
  const out = new Map<string, ServiceState>();
  for (const block of stdout.split(/\n\s*\n/)) {
    const props = new Map<string, string>();
    for (const line of block.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) props.set(line.slice(0, i), line.slice(i + 1).trim());
    }
    const id = props.get("Id");
    const a = props.get("ActiveState");
    if (!id || a === undefined) continue;
    out.set(id, a === "active" ? "active" : a === "inactive" ? "inactive" : a === "failed" ? "failed" : "unknown");
  }
  return out;
}

const KINDS: RestartKind[] = ["docker", "pm2", "systemd"];

function argvOf(kind: RestartKind, entries: readonly AllowEntry[]): string[] {
  if (kind === "docker") return ["docker", "ps", "-a", "--format", "{{.Names}}\t{{.State}}"];
  if (kind === "pm2") return ["pm2", "jlist"];
  // Names were validated by the loader (plain, no leading dash), so each is one argv element and never an option.
  return ["systemctl", "show", "--no-pager", "-p", "Id,ActiveState", ...entries.map((e) => e.name)];
}

export interface StateSnapshot { at: number; states: Map<string, ServiceState> }

/**
 * S1's live state: one batched read per kind (never one per service), through an injected exec with a fixed argv, cached for 15 s and
 * shared by concurrent callers. A read that fails marks that kind `unknown` and nothing else; stderr and the pm2 environment are never logged.
 */
export class ServiceStates {
  private cache: { sig: string; snap: StateSnapshot } | null = null;
  private inflight: { sig: string; p: Promise<StateSnapshot> } | null = null;

  constructor(private readonly exec: Exec, private readonly now: () => number = Date.now) {}

  read(entries: readonly AllowEntry[]): Promise<StateSnapshot> {
    const sig = entries.map((e) => `${e.id}|${e.kind}|${e.name}`).join("\n");
    if (this.cache && this.cache.sig === sig && this.now() - this.cache.snap.at < STATE_TTL_MS) return Promise.resolve(this.cache.snap);
    if (this.inflight && this.inflight.sig === sig) return this.inflight.p;
    const p = this.fetch(entries).then((snap) => { this.cache = { sig, snap }; return snap; }).finally(() => { if (this.inflight?.p === p) this.inflight = null; });
    this.inflight = { sig, p };
    return p;
  }

  private async fetch(entries: readonly AllowEntry[]): Promise<StateSnapshot> {
    const at = this.now();
    const states = new Map<string, ServiceState>();
    await Promise.all(KINDS.map(async (kind) => {
      const mine = entries.filter((e) => e.kind === kind);
      if (mine.length === 0) return;
      let answer: Map<string, ServiceState> | null = null;
      try {
        const [file, ...args] = argvOf(kind, mine);
        const r: ExecResult = await this.exec(file!, args, { timeoutMs: READ_TIMEOUT_MS });
        // systemctl show exits 0; docker and pm2 exit 0 on success. A timeout or any other exit is a failed read.
        if (r.code === 0 && !r.timedOut) answer = kind === "docker" ? parseDocker(r.stdout) : kind === "pm2" ? parsePm2(r.stdout) : parseSystemd(r.stdout);
        else console.warn(`[control-api] services state ${kind}: ${r.timedOut ? "timeout" : `exit ${r.code}`}`);
      } catch (e: any) {
        console.warn(`[control-api] services state ${kind}: ${String(e?.name ?? "Error").slice(0, 40)}`);
      }
      for (const en of mine) states.set(en.id, answer?.get(en.name) ?? "unknown");
    }));
    return { at, states };
  }
}
