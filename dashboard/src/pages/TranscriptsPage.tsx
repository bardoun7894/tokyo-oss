import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { api, postApi } from "../api/client";
import { useToast } from "../components/ui/Toast";
import { Button, Input } from "@bardouni/ui";

type Tab = "done" | "pending";

interface Transcript {
  id: number;
  jid: string;
  sender_name: string | null;
  from_me: number;
  is_group: number;
  timestamp: number;
  transcription: string;
  duration_seconds: number | null;
}

interface Pending {
  id: number;
  jid: string;
  sender_name: string | null;
  from_me: number;
  is_group: number;
  timestamp: number;
  media_path: string;
}

const PAGE_SIZE = 25;

function fmtWhen(ts: number): string {
  return new Date(ts * 1000).toLocaleString("en-GB", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

function who(r: { from_me: number; sender_name: string | null; jid: string; is_group: number }): string {
  const name = r.from_me ? "You" : (r.sender_name || r.jid.split("@")[0]);
  return r.is_group ? `${name} (group)` : name;
}

export default function TranscriptsPage() {
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [tab, setTab] = useState<Tab>("done");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);

  const [items, setItems] = useState<Transcript[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [total, setTotal] = useState(0);
  const [pendingTotal, setPendingTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  // Per-row state for the Transcribe buttons, so one row working or failing does not
  // blank out the others.
  const [busy, setBusy] = useState<Record<number, boolean>>({});
  const [results, setResults] = useState<Record<number, string>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});

  const [uploadName, setUploadName] = useState("");
  const [uploadText, setUploadText] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const reqRef = useRef(0);

  const load = useCallback(() => {
    const req = ++reqRef.current;
    setLoading(true);
    const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (tab === "done" && query) qs.set("q", query);
    const url = tab === "done" ? `/api/transcripts?${qs}` : `/api/transcripts/pending?${qs}`;

    api<{ items: Transcript[] | Pending[]; total: number; pending?: number }>(url)
      .then((r) => {
        if (req !== reqRef.current) return;
        if (tab === "done") {
          setItems(r.items as Transcript[]);
          setTotal(r.total);
          if (typeof r.pending === "number") setPendingTotal(r.pending);
        } else {
          setPending(r.items as Pending[]);
          setPendingTotal(r.total);
        }
      })
      .catch((err: Error) => {
        if (req === reqRef.current) showToast(err.message || "Failed to load transcripts", "error");
      })
      .finally(() => { if (req === reqRef.current) setLoading(false); });
  }, [tab, query, offset, showToast]);

  useEffect(() => { load(); }, [load]);

  function switchTab(next: Tab) {
    if (next === tab) return;
    setTab(next);
    setOffset(0);
  }

  function runSearch() {
    setOffset(0);
    setQuery(search.trim());
  }

  function transcribeOne(id: number) {
    setBusy((b) => ({ ...b, [id]: true }));
    setErrors((e) => { const n = { ...e }; delete n[id]; return n; });
    postApi<{ id: number; transcription: string }>(`/api/transcripts/${id}/transcribe`)
      .then((r) => {
        setResults((s) => ({ ...s, [id]: r.transcription }));
        setPendingTotal((n) => Math.max(n - 1, 0));
        setTotal((n) => n + 1);
      })
      .catch((err: Error) => {
        setErrors((e) => ({ ...e, [id]: err.message || "Transcription failed" }));
      })
      .finally(() => setBusy((b) => ({ ...b, [id]: false })));
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploadName(f.name);
    setUploadText("");
    setUploading(true);
    const ext = (f.name.split(".").pop() || "ogg").toLowerCase();
    // Raw body, not JSON: the API route takes the audio bytes directly so a voice note
    // does not have to fit under the 100kb express.json cap.
    fetch(`/api/transcripts/upload?ext=${encodeURIComponent(ext)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${window.__TOKEN__ ?? ""}`,
        "Content-Type": "application/octet-stream",
      },
      body: f,
    })
      .then(async (r) => {
        const d = await r.json().catch(() => ({ error: r.statusText }));
        if (!r.ok) throw new Error(d.error || `Request failed: ${r.status}`);
        return d as { transcription: string };
      })
      .then((d) => setUploadText(d.transcription))
      .catch((err: Error) => showToast(err.message || "Upload failed", "error"))
      .finally(() => {
        setUploading(false);
        if (fileRef.current) fileRef.current.value = "";
      });
  }

  const shown = tab === "done" ? items.length : pending.length;
  const currentTotal = tab === "done" ? total : pendingTotal;
  const to = Math.min(offset + shown, currentTotal);

  return (
    <div className="detail-page transcripts-page">
      <a className="back-link" onClick={() => navigate("/")}>&larr; Back to Dashboard</a>
      <h2>Voice Transcripts</h2>

      <div className="media-toolbar">
        <div role="tablist" aria-label="Transcript view" className="inline-flex rounded-md border border-line bg-bg1 p-0.5">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "done"}
            onClick={() => switchTab("done")}
            className={tab === "done" ? "rounded bg-surface2 px-2.5 py-1 text-xs text-fg" : "rounded px-2.5 py-1 text-xs text-fg3 hover:text-fg"}
          >
            Transcribed ({total})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "pending"}
            onClick={() => switchTab("pending")}
            className={tab === "pending" ? "rounded bg-surface2 px-2.5 py-1 text-xs text-fg" : "rounded px-2.5 py-1 text-xs text-fg3 hover:text-fg"}
          >
            Pending ({pendingTotal})
          </button>
        </div>

        {tab === "done" && (
          <>
            <Input
              className="min-w-[180px] flex-1"
              type="search"
              placeholder="Search transcript or sender..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }}
            />
            <Button onClick={runSearch}>Search</Button>
          </>
        )}

        <div className="media-toolbar-right">
          <label className="inline-flex cursor-pointer items-center rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-fg hover:bg-surface1">
            {uploading ? "Transcribing..." : "Transcribe a file"}
            <input
              ref={fileRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={onFile}
              disabled={uploading}
            />
          </label>
        </div>
      </div>

      {uploadText && (
        <div className="tr-item tr-upload-result">
          <div className="tr-meta"><span className="tr-who">{uploadName}</span></div>
          <div className="tr-text" dir="auto">{uploadText}</div>
        </div>
      )}

      {loading && <div className="loading">Loading...</div>}

      {!loading && tab === "done" && items.length === 0 && (
        <div className="loading">{query ? "No transcripts match that search" : "No transcripts yet"}</div>
      )}

      {!loading && tab === "done" && items.map((t) => (
        <div key={t.id} className="tr-item">
          <div className="tr-meta">
            <span className="tr-who">{who(t)}</span>
            <span>
              {fmtWhen(t.timestamp)}
              {t.duration_seconds ? ` · ${Math.round(t.duration_seconds)}s` : ""}
            </span>
          </div>
          <div className="tr-text" dir="auto">{t.transcription}</div>
        </div>
      ))}

      {!loading && tab === "pending" && pending.length === 0 && (
        <div className="loading">Nothing pending &mdash; every voice note is transcribed</div>
      )}

      {!loading && tab === "pending" && pending.map((p) => (
        <div key={p.id} className="tr-item">
          <div className="tr-meta">
            <span className="tr-who">{who(p)}</span>
            <span className="tr-row-actions">
              <span>{fmtWhen(p.timestamp)}</span>
              <Button
                size="sm"
                disabled={busy[p.id] || Boolean(results[p.id])}
                onClick={() => transcribeOne(p.id)}
              >
                {busy[p.id] ? "Transcribing..." : results[p.id] ? "Done" : errors[p.id] ? "Retry" : "Transcribe"}
              </Button>
            </span>
          </div>
          {results[p.id] && <div className="tr-text" dir="auto">{results[p.id]}</div>}
          {errors[p.id] && <div className="tr-err">{errors[p.id]}</div>}
        </div>
      ))}

      {!loading && currentTotal > 0 && (
        <div className="tr-pager">
          <Button size="sm" disabled={offset <= 0} onClick={() => setOffset(Math.max(offset - PAGE_SIZE, 0))}>Prev</Button>
          <span>{offset + 1}-{to} of {currentTotal}</span>
          <Button size="sm" disabled={to >= currentTotal} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</Button>
        </div>
      )}
    </div>
  );
}
