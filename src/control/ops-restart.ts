import { execFile } from "child_process";
import fs from "fs";

/**
 * The service restart allowlist (spec 010 section 7). The file is the owner's: Tokyo only reads it, and only when it is
 * `root:root 0600`. Nothing here executes anything.
 */

export const RESTART_KINDS = ["systemd", "docker", "pm2"] as const;
export type RestartKind = (typeof RESTART_KINDS)[number];

export interface AllowEntry { id: string; kind: RestartKind; name: string; label: string; cooldownSec: number }

export const ALLOWLIST_PATH = "/etc/tokyo/ops-restart.json";
export const DEFAULT_COOLDOWN_SEC = 300;
const MAX_COOLDOWN_SEC = 86_400;
const NAME = /^[A-Za-z0-9_.@-]{1,80}$/;
export const ENTRY_ID = /^[A-Za-z0-9_.-]{1,40}$/;
const MAX_LABEL = 80;
const MAX_FACT = 300;

export type EntryCheck = { ok: true; entry: AllowEntry } | { ok: false; error: string };

/** What a unit file says about itself; passed in the allowlist entry (`execStart`, `environment`) when the owner or the generator knows it. */
export interface SelfFacts { execStart?: string; environment?: string }

const PM2_HOME_OF_TOKYO = "PM2_HOME=/root/.pm2";

/**
 * Why a target is Tokyo itself, or null (spec 012 F8, exact since T3.2). Not a prefix: `tokyo-shop`, `tokyo-demo-shop`, `tokyo-supplier`
 * and `tokyo-jobs-web.service` are other services. Self is the pm2 app `tokyo` (whatever the case), a docker container or unit of that
 * name, the unit `pm2-root.service` (its `pm2 resurrect` restarts Tokyo's pm2 daemon), and a unit whose facts say it runs
 * `pm2 resurrect` with `PM2_HOME=/root/.pm2`.
 */
export function selfReason(kind: RestartKind, name: string, facts: SelfFacts = {}): string | null {
  const lc = name.toLowerCase();
  if (lc === "tokyo") return kind === "pm2" ? "Tokyo's own pm2 app" : "Tokyo itself";
  if (kind !== "pm2" && lc === "tokyo.service") return "Tokyo itself";
  if (kind === "systemd" && lc === "pm2-root.service") return "its pm2 resurrect restarts Tokyo's pm2 daemon (F8)";
  if (kind === "systemd" && /(^|\/)pm2\s+resurrect\b/.test(facts.execStart ?? "") && (facts.environment ?? "").split(/\s+/).includes(PM2_HOME_OF_TOKYO)) {
    return "runs pm2 resurrect for /root/.pm2";
  }
  return null;
}

export const isSelf = (kind: RestartKind, name: string, facts?: SelfFacts): boolean => selfReason(kind, name, facts) !== null;

/**
 * pm2 also takes selectors that are not one app: `all`, a numeric process id, or a namespace. Any of them can restart Tokyo (which
 * runs under pm2 as id 1 in namespace `default`) or every app, so for kind pm2 they are never a name. The namespace list is static.
 */
const PM2_NAMESPACES: ReadonlySet<string> = new Set(["default"]);
const isPm2Selector = (kind: RestartKind, name: string): boolean =>
  kind === "pm2" && (/^\d+$/.test(name) || name.toLowerCase() === "all" || PM2_NAMESPACES.has(name.toLowerCase()));

/** One entry of the file. `error` names the rule, never the value. */
export function validateEntry(raw: unknown): EntryCheck {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "entry is not an object" };
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== "string" || !ENTRY_ID.test(e.id)) return { ok: false, error: "id is not a plain identifier" };
  if (typeof e.kind !== "string" || !(RESTART_KINDS as readonly string[]).includes(e.kind)) return { ok: false, error: "kind is not systemd, docker or pm2" };
  const name = e.name;
  if (typeof name !== "string" || !NAME.test(name) || name.startsWith("-") || name.includes("..")) return { ok: false, error: "name is not a plain service name" };
  for (const fact of ["execStart", "environment"] as const) {
    if (e[fact] !== undefined && (typeof e[fact] !== "string" || (e[fact] as string).length > MAX_FACT)) return { ok: false, error: `${fact} is not a short string` };
  }
  if (isSelf(e.kind as RestartKind, name, { execStart: e.execStart as string | undefined, environment: e.environment as string | undefined }) || isPm2Selector(e.kind as RestartKind, name)) return { ok: false, error: "name is reserved" };
  if (e.label !== undefined && (typeof e.label !== "string" || e.label.length < 1 || e.label.length > MAX_LABEL)) return { ok: false, error: "label is not a short string" };
  const cooldown = e.cooldownSec === undefined ? DEFAULT_COOLDOWN_SEC : e.cooldownSec;
  if (typeof cooldown !== "number" || !Number.isInteger(cooldown) || cooldown < 0 || cooldown > MAX_COOLDOWN_SEC) return { ok: false, error: "cooldownSec is not an integer from 0 to 86400" };
  return { ok: true, entry: { id: e.id, kind: e.kind as RestartKind, name, label: (e.label as string | undefined) ?? name, cooldownSec: cooldown } };
}

/** What the loader needs from the file system; injected so a test controls mode, owner and mtime. */
export interface AllowFs {
  stat(path: string): { mode: number; uid: number; mtimeMs: number } | null;
  read(path: string): string;
}

export const realFs: AllowFs = {
  stat: (p) => {
    try {
      const s = fs.statSync(p);
      return { mode: s.mode, uid: s.uid, mtimeMs: s.mtimeMs };
    } catch {
      return null;
    }
  },
  read: (p) => fs.readFileSync(p, "utf8"),
};

type Warn = (message: string) => void;
const defaultWarn: Warn = (m) => console.warn(`[control-api] ops restart allowlist: ${m}`);

/**
 * Reads the allowlist. A missing file is an empty list (no restart is possible). A file that is not mode 0600 or not owned by
 * root, or that is not a JSON array, loads nothing and warns once. A rejected entry or a duplicate id is dropped with a
 * warning that names its position and the rule, never its content.
 */
export function loadAllowlist(path: string, fsLike: AllowFs = realFs, warn: Warn = defaultWarn): AllowEntry[] {
  const st = fsLike.stat(path);
  if (!st) return [];
  if ((st.mode & 0o777) !== 0o600) { warn(`${path} is not mode 0600, nothing loaded`); return []; }
  if (st.uid !== 0) { warn(`${path} is not owned by root, nothing loaded`); return []; }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fsLike.read(path));
  } catch {
    warn(`${path} is not valid JSON, nothing loaded`);
    return [];
  }
  if (!Array.isArray(parsed)) { warn(`${path} is not a JSON array, nothing loaded`); return []; }
  const out: AllowEntry[] = [];
  const ids = new Set<string>();
  parsed.forEach((raw, i) => {
    const v = validateEntry(raw);
    if (!v.ok) return warn(`entry ${i} rejected: ${v.error}`);
    if (ids.has(v.entry.id)) return warn(`entry ${i} rejected: duplicate id`);
    ids.add(v.entry.id);
    out.push(v.entry);
  });
  return out;
}

/** The allowlist, reread only when the file's mtime, mode or owner changes (it is stat-ed on every call, so a removal or a chmod shows at once). */
export class AllowlistCache {
  private sig: string | null = null;
  private list: AllowEntry[] = [];

  constructor(private readonly path: string = ALLOWLIST_PATH, private readonly fsLike: AllowFs = realFs, private readonly warn: Warn = defaultWarn) {}

  get(): AllowEntry[] {
    const st = this.fsLike.stat(this.path);
    if (!st) { this.sig = null; return (this.list = []); }
    const sig = `${st.mtimeMs}:${st.mode}:${st.uid}`;
    if (sig === this.sig) return this.list;
    this.sig = sig;
    return (this.list = loadAllowlist(this.path, this.fsLike, this.warn));
  }
}

// --- target resolution (T4.2) ---

/** The host id GodHome events use for this server (world.ts HOSTS). An incident from another host is never restartable here. */
export const SERVER_HOST = "app-server";

export interface RestartTarget { kind: RestartKind; name: string }

const CHECK_KIND: Record<string, RestartKind> = { docker: "docker", unit: "systemd", pm2: "pm2" };
const TITLE_TARGET: Record<string, RegExp> = { docker: /^docker: (\S+) /, unit: /^unit: (\S+\.service) /, pm2: /^pm2: (\S+) restarts=/ };

/** A name fit to hand to systemctl, docker or pm2 as one argv element. */
const plainName = (name: string, check: string): boolean =>
  NAME.test(name) && !name.startsWith("-") && !name.includes("..") && (check !== "unit" || name.endsWith(".service"));

/**
 * What a check incident is about, from the raw GodHome item (before any mapping drops `target` and `host`). Only `docker`, `unit`
 * and `pm2` checks of project `server` qualify, and an incident that names another host does not. H1's `target` wins; an incident
 * written before H1, or one whose `target` is not a plain name, falls back to the fixed title parse. `tokyo` is never a target.
 */
export function targetOf(item: Record<string, any>): RestartTarget | null {
  if (item.kind !== "check" || item.project !== "server") return null;
  if (item.host !== undefined && item.host !== SERVER_HOST) return null;
  const title = typeof item.title === "string" ? item.title : "";
  const check = typeof item.check === "string" ? item.check : title.split(":")[0]!;
  const kind = CHECK_KIND[check];
  if (!kind) return null;
  const fromTitle = TITLE_TARGET[check]!.exec(title)?.[1];
  const explicit = typeof item.target === "string" ? item.target : undefined;
  if ([explicit, fromTitle].some((n) => n !== undefined && (isSelf(kind, n) || isPm2Selector(kind, n)))) return null;
  const name = [explicit, fromTitle].find((n): n is string => n !== undefined && plainName(n, check));
  return name ? { kind, name } : null;
}

/** The allowlist entry for an incident: an exact match on kind and name (a docker container never matches a pm2 entry of the same name). */
export function resolveRestart(item: Record<string, any>, entries: readonly AllowEntry[]): AllowEntry | null {
  const t = targetOf(item);
  return t ? entries.find((e) => e.kind === t.kind && e.name === t.name) ?? null : null;
}

// --- exec (T4.3) ---

export interface ExecResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }
/** Runs one program with an argv array. Never a shell. */
export type Exec = (file: string, args: readonly string[], opts: { timeoutMs: number }) => Promise<ExecResult>;

/** `execFile`: no shell, the child is killed at the timeout. A missing program or a signal reads as a non-zero exit (`code: null`). */
export const realExec: Exec = (file, args, { timeoutMs }) =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1 << 20, shell: false }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      resolve({ code: e ? (typeof e.code === "number" ? e.code : null) : 0, stdout: String(stdout), stderr: String(stderr), timedOut: e?.killed === true });
    });
  });

export const RESTART_TIMEOUT_MS = 20_000;
export const SETTLE_MS = 10_000;
const SETTLE_STEP_MS = 1_000;
export const GLOBAL_RESTARTS = 3;
export const GLOBAL_WINDOW_MS = 10 * 60 * 1000;
export const TOKEN_TTL_MS = 120_000;

export type RestartState = "active" | "inactive" | "failed" | "unknown";

/** The fixed argv of a restart. Refuses a name that is not plain, is `tokyo`, or is a pm2 selector again here, so no caller can reach exec with one. */
export function restartArgv(t: RestartTarget): string[] {
  if (!NAME.test(t.name) || t.name.startsWith("-") || t.name.includes("..") || isSelf(t.kind, t.name) || isPm2Selector(t.kind, t.name)) throw new Error("unsafe restart target");
  return t.kind === "systemd" ? ["systemctl", "restart", t.name] : t.kind === "docker" ? ["docker", "restart", t.name] : ["pm2", "restart", t.name];
}

export function stateArgv(t: RestartTarget): string[] {
  restartArgv(t);
  return t.kind === "systemd" ? ["systemctl", "is-active", t.name] : t.kind === "docker" ? ["docker", "inspect", "-f", "{{.State.Status}}", t.name] : ["pm2", "jlist"];
}

/** `pm2 jlist` may print notices before the JSON; the array is the first line-initial `[` that parses. */
function pm2List(stdout: string): any[] | null {
  for (const m of stdout.matchAll(/(^|\n)\[/g)) {
    try {
      const v = JSON.parse(stdout.slice(m.index! + m[1]!.length));
      if (Array.isArray(v)) return v;
    } catch { /* not this one */ }
  }
  return null;
}

export function parseState(t: RestartTarget, r: ExecResult): RestartState {
  const word = r.stdout.trim();
  if (t.kind === "systemd") return word === "active" ? "active" : word === "inactive" ? "inactive" : word === "failed" ? "failed" : "unknown";
  if (t.kind === "docker") {
    if (word === "running") return "active";
    if (word === "exited" || word === "created" || word === "paused") return "inactive";
    return word === "dead" ? "failed" : "unknown";
  }
  const proc = pm2List(r.stdout)?.find((p) => p?.name === t.name);
  const s = proc?.pm2_env?.status;
  return s === "online" ? "active" : s === "stopped" || s === "stopping" ? "inactive" : s === "errored" ? "failed" : "unknown";
}

/**
 * Restarts one target and reads its state back, polling up to 10 s while it is still settling. A timeout is `failed` with no
 * read; a non-zero exit is not ok but still reports the state. ok means the command succeeded and the target is not failed.
 */
export async function runRestart(t: RestartTarget, deps: { exec: Exec; sleep: (ms: number) => Promise<void> }): Promise<{ ok: boolean; state: RestartState }> {
  const [file, ...args] = restartArgv(t);
  const r = await deps.exec(file!, args, { timeoutMs: RESTART_TIMEOUT_MS });
  if (r.timedOut) return { ok: false, state: "failed" };
  const [sFile, ...sArgs] = stateArgv(t);
  const read = async (): Promise<RestartState> => parseState(t, await deps.exec(sFile!, sArgs, { timeoutMs: RESTART_TIMEOUT_MS }));
  let state = await read();
  for (let waited = 0; state === "unknown" && waited < SETTLE_MS; waited += SETTLE_STEP_MS) {
    await deps.sleep(SETTLE_STEP_MS);
    state = await read();
  }
  return { ok: r.code === 0 && state !== "failed", state };
}
