import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useOverview, OVERVIEW_KEY } from "../hooks/useOverview";
import { api, postApi, deleteApi } from "../api/client";
import { useToast } from "../components/ui/Toast";
import type { ApiOkResponse, HabitToggleResponse } from "../types";
import { Button, Input, Select, Chip } from "@bardouni/ui";

interface HabitHistoryDay {
  date: string;
  habits: Record<number, boolean>;
}

export default function HabitsPage() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const { data: overview } = useOverview();

  const [newName, setNewName] = useState("");
  const [newFreq, setNewFreq] = useState("daily");
  const [history, setHistory] = useState<HabitHistoryDay[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  useEffect(() => {
    api<HabitHistoryDay[]>("/api/habits/history?days=7")
      .then((data) => {
        setHistory(data || []);
        setHistoryLoading(false);
      })
      .catch(() => {
        setHistoryLoading(false);
      });
  }, []);

  const toggleMutation = useMutation({
    mutationFn: (id: number) =>
      postApi<HabitToggleResponse>(`/api/habits/${id}/check`),
    onSuccess: (data) => {
      showToast(data.done ? "Habit checked!" : "Habit unchecked");
      queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const addMutation = useMutation({
    mutationFn: (body: { name: string; frequency: string }) =>
      postApi<ApiOkResponse>("/api/habits", body),
    onSuccess: () => {
      showToast("Habit added!");
      setNewName("");
      queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      deleteApi<ApiOkResponse>(`/api/habits/${id}`),
    onSuccess: () => {
      showToast("Habit removed");
      queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  function handleAdd() {
    const name = newName.trim();
    if (!name) return;
    addMutation.mutate({ name, frequency: newFreq });
  }

  function handleDelete(id: number, name: string) {
    if (!confirm(`Remove habit: ${name}?`)) return;
    deleteMutation.mutate(id);
  }

  const h = overview?.habits;
  const items = h?.items ?? [];
  const pct = h && h.totalCount > 0 ? (h.completedCount / h.totalCount) * 100 : 0;

  // Completion ring SVG
  const r = 30;
  const c = 2 * Math.PI * r;
  const offset = c - (pct / 100) * c;

  // Build 7-day labels
  const dayLabels: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dayLabels.push(d.toISOString().slice(0, 10));
  }

  if (!overview) {
    return (
      <div className="detail-page">
        <div className="loading">Loading habits...</div>
      </div>
    );
  }

  return (
    <div className="detail-page">
      <a className="back-link" onClick={() => navigate("/")}>
        &larr; Back to Dashboard
      </a>
      <h2>Habits</h2>

      {/* Completion ring + stats */}
      <div className="mb-6 flex items-center gap-6">
        <div className="relative h-[72px] w-[72px]">
          <svg width="72" height="72" viewBox="0 0 72 72">
            <circle cx="36" cy="36" r={r} fill="none" stroke="var(--surface2)" strokeWidth="5" />
            <circle
              cx="36" cy="36" r={r}
              fill="none"
              stroke="var(--green)"
              strokeWidth="5"
              strokeDasharray={c.toFixed(1)}
              strokeDashoffset={offset.toFixed(1)}
              strokeLinecap="round"
              transform="rotate(-90 36 36)"
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center text-base font-semibold">
            {Math.round(pct)}%
          </div>
        </div>
        <div>
          <div className="text-[1.3rem] font-semibold">
            {h?.completedCount ?? 0} / {h?.totalCount ?? 0}
          </div>
          <div className="text-[.85rem] text-fg2">completed today</div>
        </div>
      </div>

      {/* Habit list with streaks */}
      <div className="mb-6">
        {items.length === 0 ? (
          <div className="text-[.85rem] text-fg3">No habits tracked yet</div>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              className="mb-1.5 flex items-center gap-2.5 rounded-lg bg-surface1 px-3 py-2.5"
              style={{ borderLeft: item.done ? "3px solid var(--green)" : "3px solid var(--surface2)" }}
            >
              <span
                onClick={() => toggleMutation.mutate(item.id)}
                className="cursor-pointer text-[1.1rem]"
              >
                {item.done ? "\u2705" : "\u2B1C"}
              </span>
              <span className="min-w-0 flex-1 cursor-pointer truncate" onClick={() => toggleMutation.mutate(item.id)}>
                {item.name}
              </span>
              <span className="shrink-0 text-xs text-fg3">{item.frequency}</span>
              {item.streak > 0 && (
                <span className="shrink-0 text-[.82rem] text-amber">
                  {"\u{1F525}"}{item.streak}d
                </span>
              )}
              {item.category && <Chip>{item.category}</Chip>}
              <Button variant="danger" size="sm" onClick={() => handleDelete(item.id, item.name)}>
                {"\u2715"}
              </Button>
            </div>
          ))
        )}
      </div>

      {/* Add habit form */}
      <div className="mb-6 flex flex-wrap gap-2 rounded-lg bg-surface2 p-3">
        <Input
          type="text"
          placeholder="New habit name..."
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
          className="min-w-[200px] flex-1 bg-surface1"
        />
        <Select value={newFreq} onChange={(e) => setNewFreq(e.target.value)} className="bg-surface1">
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </Select>
        <Button variant="primary" onClick={handleAdd} disabled={addMutation.isPending}>
          + Add
        </Button>
      </div>

      {/* Weekly completion grid */}
      <h3 className="mb-3 text-[.9rem] text-fg2">7-Day Completion Grid</h3>
      {historyLoading ? (
        <div className="loading">Loading history...</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[.78rem]">
            <thead>
              <tr>
                <th className="border-b border-line px-2 py-1.5 text-left text-fg2">Habit</th>
                {dayLabels.map((d) => (
                  <th key={d} className="min-w-[40px] border-b border-line px-1 py-1.5 text-center text-fg3">
                    {d.slice(5)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td className="max-w-[160px] truncate border-b border-line px-2 py-1.5">{item.name}</td>
                  {dayLabels.map((d) => {
                    const dayData = history.find((h) => h.date === d);
                    const done = dayData?.habits?.[item.id] ?? false;
                    return (
                      <td key={d} className="border-b border-line px-1 py-1.5 text-center">
                        {done ? (
                          <span className="text-green">{"\u2705"}</span>
                        ) : (
                          <span className="text-surface2">{"\u25CB"}</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
