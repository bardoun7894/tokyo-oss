import { readFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import type { GhReadKey, GhWriteKey, GhRead, GhWriteResult, ReadParams, WriteArgs } from "./client";

// Test helpers for the GodHome modules: the T0.5 fixtures, the contract examples, and a recording fake of the GhClient.

const ROOT = path.resolve(__dirname, "../../..");

/** The body of a T0.5 fixture (`test-fixtures/gh/<name>.json`). */
export function fixture(name: string): any {
  return JSON.parse(readFileSync(path.join(ROOT, "test-fixtures", "gh", `${name}.json`), "utf8")).body;
}

/** Which fixture answers which table key. */
export const FIXTURE_OF: Partial<Record<GhReadKey, string>> = {
  fleetServices: "fleet_services", fleetSchedules: "fleet_schedules", monitor: "monitor", network: "network", networkAlerts: "network_alerts",
  services: "services", projects: "projects", projectsRefresh: "projects", worldState: "world_state", worldEvents: "world_events", control: "control",
  inbox: "inbox", hygieneFindings: "hygiene_findings", hygieneFixes: "hygiene_fixes", playbook: "playbook", graphs: "graphs", graph: "graph_detail",
  triggers: "triggers", factory: "factory", factoryRuns: "factory_runs", factoryRun: "factory_run_detail", factoryLaunches: "factory_launches",
  factoryRoster: "factory_roster", models: "models", modelsHealth: "models_health", quota: "quota", costs: "costs", roles: "roles", skills: "skills",
  skillsGraph: "skills_graph", tmuxSessions: "tmux_sessions",
};

/** A mapped contract example (`contract-examples-gh.json`) by route code. */
export function example(code: string): any {
  const doc = JSON.parse(readFileSync(path.join(ROOT, "specs", "012-full-control", "contract-examples-gh.json"), "utf8"));
  const row = doc.routes.find((r: any) => r.id === code);
  assert.ok(row, `no contract example ${code}`);
  return row.example;
}

/** Every key path of a JSON value; arrays contribute the union of their elements under `[]`. */
export function keyPaths(v: unknown, prefix = ""): Set<string> {
  const out = new Set<string>();
  const walk = (x: unknown, p: string) => {
    if (Array.isArray(x)) { for (const e of x) walk(e, p + "[]"); return; }
    if (x && typeof x === "object") {
      for (const [k, e] of Object.entries(x)) { out.add(p ? `${p}.${k}` : k); walk(e, p ? `${p}.${k}` : k); }
    }
  };
  walk(v, prefix);
  return out;
}

/** Every key path of `out` is one the contract example for `code` has (no field outside the allowlist); the top-level keys are equal. */
export function assertWithinExample(code: string, out: unknown, extraAllowed: readonly string[] = []): void {
  const allowed = keyPaths(example(code));
  const got = keyPaths(out);
  for (const p of got) assert.ok(allowed.has(p) || extraAllowed.includes(p), `${code}: key ${p} is not in the contract example`);
  const top = (s: Set<string>) => [...s].filter((p) => !p.includes(".") && !p.includes("[]")).sort();
  assert.deepEqual(top(got), top(allowed), `${code}: top-level keys`);
}

export interface FakeGh {
  reads: { key: string; params: ReadParams; fresh: boolean }[];
  writes: { key: string; args: WriteArgs }[];
  /** Per-key replacement bodies (a constructed fixture), or a function that throws / returns an unreachable read. */
  bodies: Partial<Record<GhReadKey, any>>;
  down: boolean;
  /** What the next writes answer; default ok with `{ok:true}`. */
  writeResult: (key: GhWriteKey, args: WriteArgs) => GhWriteResult;
  read(key: GhReadKey, params?: ReadParams, o?: { fresh?: boolean }): Promise<GhRead>;
  write(key: GhWriteKey, args?: WriteArgs): Promise<GhWriteResult>;
}

export function fakeGh(now = () => 1_792_238_400_000): FakeGh {
  const f: FakeGh = {
    reads: [], writes: [], bodies: {}, down: false,
    writeResult: () => ({ status: "ok", json: { ok: true } }),
    async read(key, params = {}, o = {}) {
      f.reads.push({ key, params, fresh: o.fresh === true });
      if (f.down) return { reachable: false, data: null, fetchedAt: 0 };
      if (key in f.bodies && f.bodies[key] === null) return { reachable: true, data: null, fetchedAt: now(), notFound: true };
      const body = key in f.bodies ? f.bodies[key] : FIXTURE_OF[key] ? fixture(FIXTURE_OF[key]!) : null;
      return { reachable: true, data: structuredClone(body), fetchedAt: now() };
    },
    async write(key, args = {}) {
      f.writes.push({ key, args });
      return f.down ? { status: "unreachable" } : f.writeResult(key, args);
    },
  };
  return f;
}
