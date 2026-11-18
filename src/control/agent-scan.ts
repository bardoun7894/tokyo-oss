import { execFile } from "child_process";
import { baseName } from "./godhome";

/**
 * The coding agents running on the server and on the Mac (claude, pi, codex, opencode), found by a process
 * scan. Each row is a label set: harness, model, project folder name, how long it has run. The command line
 * is parsed here and never sent on: it carries prompts and system prompts.
 */
export type AgentHost = "server" | "mac";
export type Harness = "claude" | "pi" | "codex" | "opencode";

export interface AgentRow {
  id: string; host: AgentHost; pid: number; harness: Harness; model: string | null; project: string;
  kind: "interactive" | "headless" | "sdk" | "service"; startedAt: string; elapsedSec: number;
}

export interface ProcLine { pid: number; elapsedSec: number; args: string }

export type Exec = (cmd: string, args: string[], timeoutMs: number) => Promise<string>;

const MODEL = /^[A-Za-z0-9._\/:-]{1,64}$/;
const PROMPT_FLAGS = new Set(["--append-system-prompt", "--system-prompt", "--prompt"]);

/** `[[dd-]hh:]mm:ss` (ps etime) to seconds. */
export function parseEtime(v: string): number {
  const m = v.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

/** `pid etime args` lines from `ps axo pid=,etime=,args=`. */
export function parsePs(out: string): ProcLine[] {
  const rows: ProcLine[] = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
    if (m) rows.push({ pid: Number(m[1]), elapsedSec: parseEtime(m[2]), args: m[3] });
  }
  return rows;
}

const base = (p: string) => p.split("/").pop() ?? p;

/** Which agent a command line is, or null. The program name decides, never a word inside the arguments. */
export function detect(args: string): { harness: Harness; model: string | null; kind: AgentRow["kind"] } | null {
  const argv = args.split(/\s+/);
  let prog = argv[0] ?? "";
  let rest = argv.slice(1);
  if (base(prog) === "node" || base(prog) === "bun") { prog = argv[1] ?? ""; rest = argv.slice(2); }
  // A system prompt is free text (it may well contain "-p"); flags are read up to it.
  const promptAt = rest.findIndex((a) => PROMPT_FLAGS.has(a));
  if (promptAt >= 0) rest = rest.slice(0, promptAt);
  const b = base(prog);
  let harness: Harness | null = null;
  if (b === "claude" || /\/claude\/versions\/[0-9.]+$/.test(prog)) harness = "claude";
  else if (b === "pi") harness = "pi";
  else if (b === "codex") harness = "codex";
  else if (b === "opencode") harness = "opencode";
  if (!harness) return null;
  const mi = rest.findIndex((a) => a === "--model" || a === "-m");
  const model = mi >= 0 && MODEL.test(rest[mi + 1] ?? "") ? rest[mi + 1] : null;
  const kind: AgentRow["kind"] = prog.includes("claude_agent_sdk") ? "sdk"
    : rest[0] === "serve" || rest[0] === "app-server" ? "service"
    : rest.includes("-p") || rest.includes("--print") || rest.includes("--output-format") || rest[0] === "exec" ? "headless"
    : "interactive";
  return { harness, model, kind };
}

const defaultExec: Exec = (cmd, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
});

const MAC_SSH = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=4", "mac"];

export interface ScanOptions { exec?: Exec; now?: () => number; ttlMs?: number; mac?: boolean }

export class AgentScanner {
  private cache?: { at: number; value: { agents: AgentRow[]; hosts: Record<AgentHost, boolean> } };
  private loading?: Promise<{ agents: AgentRow[]; hosts: Record<AgentHost, boolean> }>;

  constructor(private readonly opts: ScanOptions = {}) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  private exec(): Exec {
    return this.opts.exec ?? defaultExec;
  }

  private rows(host: AgentHost, procs: ProcLine[], cwd: Map<number, string>): AgentRow[] {
    const now = this.now();
    const out: AgentRow[] = [];
    for (const p of procs) {
      const d = detect(p.args);
      if (!d) continue;
      out.push({
        id: `${host}-${p.pid}`, host, pid: p.pid, harness: d.harness, model: d.model,
        project: baseName((cwd.get(p.pid) ?? "").replace(/ \(deleted\)$/, "")),
        kind: d.kind, startedAt: new Date(now - p.elapsedSec * 1000).toISOString(), elapsedSec: p.elapsedSec,
      });
    }
    return out;
  }

  /** cwd of each pid: `lsof -Fpn` output (p<pid> then n<path>). */
  static parseLsof(out: string): Map<number, string> {
    const m = new Map<number, string>();
    let pid = 0;
    for (const l of out.split("\n")) {
      if (l.startsWith("p")) pid = Number(l.slice(1));
      else if (l.startsWith("n") && pid) m.set(pid, l.slice(1));
    }
    return m;
  }

  private async host(host: AgentHost): Promise<AgentRow[]> {
    const ex = this.exec();
    const ps = ["axo", "pid=,etime=,args="];
    const procs = parsePs(host === "server" ? await ex("ps", ps, 5000) : await ex("ssh", [...MAC_SSH, "ps", ...ps], 8000))
      .filter((p) => detect(p.args));
    if (!procs.length) return [];
    const pids = procs.map((p) => p.pid).join(",");
    const lsof = ["-a", "-d", "cwd", "-Fpn", "-p", pids];
    let cwd = new Map<number, string>();
    try {
      cwd = AgentScanner.parseLsof(host === "server" ? await ex("lsof", lsof, 5000) : await ex("ssh", [...MAC_SSH, "lsof", ...lsof], 8000));
    } catch { /* lsof exits 1 when one pid is gone; the project stays empty */ }
    return this.rows(host, procs, cwd);
  }

  /** Both hosts, cached; a host that does not answer is marked down and contributes no rows. */
  scan(): Promise<{ agents: AgentRow[]; hosts: Record<AgentHost, boolean> }> {
    if (this.cache && this.now() - this.cache.at < (this.opts.ttlMs ?? 20_000)) return Promise.resolve(this.cache.value);
    this.loading ??= (async () => {
      const hosts: AgentHost[] = this.opts.mac === false ? ["server"] : ["server", "mac"];
      const results = await Promise.allSettled(hosts.map((h) => this.host(h)));
      const value = {
        agents: results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).sort((a, b) => a.elapsedSec - b.elapsedSec),
        hosts: { server: results[0].status === "fulfilled", mac: hosts.length > 1 && results[1].status === "fulfilled" },
      };
      this.cache = { at: this.now(), value };
      return value;
    })().finally(() => { this.loading = undefined; });
    return this.loading;
  }
}
