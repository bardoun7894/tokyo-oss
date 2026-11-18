import { useEffect, useState } from "react";
import { postApi } from "../../api/client";
import { useToast } from "../ui/Toast";
import {
  PLATFORMS,
  PLATFORM_LABEL,
  type Caption,
  type CaptionField,
  type Format,
  type Platform,
  type PlatformsMeta,
} from "./types";

interface Props {
  itemId: number;
  format: Format;
  platforms: Platform[];
  initial: Record<Platform, Caption>;
  meta: PlatformsMeta | null;
  unsavedPlan: boolean;
  onSaved: () => void;
}

const FALLBACK_FIELDS: Record<Platform, CaptionField[]> = {
  youtube: ["title", "description", "hashtags"],
  tiktok: ["caption", "hashtags"],
  instagram: ["caption", "hashtags"],
  facebook: ["title", "description", "hashtags"],
  linkedin: ["title", "caption", "hashtags"],
};

const FIELD_LABEL: Record<CaptionField, string> = {
  title: "Title",
  description: "Description",
  caption: "Caption",
  hashtags: "Hashtags",
};

export default function CaptionsEditor({ itemId, format, platforms, initial, meta, unsavedPlan, onSaved }: Props) {
  const { showToast } = useToast();
  const shown = platforms.length ? platforms : PLATFORMS;
  const [active, setActive] = useState<Platform>(shown[0]);
  const [captions, setCaptions] = useState<Record<Platform, Caption>>(initial);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [drafting, setDrafting] = useState(false);

  useEffect(() => {
    if (!shown.includes(active)) setActive(shown[0]);
  }, [shown, active]);

  const fields = (meta?.fields ?? FALLBACK_FIELDS)[active];
  const limits = meta?.limits[active] ?? {};
  const c = captions[active];
  const body: CaptionField = fields.includes("description") ? "description" : "caption";

  function limitFor(field: CaptionField): number | undefined {
    let limit = limits[field];
    if (limit && field === "title" && active === "youtube" && format === "short") limit -= " #Shorts".length;
    if (limit && field === body && c.hashtags.trim()) limit -= c.hashtags.trim().length + 2;
    return limit;
  }

  function set(field: CaptionField, value: string) {
    setCaptions((prev) => ({ ...prev, [active]: { ...prev[active], [field]: value } }));
    setDirty(true);
  }

  function save() {
    setSaving(true);
    postApi<{ ok: boolean; captions: Record<Platform, Caption> }>(`/api/content/items/${itemId}/captions`, { captions })
      .then((r) => {
        setCaptions(r.captions);
        setDirty(false);
        showToast("Captions saved", "success");
        onSaved();
      })
      .catch((err: Error) => showToast(err.message || "Save failed", "error"))
      .finally(() => setSaving(false));
  }

  function draftWithAi() {
    setDrafting(true);
    postApi<{ ok: boolean; drafts: Partial<Record<Platform, Caption>> }>(`/api/content/items/${itemId}/captions/draft`, {
      platforms: shown,
    })
      .then((r) => {
        setCaptions((prev) => {
          const next = { ...prev };
          for (const p of PLATFORMS) if (r.drafts[p]) next[p] = r.drafts[p]!;
          return next;
        });
        setDirty(true);
        showToast("Draft ready — review, then save", "info");
      })
      .catch((err: Error) => showToast(err.message || "AI draft failed", "error"))
      .finally(() => setDrafting(false));
  }

  return (
    <div className="cs-captions">
      <div className="cs-captions-bar">
        <div className="cs-seg small">
          {shown.map((p) => (
            <button key={p} className={active === p ? "active" : ""} onClick={() => setActive(p)}>
              {PLATFORM_LABEL[p]}
            </button>
          ))}
        </div>
        <div className="cs-spacer" />
        <button onClick={draftWithAi} disabled={drafting} title={unsavedPlan ? "Save the plan first so the AI sees your latest script" : ""}>
          {drafting ? "Drafting…" : "Draft with AI"}
        </button>
        <button className="cs-primary" onClick={save} disabled={!dirty || saving}>
          {saving ? "Saving…" : dirty ? "Save captions" : "Saved"}
        </button>
      </div>
      {unsavedPlan && <p className="cs-note">The plan has unsaved edits. The AI drafts from the saved title, hook and script.</p>}
      {!platforms.length && <p className="cs-note">No target platforms picked on the Plan tab — showing all five.</p>}

      <div className="cs-form">
        {fields.map((f) => {
          const limit = limitFor(f);
          const len = c[f].length;
          const over = limit !== undefined && f !== "hashtags" && len > limit;
          return (
            <label key={f}>
              <span>
                {FIELD_LABEL[f]}
                {limit !== undefined && f !== "hashtags" && (
                  <em className={`cs-counter${over ? " over" : ""}`}>{len}/{limit}</em>
                )}
              </span>
              {f === "title" || f === "hashtags" ? (
                <input value={c[f]} onChange={(e) => set(f, e.target.value)} placeholder={f === "hashtags" ? "#buildinpublic #ai" : ""} />
              ) : (
                <textarea value={c[f]} onChange={(e) => set(f, e.target.value)} rows={8} />
              )}
            </label>
          );
        })}
        <p className="cs-note">Hashtags are appended to the {FIELD_LABEL[body].toLowerCase()} when publishing; over-long text is trimmed to the limit.</p>
      </div>
    </div>
  );
}
