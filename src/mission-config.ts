// Per-project mission settings: where the repo lives, how to test a mission
// clone, and how root deploys the merged result. Every command is an argv array
// — never a shell string — and may use the {clone} and {id} placeholders.

export type Argv = string[];

export interface MissionProject {
  name: string;
  repo: string;
  /** Subdirectory of the clone the test commands run in. */
  workdir?: string;
  setup: Argv[];
  /** Empty means this project has no runnable tests: missions end "unverified". */
  test: Argv[];
  preDeploy: Argv[];
  deploy: Argv[];
  health?: { url: string; expectStatus: number };
  /** Operator confirmed the deploy target. Unconfirmed projects never auto-deploy. */
  confirmed: boolean;
  /** Engine used when a mission does not name one ("task dsh <project> …"). */
  engine: "claude" | "dsh";
  notes?: string;
}

function argvList(v: unknown, what: string, required: boolean): Argv[] {
  if (v === undefined && !required) return [];
  const ok = Array.isArray(v) && (!required || v.length > 0) &&
    v.every((a) => Array.isArray(a) && a.length > 0 && a.every((s) => typeof s === "string" && s.length > 0));
  if (!ok) throw new Error(`${what} must be a list of argv arrays`);
  return v as Argv[];
}

export function loadMissionConfig(text: string): Map<string, MissionProject> {
  const raw = JSON.parse(text);
  const out = new Map<string, MissionProject>();
  for (const p of raw.projects ?? []) {
    const name = String(p.name ?? "");
    if (!name) throw new Error("mission config: project without a name");
    if (out.has(name)) throw new Error(`mission config: duplicate project ${name}`);
    if (typeof p.repo !== "string" || !p.repo) throw new Error(`${name}: repo is required`);
    out.set(name, {
      name,
      repo: p.repo,
      workdir: p.workdir,
      setup: argvList(p.setup, `${name}: setup`, false),
      test: argvList(p.test, `${name}: test`, false),
      preDeploy: argvList(p.preDeploy, `${name}: preDeploy`, false),
      deploy: argvList(p.deploy, `${name}: deploy`, true),
      health: p.health,
      confirmed: p.confirmed === true,
      engine: p.engine === "dsh" ? "dsh" : (() => {
        if (p.engine !== undefined && p.engine !== "claude") throw new Error(`${name}: engine must be claude or dsh`);
        return "claude" as const;
      })(),
      notes: p.notes,
    });
  }
  return out;
}
