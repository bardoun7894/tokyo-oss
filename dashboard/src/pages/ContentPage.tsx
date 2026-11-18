import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, postApi } from "../api/client";
import { useToast } from "../components/ui/Toast";
import ItemDrawer from "../components/content/ItemDrawer";
import CalendarView from "../components/content/CalendarView";
import {
  PLATFORM_SHORT,
  STAGES,
  STAGE_LABEL,
  fmtWhen,
  type BoardItem,
  type PlatformsMeta,
  type Stage,
} from "../components/content/types";

type Tab = "board" | "calendar";

export default function ContentPage() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [tab, setTab] = useState<Tab>("board");
  const [items, setItems] = useState<BoardItem[]>([]);
  const [meta, setMeta] = useState<PlatformsMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<number | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropStage, setDropStage] = useState<Stage | null>(null);

  const load = useCallback(() => {
    api<BoardItem[]>("/api/content/items")
      .then((r) => setItems(r || []))
      .catch((err: Error) => showToast(err.message || "Failed to load content", "error"))
      .finally(() => setLoading(false));
  }, [showToast]);

  useEffect(() => {
    load();
    api<PlatformsMeta>("/api/content/platforms")
      .then(setMeta)
      .catch(() => setMeta(null));
  }, [load]);

  function create() {
    const title = newTitle.trim();
    if (!title) return;
    postApi<{ ok: boolean; item: BoardItem }>("/api/content/items", { title })
      .then((r) => {
        setNewTitle("");
        load();
        setOpenId(r.item.id);
      })
      .catch((err: Error) => showToast(err.message || "Could not create", "error"));
  }

  function move(item: BoardItem, stage: Stage) {
    if (item.stage === stage) return;
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, stage } : i)));
    postApi(`/api/content/items/${item.id}`, { stage })
      .then(load)
      .catch((err: Error) => {
        showToast(err.message || "Move failed", "error");
        load();
      });
  }

  function shift(item: BoardItem, dir: -1 | 1) {
    const idx = STAGES.indexOf(item.stage) + dir;
    if (idx < 0 || idx >= STAGES.length) return;
    move(item, STAGES[idx]);
  }

  const connected = meta?.platforms.filter((p) => p.connected && p.configured) ?? [];

  return (
    <div className="detail-page content-page">
      <a className="back-link" onClick={() => navigate("/")}>&larr; Back to Dashboard</a>
      <h2>Content Studio</h2>

      <div className="cs-toolbar">
        <div className="cs-seg">
          <button className={tab === "board" ? "active" : ""} onClick={() => setTab("board")}>Board</button>
          <button className={tab === "calendar" ? "active" : ""} onClick={() => setTab("calendar")}>Calendar</button>
        </div>
        <form
          className="cs-new"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="New video idea…" maxLength={300} />
          <button type="submit" className="cs-primary" disabled={!newTitle.trim()}>Add idea</button>
        </form>
        {meta && (
          <div className="cs-connected" title={meta.platforms.map((p) => `${p.label}: ${p.configured ? "ready" : p.missing}`).join("\n")}>
            {meta.platforms.map((p) => (
              <span key={p.platform} className={`cs-dot ${p.configured ? "on" : ""}`}>{PLATFORM_SHORT[p.platform]}</span>
            ))}
            <span className="cs-muted">{connected.length}/{meta.platforms.length} ready</span>
          </div>
        )}
      </div>

      {tab === "board" && (
        <div className="cs-board">
          {STAGES.map((stage) => {
            const col = items.filter((i) => i.stage === stage);
            return (
              <section
                key={stage}
                className={`cs-col${dropStage === stage ? " drop" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropStage(stage);
                }}
                onDragLeave={() => setDropStage((s) => (s === stage ? null : s))}
                onDrop={(e) => {
                  e.preventDefault();
                  const item = items.find((i) => i.id === dragId);
                  setDropStage(null);
                  setDragId(null);
                  if (item) move(item, stage);
                }}
              >
                <header>
                  <span>{STAGE_LABEL[stage]}</span>
                  <span className="cs-count">{col.length}</span>
                </header>
                {col.map((item) => (
                  <article
                    key={item.id}
                    className="cs-card"
                    draggable
                    onDragStart={() => setDragId(item.id)}
                    onDragEnd={() => {
                      setDragId(null);
                      setDropStage(null);
                    }}
                    onClick={() => setOpenId(item.id)}
                  >
                    <div className="cs-card-title">{item.title}</div>
                    {item.hook && <div className="cs-card-hook">{item.hook}</div>}
                    <div className="cs-card-meta">
                      <span className={`cs-badge ${item.format}`}>{item.format === "short" ? "Short" : "Long"}</span>
                      {item.video_path && <span className="cs-badge video">Video</span>}
                      {item.platforms.map((p) => {
                        const pub = item.publications.find((x) => x.platform === p);
                        return (
                          <span key={p} className={`cs-chip ${pub ? `st-${pub.status}` : ""}`} title={pub?.status}>
                            {PLATFORM_SHORT[p]}
                          </span>
                        );
                      })}
                    </div>
                    {item.stage === "scheduled" && item.scheduled_at && (
                      <div className="cs-card-when">{fmtWhen(item.scheduled_at)}</div>
                    )}
                    <div className="cs-card-move" onClick={(e) => e.stopPropagation()}>
                      <button aria-label="Move left" disabled={stage === STAGES[0]} onClick={() => shift(item, -1)}>&#8249;</button>
                      <button aria-label="Move right" disabled={stage === STAGES[STAGES.length - 1]} onClick={() => shift(item, 1)}>&#8250;</button>
                    </div>
                  </article>
                ))}
                {!loading && col.length === 0 && <div className="cs-empty">Nothing here</div>}
              </section>
            );
          })}
        </div>
      )}

      {tab === "calendar" && <CalendarView onOpen={setOpenId} />}

      {openId !== null && (
        <ItemDrawer
          id={openId}
          meta={meta}
          onClose={() => {
            setOpenId(null);
            load();
          }}
          onChanged={load}
        />
      )}
    </div>
  );
}
