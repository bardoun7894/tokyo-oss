import { useEffect, useMemo, useState } from "react";
import { api, postApi } from "../../api/client";
import { control, errorText } from "./ui";

interface VoiceContact {
  jid: string;
  name: string;
  category: string;
  setting: "default" | "on" | "off";
  work: boolean;
  effective: boolean;
  voiceNotes: number;
}

const small = "rounded-md border border-line bg-bg2 px-1.5 py-1 text-[.78rem] text-fg1";

// Which contacts' voice notes are transcribed on arrival. Default = dev work
// (client category, or a name matching a project); the per-contact setting
// overrides it. Changing the category also changes what "Default" means, and so
// does renaming a contact after a project.
export function AutoTranscribeSettings() {
  const [contacts, setContacts] = useState<VoiceContact[] | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [savingJid, setSavingJid] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ jid: string; name: string } | null>(null);

  function load() {
    api<{ contacts: VoiceContact[]; categories: string[] }>("/api/settings/auto-transcribe")
      .then((d) => { setContacts(d.contacts); setCategories(d.categories); setError(""); })
      .catch((e: Error) => setError(e.message));
  }
  useEffect(load, []);

  async function save(jid: string, change: { setting?: string; category?: string; name?: string }) {
    setSavingJid(jid);
    try {
      await postApi("/api/settings/auto-transcribe", { jid, ...change });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingJid(null);
    }
  }

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (contacts ?? []).filter((c) => !q || c.name.toLowerCase().includes(q) || c.jid.includes(q));
  }, [contacts, query]);

  const onCount = (contacts ?? []).filter((c) => c.effective).length;

  return (
    <div className="mt-4 border-t border-line pt-3.5">
      <h4 className="mb-1 text-[.85rem] font-semibold text-fg1">Auto-transcribe voice notes</h4>
      <p className="mb-2.5 text-[.78rem] text-fg3">
        Default transcribes dev work only — the client category, or a name matching a project. Shop, family and
        personal never transcribe by default; the shop group still does, for the sales log. Other voice notes wait
        in Transcripts &gt; Pending. Click a name to rename it.{" "}
        {contacts && `${onCount} of ${contacts.length} contacts are on.`}
      </p>
      {error && <div className={`${errorText} mb-2`}>{error}</div>}
      <input className={`${control} mb-2 w-full`} placeholder="Search contacts..." value={query} onChange={(e) => setQuery(e.target.value)} />
      {!contacts ? (
        <div className="p-5 text-center text-[.85rem] text-fg3">Loading...</div>
      ) : (
        <div className="flex max-h-[300px] flex-col gap-1 overflow-y-auto overscroll-contain">
          {shown.map((c) => (
            <div key={c.jid}
              className={`flex flex-wrap items-center gap-2 rounded-lg border border-line bg-bg1 px-2 py-1.5 sm:flex-nowrap ${savingJid === c.jid ? "opacity-50" : ""}`}>
              <span className={`h-2 w-2 shrink-0 rounded-full ${c.effective ? "bg-green" : "bg-fg3"}`}
                title={c.effective ? "Transcribed automatically" : "Manual only"} />
              <div className="flex min-w-0 flex-1 basis-full flex-col sm:basis-auto">
                {editing?.jid === c.jid ? (
                  <input
                    className={`${control} w-full`}
                    autoFocus
                    value={editing.name}
                    placeholder="Name (empty = WhatsApp name)"
                    disabled={savingJid === c.jid}
                    onChange={(e) => setEditing({ jid: c.jid, name: e.target.value })}
                    onBlur={() => { const n = editing.name; setEditing(null); if (n !== c.name) save(c.jid, { name: n }); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setEditing(null);
                    }}
                  />
                ) : (
                  <button type="button" className="truncate text-left text-[.84rem] hover:underline"
                    title="Rename this contact" onClick={() => setEditing({ jid: c.jid, name: c.name })}>
                    {c.name}
                  </button>
                )}
                <small className="text-[.7rem] text-fg3">{c.voiceNotes} voice notes</small>
              </div>
              <select className={small} value={c.category} disabled={savingJid === c.jid} title="Contact category"
                onChange={(e) => save(c.jid, { category: e.target.value })}>
                {categories.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
              </select>
              <select className={small} value={c.setting} disabled={savingJid === c.jid} title="Auto-transcribe"
                onChange={(e) => save(c.jid, { setting: e.target.value })}>
                <option value="default">Default ({c.work ? "on" : "off"})</option>
                <option value="on">Always</option>
                <option value="off">Never</option>
              </select>
            </div>
          ))}
          {shown.length === 0 && <div className="p-5 text-center text-[.85rem] text-fg3">No contacts match</div>}
        </div>
      )}
    </div>
  );
}
