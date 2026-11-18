// Which Claude model a dispatched run gets, decided by Jev from the task (dev-stack's
// `jev-launch claude --print`): Haiku for small work, Fable for coding, Opus 5.5 for
// architecture-scale work, with one more effort level for thinking tasks. Mapping and
// provider order live in ~/.config/jev-router/tiers.json, shared with the pi router.
//
// The task only ever reaches jev-launch on stdin or through a root-only file, never on
// a command line. `--no-fallback`: these runs have Claude logins only, so a Codex swap
// would fail. Any problem keeps the fixed fallback model, as before this existed.

export interface RunModel {
  model: string;
  effort?: string;
  tier?: string;
}

const MODEL_RE = /^claude-[a-z0-9.-]+$/;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export const pickArgv = (source: string[]) => ["jev-launch", "claude", "--print", "--no-fallback", ...source];

export function parseRunModel(stdout: string, fallback: string): RunModel {
  try {
    const d = JSON.parse(stdout.trim().split("\n").pop() ?? "");
    if (d?.harness === "claude" && typeof d.model === "string" && MODEL_RE.test(d.model)) {
      const out: RunModel = { model: d.model };
      if (EFFORTS.has(d.effort)) out.effort = d.effort;
      if (typeof d.tier === "string" && /^T[0-4]$/.test(d.tier)) out.tier = d.tier;
      return out;
    }
  } catch {
    /* fall through */
  }
  return { model: fallback };
}
