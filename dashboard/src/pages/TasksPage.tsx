import { useState, useMemo, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useOverview, OVERVIEW_KEY } from "../hooks/useOverview";
import { postApi, deleteApi } from "../api/client";
import { useToast } from "../components/ui/Toast";
import TaskBulkBar from "../components/tasks/TaskBulkBar";
import SuggestedDonePanel, { SUGGESTIONS_KEY } from "../components/tasks/SuggestedDonePanel";
import type { Task, ApiOkResponse } from "../types";
import { Button, Input, Select, Empty } from "@bardouni/ui";

const AREA_COLOR = { work: "text-accent", personal: "text-green", learn: "text-amber" } as const;

const OLD_DAYS = 30;
const DAY_MS = 86_400_000;

/** created_at is stored as UTC "YYYY-MM-DD HH:MM:SS". */
function ageDays(createdAt: string): number {
  const t = Date.parse(createdAt.replace(" ", "T") + "Z");
  return Number.isNaN(t) ? 0 : Math.floor((Date.now() - t) / DAY_MS);
}

interface BulkCompleteResponse {
  ok: boolean;
  updated: number;
  skipped: number[];
}

interface BulkDeleteResponse {
  ok: boolean;
  deleted: number;
}

export default function TasksPage() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const { data: overview } = useOverview();

  const [view, setView] = useState<"all" | "suggested">("all");
  const [search, setSearch] = useState("");
  const [filterProject, setFilterProject] = useState<string>("all");
  const [filterPriority, setFilterPriority] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  // ?area=work|personal|learn|none, so a Home widget can open a pre-filtered list
  const [searchParams] = useSearchParams();
  const [filterArea, setFilterArea] = useState<string>(searchParams.get("area") ?? "all");
  const [olderOnly, setOlderOnly] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);

  // Multi-select
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // Two-click delete for a single row
  const [armedDeleteId, setArmedDeleteId] = useState<number | null>(null);

  // Quick add
  const [quickTitle, setQuickTitle] = useState("");
  const [quickPriority, setQuickPriority] = useState("medium");
  const [quickDueDate, setQuickDueDate] = useState("");

  // Edit
  const [editingTaskId, setEditingTaskId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editPriority, setEditPriority] = useState("medium");
  const [editDueDate, setEditDueDate] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editArea, setEditArea] = useState("");

  // Subtask add
  const [addingSubtaskFor, setAddingSubtaskFor] = useState<number | null>(null);
  const [subtaskTitle, setSubtaskTitle] = useState("");

  useEffect(() => {
    if (armedDeleteId === null) return;
    const t = window.setTimeout(() => setArmedDeleteId(null), 4000);
    return () => window.clearTimeout(t);
  }, [armedDeleteId]);

  function refreshTasks() {
    queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });
    queryClient.invalidateQueries({ queryKey: SUGGESTIONS_KEY });
  }

  const completeMutation = useMutation({
    mutationFn: (id: number) =>
      postApi<ApiOkResponse>(`/api/tasks/${id}/complete`),
    onSuccess: () => {
      showToast("Task completed!");
      refreshTasks();
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const addMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      postApi<ApiOkResponse>("/api/tasks", body),
    onSuccess: () => {
      showToast("Task added!");
      setQuickTitle("");
      setQuickDueDate("");
      queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteApi<ApiOkResponse>(`/api/tasks/${id}`),
    onSuccess: () => {
      showToast("Task deleted");
      refreshTasks();
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const bulkCompleteMutation = useMutation({
    mutationFn: (ids: number[]) =>
      postApi<BulkCompleteResponse>("/api/tasks-bulk/complete", { ids }),
    onSuccess: (res) => {
      const skipped = res.skipped.length ? ` (${res.skipped.length} already closed)` : "";
      showToast(`${res.updated} task${res.updated === 1 ? "" : "s"} marked done${skipped}`);
      setSelected(new Set());
      refreshTasks();
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: number[]) =>
      postApi<BulkDeleteResponse>("/api/tasks-bulk/delete", { ids }),
    onSuccess: (res) => {
      showToast(`${res.deleted} task${res.deleted === 1 ? "" : "s"} deleted`);
      setSelected(new Set());
      refreshTasks();
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const bulkBusy = bulkCompleteMutation.isPending || bulkDeleteMutation.isPending;

  const editMutation = useMutation({
    mutationFn: ({ id, fields }: { id: number; fields: Record<string, unknown> }) =>
      postApi<ApiOkResponse>(`/api/tasks/${id}/edit`, fields),
    onSuccess: () => {
      showToast("Task updated!");
      setEditingTaskId(null);
      queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const addSubtaskMutation = useMutation({
    mutationFn: ({ taskId, title }: { taskId: number; title: string }) =>
      postApi<ApiOkResponse>(`/api/tasks/${taskId}/subtasks`, { title }),
    onSuccess: () => {
      showToast("Subtask added!");
      setSubtaskTitle("");
      setAddingSubtaskFor(null);
      queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const completeSubtaskMutation = useMutation({
    mutationFn: ({ taskId, subtaskId }: { taskId: number; subtaskId: number }) =>
      postApi<ApiOkResponse>(`/api/tasks/${taskId}/subtasks/${subtaskId}/complete`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const tasks = useMemo(() => overview?.tasks.active ?? [], [overview]);
  const completedToday = overview?.tasks.completedToday ?? [];

  const oldCount = useMemo(
    () => tasks.filter((t) => ageDays(t.created_at) > OLD_DAYS).length,
    [tasks]
  );

  // Derive filter options
  const categories = useMemo(() => {
    const cats = new Set<string>();
    for (const t of tasks) cats.add(t.category);
    return Array.from(cats).sort();
  }, [tasks]);

  const projectIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of tasks) {
      if (t.project_id) ids.add(String(t.project_id));
    }
    return Array.from(ids);
  }, [tasks]);

  // Apply filters
  const filtered = useMemo(() => {
    let result = tasks;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.category.toLowerCase().includes(q) ||
          String(t.id).includes(q)
      );
    }
    if (filterProject !== "all") {
      result = result.filter((t) => String(t.project_id) === filterProject);
    }
    if (filterPriority !== "all") {
      result = result.filter((t) => t.priority === filterPriority);
    }
    if (filterStatus !== "all") {
      result = result.filter((t) => t.status === filterStatus);
    }
    if (filterArea !== "all") {
      result = result.filter((t) => (t.area ?? "none") === filterArea);
    }
    if (olderOnly) {
      result = result.filter((t) => ageDays(t.created_at) > OLD_DAYS);
    }
    return result;
  }, [tasks, search, filterProject, filterPriority, filterStatus, filterArea, olderOnly]);

  // Bulk actions only ever touch rows the user can currently see.
  const selectedVisible = useMemo(
    () => filtered.filter((t) => selected.has(t.id)).map((t) => t.id),
    [filtered, selected]
  );
  const allVisibleSelected = filtered.length > 0 && selectedVisible.length === filtered.length;

  function toggleSelected(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllVisible(checked: boolean) {
    setSelected(checked ? new Set(filtered.map((t) => t.id)) : new Set());
  }

  // Group by priority
  const priorityOrder = ["urgent", "high", "medium", "low"] as const;
  const grouped = useMemo(() => {
    const groups: Record<string, Task[]> = {};
    for (const p of priorityOrder) groups[p] = [];
    for (const t of filtered) {
      if (!groups[t.priority]) groups[t.priority] = [];
      groups[t.priority].push(t);
    }
    return groups;
  }, [filtered]);

  function handleAdd() {
    const title = quickTitle.trim();
    if (!title) return;
    const body: Record<string, unknown> = { title, priority: quickPriority };
    if (quickDueDate) body.due_date = quickDueDate;
    addMutation.mutate(body);
  }

  function startEdit(task: Task) {
    setEditingTaskId(task.id);
    setEditTitle(task.title);
    setEditPriority(task.priority);
    setEditDueDate(task.due_date || "");
    setEditCategory(task.category);
    setEditArea(task.area ?? "");
  }

  function saveEdit(id: number) {
    const title = editTitle.trim();
    if (!title) {
      showToast("Title required", "error");
      return;
    }
    const fields: Record<string, unknown> = {
      title,
      priority: editPriority,
      category: editCategory,
      area: editArea || null,
    };
    if (editDueDate) fields.due_date = editDueDate;
    editMutation.mutate({ id, fields });
  }

  function handleDelete(id: number) {
    if (armedDeleteId !== id) {
      setArmedDeleteId(id);
      return;
    }
    setArmedDeleteId(null);
    deleteMutation.mutate(id);
  }

  function handleAddSubtask(taskId: number) {
    const title = subtaskTitle.trim();
    if (!title) return;
    addSubtaskMutation.mutate({ taskId, title });
  }

  const statuses = useMemo(() => {
    const s = new Set<string>();
    for (const t of tasks) s.add(t.status);
    return Array.from(s).sort();
  }, [tasks]);

  if (!overview) {
    return (
      <div className="detail-page">
        <div className="loading">Loading tasks...</div>
      </div>
    );
  }

  return (
    <div className="detail-page">
      <a className="back-link" onClick={() => navigate("/")}>
        &larr; Back to Dashboard
      </a>
      <h2>Tasks ({tasks.length} active)</h2>

      <div className="tasks-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={view === "all"}
          className={`tasks-tab ${view === "all" ? "tasks-tab--on" : ""}`}
          onClick={() => setView("all")}
        >
          All tasks
        </button>
        <button
          role="tab"
          aria-selected={view === "suggested"}
          className={`tasks-tab ${view === "suggested" ? "tasks-tab--on" : ""}`}
          onClick={() => setView("suggested")}
        >
          Suggested done
        </button>
      </div>

      {view === "suggested" ? (
        <SuggestedDonePanel
          busy={bulkBusy}
          onComplete={(ids) => bulkCompleteMutation.mutateAsync(ids)}
          onDelete={(ids) => bulkDeleteMutation.mutateAsync(ids)}
        />
      ) : (
      <>
      {/* Stats bar */}
      <div className="mb-4 flex flex-wrap gap-4">
        <div className="rounded-lg bg-surface2 px-3.5 py-2 text-[.85rem]">
          <span className="font-semibold text-green">{completedToday.length}</span> completed today
        </div>
        <div className="rounded-lg bg-surface2 px-3.5 py-2 text-[.85rem]">
          <span className="font-semibold text-red">{tasks.filter((t) => t.priority === "urgent").length}</span> urgent
        </div>
        <div className="rounded-lg bg-surface2 px-3.5 py-2 text-[.85rem]">
          <span className="font-semibold text-amber">{tasks.filter((t) => t.priority === "high").length}</span> high priority
        </div>
        <div className="rounded-lg bg-surface2 px-3.5 py-2 text-[.85rem]">
          <span className="font-semibold text-amber">{oldCount}</span> older than {OLD_DAYS} days
        </div>
        {categories.map((cat) => (
          <div key={cat} className="max-w-full truncate rounded-lg bg-surface2 px-3.5 py-2 text-[.85rem]">
            {cat}: {tasks.filter((t) => t.category === cat).length}
          </div>
        ))}
      </div>

      {/* Search & filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          type="text"
          placeholder="Search tasks..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="min-w-[200px] flex-1"
        />
        <Select value={filterArea} onChange={(e) => setFilterArea(e.target.value)}>
          <option value="all">All areas</option>
          <option value="work">Work</option>
          <option value="personal">Personal</option>
          <option value="learn">Learn</option>
          <option value="none">Unsorted</option>
        </Select>
        <Select value={filterPriority} onChange={(e) => setFilterPriority(e.target.value)}>
          <option value="all">All Priorities</option>
          <option value="urgent">Urgent</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </Select>
        <Select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="all">All Statuses</option>
          {statuses.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </Select>
        {projectIds.length > 0 && (
          <Select value={filterProject} onChange={(e) => setFilterProject(e.target.value)}>
            <option value="all">All Projects</option>
            {projectIds.map((pid) => (
              <option key={pid} value={pid}>Project #{pid}</option>
            ))}
          </Select>
        )}
      </div>

      {/* Add task form */}
      <div className="mb-5 flex flex-wrap gap-2 rounded-lg bg-surface2 p-3">
        <Input
          type="text"
          placeholder="New task title..."
          value={quickTitle}
          onChange={(e) => setQuickTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
          className="min-w-[200px] flex-1 bg-surface1"
        />
        <Select value={quickPriority} onChange={(e) => setQuickPriority(e.target.value)} className="bg-surface1">
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="urgent">Urgent</option>
        </Select>
        <Input type="date" value={quickDueDate} onChange={(e) => setQuickDueDate(e.target.value)} className="bg-surface1" />
        <Button variant="primary" onClick={handleAdd} disabled={addMutation.isPending}>
          + Add Task
        </Button>
      </div>

      {/* Selection toolbar */}
      <div className="tasks-toolbar">
        <label className="tasks-selectall">
          <input
            type="checkbox"
            checked={allVisibleSelected}
            onChange={(e) => toggleSelectAllVisible(e.target.checked)}
          />
          Select all shown ({filtered.length})
        </label>
        <label className={`tasks-toggle ${olderOnly ? "tasks-toggle--on" : ""}`}>
          <input type="checkbox" checked={olderOnly} onChange={(e) => setOlderOnly(e.target.checked)} />
          Only older than {OLD_DAYS} days ({oldCount})
        </label>
      </div>

      <TaskBulkBar
        count={selectedVisible.length}
        busy={bulkBusy}
        onDone={() => bulkCompleteMutation.mutate(selectedVisible)}
        onDelete={() => bulkDeleteMutation.mutate(selectedVisible)}
        onClear={() => setSelected(new Set())}
      />

      {/* Task list grouped by priority */}
      {priorityOrder.map((priority) => {
        const group = grouped[priority];
        if (!group || group.length === 0) return null;
        const priorityColors: Record<string, string> = {
          urgent: "var(--red)",
          high: "var(--amber)",
          medium: "var(--blue)",
          low: "var(--text3)",
        };
        return (
          <div key={priority} className="mb-5">
            <h3 className="mb-2 text-[.9rem] tracking-[.05em] uppercase" style={{ color: priorityColors[priority] }}>
              {priority} ({group.length})
            </h3>
            {group.map((t) => {
              const age = ageDays(t.created_at);
              return (
              <div key={t.id} className="mb-2">
                {editingTaskId === t.id ? (
                  <div className="flex flex-col gap-2 rounded-lg bg-surface2 p-3">
                    <Input
                      type="text"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      className="bg-surface1"
                    />
                    <div className="flex flex-wrap gap-2">
                      <Select value={editPriority} onChange={(e) => setEditPriority(e.target.value)} className="bg-surface1">
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                        <option value="urgent">Urgent</option>
                      </Select>
                      <Select value={editArea} onChange={(e) => setEditArea(e.target.value)} title="Area" className="bg-surface1">
                        <option value="">Unsorted</option>
                        <option value="work">Work</option>
                        <option value="personal">Personal</option>
                        <option value="learn">Learn</option>
                      </Select>
                      <Input
                        type="text"
                        placeholder="Category"
                        value={editCategory}
                        onChange={(e) => setEditCategory(e.target.value)}
                        className="w-[120px] shrink-0 bg-surface1"
                      />
                      <Input type="date" value={editDueDate} onChange={(e) => setEditDueDate(e.target.value)} className="bg-surface1" />
                      <Button variant="success" size="sm" onClick={() => saveEdit(t.id)}>
                        Save
                      </Button>
                      <Button size="sm" onClick={() => setEditingTaskId(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div
                    className="flex items-center gap-2 rounded-lg bg-surface1 px-3 py-2"
                    style={{ borderLeft: `3px solid ${priorityColors[t.priority]}` }}
                  >
                    <input
                      type="checkbox"
                      className="tasks-row-check"
                      aria-label={`Select task ${t.id}`}
                      checked={selected.has(t.id)}
                      onChange={() => toggleSelected(t.id)}
                    />
                    <Button variant="ghost" size="sm" onClick={() => completeMutation.mutate(t.id)} title="Complete" className="!text-green">
                      {"✓"}
                    </Button>
                    <div className="min-w-0 flex-1 break-words">
                      <span className="text-[.85rem] font-semibold">#{t.id}</span>{" "}
                      <span>{t.title}</span>
                      {t.due_date && (
                        <span className="ml-2 text-xs text-fg3">{t.due_date}</span>
                      )}
                      <span className={`tasks-age ${age > OLD_DAYS ? "tasks-age--old" : ""}`} title={t.created_at}>
                        {age}d
                      </span>
                    </div>
                    {t.area && <span className={`rounded bg-surface2 px-2 py-0.5 text-[.72rem] capitalize ${AREA_COLOR[t.area]}`}>{t.area}</span>}
                    <span className="rounded bg-surface2 px-2 py-0.5 text-[.72rem] text-fg3">
                      {t.category}
                    </span>
                    <span className="text-[.72rem] text-fg3">{t.status}</span>
                    <Button variant="ghost" size="sm" onClick={() => startEdit(t)} title="Edit">
                      {"✎"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setAddingSubtaskFor(addingSubtaskFor === t.id ? null : t.id)}
                      title="Add subtask"
                    >
                      +sub
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      armed={armedDeleteId === t.id}
                      onClick={() => handleDelete(t.id)}
                      title={armedDeleteId === t.id ? "Click again to delete" : "Delete"}
                    >
                      {armedDeleteId === t.id ? "Delete?" : "✕"}
                    </Button>
                  </div>
                )}

                {/* Subtasks */}
                {t.subtasks && t.subtasks.length > 0 && (
                  <div className="mt-1 ml-8">
                    {t.subtasks.map((sub) => (
                      <div key={sub.id} className="flex items-center gap-2 py-1 text-[.82rem]">
                        <span
                          onClick={() => sub.status !== "done" && completeSubtaskMutation.mutate({ taskId: t.id, subtaskId: sub.id })}
                          className={sub.status !== "done" ? "cursor-pointer" : "cursor-default"}
                        >
                          {sub.status === "done" ? "✅" : "○"}
                        </span>
                        <span className={sub.status === "done" ? "text-fg3 line-through" : "text-fg"}>
                          {sub.title}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Add subtask form */}
                {addingSubtaskFor === t.id && (
                  <div className="mt-1.5 ml-8 flex gap-1.5">
                    <Input
                      type="text"
                      placeholder="Subtask title..."
                      value={subtaskTitle}
                      onChange={(e) => setSubtaskTitle(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleAddSubtask(t.id); }}
                      className="flex-1 text-[.82rem]"
                    />
                    <Button variant="primary" size="sm" onClick={() => handleAddSubtask(t.id)}>
                      Add
                    </Button>
                  </div>
                )}
              </div>
              );
            })}
          </div>
        );
      })}

      {filtered.length === 0 && <Empty>No tasks match your filters</Empty>}

      {/* Completed tasks history */}
      <div className="mt-6">
        <h3
          onClick={() => setShowCompleted(!showCompleted)}
          className="mb-2 cursor-pointer text-[.9rem] text-green"
        >
          {showCompleted ? "▼" : "▶"} Completed Today ({completedToday.length})
        </h3>
        {showCompleted && (
          <div>
            {completedToday.length === 0 ? (
              <div className="text-[.85rem] text-fg3">No tasks completed today</div>
            ) : (
              completedToday.map((c) => (
                <div key={c.id} className="flex justify-between border-b border-line px-3 py-1.5 text-[.85rem]">
                  <span className="truncate text-fg3 line-through">
                    #{c.id} {c.title}
                  </span>
                  <span className="shrink-0 text-xs text-fg3">{c.completed_at}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
      </>
      )}
    </div>
  );
}
