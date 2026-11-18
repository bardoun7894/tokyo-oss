import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import TaskBulkBar from "./TaskBulkBar";

export const SUGGESTIONS_KEY = ["tasks-bulk-suggestions"] as const;

type Classification = "LIKELY_DONE" | "OBSOLETE";

interface Suggestion {
  id: number;
  title: string;
  category: string;
  created: string;
  due: string | null;
  ageDays: number;
  classification: Classification;
  evidence: string[];
}

interface SuggestionsResponse {
  generatedAt: string | null;
  counts: Record<string, number>;
  suggestions: Suggestion[];
}

interface Props {
  busy: boolean;
  onComplete: (ids: number[]) => Promise<unknown>;
  onDelete: (ids: number[]) => Promise<unknown>;
}

const LABEL: Record<Classification, string> = {
  LIKELY_DONE: "Likely done",
  OBSOLETE: "Obsolete",
};

export default function SuggestedDonePanel({ busy, onComplete, onDelete }: Props) {
  const { data, isLoading, error } = useQuery<SuggestionsResponse>({
    queryKey: SUGGESTIONS_KEY,
    queryFn: () => api<SuggestionsResponse>("/api/tasks-bulk/suggestions"),
    staleTime: 60_000,
  });

  const [kind, setKind] = useState<"all" | Classification>("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState<number | null>(null);

  const rows = useMemo(() => {
    const all = data?.suggestions ?? [];
    return kind === "all" ? all : all.filter((s) => s.classification === kind);
  }, [data, kind]);

  // Everything visible starts selected; the user unticks what should stay open.
  useEffect(() => {
    setSelected(new Set(rows.map((r) => r.id)));
  }, [rows]);

  const chosen = rows.filter((r) => selected.has(r.id)).map((r) => r.id);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (isLoading) return <div className="loading">Loading suggestions...</div>;
  if (error) return <div className="tasks-empty">Could not load suggestions: {(error as Error).message}</div>;
  if (!data?.generatedAt) {
    return <div className="tasks-empty">No audit has been run yet.</div>;
  }

  const likely = data.suggestions.filter((s) => s.classification === "LIKELY_DONE").length;
  const obsolete = data.suggestions.length - likely;

  return (
    <div className="tasks-suggest">
      <p className="tasks-suggest__intro">
        Audit from {data.generatedAt.slice(0, 16).replace("T", " ")} UTC. These open tasks look finished or no
        longer relevant. Untick anything that should stay open, then confirm.
      </p>

      <div className="tasks-chips">
        {(["all", "LIKELY_DONE", "OBSOLETE"] as const).map((k) => (
          <button
            key={k}
            className={`tasks-chip ${kind === k ? "tasks-chip--on" : ""}`}
            onClick={() => setKind(k)}
          >
            {k === "all" ? `All (${data.suggestions.length})` : `${LABEL[k]} (${k === "LIKELY_DONE" ? likely : obsolete})`}
          </button>
        ))}
        <label className="tasks-selectall">
          <input
            type="checkbox"
            checked={rows.length > 0 && chosen.length === rows.length}
            onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
          />
          Select all
        </label>
      </div>

      <TaskBulkBar
        count={chosen.length}
        busy={busy}
        doneLabel={`Mark ${chosen.length} done`}
        onDone={() => void onComplete(chosen)}
        onDelete={() => void onDelete(chosen)}
        onClear={() => setSelected(new Set())}
      />

      {rows.length === 0 ? (
        <div className="tasks-empty">Nothing to suggest.</div>
      ) : (
        <ul className="tasks-suggest__list">
          {rows.map((s) => (
            <li key={s.id} className={`tasks-suggest__row ${selected.has(s.id) ? "is-selected" : ""}`}>
              <input
                type="checkbox"
                aria-label={`Select task ${s.id}`}
                checked={selected.has(s.id)}
                onChange={() => toggle(s.id)}
              />
              <div className="tasks-suggest__body">
                <div className="tasks-suggest__title">
                  <span className="tasks-id">#{s.id}</span> {s.title}
                </div>
                <div className="tasks-suggest__meta">
                  <span className={`tasks-badge tasks-badge--${s.classification.toLowerCase()}`}>
                    {LABEL[s.classification]}
                  </span>
                  <span>{s.category}</span>
                  <span>{s.ageDays}d old</span>
                  {s.due && <span>due {s.due.slice(0, 10)}</span>}
                </div>
                {s.evidence.length > 0 && (
                  <div className="tasks-suggest__evidence">
                    {expanded === s.id ? (
                      s.evidence.map((e, i) => <div key={i}>{e}</div>)
                    ) : (
                      <div>{s.evidence[0]}</div>
                    )}
                    {s.evidence.length > 1 && (
                      <button
                        className="tasks-link"
                        onClick={() => setExpanded(expanded === s.id ? null : s.id)}
                      >
                        {expanded === s.id ? "less" : `+${s.evidence.length - 1} more`}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
