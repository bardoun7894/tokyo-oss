import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

// One done/missing summary for the Telegram card (Part B) and the Control API (Part C), D8.
// Server projects are read from the repo; Mac projects use the numbers carried in the snapshot.

export interface TriageEntry {
  name: string;
  host: string;
  path?: string;
  also_at?: string[];
  commits?: number;
  last_commit?: string;
  specs_total?: number;
  specs_missing_plan?: number;
  specs_missing_tasks?: number;
  open_tasks?: number;
  completeness: number | null;
  next_action: string;
  customer?: boolean;
  report_only?: boolean;
}

export interface Recommendation {
  code: string;
  title: string;
  kind: string;
  why: string;
  evidence: string[];
  size: "S" | "M" | "L";
  impact: number | null;
}

export interface Gap {
  code: string;
  text: string;
  severity: "P0" | "P1" | "P2" | "P3";
  source: "readiness-audit" | "defects";
}

export interface SpecProgress {
  name: string;
  hasSpec: boolean;
  hasPlan: boolean;
  hasTasks: boolean;
  tasksDone: number;
  tasksOpen: number;
}

export interface Merged { sha: string; subject: string; at: string }

export interface RepoReader {
  specs(): SpecProgress[];
  merged7d(): Merged[];
  gaps(): Gap[];
}

export interface Summary {
  done: { specs_complete: number; tasks_done: number; tasks_total: number; merged_7d: Merged[] };
  missing: {
    open_tasks: number;
    specs_incomplete: { name: string; missing: ("plan" | "tasks")[] }[];
    gaps: Gap[];
    recommendations: Recommendation[];
  };
}

const MAX_MERGED = 5;
const MAX_RECS = 3;

/** Checkbox counts of one tasks.md. Anything unparseable counts as 0. */
export function countTasks(text: string): { done: number; open: number } {
  let done = 0;
  let open = 0;
  for (const line of String(text ?? "").split("\n")) {
    const m = /^\s*- \[([ xX])\]/.exec(line);
    if (!m) continue;
    if (m[1] === " ") open++;
    else done++;
  }
  return { done, open };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function summarize(
  project: { name: string; location: "server" | "laptop" },
  snapshot: TriageEntry,
  repoReader: RepoReader | null,
  recs: Recommendation[] = [],
): Summary {
  const recommendations = recs.slice(0, MAX_RECS);
  if (project.location !== "server" || !repoReader) {
    return {
      done: { specs_complete: 0, tasks_done: 0, tasks_total: snapshot.open_tasks ?? 0, merged_7d: [] },
      missing: { open_tasks: snapshot.open_tasks ?? 0, specs_incomplete: [], gaps: [], recommendations },
    };
  }
  const specs = safe(() => repoReader.specs(), [] as SpecProgress[]);
  const specsComplete = specs.filter((s) => s.hasTasks && s.tasksOpen === 0 && s.tasksDone > 0).length;
  const tasksDone = specs.reduce((n, s) => n + s.tasksDone, 0);
  const tasksOpen = specs.reduce((n, s) => n + s.tasksOpen, 0);
  const incomplete = specs
    .filter((s) => !s.hasPlan || !s.hasTasks)
    .map((s) => ({
      name: s.name,
      missing: [...(s.hasPlan ? [] : ["plan"]), ...(s.hasTasks ? [] : ["tasks"])] as ("plan" | "tasks")[],
    }));
  return {
    done: {
      specs_complete: specsComplete,
      tasks_done: tasksDone,
      tasks_total: tasksDone + tasksOpen,
      merged_7d: safe(() => repoReader.merged7d(), [] as Merged[]).slice(0, MAX_MERGED),
    },
    missing: {
      open_tasks: tasksOpen,
      specs_incomplete: incomplete,
      gaps: safe(() => repoReader.gaps(), [] as Gap[]),
      recommendations,
    },
  };
}

/** The two card lines. */
export function summaryLines(s: Summary): [string, string] {
  return [
    `Done: ${s.done.specs_complete} specs complete, ${s.done.tasks_done}/${s.done.tasks_total} tasks, ${s.done.merged_7d.length} merged in 7d`,
    `Missing: ${s.missing.open_tasks} open tasks, ${s.missing.specs_incomplete.length} specs incomplete, ${s.missing.gaps.length} gaps`,
  ];
}

const SEVERITIES = new Set(["P0", "P1", "P2", "P3"]);

function normGap(g: any): Gap | null {
  if (!g || typeof g.code !== "string" || typeof g.text !== "string") return null;
  return {
    code: g.code,
    text: g.text,
    severity: SEVERITIES.has(g.severity) ? g.severity : "P2",
    source: g.source === "defects" ? "defects" : "readiness-audit",
  };
}

/**
 * Reads a registry project path: specs/<n>/{spec,plan,tasks}.md, the newest
 * specs/_audit/<date>/gaps.json and `git log --since=7.days`. The path comes from the
 * registry; git runs with an argv array, never through a shell.
 */
export function fsRepoReader(repo: string): RepoReader {
  return {
    specs: () => safe(() => readSpecs(repo), [] as SpecProgress[]),
    merged7d: () => safe(() => readMerged(repo), [] as Merged[]),
    gaps: () => safe(() => readGaps(repo), [] as Gap[]),
  };
}

function readSpecs(repo: string): SpecProgress[] {
  const dir = path.join(repo, "specs");
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name)
    .sort()
    .map((name) => {
      const p = (f: string) => path.join(dir, name, f);
      const hasTasks = fs.existsSync(p("tasks.md"));
      const c = hasTasks ? safe(() => countTasks(fs.readFileSync(p("tasks.md"), "utf8")), { done: 0, open: 0 }) : { done: 0, open: 0 };
      return {
        name, hasSpec: fs.existsSync(p("spec.md")), hasPlan: fs.existsSync(p("plan.md")), hasTasks,
        tasksDone: c.done, tasksOpen: c.open,
      };
    });
}

function readMerged(repo: string): Merged[] {
  const out = execFileSync("git", ["-C", repo, "log", "--since=7.days", "--format=%h%x09%cI%x09%s", "-n", String(MAX_MERGED)], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000,
  });
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, at, ...rest] = l.split("\t");
      return { sha, subject: rest.join("\t"), at };
    });
}

function readGaps(repo: string): Gap[] {
  const dir = path.join(repo, "specs", "_audit");
  const dates = fs.readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  for (const d of dates) {
    const f = path.join(dir, d, "gaps.json");
    if (!fs.existsSync(f)) continue;
    const arr = JSON.parse(fs.readFileSync(f, "utf8"));
    return Array.isArray(arr) ? arr.map(normGap).filter((g): g is Gap => g !== null) : [];
  }
  return [];
}
