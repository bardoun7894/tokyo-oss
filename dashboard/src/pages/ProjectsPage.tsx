import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useProjectRepos, useProjects, useSyncProjectRepos, useUpdateProjectRepo } from "../hooks/useProjects";
import { useOverview } from "../hooks/useOverview";
import {
  PROJECT_CATEGORIES,
  REPO_STATUSES,
  type ManualProject,
  type ProjectRepo,
  type RepoActivity,
  type RepoPatch,
  type RepoStatus,
} from "../types/projects";
import { Button, Input, Select as UiSelect } from "@bardouni/ui";

function relTime(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms)) return "unknown";
  const min = Math.round(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d}d ago`;
  const mo = Math.round(d / 30);
  return mo < 24 ? `${mo}mo ago` : `${Math.round(d / 365)}y ago`;
}

function daysUntil(date: string): number {
  return Math.ceil((new Date(date).getTime() - Date.now()) / 86400000);
}

type Filter<T extends string> = T | "all";

export default function ProjectsPage() {
  const navigate = useNavigate();
  const { data, isLoading, isError, error } = useProjectRepos();
  const { data: manualData } = useProjects();
  const { data: overview } = useOverview();
  const sync = useSyncProjectRepos();
  const update = useUpdateProjectRepo();

  const [status, setStatus] = useState<Filter<RepoStatus>>("active");
  const [activity, setActivity] = useState<Filter<Exclude<RepoActivity, "unknown">>>("all");
  const [host, setHost] = useState<Filter<"server" | "mac">>("all");
  const [showHidden, setShowHidden] = useState(false);
  const [query, setQuery] = useState("");

  const repos = data?.repos ?? [];
  const projects = data?.projects ?? [];
  const upcomingDeadlines = manualData?.upcomingDeadlines ?? [];

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return repos.filter((r) => {
      if (!showHidden && (r.hidden || !r.present)) return false;
      if (status !== "all" && r.status !== status) return false;
      if (activity !== "all" && r.activity !== activity) return false;
      if (host !== "all" && r.host !== host) return false;
      if (q && !`${r.name} ${r.path} ${r.client_name ?? ""} ${r.project_name ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [repos, status, activity, host, showHidden, query]);

  const counts = useMemo(() => {
    const shown = repos.filter((r) => !r.hidden && r.present);
    return {
      active: shown.filter((r) => r.activity === "active").length,
      idle: shown.filter((r) => r.activity === "idle").length,
      stale: shown.filter((r) => r.activity === "stale").length,
      hidden: repos.length - shown.length,
      commits7: shown.reduce((s, r) => s + r.commits_7d, 0),
    };
  }, [repos]);

  const tasksByProject = useMemo(() => {
    const map: Record<number, number> = {};
    for (const t of overview?.tasks.active ?? []) if (t.project_id) map[t.project_id] = (map[t.project_id] ?? 0) + 1;
    return map;
  }, [overview]);

  const reposByProject = useMemo(() => {
    const map: Record<number, ProjectRepo[]> = {};
    for (const r of repos) if (r.project_id) (map[r.project_id] ??= []).push(r);
    return map;
  }, [repos]);

  const hosts = data?.hosts ?? [];
  const lastSync = hosts.reduce<string | null>((max, h) => (h.last_ok_at && (!max || h.last_ok_at > max) ? h.last_ok_at : max), null);
  const syncing = sync.isPending || data?.syncing;

  if (isLoading) {
    return <div className="detail-page"><div className="loading">Loading projects...</div></div>;
  }

  return (
    <div className="detail-page projects-page">
      <a className="back-link" onClick={() => navigate("/")}>&larr; Back to Dashboard</a>

      <div className="pr-head">
        <h2>Projects</h2>
        <div className="pr-sync">
          <div className="pr-sync-meta">
            <span>Last sync {relTime(lastSync)}</span>
            {hosts.map((h) => (
              <span key={h.host} className={`pr-host-state ${h.last_error ? "err" : "ok"}`} title={h.last_error ?? `last ok ${h.last_ok_at ?? "never"}`}>
                {h.host}: {h.last_error ? `offline, data from ${relTime(h.last_ok_at)}` : `${h.repo_count ?? 0} repos`}
              </span>
            ))}
          </div>
          <Button size="sm" disabled={!!syncing} onClick={() => sync.mutate()}>
            {syncing ? "Syncing..." : "Sync now"}
          </Button>
        </div>
      </div>
      {sync.isError && <div className="pr-error">Sync failed: {(sync.error as Error).message}</div>}
      {isError && <div className="pr-error">Failed to load repos: {(error as Error).message}</div>}

      <div className="pr-stats">
        <Stat value={counts.active} label="Active (<14d)" color="var(--green)" />
        <Stat value={counts.idle} label="Idle (14-60d)" color="var(--amber)" />
        <Stat value={counts.stale} label="Stale (>60d)" color="var(--text3)" />
        <Stat value={counts.commits7} label="Commits, 7 days" color="var(--accent)" />
      </div>

      {upcomingDeadlines.length > 0 && (
        <div className="pr-deadlines">
          <h3>Upcoming deadlines</h3>
          {upcomingDeadlines.map((dl) => {
            const d = daysUntil(dl.deadline);
            return (
              <div key={dl.id} className="pr-deadline">
                <span>{dl.name}</span>
                <span style={{ color: d <= 1 ? "var(--red)" : d <= 3 ? "var(--amber)" : "var(--text2)" }}>
                  {dl.deadline} ({d >= 0 ? `${d}d` : "overdue"})
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="pr-filters">
        <Input className="min-w-0 flex-1" placeholder="Search repos" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Select label="Status" value={status} options={["all", ...REPO_STATUSES]} onChange={(v) => setStatus(v as Filter<RepoStatus>)} />
        <Select label="Activity" value={activity} options={["all", "active", "idle", "stale"]} onChange={(v) => setActivity(v as typeof activity)} />
        <Select label="Host" value={host} options={["all", "server", "mac"]} onChange={(v) => setHost(v as typeof host)} />
        <label className="pr-check">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          Show hidden ({counts.hidden})
        </label>
      </div>

      <div className="pr-count">{visible.length} of {repos.length} repos</div>

      {visible.length === 0 ? (
        <div className="pr-empty">{repos.length === 0 ? "No repos synced yet. Press Sync now." : "No repos match these filters."}</div>
      ) : (
        <div className="pr-list">
          {visible.map((r) => (
            <RepoRow
              key={r.id}
              repo={r}
              clients={data?.clients ?? []}
              projects={projects}
              onPatch={(patch) => update.mutate({ id: r.id, patch })}
            />
          ))}
        </div>
      )}

      <h3 className="pr-section">Tracked projects (deadlines, budget, hours)</h3>
      {projects.length === 0 ? (
        <div className="pr-empty">No manual projects</div>
      ) : (
        <div className="pr-manual">
          {projects.map((p) => (
            <ManualCard key={p.id} project={p} repos={reposByProject[p.id] ?? []} tasks={tasksByProject[p.id] ?? 0} />
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div className="pr-stat">
      <div className="pr-stat-value" style={{ color }}>{value}</div>
      <div className="pr-stat-label">{label}</div>
    </div>
  );
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <label className="pr-select">
      <span>{label}</span>
      <UiSelect value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </UiSelect>
    </label>
  );
}

function RepoRow({
  repo: r,
  clients,
  projects,
  onPatch,
}: {
  repo: ProjectRepo;
  clients: { id: number; name: string }[];
  projects: ManualProject[];
  onPatch: (patch: RepoPatch) => void;
}) {
  const client = r.client_name ?? r.project_client_name;
  const deadlineDays = r.project_deadline ? daysUntil(r.project_deadline) : null;
  const remote = r.remote_url?.replace(/^git@([^:]+):/, "$1/").replace(/^https?:\/\//, "").replace(/\.git$/, "");

  return (
    <div className={`pr-row act-${r.activity}${r.hidden || !r.present ? " is-hidden" : ""}`}>
      <div className="pr-row-main">
        <div className="pr-row-title">
          <span className={`pr-dot act-${r.activity}`} title={r.activity} />
          <span className="pr-name">{r.name}</span>
          <span className={`pr-badge host-${r.host}`}>{r.host}</span>
          <span className={`pr-badge act-${r.activity}`}>{r.activity}</span>
          {r.hidden && <span className="pr-badge">hidden</span>}
          {!r.present && <span className="pr-badge warn">missing on disk</span>}
          {client && <span className="pr-client">{client}</span>}
        </div>
        <div className="pr-commit">
          <span className="pr-when">{relTime(r.last_commit_at)}</span>
          <span className="pr-subject" title={r.last_commit_subject ?? ""}>{r.last_commit_subject ?? "no commits"}</span>
        </div>
        <div className="pr-meta">
          <span>{r.commits_7d} / {r.commits_30d} commits (7d / 30d)</span>
          {r.branch && <span>branch {r.branch}</span>}
          <span className="pr-path" title={r.path}>{r.path}</span>
          {remote && <span className="pr-path" title={r.remote_url ?? ""}>{remote}</span>}
          {r.project_name && (
            <span>
              linked: {r.project_name}
              {deadlineDays !== null && (
                <span style={{ color: deadlineDays <= 3 ? "var(--red)" : "var(--text2)" }}> , due {r.project_deadline} ({deadlineDays >= 0 ? `${deadlineDays}d` : "overdue"})</span>
              )}
            </span>
          )}
        </div>
      </div>
      <div className="pr-edit">
        <UiSelect aria-label="Status" value={r.status} onChange={(e) => onPatch({ status: e.target.value as RepoStatus })}>
          {REPO_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </UiSelect>
        <UiSelect aria-label="Client" value={r.client_id ?? ""} onChange={(e) => onPatch({ client_id: e.target.value ? Number(e.target.value) : null })}>
          <option value="">no client</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </UiSelect>
        <UiSelect aria-label="Category" value={r.category ?? ""} onChange={(e) => onPatch({ category: (e.target.value || null) as ProjectRepo["category"] })}>
          <option value="">no category</option>
          {PROJECT_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </UiSelect>
        <UiSelect aria-label="Linked project" value={r.project_id ?? ""} onChange={(e) => onPatch({ project_id: e.target.value ? Number(e.target.value) : null })}>
          <option value="">no linked project</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </UiSelect>
        <Button size="sm" variant="ghost" onClick={() => onPatch({ hidden: !r.hidden })}>
          {r.hidden ? "Unhide" : "Hide"}
        </Button>
      </div>
    </div>
  );
}

function ManualCard({ project: p, repos, tasks }: { project: ManualProject; repos: ProjectRepo[]; tasks: number }) {
  const est = p.estimated_hours || 0;
  const act = p.actual_hours || 0;
  const pct = est > 0 ? Math.min(100, (act / est) * 100) : 0;
  const latest = repos.reduce<ProjectRepo | null>((best, r) => (r.last_commit_at && (!best || (best.last_commit_at ?? "") < r.last_commit_at) ? r : best), null);
  const deadlineDays = p.deadline ? daysUntil(p.deadline) : null;

  return (
    <div className="pr-mcard">
      <div className="pr-row-title">
        <span className="pr-name">{p.name}</span>
        <span className="pr-badge">{p.category}</span>
        <span className="pr-badge">{p.status}</span>
        {p.client_name && <span className="pr-client">{p.client_name}</span>}
      </div>
      {est > 0 && (
        <div className="progress h-1.5">
          <div className="fill fill-accent" style={{ width: `${pct.toFixed(0)}%` }} />
        </div>
      )}
      <div className="pr-meta">
        <span>{act}h / {est}h</span>
        {p.deadline && deadlineDays !== null && (
          <span style={{ color: deadlineDays <= 1 ? "var(--red)" : deadlineDays <= 3 ? "var(--amber)" : undefined }}>
            due {p.deadline} ({deadlineDays >= 0 ? `${deadlineDays}d` : "overdue"})
          </span>
        )}
        {p.budget != null && <span>{p.budget.toLocaleString()} {p.currency || "MAD"}</span>}
        {tasks > 0 && <span>{tasks} open tasks</span>}
        <span>
          {repos.length === 0 ? "no linked repo" : `${repos.length} repo${repos.length > 1 ? "s" : ""}`}
          {latest && `, last commit ${relTime(latest.last_commit_at)}`}
        </span>
      </div>
      {p.description && <div className="pr-desc">{p.description}</div>}
    </div>
  );
}
