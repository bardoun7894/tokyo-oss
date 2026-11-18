import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  useGoals,
  useCreateGoal,
  useUpdateGoalValue,
  useDeleteGoal,
} from "../hooks/useGoals";
import { useToast } from "../components/ui/Toast";
import { Button, Input, Select, Empty, cx } from "@bardouni/ui";
import type { GoalMetric, GoalPeriod } from "../types";

const METRICS: { value: GoalMetric; label: string }[] = [
  { value: "income", label: "Income" },
  { value: "quran_pages", label: "Quran Pages" },
  { value: "work_hours", label: "Work Hours" },
  { value: "tasks", label: "Tasks" },
  { value: "habits", label: "Habits" },
  { value: "custom", label: "Custom" },
];

const PERIODS: { value: GoalPeriod; label: string }[] = [
  { value: "monthly", label: "Monthly" },
  { value: "weekly", label: "Weekly" },
  { value: "yearly", label: "Yearly" },
];

export default function GoalsPage() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { data: goals, isLoading, isError } = useGoals();

  const createGoal = useCreateGoal();
  const updateValue = useUpdateGoalValue();
  const deleteGoal = useDeleteGoal();

  const [title, setTitle] = useState("");
  const [metric, setMetric] = useState<GoalMetric>("income");
  const [target, setTarget] = useState("");
  const [period, setPeriod] = useState<GoalPeriod>("monthly");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");

  function handleAdd() {
    const trimmedTitle = title.trim();
    const targetNum = parseFloat(target);
    if (!trimmedTitle || !targetNum) {
      showToast("Fill title and target", "error");
      return;
    }
    createGoal.mutate(
      { title: trimmedTitle, metric, targetValue: targetNum, period },
      {
        onSuccess: () => {
          showToast("Goal created!");
          setTitle("");
          setTarget("");
        },
        onError: (err) => showToast(err.message || "Failed", "error"),
      }
    );
  }

  function handleDelete(id: number) {
    if (!confirm("Delete this goal?")) return;
    deleteGoal.mutate(id, {
      onSuccess: () => showToast("Goal deleted"),
      onError: (err) => showToast(err.message || "Failed", "error"),
    });
  }

  function handleUpdateValue(id: number) {
    const num = parseFloat(editValue);
    if (isNaN(num)) return;
    updateValue.mutate(
      { id, value: num },
      {
        onSuccess: () => {
          showToast("Goal updated!");
          setEditingId(null);
          setEditValue("");
        },
        onError: (err) => showToast(err.message || "Failed", "error"),
      }
    );
  }

  function fillColor(pct: number): string {
    if (pct >= 100) return "green";
    if (pct >= 75) return "blue";
    if (pct >= 50) return "accent";
    return "amber";
  }

  // Literal class strings so Tailwind's static scan can find them (dynamic
  // template interpolation like `border-l-${color}` would not be detected).
  const BORDER_TONE: Record<string, string> = {
    green: "border-l-green",
    blue: "border-l-blue",
    accent: "border-l-accent",
    amber: "border-l-amber",
  };
  const TEXT_TONE: Record<string, string> = {
    green: "text-green",
    blue: "text-blue",
    accent: "text-accent",
    amber: "text-amber",
  };

  if (isLoading) {
    return (
      <div className="detail-page">
        <div className="loading">Loading goals...</div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="detail-page">
        <a className="back-link" onClick={() => navigate("/")}>
          &larr; Back to Dashboard
        </a>
        <h2>Goals</h2>
        <div className="loading">Failed to load goals</div>
      </div>
    );
  }

  // Group goals by period
  const grouped: Record<string, typeof goals> = { weekly: [], monthly: [], yearly: [] };
  for (const g of goals || []) {
    if (!grouped[g.period]) grouped[g.period] = [];
    grouped[g.period]!.push(g);
  }

  return (
    <div className="detail-page">
      <a className="back-link" onClick={() => navigate("/")}>
        &larr; Back to Dashboard
      </a>
      <h2>Goals</h2>

      {/* Add goal form */}
      <div className="mb-6 rounded-lg bg-surface2 p-3.5">
        <div className="mb-2 text-[.85rem] font-semibold">Add New Goal</div>
        <div className="flex flex-wrap gap-2">
          <Input
            type="text"
            placeholder="Goal title..."
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="min-w-[180px] flex-1"
          />
          <Select value={metric} onChange={(e) => setMetric(e.target.value as GoalMetric)}>
            {METRICS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </Select>
          <Input
            type="number"
            placeholder="Target"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="w-[100px] flex-none"
          />
          <Select value={period} onChange={(e) => setPeriod(e.target.value as GoalPeriod)}>
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </Select>
          <Button variant="primary" className="font-semibold" onClick={handleAdd} disabled={createGoal.isPending}>
            + Add Goal
          </Button>
        </div>
      </div>

      {/* Goals by period */}
      {(["weekly", "monthly", "yearly"] as const).map((periodKey) => {
        const periodGoals = grouped[periodKey];
        if (!periodGoals || periodGoals.length === 0) return null;
        return (
          <div key={periodKey} className="mb-6">
            <h3 className="mb-3 text-[.9rem] text-fg2 capitalize">
              {periodKey} Goals ({periodGoals.length})
            </h3>
            {periodGoals.map((g) => {
              const pctVal = Math.round(g.progress);
              const color = fillColor(pctVal);

              return (
                <div key={g.id} className={cx("mb-2.5 rounded-lg border-l-[3px] bg-surface1 p-3.5", BORDER_TONE[color])}>
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1 truncate">
                      <span className="text-[.92rem] font-semibold">{g.title}</span>
                      <span className="ml-2 text-[.72rem] text-fg3">{g.metric}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2.5">
                      <span className={cx("text-[1.1rem] font-semibold", TEXT_TONE[color])}>{pctVal}%</span>
                      <Button variant="danger" size="sm" onClick={() => handleDelete(g.id)} title="Delete">
                        {"\u2715"}
                      </Button>
                    </div>
                  </div>

                  <div className="progress" style={{ height: 10, marginBottom: 6 }}>
                    <div
                      className={`fill fill-${color}`}
                      style={{ width: `${Math.min(100, g.progress).toFixed(1)}%` }}
                    />
                  </div>

                  <div className="flex justify-between text-[.82rem] text-fg2">
                    <span>{g.currentValue} / {g.target_value}</span>
                    <div className="flex items-center gap-1.5">
                      {g.metric === "custom" && (
                        editingId === g.id ? (
                          <>
                            <Input
                              type="number"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") handleUpdateValue(g.id); }}
                              className="w-[70px] flex-none"
                              autoFocus
                            />
                            <Button variant="success" size="sm" onClick={() => handleUpdateValue(g.id)}>
                              Save
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => { setEditingId(null); setEditValue(""); }}>
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <Button variant="on" size="sm" onClick={() => { setEditingId(g.id); setEditValue(String(g.currentValue)); }}>
                            Update Value
                          </Button>
                        )
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}

      {(!goals || goals.length === 0) && (
        <Empty>No goals set yet. Add your first goal above.</Empty>
      )}
    </div>
  );
}
