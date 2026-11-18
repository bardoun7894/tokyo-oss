/**
 * Builders for the GodHome shapes the ops tests feed the mappers: engine runs (`GET /runs`, `GET /runs/:id`),
 * graphs (`GET /graphs/:name`) and incidents. They carry the fields GodHome sends that the contract must not
 * forward (cwd, input, prompt, phase output), so a test can prove they do not leak. Test-only.
 */

export const T0 = Date.parse("2026-10-16T08:00:00Z");
export const MIN = 60_000;

export interface PhaseOpts {
  kind?: string; ok?: boolean; status?: string; ms?: number; output?: string; error?: string; to?: string;
  tokens?: number | null; outputBytes?: number;
}

/** A phase as the detail route sends it (with `output`). */
export function phaseRec(id: string, state: "running" | "done" | "failed", o: PhaseOpts = {}) {
  return {
    id, kind: o.kind ?? "agent", state,
    ...(o.ok !== undefined ? { ok: o.ok } : {}),
    ...(o.status ? { status: o.status } : {}),
    ...(o.ms !== undefined ? { ms: o.ms } : {}),
    ...(o.output !== undefined ? { output: o.output } : {}),
    ...(o.outputBytes !== undefined ? { outputBytes: o.outputBytes } : {}),
    ...(o.error ? { error: o.error } : {}),
    ...(o.to ? { tookEdgeTo: o.to } : {}),
    model: "provider/model-x",
    ...(o.tokens === null ? {} : { tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: o.tokens ?? 30, cost: 0.5 } }),
  };
}

export interface RunOpts {
  ended?: number; done?: boolean; ok?: boolean; phases?: any[]; calls?: number; subCalls?: number; error?: string;
}

/** A run record as the detail route sends it (input, cwd and phase output included). */
export function runRec(id: string, graph: string, started: number, o: RunOpts = {}) {
  return {
    id, graph, scope: "project", cwd: "/root/secret-project/work", input: "PRIVATE INPUT /root/secret-project/x",
    started, ...(o.ended !== undefined ? { ended: o.ended } : {}),
    phases: o.phases ?? [], done: o.done ?? true, ...(o.ok !== undefined ? { ok: o.ok } : {}),
    ...(o.error ? { error: o.error } : {}),
    transitions: 3, calls: o.calls ?? 0, ...(o.subCalls !== undefined ? { subCalls: o.subCalls } : {}),
    maxCalls: 25, tokensTotal: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 3, cost: 1 },
    parents: ["p0"], depth: 0,
  };
}

/** The same record as `GET /runs` sends it: phases lose `output` and gain `outputBytes`; input and cwd stay. */
export function listView(run: any) {
  const { child: _c, phases, ...rest } = run;
  return { ...rest, phases: (phases ?? []).map(({ output, ...p }: any) => ({ ...p, outputBytes: output?.length ?? 0 })) };
}

/** `GET /graphs/:name`: `{graph, warnings}`. Nodes carry prompts that must never leave Tokyo. */
export function graphBody(name: string, nodeIds: string[], edges: [string, string][] = []) {
  return {
    graph: {
      name, description: "internal description /root/secret-project", maxTransitions: 20,
      nodes: nodeIds.map((id) => ({ id, kind: "agent", prompt: "SECRET PROMPT /root/secret-project/p", model: "provider/model-x", run: undefined })),
      edges: edges.map(([from, to]) => ({ from, to })),
    },
    warnings: [],
  };
}
