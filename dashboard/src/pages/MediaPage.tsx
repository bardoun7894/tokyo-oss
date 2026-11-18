import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { api, postApi } from "../api/client";
import { useToast } from "../components/ui/Toast";
import { Button, Select as UiSelect } from "@bardouni/ui";

type MediaType = "all" | "image" | "video";

interface MediaItem {
  id: number;
  jid: string;
  chatName: string;
  sender: string | null;
  fromMe: boolean;
  timestamp: number;
  type: "image" | "video";
  file: string;
  caption: string;
}

interface MediaChat {
  jid: string;
  name: string;
  count: number;
}

const PAGE_SIZE = 60;

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function fmtDuration(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function dayLabel(ts: number): string {
  const d = new Date(ts * 1000);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

export default function MediaPage() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [type, setType] = useState<MediaType>("all");
  const [jid, setJid] = useState("");
  const [chats, setChats] = useState<MediaChat[]>([]);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [durations, setDurations] = useState<Record<number, number>>({});
  const sentinelRef = useRef<HTMLDivElement>(null);
  const reqRef = useRef(0);

  const loadChats = useCallback(() => {
    api<MediaChat[]>("/api/whatsapp/media/chats")
      .then((c) => setChats(c || []))
      .catch(() => setChats([]));
  }, []);

  useEffect(() => { loadChats(); }, [loadChats]);

  const loadPage = useCallback((before: number | null, reset: boolean) => {
    const req = ++reqRef.current;
    setLoading(true);
    const qs = new URLSearchParams({ type, limit: String(PAGE_SIZE) });
    if (jid) qs.set("jid", jid);
    if (before) qs.set("before", String(before));
    api<{ items: MediaItem[]; nextBefore: number | null }>(`/api/whatsapp/media?${qs}`)
      .then((r) => {
        if (req !== reqRef.current) return;
        setItems((prev) => (reset ? r.items : [...prev, ...r.items]));
        setNextBefore(r.nextBefore);
        setDone(r.nextBefore === null);
      })
      .catch((err: Error) => {
        if (req === reqRef.current) showToast(err.message || "Failed to load media", "error");
      })
      .finally(() => { if (req === reqRef.current) setLoading(false); });
  }, [type, jid, showToast]);

  // Reset whenever a filter changes
  useEffect(() => {
    setItems([]);
    setNextBefore(null);
    setDone(false);
    setSelected(new Set());
    setConfirming(false);
    loadPage(null, true);
  }, [loadPage]);

  // Infinite scroll
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !loading && !done && nextBefore) loadPage(nextBefore, false);
    }, { rootMargin: "600px" });
    obs.observe(el);
    return () => obs.disconnect();
  }, [loading, done, nextBefore, loadPage]);

  const open = openIdx !== null ? items[openIdx] : null;

  // Day sections; each entry keeps its index in `items` so the lightbox can walk the flat list.
  const groups = useMemo(() => {
    const byDay = new Map<string, { key: string; label: string; items: { m: MediaItem; i: number }[] }>();
    items.forEach((m, i) => {
      const key = new Date(m.timestamp * 1000).toDateString();
      let g = byDay.get(key);
      if (!g) {
        g = { key, label: dayLabel(m.timestamp), items: [] };
        byDay.set(key, g);
      }
      g.items.push({ m, i });
    });
    return [...byDay.values()];
  }, [items]);

  // Lightbox keyboard
  useEffect(() => {
    if (openIdx === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpenIdx(null); setConfirming(false); }
      if (e.key === "ArrowRight") { setOpenIdx((i) => (i !== null && i < items.length - 1 ? i + 1 : i)); setConfirming(false); }
      if (e.key === "ArrowLeft") { setOpenIdx((i) => (i !== null && i > 0 ? i - 1 : i)); setConfirming(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openIdx, items.length]);

  // Pull the next page in when the lightbox reaches the end of what is loaded
  useEffect(() => {
    if (openIdx !== null && openIdx >= items.length - 3 && !loading && !done && nextBefore) loadPage(nextBefore, false);
  }, [openIdx, items.length, loading, done, nextBefore, loadPage]);

  function deleteIds(ids: number[]) {
    postApi<{ ok: boolean; deleted: number }>("/api/whatsapp/media/delete", { ids })
      .then((r) => {
        const gone = new Set(ids);
        setItems((prev) => {
          const next = prev.filter((m) => !gone.has(m.id));
          setOpenIdx((i) => (i === null || next.length === 0 ? null : Math.min(i, next.length - 1)));
          return next;
        });
        setSelected(new Set());
        setConfirming(false);
        setSelecting(false);
        showToast(`Deleted ${r.deleted} file${r.deleted === 1 ? "" : "s"}`, "success");
        loadChats();
      })
      .catch((err: Error) => showToast(err.message || "Delete failed", "error"));
  }

  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setConfirming(false);
  }

  const chatTotal = chats.reduce((s, c) => s + c.count, 0);

  return (
    <div className="detail-page media-page">
      <a className="back-link" onClick={() => navigate("/")}>&larr; Back to Dashboard</a>
      <h2>WhatsApp Media</h2>

      <div className="media-toolbar">
        <div role="tablist" aria-label="Media type" className="inline-flex rounded-md border border-line bg-bg1 p-0.5">
          {(["all", "image", "video"] as MediaType[]).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={type === t}
              onClick={() => setType(t)}
              className={type === t ? "rounded bg-surface2 px-2.5 py-1 text-xs text-fg" : "rounded px-2.5 py-1 text-xs text-fg3 hover:text-fg"}
            >
              {t === "all" ? "All" : t === "image" ? "Images" : "Videos"}
            </button>
          ))}
        </div>
        <UiSelect value={jid} onChange={(e) => setJid(e.target.value)} className="max-w-[260px]">
          <option value="">All chats ({chatTotal})</option>
          {chats.map((c) => (
            <option key={c.jid} value={c.jid}>{c.name} ({c.count})</option>
          ))}
        </UiSelect>
        <div className="media-toolbar-right">
          {selecting ? (
            <>
              <span className="text-xs text-fg2">{selected.size} selected</span>
              <Button size="sm" onClick={() => { setSelected(new Set(items.map((m) => m.id))); setConfirming(false); }}>
                Select all ({items.length})
              </Button>
              {selected.size > 0 && (
                confirming ? (
                  <Button size="sm" variant="danger" armed onClick={() => deleteIds([...selected])}>Confirm delete {selected.size}</Button>
                ) : (
                  <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>Delete</Button>
                )
              )}
              <Button size="sm" onClick={() => { setSelecting(false); setSelected(new Set()); setConfirming(false); }}>Cancel</Button>
            </>
          ) : (
            <Button size="sm" onClick={() => setSelecting(true)} disabled={items.length === 0}>Select</Button>
          )}
        </div>
      </div>

      {groups.map((g) => (
        <section key={g.key} className="media-day">
          <div className="media-day-head">
            <span>{g.label}</span>
            <span className="media-day-count">{g.items.length}</span>
          </div>
          <div className="media-grid">
            {g.items.map(({ m, i }) => {
              const src = `/api/media/${m.file}`;
              const isSel = selected.has(m.id);
              return (
                <button
                  key={m.id}
                  className={`media-tile${isSel ? " selected" : ""}`}
                  onClick={() => (selecting ? toggleSelect(m.id) : setOpenIdx(i))}
                  title={`${m.chatName} · ${fmtDate(m.timestamp)}`}
                >
                  {m.type === "image" ? (
                    <img src={`${src}?w=320`} alt={m.caption || "WhatsApp image"} loading="lazy" decoding="async" />
                  ) : (
                    <>
                      <video
                        src={`${src}#t=0.5`}
                        preload="metadata"
                        muted
                        playsInline
                        onLoadedMetadata={(e) => {
                          const d = e.currentTarget.duration;
                          if (Number.isFinite(d)) setDurations((prev) => ({ ...prev, [m.id]: d }));
                        }}
                      />
                      <span className="media-play" aria-hidden>&#9654;</span>
                      {durations[m.id] !== undefined && <span className="media-duration">{fmtDuration(durations[m.id])}</span>}
                    </>
                  )}
                  <span className="media-tile-info" aria-hidden>
                    <span>{m.chatName}</span>
                    <span>{fmtTime(m.timestamp)}</span>
                  </span>
                  {selecting && <span className={`media-check${isSel ? " on" : ""}`} aria-hidden>{isSel ? "✓" : ""}</span>}
                </button>
              );
            })}
          </div>
        </section>
      ))}

      {!loading && items.length === 0 && <div className="loading">No media found.</div>}
      {loading && <div className="loading">Loading media...</div>}
      <div ref={sentinelRef} className="h-px" />

      {open && openIdx !== null && (
        <div className="media-lightbox" onClick={() => { setOpenIdx(null); setConfirming(false); }}>
          <div className="media-lightbox-top" onClick={(e) => e.stopPropagation()}>
            <div className="media-meta">
              <strong>{open.chatName}</strong>
              <span>{open.fromMe ? "You" : open.sender || ""} · {fmtDate(open.timestamp)}</span>
            </div>
            <div className="media-actions">
              <span className="media-position">{openIdx + 1} / {items.length}{done ? "" : "+"}</span>
              <a href={`/api/media/${open.file}`} target="_blank" rel="noreferrer">Open original</a>
              <a href={`/api/media/${open.file}`} download={open.file}>Download</a>
              {confirming ? (
                <Button size="sm" variant="danger" armed onClick={() => deleteIds([open.id])}>Confirm delete</Button>
              ) : (
                <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>Delete</Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => { setOpenIdx(null); setConfirming(false); }} aria-label="Close">&#10005;</Button>
            </div>
          </div>

          <div className="media-stage" onClick={(e) => e.stopPropagation()}>
            {openIdx > 0 && (
              <button className="media-nav prev" onClick={() => { setOpenIdx(openIdx - 1); setConfirming(false); }} aria-label="Previous">&#8249;</button>
            )}
            {open.type === "image" ? (
              <img key={open.id} src={`/api/media/${open.file}`} alt={open.caption || "WhatsApp image"} />
            ) : (
              <video key={open.id} src={`/api/media/${open.file}`} controls autoPlay playsInline />
            )}
            {openIdx < items.length - 1 && (
              <button className="media-nav next" onClick={() => { setOpenIdx(openIdx + 1); setConfirming(false); }} aria-label="Next">&#8250;</button>
            )}
          </div>

          {open.caption && <div className="media-caption" onClick={(e) => e.stopPropagation()}>{open.caption}</div>}
        </div>
      )}
    </div>
  );
}
