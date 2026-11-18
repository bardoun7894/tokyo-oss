import { useCallback, useEffect, useState } from "react";
import { api, deleteApi, postApi } from "../../api/client";
import { useToast } from "../ui/Toast";
import CaptionsEditor from "./CaptionsEditor";
import PublishPanel from "./PublishPanel";
import {
  PLATFORMS,
  PLATFORM_LABEL,
  STAGES,
  STAGE_LABEL,
  type ContentItem,
  type Format,
  type ItemDetail,
  type Platform,
  type PlatformsMeta,
  type Stage,
} from "./types";

type Tab = "plan" | "captions" | "publish";

interface Props {
  id: number;
  meta: PlatformsMeta | null;
  onClose: () => void;
  onChanged: () => void;
}

type Draft = Pick<ContentItem, "title" | "hook" | "script" | "notes" | "format" | "platforms">;

function toDraft(item: ContentItem): Draft {
  return {
    title: item.title,
    hook: item.hook,
    script: item.script,
    notes: item.notes,
    format: item.format,
    platforms: item.platforms,
  };
}

export default function ItemDrawer({ id, meta, onClose, onChanged }: Props) {
  const { showToast } = useToast();
  const [tab, setTab] = useState<Tab>("plan");
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const reload = useCallback(
    (resetDraft = false) =>
      api<ItemDetail>(`/api/content/items/${id}`)
        .then((d) => {
          setDetail(d);
          if (resetDraft) setDraft(toDraft(d.item));
          return d;
        })
        .catch((err: Error) => {
          showToast(err.message || "Failed to load item", "error");
          return null;
        }),
    [id, showToast]
  );

  useEffect(() => {
    reload(true);
  }, [reload]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const dirty =
    detail && draft ? JSON.stringify(toDraft(detail.item)) !== JSON.stringify(draft) : false;

  function save() {
    if (!draft) return;
    setSaving(true);
    postApi(`/api/content/items/${id}`, { ...draft })
      .then(() => reload(true))
      .then(() => {
        showToast("Saved", "success");
        onChanged();
      })
      .catch((err: Error) => showToast(err.message || "Save failed", "error"))
      .finally(() => setSaving(false));
  }

  function setStage(stage: Stage) {
    postApi(`/api/content/items/${id}`, { stage })
      .then(() => reload(false))
      .then(onChanged)
      .catch((err: Error) => showToast(err.message || "Move failed", "error"));
  }

  function remove() {
    deleteApi(`/api/content/items/${id}`)
      .then(() => {
        showToast("Item deleted", "success");
        onClose();
      })
      .catch((err: Error) => showToast(err.message || "Delete failed", "error"));
  }

  function togglePlatform(p: Platform) {
    setDraft((d) =>
      d ? { ...d, platforms: d.platforms.includes(p) ? d.platforms.filter((x) => x !== p) : PLATFORMS.filter((x) => x === p || d.platforms.includes(x)) } : d
    );
  }

  return (
    <div className="cs-overlay" onClick={onClose}>
      <aside className="cs-drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Content item">
        {!detail || !draft ? (
          <div className="loading">Loading…</div>
        ) : (
          <>
            <div className="cs-drawer-head">
              <input
                className="cs-title-input"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                maxLength={300}
                aria-label="Title"
              />
              <button className="cs-icon" onClick={onClose} aria-label="Close">&#10005;</button>
            </div>

            <div className="cs-drawer-sub">
              <select
                value={detail.item.stage}
                onChange={(e) => setStage(e.target.value as Stage)}
                aria-label="Stage"
              >
                {STAGES.map((s) => (
                  <option key={s} value={s} disabled={s === "scheduled" && detail.item.stage !== "scheduled"}>
                    {STAGE_LABEL[s]}
                  </option>
                ))}
              </select>
              <div className="cs-seg small">
                {(["plan", "captions", "publish"] as Tab[]).map((t) => (
                  <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
                    {t === "plan" ? "Plan" : t === "captions" ? "Captions" : "Publish"}
                  </button>
                ))}
              </div>
            </div>

            <div className="cs-drawer-body">
              {tab === "plan" && (
                <div className="cs-form">
                  <label>
                    <span>Format</span>
                    <div className="cs-seg small">
                      {(["short", "long"] as Format[]).map((f) => (
                        <button key={f} className={draft.format === f ? "active" : ""} onClick={() => setDraft({ ...draft, format: f })}>
                          {f === "short" ? "Short (vertical)" : "Long-form"}
                        </button>
                      ))}
                    </div>
                  </label>
                  <label>
                    <span>Target platforms</span>
                    <div className="cs-checks">
                      {PLATFORMS.map((p) => (
                        <label key={p} className="cs-check">
                          <input type="checkbox" checked={draft.platforms.includes(p)} onChange={() => togglePlatform(p)} />
                          {PLATFORM_LABEL[p]}
                        </label>
                      ))}
                    </div>
                  </label>
                  <label>
                    <span>Hook</span>
                    <input value={draft.hook} onChange={(e) => setDraft({ ...draft, hook: e.target.value })} maxLength={2000} placeholder="First 3 seconds — why keep watching?" />
                  </label>
                  <label>
                    <span>Script</span>
                    <textarea className="cs-script" value={draft.script} onChange={(e) => setDraft({ ...draft, script: e.target.value })} placeholder="Write the script…" />
                  </label>
                  <label>
                    <span>Notes</span>
                    <textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} rows={4} placeholder="B-roll, links, references…" />
                  </label>
                  <div className="cs-form-actions">
                    <button className="cs-primary" onClick={save} disabled={!dirty || saving || !draft.title.trim()}>
                      {saving ? "Saving…" : dirty ? "Save" : "Saved"}
                    </button>
                    <div className="cs-spacer" />
                    {confirmDelete ? (
                      <>
                        <button className="cs-danger" onClick={remove}>Confirm delete</button>
                        <button onClick={() => setConfirmDelete(false)}>Keep</button>
                      </>
                    ) : (
                      <button className="cs-danger-outline" onClick={() => setConfirmDelete(true)}>Delete item</button>
                    )}
                  </div>
                </div>
              )}

              {tab === "captions" && (
                <CaptionsEditor
                  itemId={id}
                  format={detail.item.format}
                  platforms={detail.item.platforms}
                  initial={detail.captions}
                  meta={meta}
                  unsavedPlan={dirty}
                  onSaved={() => reload(false)}
                />
              )}

              {tab === "publish" && (
                <PublishPanel detail={detail} meta={meta} reload={() => reload(false)} onChanged={onChanged} />
              )}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
