import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useOverview, OVERVIEW_KEY } from "../hooks/useOverview";
import { useWorkTimer } from "../hooks/useWorkTimer";
import { api, postApi } from "../api/client";
import { useToast } from "../components/ui/Toast";
import { fmtMin } from "../lib/utils";
import type { Project, ProjectsResponse, ApiOkResponse } from "../types";
import { Button, Input, Select, Card, StatTile } from "@bardouni/ui";

interface WorkLogEntry {
  id: number;
  work_type: string;
  note: string | null;
  project_id: number | null;
  project_name: string | null;
  started_at: string;
  ended_at: string | null;
  minutes: number;
  on_break: boolean;
}

interface WorkLogDay {
  date: string;
  totalMinutes: number;
  sessions: WorkLogEntry[];
}

export default function WorkPage() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const { data: overview } = useOverview();

  const [projects, setProjects] = useState<Project[]>([]);
  const [workLog, setWorkLog] = useState<WorkLogDay[]>([]);
  const [logLoading, setLogLoading] = useState(true);

  // Start form
  const [showStartForm, setShowStartForm] = useState(false);
  const [workProject, setWorkProject] = useState("");
  const [workType, setWorkType] = useState("dev");
  const [workNote, setWorkNote] = useState("");

  const activeSession = overview?.work.activeSession ?? null;
  const timerDisplay = useWorkTimer(activeSession);

  useEffect(() => {
    api<ProjectsResponse>("/api/projects")
      .then((data) => setProjects(data.projects || []))
      .catch(() => {});

    api<WorkLogDay[]>("/api/work/log")
      .then((data) => {
        setWorkLog(data || []);
        setLogLoading(false);
      })
      .catch(() => {
        setLogLoading(false);
      });
  }, []);

  const startMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      postApi<ApiOkResponse>("/api/work/start", body),
    onSuccess: () => {
      showToast("Work started!");
      setShowStartForm(false);
      setWorkNote("");
      queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const stopMutation = useMutation({
    mutationFn: () => postApi<ApiOkResponse>("/api/work/stop"),
    onSuccess: () => {
      showToast("Work stopped!");
      queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const breakMutation = useMutation({
    mutationFn: () =>
      postApi<{ ok: true; onBreak: boolean }>("/api/work/break"),
    onSuccess: (data) => {
      showToast(data.onBreak ? "Break started!" : "Break ended!");
      queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  function handleStart() {
    const body: Record<string, unknown> = { workType };
    if (workNote.trim()) body.note = workNote.trim();
    if (workProject) body.projectId = parseInt(workProject);
    startMutation.mutate(body);
  }

  const w = overview?.work;
  const types = w ? Object.entries(w.byType) : [];
  const typeTotal = types.reduce((s, e) => s + e[1], 0) || 1;

  // Per-project hours from work log
  const projectHours: Record<string, number> = {};
  for (const day of workLog) {
    for (const s of day.sessions) {
      const name = s.project_name || s.work_type || "unassigned";
      projectHours[name] = (projectHours[name] || 0) + s.minutes;
    }
  }

  const weekTotalMinutes = workLog.reduce((sum, d) => sum + d.totalMinutes, 0);

  if (!overview) {
    return (
      <div className="detail-page">
        <div className="loading">Loading work data...</div>
      </div>
    );
  }

  return (
    <div className="detail-page">
      <a className="back-link" onClick={() => navigate("/")}>
        &larr; Back to Dashboard
      </a>
      <h2>Work</h2>

      {/* Today's stats */}
      <div className="mb-5 flex flex-wrap gap-4">
        <StatTile className="items-center text-center" label="Total Today" value={<span className="text-accent">{fmtMin(w?.totalMinutes)}</span>} />
        <StatTile className="items-center text-center" label="Breaks" value={<span className="text-fg2">{fmtMin(w?.breakMinutes)}</span>} />
        <StatTile className="items-center text-center" label="This Week" value={<span className="text-green">{fmtMin(weekTotalMinutes)}</span>} />
      </div>

      {/* Active session with live timer */}
      {activeSession && (
        <Card className="flex items-center gap-3 border-l-[3px] border-l-green">
          <span className="pulse" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold">Currently Working</div>
            <div className="truncate text-[.85rem] text-fg2">
              {activeSession.note || activeSession.work_type}
              {activeSession.project_name && <span className="ml-1.5 text-accent">{activeSession.project_name}</span>}
            </div>
          </div>
          <div className="live-timer shrink-0 font-mono text-[1.4rem] font-semibold">
            {timerDisplay}
          </div>
        </Card>
      )}

      {/* Action buttons */}
      <div className="mb-5 flex flex-wrap gap-2">
        {activeSession ? (
          <>
            <Button variant="destructive" onClick={() => stopMutation.mutate()}>
              Stop Work
            </Button>
            <Button variant="warn" onClick={() => breakMutation.mutate()}>
              Toggle Break
            </Button>
          </>
        ) : (
          <Button variant="success" onClick={() => setShowStartForm(!showStartForm)}>
            Start Work
          </Button>
        )}
      </div>

      {/* Start form */}
      {!activeSession && showStartForm && (
        <div className="mb-5 flex flex-wrap gap-2 rounded-lg bg-surface2 p-3">
          <Select value={workProject} onChange={(e) => setWorkProject(e.target.value)} className="bg-surface1">
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </Select>
          <Select value={workType} onChange={(e) => setWorkType(e.target.value)} className="bg-surface1">
            <option value="dev">Dev</option>
            <option value="shop">Shop</option>
            <option value="learning">Learning</option>
          </Select>
          <Input
            type="text"
            placeholder="Note (optional)"
            value={workNote}
            onChange={(e) => setWorkNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleStart(); }}
            className="min-w-[150px] flex-1 bg-surface1"
          />
          <Button variant="success" onClick={handleStart}>
            Go
          </Button>
        </div>
      )}

      {/* Type distribution */}
      {types.length > 0 && (
        <div className="mb-5">
          <h3 className="mb-2 text-[.9rem] text-fg2">Today by Type</h3>
          <div className="type-bar h-7">
            {types.map(([name, minutes]) => {
              const pct = Math.max(5, (minutes / typeTotal) * 100);
              const cls = name === "dev" ? "type-dev" : name === "shop" ? "type-shop" : "type-learning";
              return (
                <div key={name} className={cls} style={{ width: `${pct}%` }}>
                  {name} {fmtMin(minutes)}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Per-project breakdown */}
      {Object.keys(projectHours).length > 0 && (
        <div className="mb-6">
          <h3 className="mb-2 text-[.9rem] text-fg2">Hours by Project (This Week)</h3>
          {Object.entries(projectHours)
            .sort((a, b) => b[1] - a[1])
            .map(([name, mins]) => {
              const pct = weekTotalMinutes > 0 ? (mins / weekTotalMinutes) * 100 : 0;
              return (
                <div key={name} className="mb-1.5 flex items-center gap-2.5">
                  <span className="w-[120px] shrink-0 truncate text-[.82rem]">{name}</span>
                  <div className="h-2 min-w-0 flex-1 overflow-hidden rounded bg-surface2">
                    <div className="h-full rounded bg-accent" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="w-[50px] shrink-0 text-right text-[.82rem] text-fg2">{fmtMin(mins)}</span>
                </div>
              );
            })}
        </div>
      )}

      {/* Work log history */}
      <h3 className="mb-2 text-[.9rem] text-fg2">Work Log (This Week)</h3>
      {logLoading ? (
        <div className="loading">Loading work log...</div>
      ) : workLog.length === 0 ? (
        <div className="text-[.85rem] text-fg3">No work sessions this week</div>
      ) : (
        workLog.map((day) => (
          <div key={day.date} className="mb-4">
            <div className="mb-1.5 flex justify-between border-b border-line py-1.5">
              <span className="text-[.88rem] font-semibold">{day.date}</span>
              <span className="text-[.85rem] text-accent">{fmtMin(day.totalMinutes)}</span>
            </div>
            {day.sessions.map((s) => (
              <div key={s.id} className="flex flex-wrap justify-between gap-2 px-3 py-1 text-[.82rem] text-fg2">
                <div className="min-w-0 truncate">
                  <span style={{ color: s.work_type === "dev" ? "var(--blue)" : s.work_type === "shop" ? "var(--orange)" : "var(--accent2)" }}>
                    {s.work_type}
                  </span>
                  {s.project_name && <span className="ml-1.5 text-accent">[{s.project_name}]</span>}
                  {s.note && <span className="ml-2">{s.note}</span>}
                  {s.on_break && <span className="ml-1.5 text-amber">(break)</span>}
                </div>
                <div className="shrink-0">
                  <span>{fmtMin(s.minutes)}</span>
                  {s.started_at && (
                    <span className="ml-2 text-fg3">
                      {s.started_at.slice(11, 16)}
                      {s.ended_at ? ` - ${s.ended_at.slice(11, 16)}` : " - now"}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
