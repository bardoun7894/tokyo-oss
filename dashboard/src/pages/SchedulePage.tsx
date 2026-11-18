import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { CalendarRangeResponse, DaySummary, DailyActivity, Goal } from "../types";

function getWeekDates(): string[] {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - diff);
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

function getMonthDates(year: number, month: number): string[] {
  const dates: string[] = [];
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    dates.push(new Date(year, month, d).toISOString().slice(0, 10));
  }
  return dates;
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// Activity indicators for a day
function DayIndicators({ day }: { day: DaySummary | undefined }) {
  if (!day) return <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginTop: 4 }} />;
  const dots: { color: string; label: string }[] = [];
  if (day.tasksCompleted > 0) dots.push({ color: "var(--green)", label: `${day.tasksCompleted} tasks` });
  if (day.workMinutes > 0) dots.push({ color: "var(--accent)", label: `${Math.round(day.workMinutes / 60 * 10) / 10}h work` });
  if (day.habitsCompleted > 0) dots.push({ color: "var(--accent2)", label: `${day.habitsCompleted}/${day.habitsTotal} habits` });
  if (day.quranPages > 0) dots.push({ color: "var(--amber)", label: `${day.quranPages}p quran` });
  if (day.journalCount > 0) dots.push({ color: "var(--orange)", label: `${day.journalCount} journal` });
  if (day.income > 0) dots.push({ color: "var(--green)", label: `${day.income} DH` });
  if ((day.waMessages ?? 0) > 0) dots.push({ color: "var(--blue)", label: `${day.waMessages} WA msgs` });
  if ((day.conversations ?? 0) > 0) dots.push({ color: "var(--accent2)", label: `${day.conversations} AI convos` });
  return (
    <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginTop: 4 }}>
      {dots.map((d, i) => (
        <span key={i} title={d.label} style={{
          width: 6, height: 6, borderRadius: "50%", background: d.color, display: "inline-block",
        }} />
      ))}
    </div>
  );
}

// Detail panel for selected day
function DayDetail({ activity, loading, goals }: { activity: DailyActivity | null; loading: boolean; goals: Goal[] }) {
  if (loading) return <div style={{ padding: 20, color: "var(--text3)", textAlign: "center" }}>Loading...</div>;
  if (!activity) return <div style={{ padding: 20, color: "var(--text3)", textAlign: "center" }}>Select a day to see details</div>;

  const dayName = new Date(activity.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  const hasActivity = activity.tasksCompleted.length > 0 || activity.tasksCreated.length > 0 ||
    activity.activeTasks.length > 0 ||
    activity.work.totalMinutes > 0 || activity.habits.some(h => h.done) ||
    activity.quranPages > 0 || activity.journals.length > 0 ||
    activity.schedule.length > 0 || activity.income.length > 0 || activity.shopSales.length > 0;

  return (
    <div>
      <h3 style={{
        fontSize: "1rem", fontWeight: 600, margin: "-16px -16px 12px", padding: "12px 16px",
        color: "var(--text)", position: "sticky", top: -16, zIndex: 1,
        background: "var(--surface)", borderBottom: "1px solid var(--border)",
      }}>{dayName}</h3>

      {!hasActivity && (
        <div style={{ color: "var(--text3)", fontSize: ".85rem", padding: "20px 0", textAlign: "center" }}>
          No activity recorded
        </div>
      )}

      {/* Schedule */}
      {activity.schedule.length > 0 && (
        <Section title="Schedule" emoji="🕐">
          {activity.schedule.map((s) => (
            <Row key={s.id} left={s.time} right={s.title + (s.recurring ? " 🔁" : "")} color="var(--accent)" />
          ))}
        </Section>
      )}

      {/* Tasks Completed */}
      {activity.tasksCompleted.length > 0 && (
        <Section title={`Tasks Completed (${activity.tasksCompleted.length})`} emoji="✅">
          {activity.tasksCompleted.map((t) => (
            <Row key={t.id} left={`#${t.id}`} right={t.title} tag={t.category} color="var(--green)" />
          ))}
        </Section>
      )}

      {/* Tasks Created */}
      {(() => {
        const newOnly = activity.tasksCreated.filter(
          t => !activity.tasksCompleted.some(c => c.id === t.id)
        );
        if (newOnly.length === 0) return null;
        return (
          <Section title={`Tasks Created (${newOnly.length})`} emoji="📋">
            {newOnly.map((t) => (
              <Row key={t.id} left={`#${t.id}`} right={t.title} tag={t.status} color="var(--text2)" />
            ))}
          </Section>
        );
      })()}

      {/* Active Tasks (pending/in_progress) */}
      {activity.activeTasks.length > 0 && (
        <Section title={`Active Tasks (${activity.activeTasks.length})`} emoji="🎯">
          {activity.activeTasks.slice(0, 10).map((t) => {
            const priorityColor: Record<string, string> = { urgent: "var(--red)", high: "var(--orange)", medium: "var(--amber)", low: "var(--text3)" };
            return (
              <Row key={t.id} left={`#${t.id}`} right={t.title} tag={t.priority} color={priorityColor[t.priority] || "var(--text2)"} />
            );
          })}
          {activity.activeTasks.length > 10 && (
            <div style={{ fontSize: ".75rem", color: "var(--text3)", padding: "4px 0" }}>+{activity.activeTasks.length - 10} more</div>
          )}
        </Section>
      )}

      {/* Work */}
      {activity.work.totalMinutes > 0 && (
        <Section title="Work" emoji="⏱">
          <div style={{ fontSize: ".85rem", padding: "6px 0" }}>
            <strong>{Math.floor(activity.work.totalMinutes / 60)}h {activity.work.totalMinutes % 60}m</strong>
            {activity.work.breakMinutes > 0 && (
              <span style={{ color: "var(--text3)", marginLeft: 8 }}>({Math.floor(activity.work.breakMinutes / 60)}h {activity.work.breakMinutes % 60}m breaks)</span>
            )}
          </div>
          {Object.entries(activity.work.byType).length > 0 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
              {Object.entries(activity.work.byType).map(([type, mins]) => (
                <span key={type} style={{ fontSize: ".78rem", background: "var(--surface2)", padding: "3px 8px", borderRadius: 4 }}>
                  {type}: {Math.floor(mins / 60)}h{mins % 60}m
                </span>
              ))}
            </div>
          )}
        </Section>
      )}

      {/* Habits */}
      {activity.habits.length > 0 && (() => {
        const done = activity.habits.filter(h => h.done).length;
        return (
          <Section title={`Habits (${done}/${activity.habits.length})`} emoji="✓">
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {activity.habits.map((h) => (
                <span key={h.id} style={{
                  fontSize: ".78rem",
                  background: h.done ? "color-mix(in srgb, var(--green) 15%, transparent)" : "var(--surface2)",
                  color: h.done ? "var(--green)" : "var(--text3)",
                  padding: "4px 10px",
                  borderRadius: 6,
                  border: h.done ? "1px solid color-mix(in srgb, var(--green) 30%, transparent)" : "1px solid var(--border)",
                }}>
                  {h.done ? "✓" : "○"} {h.name}
                </span>
              ))}
            </div>
          </Section>
        );
      })()}

      {/* Deen */}
      {(activity.quranPages > 0 || activity.adhkar.morning || activity.adhkar.evening) && (
        <Section title="Deen" emoji="🕌">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {activity.quranPages > 0 && (
              <Tag color="var(--amber)">📖 {activity.quranPages} pages</Tag>
            )}
            {activity.adhkar.morning && <Tag color="var(--accent2)">🌅 Morning adhkar</Tag>}
            {activity.adhkar.evening && <Tag color="var(--accent2)">🌙 Evening adhkar</Tag>}
            {activity.adhkar.postPrayer && <Tag color="var(--accent2)">🤲 Post-prayer</Tag>}
          </div>
        </Section>
      )}

      {/* Finance */}
      {(activity.income.length > 0 || activity.shopSales.length > 0) && (
        <Section title="Finance" emoji="💰">
          {activity.income.map((inc, i) => (
            <Row key={`inc-${i}`} left={`+${inc.amount} DH`} right={inc.source + (inc.description ? `: ${inc.description}` : "")} color="var(--green)" />
          ))}
          {activity.shopSales.map((s, i) => (
            <Row key={`shop-${i}`} left={`${s.total_revenue} DH`} right={`Shop${s.items_sold ? ` (${s.items_sold} items)` : ""}`} color="var(--green)" />
          ))}
        </Section>
      )}

      {/* Journal */}
      {activity.journals.length > 0 && (
        <Section title={`Journal (${activity.journals.length})`} emoji="📝">
          {activity.journals.map((j) => (
            <div key={j.id} style={{ padding: "8px 10px", background: "var(--surface2)", borderRadius: 6, marginBottom: 6, fontSize: ".83rem", lineHeight: 1.5 }}>
              {j.mood && <span style={{ fontSize: ".72rem", color: "var(--accent2)", marginRight: 6 }}>[{j.mood}]</span>}
              {j.entry}
            </div>
          ))}
        </Section>
      )}

      {/* WhatsApp */}
      {activity.whatsapp && activity.whatsapp.messages.length > 0 && (() => {
        const catColors: Record<string, string> = { client: "var(--orange)", shop: "var(--green)", family: "var(--accent2)", personal: "var(--accent)", other: "var(--text3)" };
        const catLabels: Record<string, string> = { client: "👤 Client", shop: "🏪 Shop", family: "👨‍👩‍👧 Family", personal: "🏠 Personal", other: "📱 Other" };
        // Group by category
        const grouped: Record<string, typeof activity.whatsapp.messages> = {};
        for (const m of activity.whatsapp.messages) {
          const cat = m.contact_category || "other";
          if (!grouped[cat]) grouped[cat] = [];
          grouped[cat].push(m);
        }
        const catOrder = ["client", "shop", "family", "personal", "other"];
        return (
          <Section title={`WhatsApp (${activity.whatsapp.received}↓ ${activity.whatsapp.sent}↑ — ${activity.whatsapp.chats} chats)`} emoji="📱">
            <div style={{ maxHeight: 280, overflowY: "auto" }}>
              {catOrder.map(cat => {
                const msgs = grouped[cat];
                if (!msgs || msgs.length === 0) return null;
                return (
                  <div key={cat} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: ".72rem", fontWeight: 600, color: catColors[cat], marginBottom: 4 }}>
                      {catLabels[cat] || cat} ({msgs.length})
                    </div>
                    {msgs.slice(-5).map((m) => (
                      <div key={m.id} style={{
                        padding: "3px 8px", fontSize: ".76rem", marginBottom: 2, borderRadius: 4,
                        background: m.from_me ? "color-mix(in srgb, var(--accent) 6%, transparent)" : "var(--surface2)",
                        borderLeft: `2px solid ${catColors[cat]}`,
                      }}>
                        <div>
                          <span style={{ fontWeight: 600, color: m.from_me ? "var(--accent)" : "var(--text2)", marginRight: 4, fontSize: ".72rem" }}>
                            {m.from_me ? "→" : "←"} {m.contact_display_name || m.sender_name}
                          </span>
                          <span style={{ fontSize: ".62rem", color: "var(--text3)", float: "right" }}>
                            {new Date(m.timestamp * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                        {/* Image */}
                        {m.message_type === "image" && m.media_path && (
                          <img
                            src={`/api/media/${m.media_path.split("/").pop()}`}
                            alt="WA Image"
                            style={{ maxWidth: "100%", maxHeight: 150, borderRadius: 4, marginTop: 4, cursor: "pointer" }}
                            onClick={() => window.open(`/api/media/${m.media_path!.split("/").pop()}`, "_blank")}
                          />
                        )}
                        {/* Audio with transcription */}
                        {m.message_type === "audio" && (
                          <div style={{ marginTop: 2 }}>
                            {m.media_path && (
                              <audio controls style={{ height: 28, width: "100%" }} preload="none">
                                <source src={`/api/media/${m.media_path.split("/").pop()}`} />
                              </audio>
                            )}
                            {m.transcription && (
                              <div style={{ fontSize: ".72rem", color: "var(--text2)", fontStyle: "italic", marginTop: 2, padding: "2px 6px", background: "var(--surface)", borderRadius: 4 }}>
                                🎤 {m.transcription}
                              </div>
                            )}
                            {!m.transcription && <span style={{ fontSize: ".72rem", color: "var(--text3)" }}>🎤 [Voice message]</span>}
                          </div>
                        )}
                        {/* Video */}
                        {m.message_type === "video" && m.media_path && (
                          <video controls style={{ maxWidth: "100%", maxHeight: 150, borderRadius: 4, marginTop: 4 }} preload="none">
                            <source src={`/api/media/${m.media_path.split("/").pop()}`} />
                          </video>
                        )}
                        {/* Text content (skip for media-only that's already rendered) */}
                        {(!["image", "audio", "video"].includes(m.message_type || "") || (m.content && !m.content.startsWith("[")) ) && (
                          <span>{m.content.substring(0, 150)}</span>
                        )}
                        {/* Image/video caption */}
                        {["image", "video"].includes(m.message_type || "") && m.content && !m.content.startsWith("[") && (
                          <div style={{ fontSize: ".72rem", color: "var(--text2)", marginTop: 2 }}>{m.content.replace(/^\[(Image|Video)\]\s*/, "")}</div>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </Section>
        );
      })()}

      {/* AI Conversations */}
      {activity.conversations && activity.conversations.length > 0 && (
        <Section title={`AI Conversations (${activity.conversations.length})`} emoji="🤖">
          <div style={{ maxHeight: 200, overflowY: "auto" }}>
            {activity.conversations.slice(-10).map((c, i) => (
              <div key={i} style={{
                padding: "4px 8px", fontSize: ".78rem", marginBottom: 3, borderRadius: 4,
                background: c.role === "user" ? "color-mix(in srgb, var(--accent) 8%, transparent)" : "var(--surface2)",
                borderLeft: c.role === "user" ? "2px solid var(--accent)" : "2px solid var(--accent2)",
              }}>
                <span style={{ fontWeight: 600, color: c.role === "user" ? "var(--accent)" : "var(--accent2)", marginRight: 6 }}>
                  {c.role === "user" ? "You" : "Tokyo"}
                </span>
                <span style={{ color: "var(--text)" }}>{c.content.substring(0, 150)}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Goals */}
      {goals.length > 0 && (
        <Section title={`Goals (${goals.length})`} emoji="🎯">
          {goals.map((g) => {
            const pct = Math.min(100, Math.round(g.progress));
            const barColor = pct >= 75 ? "var(--green)" : pct >= 40 ? "var(--amber)" : "var(--red)";
            return (
              <div key={g.id} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: ".8rem", marginBottom: 4, display: "flex", justifyContent: "space-between" }}>
                  <span>{g.title}</span>
                  <span style={{ color: "var(--text3)", fontSize: ".72rem" }}>{g.currentValue}/{g.target_value} {g.metric}</span>
                </div>
                <div style={{ height: 6, background: "var(--surface2)", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${pct}%`, background: barColor, borderRadius: 3, transition: "width .3s" }} />
                </div>
              </div>
            );
          })}
        </Section>
      )}
    </div>
  );
}

function Section({ title, emoji, children }: { title: string; emoji: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: ".82rem", fontWeight: 600, color: "var(--text2)", marginBottom: 8 }}>
        {emoji} {title}
      </div>
      {children}
    </div>
  );
}

function Row({ left, right, tag, color }: { left: string; right: string; tag?: string; color: string }) {
  return (
    <div style={{ display: "flex", gap: 8, padding: "5px 0", fontSize: ".83rem", alignItems: "center" }}>
      <span style={{ color, fontWeight: 600, minWidth: 40, flexShrink: 0 }}>{left}</span>
      <span style={{ flex: 1 }}>{right}</span>
      {tag && <span style={{ fontSize: ".7rem", color: "var(--text3)", background: "var(--surface2)", padding: "2px 6px", borderRadius: 4 }}>{tag}</span>}
    </div>
  );
}

function Tag({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{ fontSize: ".78rem", color, background: `${color}15`, padding: "4px 10px", borderRadius: 6, border: `1px solid ${color}30` }}>
      {children}
    </span>
  );
}

type ViewMode = "week" | "month";

export default function SchedulePage() {
  const navigate = useNavigate();
  const [view, setView] = useState<ViewMode>("week");
  const [calendarData, setCalendarData] = useState<Record<string, DaySummary>>({});
  const [selectedDate, setSelectedDate] = useState<string>(today());
  const [dayDetail, setDayDetail] = useState<DailyActivity | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [calLoading, setCalLoading] = useState(true);
  const [goals, setGoals] = useState<Goal[]>([]);

  // For month navigation
  const [viewYear, setViewYear] = useState(new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(new Date().getMonth());

  const weekDates = getWeekDates();
  const monthDates = getMonthDates(viewYear, viewMonth);

  // First day of month's weekday (0=Sun, adjust to Mon-start)
  const firstDayOfMonth = new Date(viewYear, viewMonth, 1).getDay();
  const monthOffset = firstDayOfMonth === 0 ? 6 : firstDayOfMonth - 1;

  // Load calendar data
  useEffect(() => {
    setCalLoading(true);
    let start: string, end: string;
    if (view === "week") {
      start = weekDates[0];
      end = weekDates[6];
    } else {
      start = monthDates[0];
      end = monthDates[monthDates.length - 1];
    }
    api<CalendarRangeResponse>(`/api/calendar?start=${start}&end=${end}`)
      .then((data) => {
        const map: Record<string, DaySummary> = {};
        for (const d of data.days) map[d.date] = d;
        setCalendarData(map);
        setCalLoading(false);
      })
      .catch(() => setCalLoading(false));
  }, [view, viewYear, viewMonth]);

  // Load goals
  useEffect(() => {
    api<Goal[]>("/api/goals")
      .then((data) => setGoals(data || []))
      .catch(() => {});
  }, []);

  // Load detail for selected date
  useEffect(() => {
    if (!selectedDate) return;
    setDetailLoading(true);
    api<DailyActivity>(`/api/calendar/${selectedDate}`)
      .then((data) => {
        setDayDetail(data);
        setDetailLoading(false);
      })
      .catch(() => setDetailLoading(false));
  }, [selectedDate]);

  function prevMonth() {
    if (viewMonth === 0) { setViewYear(viewYear - 1); setViewMonth(11); }
    else setViewMonth(viewMonth - 1);
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewYear(viewYear + 1); setViewMonth(0); }
    else setViewMonth(viewMonth + 1);
  }

  const todayStr = today();

  // Activity intensity for heat-map style coloring
  function getIntensity(date: string): string {
    const d = calendarData[date];
    if (!d) return "transparent";
    let score = 0;
    if (d.tasksCompleted > 0) score += 2;
    if (d.workMinutes > 60) score += 2;
    else if (d.workMinutes > 0) score += 1;
    if (d.habitsCompleted > 0) score += 1;
    if (d.quranPages > 0) score += 1;
    if (d.journalCount > 0) score += 1;
    if (d.income > 0) score += 1;
    if ((d.waMessages ?? 0) > 0) score += 1;
    if ((d.conversations ?? 0) > 0) score += 1;
    if (score >= 6) return "color-mix(in srgb, var(--accent) 16%, transparent)";
    if (score >= 4) return "color-mix(in srgb, var(--accent) 11%, transparent)";
    if (score >= 2) return "color-mix(in srgb, var(--accent) 7%, transparent)";
    if (score >= 1) return "color-mix(in srgb, var(--accent) 4%, transparent)";
    return "transparent";
  }

  return (
    <div className="detail-page" style={{ maxWidth: 1100 }}>
      <a className="back-link" onClick={() => navigate("/")}>
        &larr; Back to Dashboard
      </a>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Calendar</h2>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            onClick={() => setView("week")}
            style={{
              background: view === "week" ? "var(--accent)" : "var(--surface2)",
              color: view === "week" ? "var(--on-color)" : "var(--text2)",
              border: "none", padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: ".8rem", fontWeight: 600,
            }}
          >Week</button>
          <button
            onClick={() => setView("month")}
            style={{
              background: view === "month" ? "var(--accent)" : "var(--surface2)",
              color: view === "month" ? "var(--on-color)" : "var(--text2)",
              border: "none", padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: ".8rem", fontWeight: 600,
            }}
          >Month</button>
        </div>
      </div>

      <div className="cal-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 380px", gap: 20, alignItems: "start" }}>
        {/* Left: Calendar grid */}
        <div>
          {/* Month nav (only in month view) */}
          {view === "month" && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <button onClick={prevMonth} style={{ background: "var(--surface2)", border: "none", color: "var(--text)", padding: "6px 12px", borderRadius: 6, cursor: "pointer" }}>&larr;</button>
              <span style={{ fontWeight: 600, fontSize: ".9rem" }}>{MONTH_NAMES[viewMonth]} {viewYear}</span>
              <button onClick={nextMonth} style={{ background: "var(--surface2)", border: "none", color: "var(--text)", padding: "6px 12px", borderRadius: 6, cursor: "pointer" }}>&rarr;</button>
            </div>
          )}

          {view === "week" ? (
            /* Week view: 7 tall cards */
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
              {weekDates.map((date, i) => {
                const d = calendarData[date];
                const isToday = date === todayStr;
                const isSelected = date === selectedDate;
                return (
                  <div
                    key={date}
                    onClick={() => setSelectedDate(date)}
                    style={{
                      padding: "10px 8px",
                      background: isSelected ? "var(--surface2)" : getIntensity(date),
                      borderRadius: 8,
                      border: "1px solid var(--border)",
                      outline: isToday ? "2px solid var(--accent)" : isSelected ? "1px solid var(--text2)" : "none",
                      outlineOffset: isToday ? "-1px" : "0",
                      cursor: "pointer",
                      minHeight: 90,
                      transition: "background .15s, outline-color .15s",
                    }}
                  >
                    <div style={{ fontSize: ".75rem", fontWeight: 600, color: isToday ? "var(--text)" : "var(--text2)", marginBottom: 4 }}>
                      {DAY_NAMES[i]}
                    </div>
                    <div style={{ fontSize: ".85rem", fontWeight: 600 }}>{date.slice(8)}</div>
                    {d ? (
                      <div style={{ marginTop: 6 }}>
                        {d.tasksCompleted > 0 && <MiniStat icon="✅" value={d.tasksCompleted} />}
                        {d.workMinutes > 0 && <MiniStat icon="⏱" value={`${Math.round(d.workMinutes / 60 * 10) / 10}h`} />}
                        {d.habitsCompleted > 0 && <MiniStat icon="✓" value={`${d.habitsCompleted}/${d.habitsTotal}`} />}
                        {d.quranPages > 0 && <MiniStat icon="📖" value={`${d.quranPages}p`} />}
                        {d.journalCount > 0 && <MiniStat icon="📝" value={d.journalCount} />}
                        {(d.waMessages ?? 0) > 0 && <MiniStat icon="📱" value={d.waMessages!} />}
                        {(d.conversations ?? 0) > 0 && <MiniStat icon="🤖" value={d.conversations!} />}
                      </div>
                    ) : (
                      <div style={{ fontSize: ".7rem", color: "var(--text3)", marginTop: 8 }}>—</div>
                    )}
                    <DayIndicators day={d} />
                  </div>
                );
              })}
            </div>
          ) : (
            /* Month view: calendar grid */
            <div>
              {/* Day headers */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginBottom: 4 }}>
                {DAY_NAMES.map((name) => (
                  <div key={name} style={{ textAlign: "center", fontSize: ".72rem", color: "var(--text3)", fontWeight: 600, padding: 4 }}>
                    {name}
                  </div>
                ))}
              </div>
              {/* Calendar cells */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
                {/* Empty cells before first day */}
                {Array.from({ length: monthOffset }).map((_, i) => (
                  <div key={`empty-${i}`} style={{ minHeight: 60 }} />
                ))}
                {monthDates.map((date) => {
                  const d = calendarData[date];
                  const isToday = date === todayStr;
                  const isSelected = date === selectedDate;
                  const dayNum = parseInt(date.slice(8));
                  return (
                    <div
                      key={date}
                      onClick={() => setSelectedDate(date)}
                      style={{
                        padding: "6px 5px",
                        background: isSelected ? "var(--surface2)" : getIntensity(date),
                        borderRadius: 6,
                        border: isToday ? "2px solid var(--accent)" : isSelected ? "1px solid var(--accent2)" : "1px solid transparent",
                        cursor: "pointer",
                        minHeight: 60,
                        transition: "all .15s",
                      }}
                    >
                      <div style={{ fontSize: ".78rem", fontWeight: isToday ? 700 : 500, color: isToday ? "var(--accent)" : "var(--text)", marginBottom: 2 }}>
                        {dayNum}
                      </div>
                      <DayIndicators day={d} />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {calLoading && <div style={{ textAlign: "center", color: "var(--text3)", padding: 12, fontSize: ".8rem" }}>Loading calendar...</div>}

          {/* Legend */}
          <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
            <LegendDot color="var(--green)" label="Tasks" />
            <LegendDot color="var(--accent)" label="Work" />
            <LegendDot color="var(--accent2)" label="Habits" />
            <LegendDot color="var(--amber)" label="Quran" />
            <LegendDot color="var(--orange)" label="Journal" />
            <LegendDot color="var(--blue)" label="WhatsApp" />
            <LegendDot color="var(--accent2)" label="AI Chat" />
          </div>
        </div>

        {/* Right: Day detail panel */}
        <div style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: 16,
          position: "sticky",
          top: 12,
          maxHeight: "calc(100vh - 32px)",
          overflowY: "auto",
        }}>
          <DayDetail activity={dayDetail} loading={detailLoading} goals={goals} />
        </div>
      </div>
    </div>
  );
}

function MiniStat({ icon, value }: { icon: string; value: string | number }) {
  return (
    <div style={{ fontSize: ".7rem", color: "var(--text2)", display: "flex", gap: 3, alignItems: "center" }}>
      <span>{icon}</span>
      <span>{value}</span>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: ".72rem", color: "var(--text3)" }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, display: "inline-block" }} />
      {label}
    </div>
  );
}
