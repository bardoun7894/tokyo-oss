import { useCallback, useEffect, useState } from "react";
import { api, postApi, deleteApi } from "../../api/client";
import { useToast } from "../../components/ui/Toast";

type Surface = { key: string; label: string; enabled: boolean; supported: boolean };
type TransportInfo = { key: string; label: string; configured: boolean; missing: string; doctor: string[] };
type StrategyInfo = { key: string; label: string; description: string };
type Reply = {
  id: number;
  status: "sent" | "failed" | "escalated" | "skipped";
  surface: string;
  handle: string | null;
  inbound: string;
  text: string | null;
  reason: string | null;
  error: string | null;
  at: string;
};
type Rule = {
  id: number;
  pattern: string;
  match_type: string;
  reply: string;
  surface: string | null;
  enabled: number;
  priority: number;
};

type Status = {
  enabled: boolean;
  transport: string;
  strategy: string;
  running: string | null;
  configured: boolean;
  missing: string;
  persona: string;
  threadDailyCap: number;
  commentDmFollowup: boolean;
  surfaces: Surface[];
  transports: TransportInfo[];
  strategies: StrategyInfo[];
  stats: { events: number; sent: number; escalated: number; failed: number };
  recent: Reply[];
};

const STATUS_COLOR: Record<Reply["status"], string> = {
  sent: "var(--green)",
  failed: "var(--red)",
  escalated: "var(--amber)",
  skipped: "var(--text3)",
};

const input: React.CSSProperties = {
  background: "var(--surface2)",
  border: "1px solid var(--border)",
  color: "var(--text)",
  padding: "7px 10px",
  borderRadius: 8,
  fontSize: ".82rem",
  outline: "none",
};

function pill(active: boolean, ok = true): React.CSSProperties {
  return {
    background: active ? "var(--green)" : "var(--surface2)",
    color: active ? "var(--on-color)" : ok ? "var(--text)" : "var(--text3)",
    border: `1px solid ${active ? "var(--green)" : "var(--border)"}`,
    padding: "5px 11px",
    borderRadius: 999,
    cursor: "pointer",
    fontWeight: active ? 700 : 500,
    fontSize: ".76rem",
    whiteSpace: "nowrap",
  };
}

export function InstagramCard() {
  const { showToast } = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [busy, setBusy] = useState(false);
  const [showDoctor, setShowDoctor] = useState(false);
  const [persona, setPersona] = useState("");
  const [testText, setTestText] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [newPattern, setNewPattern] = useState("");
  const [newReply, setNewReply] = useState("");

  const load = useCallback(() => {
    api<Status>("/api/instagram")
      .then((s) => {
        setStatus(s);
        setPersona(s.persona);
      })
      .catch((err: Error) => showToast(err.message, "error"));
    api<Rule[]>("/api/instagram/rules").then(setRules).catch(() => setRules([]));
  }, [showToast]);

  useEffect(load, [load]);

  const patch = useCallback(
    (body: Record<string, unknown>, note?: string) => {
      setBusy(true);
      postApi<{ applied: boolean; detail: string }>("/api/instagram/settings", body)
        .then((r) => {
          // applyTransport reports why a transport refused to start; without
          // surfacing it the toggle looks like it worked and nothing listens.
          showToast(note ?? r.detail, r.applied ? "success" : "error");
          load();
        })
        .catch((err: Error) => showToast(err.message, "error"))
        .finally(() => setBusy(false));
    },
    [load, showToast]
  );

  if (!status) return <div className="loading">Loading Instagram...</div>;

  const activeTransport = status.transports.find((t) => t.key === status.transport);

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          disabled={busy}
          onClick={() => patch({ enabled: !status.enabled })}
          style={{
            ...pill(status.enabled),
            background: status.enabled ? "var(--green)" : "var(--red)",
            borderColor: status.enabled ? "var(--green)" : "var(--red)",
            color: "var(--on-color)",
            fontWeight: 600,
          }}
        >
          {status.enabled ? "Bot ON" : "Bot OFF"}
        </button>
        <span style={{ fontSize: ".78rem", color: "var(--text2)" }}>
          {status.running
            ? `${activeTransport?.label} running`
            : status.configured
              ? "configured, not started"
              : "not configured"}
        </span>
        <button onClick={() => setShowDoctor((v) => !v)} style={{ ...pill(false), marginLeft: "auto" }}>
          {showDoctor ? "Hide setup" : "Setup"}
        </button>
      </div>

      {!status.configured && (
        <div
          style={{
            marginTop: 10,
            padding: "8px 11px",
            borderRadius: 8,
            background: "var(--surface2)",
            borderLeft: "3px solid var(--amber)",
            fontSize: ".78rem",
            color: "var(--text2)",
          }}
        >
          {status.missing}
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: ".72rem", color: "var(--text3)", marginBottom: 6, letterSpacing: ".04em" }}>
          TRANSPORT
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {status.transports.map((t) => (
            <button
              key={t.key}
              disabled={busy}
              title={t.configured ? "" : t.missing}
              onClick={() => patch({ transport: t.key })}
              style={pill(status.transport === t.key, t.configured)}
            >
              {t.configured ? "" : "⚠ "}
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: ".72rem", color: "var(--text3)", marginBottom: 6, letterSpacing: ".04em" }}>
          STRATEGY
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {status.strategies.map((s) => (
            <button
              key={s.key}
              disabled={busy}
              onClick={() => patch({ strategy: s.key })}
              style={pill(status.strategy === s.key)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: ".72rem", color: "var(--text3)", marginBottom: 6, letterSpacing: ".04em" }}>
          SURFACES
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {status.surfaces.map((s) => (
            <button
              key={s.key}
              disabled={busy || !s.supported}
              title={s.supported ? "" : `${activeTransport?.label} cannot answer this`}
              onClick={() =>
                postApi("/api/instagram/surface", { surface: s.key })
                  .then(load)
                  .catch((err: Error) => showToast(err.message, "error"))
              }
              style={{
                ...pill(s.supported && s.enabled),
                opacity: s.supported ? 1 : 0.4,
                cursor: s.supported ? "pointer" : "not-allowed",
              }}
            >
              {s.supported ? "" : "\u{1F6AB} "}
              {s.label}
            </button>
          ))}
          <button
            disabled={busy}
            onClick={() => patch({ commentDmFollowup: !status.commentDmFollowup })}
            style={pill(status.commentDmFollowup)}
          >
            DM after public reply
          </button>
        </div>
      </div>

      {showDoctor && (
        <div style={{ marginTop: 14, fontSize: ".76rem", lineHeight: 1.65 }}>
          {status.transports.map((t) => (
            <div key={t.key} style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 600, color: t.configured ? "var(--green)" : "var(--amber)" }}>
                {t.configured ? "✅" : "❌"} {t.label}
              </div>
              <ul style={{ margin: "4px 0 0 16px", padding: 0, color: "var(--text2)" }}>
                {t.doctor.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
          ))}
          <div style={{ color: "var(--text3)" }}>Full setup guide: docs/instagram-bot.md</div>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: ".72rem", color: "var(--text3)", marginBottom: 6, letterSpacing: ".04em" }}>
          PERSONA — what the AI is allowed to know
        </div>
        <textarea
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          rows={3}
          placeholder="What you sell, delivery, hours, tone. Anything not written here, the bot escalates instead of guessing."
          style={{ ...input, width: "100%", resize: "vertical", fontFamily: "inherit" }}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center" }}>
          <button
            disabled={busy || persona === status.persona}
            onClick={() => patch({ persona }, "Persona saved")}
            style={pill(persona !== status.persona)}
          >
            Save persona
          </button>
          <span style={{ fontSize: ".74rem", color: "var(--text3)" }}>Cap</span>
          <input
            type="number"
            min={0}
            value={status.threadDailyCap}
            onChange={(e) => patch({ threadDailyCap: Number(e.target.value) })}
            style={{ ...input, width: 64 }}
          />
          <span style={{ fontSize: ".74rem", color: "var(--text3)" }}>replies / thread / day</span>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: ".72rem", color: "var(--text3)", marginBottom: 6, letterSpacing: ".04em" }}>
          DRY RUN — picks a reply, sends nothing
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            value={testText}
            placeholder="how much is delivery"
            onChange={(e) => setTestText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || !testText.trim()) return;
              postApi<{ text: string | null; reason: string }>("/api/instagram/test", { text: testText })
                .then((r) => setTestResult(r.text ? `${r.text}   (${r.reason})` : `Would escalate — ${r.reason}`))
                .catch((err: Error) => showToast(err.message, "error"));
            }}
            style={{ ...input, flex: 1 }}
          />
        </div>
        {testResult && (
          <div style={{ marginTop: 6, fontSize: ".8rem", color: "var(--text2)", lineHeight: 1.5 }}>{testResult}</div>
        )}
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: ".72rem", color: "var(--text3)", marginBottom: 6, letterSpacing: ".04em" }}>
          RULES ({rules.filter((r) => r.enabled).length} active)
        </div>
        {rules.map((r) => (
          <div
            key={r.id}
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              padding: "5px 0",
              borderBottom: "1px solid var(--border)",
              fontSize: ".79rem",
              opacity: r.enabled ? 1 : 0.45,
            }}
          >
            <code style={{ background: "var(--surface2)", padding: "2px 6px", borderRadius: 4, whiteSpace: "nowrap" }}>
              {r.pattern}
            </code>
            <span style={{ color: "var(--text2)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {"→"} {r.reply}
            </span>
            <button
              onClick={() => postApi(`/api/instagram/rules/${r.id}/toggle`).then(load)}
              style={{ ...pill(r.enabled === 1), padding: "2px 8px" }}
            >
              {r.enabled ? "on" : "off"}
            </button>
            <button
              onClick={() => deleteApi(`/api/instagram/rules/${r.id}`).then(load)}
              style={{ background: "none", border: "none", color: "var(--red)", cursor: "pointer", fontSize: ".9rem" }}
            >
              {"×"}
            </button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <input
            value={newPattern}
            placeholder="keyword"
            onChange={(e) => setNewPattern(e.target.value)}
            style={{ ...input, width: 130 }}
          />
          <input
            value={newReply}
            placeholder="reply text"
            onChange={(e) => setNewReply(e.target.value)}
            style={{ ...input, flex: 1 }}
          />
          <button
            disabled={!newPattern.trim() || !newReply.trim()}
            onClick={() =>
              postApi("/api/instagram/rules", { pattern: newPattern, reply: newReply })
                .then(() => {
                  setNewPattern("");
                  setNewReply("");
                  load();
                })
                .catch((err: Error) => showToast(err.message, "error"))
            }
            style={pill(Boolean(newPattern.trim() && newReply.trim()))}
          >
            Add
          </button>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: ".72rem", color: "var(--text3)", marginBottom: 6, letterSpacing: ".04em" }}>
          SEEN {status.stats.events} · SENT {status.stats.sent} · ESCALATED {status.stats.escalated} · FAILED{" "}
          {status.stats.failed}
        </div>
        {status.recent.length === 0 ? (
          <div style={{ fontSize: ".79rem", color: "var(--text3)" }}>Nothing yet.</div>
        ) : (
          status.recent.map((r) => (
            <div key={r.id} style={{ padding: "6px 0", borderBottom: "1px solid var(--border)", fontSize: ".79rem" }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: STATUS_COLOR[r.status] }} />
                <strong>{r.handle ? `@${r.handle}` : "unknown"}</strong>
                <span style={{ color: "var(--text3)", fontSize: ".72rem" }}>{r.surface}</span>
              </div>
              <div style={{ color: "var(--text2)", marginLeft: 13 }}>{"“"}{r.inbound.slice(0, 90)}{"”"}</div>
              <div style={{ color: "var(--text3)", marginLeft: 13, fontSize: ".74rem" }}>
                {"→"} {r.text ?? r.error ?? r.reason}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
