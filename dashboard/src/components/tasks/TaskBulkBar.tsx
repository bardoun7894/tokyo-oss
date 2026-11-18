import { useEffect, useState } from "react";

interface Props {
  count: number;
  busy: boolean;
  onDone: () => void;
  onDelete: () => void;
  onClear: () => void;
  doneLabel?: string;
}

/** Sticky action bar for a multi-selection. Delete needs a second click within 4s. */
export default function TaskBulkBar({ count, busy, onDone, onDelete, onClear, doneLabel }: Props) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(t);
  }, [armed]);

  useEffect(() => {
    setArmed(false);
  }, [count]);

  if (count === 0) return null;

  return (
    <div className="tasks-bulkbar" role="toolbar" aria-label="Bulk task actions">
      <span className="tasks-bulkbar__count">{count} selected</span>
      <button className="tasks-btn tasks-btn--done" disabled={busy} onClick={onDone}>
        {doneLabel ?? "Mark done"}
      </button>
      <button
        className={`tasks-btn ${armed ? "tasks-btn--danger-armed" : "tasks-btn--danger"}`}
        disabled={busy}
        onClick={() => {
          if (!armed) {
            setArmed(true);
            return;
          }
          setArmed(false);
          onDelete();
        }}
      >
        {armed ? `Confirm delete ${count}` : "Delete"}
      </button>
      {armed && (
        <button className="tasks-btn tasks-btn--ghost" onClick={() => setArmed(false)}>
          Keep
        </button>
      )}
      <button className="tasks-btn tasks-btn--ghost" disabled={busy} onClick={onClear}>
        Clear
      </button>
    </div>
  );
}
