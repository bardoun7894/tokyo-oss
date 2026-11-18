import * as db from "./db";
import { scoreTasks, type ScoringContext } from "./scoring";
import { getCurrentState, type UserState } from "./state";
import { getTodayPrayerTimes, getNextPrayer, getWorkWindows } from "./prayer";
import { localToday, localNow } from "./utils";

const TZ = process.env.TIMEZONE || "Africa/Casablanca";

function fmtTime(date: Date): string {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
}

function fmtHHMM(timeStr: string): string {
  const [h, m] = timeStr.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
}

function hhmmToMins(timeStr: string): number {
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
}

export async function getNowOutput(): Promise<string> {
  // Auto-update promise statuses before scoring
  db.updatePromiseStatuses();

  const today = localToday();
  const now = localNow();
  const timeStr = fmtTime(now);

  const [prayerTimes, nextPrayer, workWindows] = await Promise.all([
    getTodayPrayerTimes(),
    getNextPrayer(),
    getWorkWindows(),
  ]);

  const stateInfo = getCurrentState();
  const tasks = db.getAllActiveTasks() as any[];

  let windowMinutes = Math.max(nextPrayer.minutesUntil - 5, 5);

  const scored = scoreTasks(tasks, {
    windowMinutes,
    state: stateInfo.state,
    today,
  });

  const unreplied = db.getUnrepliedByCategory();
  const duePromises = db.getDueTodayPromises() as any[];
  const overduePromises = db.getOverduePromises() as any[];
  const stats = db.getWorkStats(today);

  const lines: string[] = [];
  lines.push(`🏙 NOW — ${timeStr}`);
  lines.push("");
  lines.push(`🕌 ${nextPrayer.name} in ${nextPrayer.minutesUntil} min (${fmtHHMM(nextPrayer.time)})`);

  const nowMins = now.getHours() * 60 + now.getMinutes();
  const currentWindow = workWindows.find(w => {
    const s = hhmmToMins(w.start);
    const e = hhmmToMins(w.end);
    return nowMins >= s && nowMins < e;
  });

  if (currentWindow) {
    const wm = currentWindow.durationMinutes;
    const label = wm < 20 ? "short" : wm < 60 ? "medium" : "long";
    lines.push(`⏱ Window: ${fmtHHMM(currentWindow.start)}-${fmtHHMM(currentWindow.end)} (${wm} min, ${label})`);
  } else {
    lines.push(`⏱ Window: ~${windowMinutes} min`);
  }

  lines.push(`📍 State: ${stateInfo.state}`);

  const allPromises = [...overduePromises, ...duePromises];
  if (allPromises.length > 0) {
    lines.push("");
    const seen = new Set<number>();
    for (const p of allPromises) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const icon = overduePromises.some(o => o.id === p.id) ? "🔴" : "🟡";
      lines.push(`${icon} Promise: ${p.content}${p.due_date ? ` (due ${p.due_date})` : ""}`);
    }
  }

  lines.push("");
  lines.push("📋 DO THIS NOW:");

  if (scored.length === 0) {
    lines.push("  No active tasks — add some or take a break!");
  } else if (windowMinutes < 20) {
    const quick = scored.filter(s => {
      const est = s.task.estimated_hours;
      return !est || est <= 0.25;
    }).slice(0, 3);
    if (quick.length === 0) {
      lines.push("  No quick tasks fit the short window. Use this time for adhkar/replies.");
    } else {
      for (const s of quick) {
        const est = s.task.estimated_hours ? ` (${Math.round(s.task.estimated_hours * 60)} min)` : "";
        lines.push(`  ▶ ${s.task.title} #${s.task.id} [${s.task.category}]${est} — score: ${s.score}`);
      }
    }
  } else if (stateInfo.state === "post_prayer") {
    const deen = scored.filter(s => s.task.category === "deen" || s.task.category === "personal").slice(0, 3);
    if (deen.length === 0) {
      lines.push("  No deen/personal tasks. Take a moment for dhikr.");
    } else {
      for (const s of deen) {
        const est = s.task.estimated_hours ? ` (${Math.round(s.task.estimated_hours * 60)} min)` : "";
        lines.push(`  ▶ ${s.task.title} #${s.task.id} [${s.task.category}]${est} — score: ${s.score}`);
      }
    }
  } else {
    for (const s of scored.slice(0, 3)) {
      const est = s.task.estimated_hours ? ` (${Math.round(s.task.estimated_hours * 60)} min)` : "";
      lines.push(`  ▶ ${s.task.title} #${s.task.id} [${s.task.category}]${est} — score: ${s.score}`);
    }
  }

  // Add reasoning for the top recommended task
  if (scored.length > 0) {
    const top = scored[0];
    const reasons: string[] = [];
    if (top.breakdown.urgency >= 10) reasons.push("OVERDUE");
    else if (top.breakdown.urgency >= 8) reasons.push("deadline close");
    if (top.breakdown.trust >= 7) reasons.push("client waiting");
    if (top.breakdown.income >= 7) reasons.push("income impact");
    if (top.breakdown.stateFit >= 6) reasons.push("fits current mode");
    if (top.breakdown.windowFit >= 6) reasons.push("fits time window");
    if (top.breakdown.ease >= 7) reasons.push("quick win");
    if (top.breakdown.blocked < 0) reasons.push("⚠️ may be blocked");
    if (reasons.length > 0) {
      lines.push(`  _Why #${top.task.id}: ${reasons.join(" + ")}_`);
    }
  }

  const unrepliedEntries = Object.entries(unreplied);
  if (unrepliedEntries.length > 0) {
    lines.push("");
    lines.push("💬 REPLY TO:");
    let count = 0;
    for (const [, msgs] of unrepliedEntries) {
      for (const m of (msgs as any[]).slice(0, 3)) {
        if (count >= 5) break;
        const minsAgo = m.timestamp ? Math.round((Date.now() / 1000 - m.timestamp) / 60) : "?";
        const preview = (m.content || "").slice(0, 30);
        lines.push(`  👤 ${m.display_name || m.sender_name || "?"} — "${preview}…" (${minsAgo} min ago)`);
        count++;
      }
      if (count >= 5) break;
    }
  }

  const quickWin = scored.find(s => {
    const est = s.task.estimated_hours;
    return est && est <= 0.15;
  });
  if (quickWin) {
    lines.push("");
    lines.push("⚡ QUICK WIN:");
    lines.push(`  ✅ ${quickWin.task.title} (${Math.round(quickWin.task.estimated_hours * 60)} min)`);
  }

  if (windowMinutes < 20) {
    lines.push("");
    lines.push("⛔ AVOID:");
    lines.push(`  Don't start deep coding — only ${windowMinutes} min before ${nextPrayer.name}`);
  }

  if (nextPrayer.minutesUntil < 120) {
    const afterTasks = scored.filter(s => {
      const est = s.task.estimated_hours;
      return est && est * 60 > windowMinutes;
    }).slice(0, 3);
    if (afterTasks.length > 0) {
      lines.push("");
      lines.push(`📌 AFTER ${nextPrayer.name.toUpperCase()} (${fmtHHMM(nextPrayer.time)}):`);
      for (let i = 0; i < afterTasks.length; i++) {
        const s = afterTasks[i];
        const est = s.task.estimated_hours ? ` (est. ${Math.round(s.task.estimated_hours * 60)} min)` : "";
        lines.push(`  ${i + 1}. ${s.task.title} #${s.task.id}${est}`);
      }
    }
  }

  if (stats.totalWorkMinutes > 0) {
    const h = Math.floor(stats.totalWorkMinutes / 60);
    const m = stats.totalWorkMinutes % 60;
    const byType = Object.entries(stats.byType).map(([, mins]) => `${Math.round((mins as number) / 60)}h${Math.round((mins as number) % 60)}m`).join(", ");
    lines.push("");
    lines.push(`📊 Today: ${h}h ${m}m worked${byType ? ` (${byType})` : ""}`);
  }

  let output = lines.join("\n");
  if (output.length > 3900) {
    output = output.slice(0, 3900) + "\n… (truncated)";
  }

  return output;
}

export async function getTimelineOutput(): Promise<string> {
  const today = localToday();
  const events = db.getActivityEventsForDate(today) as any[];
  const workLogs = db.getWorkLogsForDate(today) as any[];
  const quranProgress = db.getQuranProgress();
  const stats = db.getWorkStats(today);

  const dateLabel = new Date(today + "T12:00:00Z").toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: TZ,
  });

  interface TimeEntry {
    mins: number;
    text: string;
  }

  const entries: TimeEntry[] = [];

  if (quranProgress.totalPages > 0 && quranProgress.latest) {
    const latest = quranProgress.latest;
    const t = latest.created_at ? new Date(latest.created_at) : new Date();
    const mins = t.getHours() * 60 + t.getMinutes();
    entries.push({ mins, text: `📖 Quran (${quranProgress.totalPages} pages)` });
  }

  let workStart: Date | null = null;
  let workNote = "";
  let workType = "";
  for (const log of workLogs) {
    const logTime = new Date(log.logged_at);
    const logMins = logTime.getHours() * 60 + logTime.getMinutes();
    if (log.type === "work_start") {
      workStart = logTime;
      workNote = log.note || "";
      workType = log.work_type || "dev";
    }
    if (log.type === "work_end" && workStart) {
      const durationMins = Math.round((logTime.getTime() - workStart.getTime()) / 60000);
      const icon = workType === "shop" ? "🏪" : "💻";
      entries.push({ mins: logMins, text: `${icon} ${workType === "shop" ? "Shop" : "Dev"}: ${workNote || workType} (${durationMins} min) ✅` });
      workStart = null;
    }
  }

  for (const ev of events) {
    const t = new Date(ev.logged_at);
    const mins = t.getHours() * 60 + t.getMinutes();
    const icon = ev.category === "shop" ? "🏪" : ev.category === "deen" ? "🕌" : "💻";
    const confirmedIcon = ev.confirmed ? "✅" : "⬜";
    const dur = ev.duration_minutes ? ` (${ev.duration_minutes} min)` : "";
    entries.push({ mins, text: `${icon} ${ev.title || ev.event_type}${dur} ${confirmedIcon}` });
  }

  const prayerTimes = await getTodayPrayerTimes();
  const prayers = [
    { name: "Fajr", time: prayerTimes.fajr },
    { name: "Dhuhr", time: prayerTimes.dhuhr },
    { name: "Asr", time: prayerTimes.asr },
    { name: "Maghrib", time: prayerTimes.maghrib },
    { name: "Isha", time: prayerTimes.isha },
  ];

  for (const p of prayers) {
    entries.push({ mins: hhmmToMins(p.time), text: `🕌 ${p.name}` });
  }

  entries.sort((a, b) => a.mins - b.mins);

  const lines: string[] = [`📅 Today — ${dateLabel}`, ""];
  for (const e of entries) {
    const h = Math.floor(e.mins / 60).toString().padStart(2, "0");
    const m = (e.mins % 60).toString().padStart(2, "0");
    lines.push(`${h}:${m}  ${e.text}`);
  }

  lines.push("");
  lines.push("📊 ");
  if (stats.totalWorkMinutes > 0) {
    const parts = Object.entries(stats.byType).map(([t, mins]) => `${Math.round((mins as number) / 60)}h${Math.round((mins as number) % 60)}m ${t}`);
    lines[lines.length - 1] += parts.join(", ");
  }
  lines.push("✅ auto  🟡 confirmed  ⬜ pending");

  return lines.join("\n");
}
