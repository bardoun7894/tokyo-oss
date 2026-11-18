/**
 * Project repo auto-sync.
 *
 * Scans known locations on the server and on the Mac (via `ssh mac`) for git
 * repos and records their activity in `project_repos`. One process per host
 * runs a single shell script, never one ssh per repo.
 *
 * Sync-owned columns: branch, remote, last commit, commit counts, seen/present.
 * User-owned columns (never written by the sync after insert): status,
 * client_id, category, description, hidden, project_id.
 */

import { spawn } from "child_process";
import db from "./db";

export type RepoHost = "server" | "mac";
export type RepoStatus = "active" | "paused" | "completed" | "cancelled";
export type RepoActivity = "active" | "idle" | "stale" | "unknown";

export const REPO_STATUSES: RepoStatus[] = ["active", "paused", "completed", "cancelled"];
export const REPO_CATEGORIES = ["client", "product", "shop", "internal"] as const;

const HOSTS: { host: RepoHost; roots: string[]; ssh: string | null }[] = [
  { host: "server", roots: ["/root", "/local", "/var/www", "/var/local"], ssh: null },
  { host: "mac", roots: ["/Users/owner/projects"], ssh: "mac" },
];

const SYNC_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_SYNC_DELAY_MS = 30 * 1000;
const HOST_TIMEOUT_MS = 90 * 1000;

// Fields separated by \037 (unit separator), one repo per line. Written for
// bash 3.2 (macOS) as well as bash 5. No brace-dollar sequences on purpose:
// this lives in a TS template literal.
const SCAN_SCRIPT = `
export LC_ALL=C
g() { git -c 'safe.directory=*' -C "$d" "$@" 2>/dev/null; }
for root in "$@"; do
  for d in "$root"/*; do
    [ -e "$d/.git" ] || continue
    branch=$(g rev-parse --abbrev-ref HEAD)
    remote=$(g config --get remote.origin.url)
    last=$(g log -1 --format=%cI%x1f%s HEAD)
    c7=$(g rev-list --count --since=7.days.ago HEAD)
    c30=$(g rev-list --count --since=30.days.ago HEAD)
    printf 'REPO\\037%s\\037%s\\037%s\\037%s\\037%s\\037%s\\n' "$d" "$branch" "$remote" "$last" "$c7" "$c30"
  done
done
echo SCAN_DONE
`;

export function initProjectReposTables(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host TEXT NOT NULL CHECK(host IN ('server', 'mac')),
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      branch TEXT,
      remote_url TEXT,
      last_commit_at TEXT,
      last_commit_subject TEXT,
      commits_7d INTEGER NOT NULL DEFAULT 0,
      commits_30d INTEGER NOT NULL DEFAULT 0,
      present INTEGER NOT NULL DEFAULT 1,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed', 'cancelled')),
      client_id INTEGER REFERENCES clients(id),
      category TEXT CHECK(category IS NULL OR category IN ('client', 'product', 'shop', 'internal')),
      description TEXT,
      hidden INTEGER NOT NULL DEFAULT 0,
      project_id INTEGER REFERENCES projects(id),
      UNIQUE(host, path)
    );

    CREATE TABLE IF NOT EXISTS project_sync_hosts (
      host TEXT PRIMARY KEY,
      last_attempt_at TEXT,
      last_ok_at TEXT,
      last_error TEXT,
      repo_count INTEGER
    );
  `);
}

initProjectReposTables();

interface ScannedRepo {
  path: string;
  name: string;
  branch: string | null;
  remote: string | null;
  lastCommitAt: string | null;
  lastCommitSubject: string | null;
  commits7: number;
  commits30: number;
}

/** Drop credentials from https remotes (https://token@github.com/...). */
function sanitizeRemote(url: string): string {
  return url.replace(/^(https?:\/\/)[^@/]+@/i, "$1");
}

function parseScan(stdout: string): ScannedRepo[] {
  const repos: ScannedRepo[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("REPO\x1f")) continue;
    const [, path, branch, remote, lastDate, lastSubject, c7, c30] = line.split("\x1f");
    if (!path) continue;
    const date = lastDate ? new Date(lastDate) : null;
    repos.push({
      path,
      name: path.split("/").filter(Boolean).pop() ?? path,
      branch: branch || null,
      remote: remote ? sanitizeRemote(remote) : null,
      lastCommitAt: date && !isNaN(date.getTime()) ? date.toISOString() : null,
      lastCommitSubject: lastSubject || null,
      commits7: parseInt(c7 ?? "", 10) || 0,
      commits30: parseInt(c30 ?? "", 10) || 0,
    });
  }
  return repos;
}

function runScan(ssh: string | null, roots: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = ssh
      ? spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", ssh, "bash", "-s", "--", ...roots.map((r) => `'${r}'`)])
      : spawn("bash", ["-s", "--", ...roots]);
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`scan timed out after ${HOST_TIMEOUT_MS / 1000}s`));
    }, HOST_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!out.includes("SCAN_DONE")) {
        reject(new Error((err.trim() || `exit code ${code}`).slice(0, 300)));
      } else {
        resolve(out);
      }
    });
    child.stdin.on("error", () => { /* surfaced via close */ });
    child.stdin.end(SCAN_SCRIPT);
  });
}

const BACKUP_PATTERN = /(presync|backup|baseline|golden|[-_]bak\b|[-_]old\b|[-_]copy\b|\d{8})/i;

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Guess a manual project to link on first insert only. */
function guessProjectId(repoName: string, projects: { id: number; name: string }[]): number | null {
  const repo = norm(repoName);
  for (const p of projects) {
    const tokens = p.name.toLowerCase().split(/\s+/).map(norm).filter(Boolean);
    if (tokens.length === 0) continue;
    const key = tokens[0].length >= 5 || tokens.length === 1 ? tokens[0] : tokens[0] + tokens[1];
    if (key.length >= 4 && repo.includes(key)) return p.id;
  }
  return null;
}

export interface HostSyncResult {
  host: RepoHost;
  ok: boolean;
  repos: number;
  inserted: number;
  error?: string;
}

function applyHostScan(host: RepoHost, repos: ScannedRepo[], now: string): HostSyncResult {
  const projects = db.prepare("SELECT id, name, client_id, category, status FROM projects").all() as {
    id: number; name: string; client_id: number | null; category: string | null; status: string;
  }[];
  const existing = db.prepare("SELECT id FROM project_repos WHERE host = ? AND path = ?");
  const insert = db.prepare(`
    INSERT INTO project_repos (host, path, name, branch, remote_url, last_commit_at, last_commit_subject,
      commits_7d, commits_30d, present, first_seen_at, last_seen_at, status, client_id, category, hidden, project_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE project_repos SET name = ?, branch = ?, remote_url = ?, last_commit_at = ?, last_commit_subject = ?,
      commits_7d = ?, commits_30d = ?, present = 1, last_seen_at = ?
    WHERE id = ?
  `);
  let inserted = 0;

  const tx = db.transaction(() => {
    for (const r of repos) {
      const row = existing.get(host, r.path) as { id: number } | undefined;
      if (row) {
        update.run(r.name, r.branch, r.remote, r.lastCommitAt, r.lastCommitSubject, r.commits7, r.commits30, now, row.id);
        continue;
      }
      const hidden = BACKUP_PATTERN.test(r.name) ? 1 : 0;
      const projectId = hidden ? null : guessProjectId(r.name, projects);
      const project = projectId ? projects.find((p) => p.id === projectId) : undefined;
      const status = project && REPO_STATUSES.includes(project.status as RepoStatus) ? project.status : "active";
      insert.run(
        host, r.path, r.name, r.branch, r.remote, r.lastCommitAt, r.lastCommitSubject, r.commits7, r.commits30,
        now, now, status, project?.client_id ?? null, project?.category ?? null, hidden, projectId,
      );
      inserted++;
    }
    // Host scanned fine, so anything not reported is gone from disk. Keep the
    // row (and its user fields) but flag it.
    const seen = new Set(repos.map((r) => r.path));
    const rows = db.prepare("SELECT id, path FROM project_repos WHERE host = ? AND present = 1").all(host) as { id: number; path: string }[];
    const markGone = db.prepare("UPDATE project_repos SET present = 0 WHERE id = ?");
    for (const row of rows) if (!seen.has(row.path)) markGone.run(row.id);

    db.prepare(`
      INSERT INTO project_sync_hosts (host, last_attempt_at, last_ok_at, last_error, repo_count)
      VALUES (?, ?, ?, NULL, ?)
      ON CONFLICT(host) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_ok_at = excluded.last_ok_at,
        last_error = NULL, repo_count = excluded.repo_count
    `).run(host, now, now, repos.length);
  });
  tx();
  return { host, ok: true, repos: repos.length, inserted };
}

function recordHostError(host: RepoHost, now: string, error: string): void {
  db.prepare(`
    INSERT INTO project_sync_hosts (host, last_attempt_at, last_error) VALUES (?, ?, ?)
    ON CONFLICT(host) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error
  `).run(host, now, error);
}

let inFlight: Promise<HostSyncResult[]> | null = null;

/** Scan every host. Concurrent callers share the same run. */
export function syncProjectRepos(): Promise<HostSyncResult[]> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const results = await Promise.all(
      HOSTS.map(async ({ host, roots, ssh }): Promise<HostSyncResult> => {
        const now = new Date().toISOString();
        try {
          const out = await runScan(ssh, roots);
          return applyHostScan(host, parseScan(out), now);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          recordHostError(host, now, msg);
          return { host, ok: false, repos: 0, inserted: 0, error: msg };
        }
      }),
    );
    return results;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export function isSyncRunning(): boolean {
  return inFlight !== null;
}

export function activityFor(lastCommitAt: string | null, nowMs = Date.now()): { activity: RepoActivity; daysSince: number | null } {
  if (!lastCommitAt) return { activity: "unknown", daysSince: null };
  const t = new Date(lastCommitAt).getTime();
  if (isNaN(t)) return { activity: "unknown", daysSince: null };
  const days = Math.max(0, Math.floor((nowMs - t) / 86400000));
  return { activity: days < 14 ? "active" : days <= 60 ? "idle" : "stale", daysSince: days };
}

export function listProjectRepos() {
  const rows = db.prepare(`
    SELECT r.*, c.name AS client_name, p.name AS project_name, p.deadline AS project_deadline,
      p.budget AS project_budget, p.currency AS project_currency, p.status AS project_status,
      pc.name AS project_client_name
    FROM project_repos r
    LEFT JOIN clients c ON c.id = r.client_id
    LEFT JOIN projects p ON p.id = r.project_id
    LEFT JOIN clients pc ON pc.id = p.client_id
    ORDER BY (r.last_commit_at IS NULL), r.last_commit_at DESC
  `).all() as Record<string, unknown>[];
  const nowMs = Date.now();
  return rows.map((r) => ({
    ...r,
    hidden: r.hidden === 1,
    present: r.present === 1,
    ...activityFor(r.last_commit_at as string | null, nowMs),
  }));
}

export function listSyncHosts() {
  return db.prepare("SELECT * FROM project_sync_hosts ORDER BY host").all();
}

export interface RepoPatch {
  status?: RepoStatus;
  client_id?: number | null;
  category?: string | null;
  description?: string | null;
  hidden?: boolean;
  project_id?: number | null;
}

/** Apply user edits. Returns an error string on bad input. */
export function updateProjectRepo(id: number, patch: Record<string, unknown>): string | null {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const nullableId = (v: unknown) => v === null || v === "" || (typeof v === "number" && Number.isInteger(v) && v > 0);

  if ("status" in patch) {
    if (!REPO_STATUSES.includes(patch.status as RepoStatus)) return "invalid status";
    sets.push("status = ?"); vals.push(patch.status);
  }
  if ("category" in patch) {
    const c = patch.category === "" ? null : patch.category;
    if (c !== null && !(REPO_CATEGORIES as readonly string[]).includes(c as string)) return "invalid category";
    sets.push("category = ?"); vals.push(c);
  }
  if ("client_id" in patch) {
    if (!nullableId(patch.client_id)) return "invalid client_id";
    const v = patch.client_id === "" ? null : patch.client_id;
    if (v !== null && !db.prepare("SELECT 1 FROM clients WHERE id = ?").get(v)) return "unknown client";
    sets.push("client_id = ?"); vals.push(v);
  }
  if ("project_id" in patch) {
    if (!nullableId(patch.project_id)) return "invalid project_id";
    const v = patch.project_id === "" ? null : patch.project_id;
    if (v !== null && !db.prepare("SELECT 1 FROM projects WHERE id = ?").get(v)) return "unknown project";
    sets.push("project_id = ?"); vals.push(v);
  }
  if ("description" in patch) {
    if (patch.description !== null && typeof patch.description !== "string") return "invalid description";
    sets.push("description = ?"); vals.push(patch.description ? String(patch.description).slice(0, 2000) : null);
  }
  if ("hidden" in patch) {
    if (typeof patch.hidden !== "boolean") return "invalid hidden";
    sets.push("hidden = ?"); vals.push(patch.hidden ? 1 : 0);
  }
  if (sets.length === 0) return "nothing to update";
  const res = db.prepare(`UPDATE project_repos SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  return res.changes === 0 ? "not found" : null;
}

let schedulerStarted = false;

/** Idempotent: first sync shortly after boot, then hourly. */
export function startProjectReposSync(): void {
  const g = globalThis as { __tokyoProjectReposSync?: boolean };
  if (schedulerStarted || g.__tokyoProjectReposSync) return;
  schedulerStarted = true;
  g.__tokyoProjectReposSync = true;
  const run = () => {
    syncProjectRepos()
      .then((r) => console.log("[projects-sync]", r.map((h) => `${h.host}:${h.ok ? h.repos : "fail"}`).join(" ")))
      .catch((e) => console.error("[projects-sync] error:", e));
  };
  setTimeout(run, FIRST_SYNC_DELAY_MS).unref();
  setInterval(run, SYNC_INTERVAL_MS).unref();
}
