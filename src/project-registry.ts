import fs from "fs";

export type ProjectLocation = "server" | "laptop";

export interface ProjectRef {
  /** Canonical short name used by Tokyo and the AI. */
  name: string;
  location: ProjectLocation;
  /** Absolute path on its host. */
  path: string;
  /** KB root, or undefined if the project has no KB. */
  kbPath?: string;
  /** WhatsApp chat/contact names that should map here. Compared case-insensitively, spaces/dashes/underscores normalized. */
  aliases?: string[];
  /** Free-text note the AI can use when reasoning about this project. */
  note?: string;
  /** Live or preview URL on the target server shown in Telegram deploy offers. */
  url?: string;
  /** The live copy is on another host: an approved deploy run works there over ssh, not in `path` here. */
  deployRemote?: { host: string; path: string; testPath: string; branch: string };
  /** The documented deploy process for a project whose prod is on this host but not in `path`. An approved deploy run follows it exactly. */
  deployNote?: string;
}

/**
 * Example project list. Replace with your own: either edit this array or point
 * PROJECTS_FILE at a JSON array of ProjectRef objects (see projects.example.json).
 */
const EXAMPLE_PROJECTS: ProjectRef[] = [
  {
    name: "crmdemo",
    location: "server",
    path: "/srv/crmdemo",
    url: "https://example.com/crm",
    kbPath: "/srv/crmdemo/ai-knowledge-base",
    aliases: ["crm ai", "ai receptionist", "receptionist crm"],
    note: "WhatsApp AI receptionist CRM. Deploy: test the target commit in its own worktree, then run ops/deploy.sh.",
  },
  {
    name: "up",
    location: "laptop",
    path: "/Users/owner/projects/up",
    kbPath: "/Users/owner/projects/up/ai-knowledge-base",
    aliases: ["level up", "levelup", "level-up"],
  },
  { name: "clinic", location: "laptop", path: "/Users/owner/projects/clinic_app", kbPath: "/Users/owner/projects/clinic_app/ai-knowledge-base" },
  { name: "erpdemo", location: "laptop", path: "/Users/owner/projects/erpdemo", kbPath: "/Users/owner/projects/erpdemo/ai-knowledge-base", note: "Project SSHes to its own server via ~/.ssh/config for deploy." },
  { name: "billing", location: "laptop", path: "/Users/owner/projects/billing_app", kbPath: "/Users/owner/projects/billing_app/ai-knowledge-base" },
  { name: "studio", location: "laptop", path: "/Users/owner/projects/studio", kbPath: "/Users/owner/projects/studio/ai-knowledge-base" },
  {
    name: "tokyo-dev",
    location: "laptop",
    path: "/Users/owner/projects/tokyo",
    kbPath: "/Users/owner/projects/tokyo/ai-knowledge-base",
    note: "Laptop dev shell for Tokyo. Runtime lives on the server.",
  },
  { name: "tokyo", location: "server", path: "/srv/tokyo", note: "Tokyo's own runtime. Use with care — restarting this restarts the bot." },
  { name: "shopdemo", location: "server", path: "/srv/shopdemo" },
  { name: "lab", location: "server", path: "/srv/lab-app", aliases: ["lab-app", "chemical"] },
  { name: "fashiondemo", location: "server", path: "/srv/fashiondemo", aliases: ["fashion demo"] },
  { name: "godhome", location: "server", path: "/srv/godhome", url: "http://127.0.0.1:8000", aliases: ["controller", "god home"], note: "GodHome — the controller board (graphs, runs, triggers)." },
  {
    name: "edudemo-erp",
    location: "server",
    path: "/srv/edudemo-erp",
    url: "https://edu.example.com/",
    kbPath: "/srv/edudemo-erp/ai-knowledge-base",
    aliases: ["edudemo", "edudemo erp", "EduDemo-ERP"],
    note: "Example ERP whose prod runs on this host from a separate live checkout. Dev checkout /srv/edudemo-erp; never deploy from it.",
    deployNote:
      "Deploy with exactly these steps at the pinned commit <sha>. " +
      "(1) Pass the pre-deploy gate first: `gate-submit edudemo-predeploy 150m -- bash ops/predeploy.sh`, then end your answer with `WAITING-GATE <id>`. " +
      "(2) Back up the DB. (3) In the live checkout run `git fetch -q origin` and `git merge -q --ff-only <sha>`. " +
      "(4) Run deploy/redeploy.sh through the gate. (5) Run deploy/verify-prod.sh. (6) Report.",
  },
  {
    name: "acme-site",
    location: "server",
    path: "/srv/acme-site",
    url: "https://acme.example/app",
    kbPath: "/srv/acme-site/ai-knowledge-base",
    aliases: ["acme"],
    note: "Example client site whose live copy runs on another host (see deployRemote).",
    deployRemote: { host: "client-server", path: "/srv/acme-site", testPath: "/srv/acme-site-ci", branch: "main" },
  },
  { name: "appstudio", location: "server", path: "/srv/appstudio", url: "http://127.0.0.1:8600", aliases: ["studio os"] },
];

function loadProjects(): ProjectRef[] {
  const file = process.env.PROJECTS_FILE;
  if (!file) return EXAMPLE_PROJECTS;
  try {
    const list = JSON.parse(fs.readFileSync(file, "utf-8"));
    return Array.isArray(list) ? list : EXAMPLE_PROJECTS;
  } catch (err) {
    console.error(`PROJECTS_FILE ${file} unreadable, using example projects:`, err);
    return EXAMPLE_PROJECTS;
  }
}

export const PROJECTS: ProjectRef[] = loadProjects();

/** Tokyo's own KB — always consulted alongside the matched project's KB. */
export const TOKYO_KB_PATH = "/Users/owner/projects/tokyo/ai-knowledge-base";

function norm(s: string): string {
  return s.toLowerCase().trim().replace(/[\s_\-]+/g, " ");
}

/**
 * Match a WhatsApp chat name / contact / free-text reference to a project.
 * Priority: explicit alias → exact canonical name → longest substring match.
 */
export function matchProject(waName: string): ProjectRef | null {
  if (!waName) return null;
  const needle = norm(waName);

  for (const p of PROJECTS) {
    if (p.aliases?.some((a) => norm(a) === needle)) return p;
  }
  for (const p of PROJECTS) {
    if (norm(p.name) === needle) return p;
  }
  const sorted = [...PROJECTS].sort((a, b) => b.name.length - a.name.length);
  for (const p of sorted) {
    if (needle.includes(norm(p.name))) return p;
    if (p.aliases?.some((a) => needle.includes(norm(a)))) return p;
  }
  if (needle.length >= 4) {
    for (const p of sorted) {
      if (norm(p.name).includes(needle)) return p;
    }
  }
  return null;
}

export function listProjectNames(): string[] {
  return PROJECTS.map((p) => p.name);
}

export function getProject(name: string): ProjectRef | undefined {
  return PROJECTS.find((p) => norm(p.name) === norm(name));
}
