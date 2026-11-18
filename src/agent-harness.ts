import type { ProjectLocation } from "./project-registry";

/**
 * Which agent runs a /agent task.
 *
 * zen  — one model call through tokyo-zen-cli. Reads, cannot touch files. Server only.
 * dsh  — DeepSeek Harness, a coding agent that edits files and runs commands.
 *        Server projects run /usr/local/bin/dsh-agent in the project directory;
 *        laptop projects run the Mac's copy over `ssh mac`.
 */
export const HARNESSES = ["zen", "dsh"] as const;
export type Harness = (typeof HARNESSES)[number];

export type AgentCommand =
  | { kind: "help" }
  | { kind: "stop"; id: number | null }
  | { kind: "run"; harness: Harness; project: string; prompt: string };

export interface AgentTarget {
  name: string;
  location: ProjectLocation;
  path: string;
}

export interface Invocation {
  command: string;
  args: string[];
  cwd?: string;
}

const DEFAULT_PROMPT = "Check the project for issues and fix them";
const SERVER_ZEN = "/usr/local/bin/tokyo-zen-cli";
const SERVER_DSH = "/usr/local/bin/dsh-agent";
const MAC_DSH = "/Users/owner/.local/bin/dsh-agent";

/** `/agent [zen|dsh] <project> <task>`, `/agent stop <id>`, or nothing. */
export function parseAgentCommand(input: string): AgentCommand {
  const parts = input.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { kind: "help" };

  if (parts[0].toLowerCase() === "stop") {
    const id = parseInt(parts[1] ?? "", 10);
    return { kind: "stop", id: Number.isFinite(id) && id > 0 ? id : null };
  }

  let harness: Harness = "zen";
  if ((HARNESSES as readonly string[]).includes(parts[0].toLowerCase())) {
    harness = parts.shift()!.toLowerCase() as Harness;
    if (parts.length === 0) return { kind: "help" };
  }

  return {
    kind: "run",
    harness,
    project: parts[0].toLowerCase(),
    prompt: parts.slice(1).join(" ") || DEFAULT_PROMPT,
  };
}

/** POSIX single-quoting: the result is one inert word in any sh-compatible shell. */
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * The process to spawn for a task. Server runs are argv with no shell in
 * between; laptop runs cross ssh, where the remote side is a shell string, so
 * every value in it is quoted.
 */
export function buildInvocation(target: AgentTarget, harness: Harness, prompt: string): Invocation {
  if (target.location === "server") {
    return harness === "dsh"
      ? { command: SERVER_DSH, args: ["headless", prompt], cwd: target.path }
      : { command: SERVER_ZEN, args: [prompt], cwd: target.path };
  }

  if (harness !== "dsh") {
    throw new Error(`${harness} runs only on the server, and ${target.name} is a laptop project — use dsh`);
  }
  const remote = `cd ${shellQuote(target.path)} && ${MAC_DSH} headless ${shellQuote(prompt)}`;
  return { command: "ssh", args: ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", "mac", remote] };
}
