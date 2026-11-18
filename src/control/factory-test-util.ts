import type { FactoryExec } from "./factory";

export const ticket = (over: Record<string, unknown> = {}) => ({
  id: "007-login-form", title: "Login form", epic: "auth-v1", column: "failed", dependsOn: ["006-api"], adw: "quick_build",
  runId: "run-1", rounds: 2, mergeOutcome: null, validation: null, error: "tests red", updatedAt: "2026-10-16T12:00:00Z", ...over,
});
export const status = (over: Record<string, unknown> = {}) => ({
  generatedAt: "2026-10-16T12:00:00Z", target: "main", paused: false,
  counts: { backlog: 1, blocked: 2, inProgress: 3, done: 4, failed: 5 },
  tickets: [ticket()],
  merges: [{ at: "2026-10-16T11:00:00Z", ticket: "006-api", branch: "factory/006-api", outcome: "merged", commit: "abc1234" }],
  alerts: [{ at: "2026-10-16T11:30:00Z", level: "error", ticket: "007-login-form", message: "gate failed" }],
  ...over,
});

/** A fake Mac: records every call, answers with the next queued reply (or the default). */
export function fake(reply: (args: string[]) => { code: number; stdout: string } | Error) {
  const calls: string[][] = [];
  const exec: FactoryExec = async (args) => {
    calls.push(args);
    const r = reply(args);
    if (r instanceof Error) throw r;
    return r;
  };
  return { calls, exec };
}
export const NO_HOLDOUT = { epic: null, passed: null, failed: null, at: null };
export const NO_FIX = { attempts: 0, auto: false, runtime: null, state: "none", runId: null, startedAt: null, endedAt: null };
export const step = (over: Record<string, unknown> = {}) => ({
  name: "build-1", kind: "build", round: 1, state: "pass", startedAt: "2026-10-16T12:00:00Z", endedAt: "2026-10-16T12:01:00Z",
  ms: 60000, summary: "built", ...over,
});
export const fixOf = (over: Record<string, unknown> = {}) => ({
  attempts: 1, auto: true, runtime: "claude", state: "running", runId: "fix-1", startedAt: "2026-10-16T12:02:00Z", endedAt: null, ...over,
});
export const ok = (json: unknown) => ({ code: 0, stdout: JSON.stringify(json) + "\n" });
