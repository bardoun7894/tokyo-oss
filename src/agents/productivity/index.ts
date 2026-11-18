import type { Agent, AgentContext, AgentResult, AgentDomain } from "../types";
import type { AgentEvent } from "../event-bus";
import { localToday, localNow } from "../../utils";

// ─── Helpers ───────────────────────────────────────────────

function getTodayStr(): string {
  return localToday();
}

function getMonthRange(): { start: string; end: string } {
  const now = localNow();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];
  return { start, end };
}

// ─── Command Handlers ──────────────────────────────────────

async function handleTasks(ctx: AgentContext): Promise<AgentResult> {
  const db = ctx.db;
  const tasks = db.getAllActiveTasks() as any[];
  if (tasks.length === 0) {
    return { success: true, output: "No active tasks. Talk to me to add one!" };
  }

  const priorityEmoji: Record<string, string> = { urgent: "🔴", high: "🟠", medium: "🟡", low: "🟢" };
  const categoryEmoji: Record<string, string> = {
    client: "👤", product: "🚀", shop: "🏪", learning: "📚",
    deen: "🕌", admin: "📁", health: "💪", personal: "🏠",
  };
  const statusEmoji: Record<string, string> = { pending: "", in_progress: " ▶️" };

  const grouped: Record<string, any[]> = {};
  for (const t of tasks) {
    const cat = t.category || "client";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(t);
  }

  const sections = Object.entries(grouped).map(([cat, items]) => {
    const emoji = categoryEmoji[cat] || "📋";
    const lines = items.map((t) => {
      const subs = db.getSubtasks(t.id) as any[];
      let line = `  ${priorityEmoji[t.priority] || "⚪"} *#${t.id}* ${t.title}${t.due_date ? ` _(${t.due_date})_` : ""}${statusEmoji[t.status] || ""}`;
      if (subs.length > 0) {
        line += "\n" + subs.map((s) => `    └ #${s.id} ${s.title} (${s.status})`).join("\n");
      }
      return line;
    });
    return `${emoji} *${cat.toUpperCase()}*\n${lines.join("\n")}`;
  });

  return { success: true, output: `📋 *Active Tasks:*\n\n${sections.join("\n\n")}` };
}

async function handleDone(args: string, ctx: AgentContext): Promise<AgentResult> {
  const id = parseInt(args, 10);
  if (!id) return { success: false, output: "Usage: /done [task_id]" };
  ctx.db.completeTask(id);
  return { success: true, output: `✅ Task #${id} done!` };
}

async function handleBegin(args: string, ctx: AgentContext): Promise<AgentResult> {
  const id = parseInt(args, 10);
  if (!id) return { success: false, output: "Usage: /begin [task_id]" };
  ctx.db.startTask(id);
  return { success: true, output: `▶️ Task #${id} in progress. بالتوفيق!` };
}

async function handleEdit(args: string, ctx: AgentContext): Promise<AgentResult> {
  const parts = args.trim().split(/\s+/);
  const id = parseInt(parts[0], 10);
  const field = parts[1];
  const value = parts.slice(2).join(" ");
  if (!id || !field || !value) {
    return { success: false, output: "Usage: /edit [id] [field] [value]\n\nFields: title, priority, due_date, category, notes\n\nExample: /edit 3 priority urgent" };
  }
  const allowed = ["title", "priority", "due_date", "category", "notes", "status"];
  if (!allowed.includes(field)) {
    return { success: false, output: `Invalid field. Use: ${allowed.join(", ")}` };
  }
  ctx.db.updateTask(id, { [field]: value });
  return { success: true, output: `✏️ Task #${id} updated: ${field} = ${value}` };
}

async function handleSub(args: string, ctx: AgentContext): Promise<AgentResult> {
  const parts = args.trim().split(/\s+/);
  const parentId = parseInt(parts[0], 10);
  const title = parts.slice(1).join(" ");
  if (!parentId || !title) {
    return { success: false, output: "Usage: /sub [parent_task_id] [subtask title]\n\nExample: /sub 3 Design database schema" };
  }
  const result = ctx.db.addSubtask(parentId, title);
  return { success: true, output: `✅ Subtask added under #${parentId}: *${title}* — ID #${result.lastInsertRowid}` };
}

async function handleDel(args: string, ctx: AgentContext): Promise<AgentResult> {
  const id = parseInt(args, 10);
  if (!id) return { success: false, output: "Usage: /del [task_id]" };
  ctx.db.deleteTask(id);
  return { success: true, output: `🗑 Task #${id} deleted.` };
}

async function handleHabits(ctx: AgentContext): Promise<AgentResult> {
  const today = getTodayStr();
  const habits = ctx.db.getHabitLogsForDate(today) as any[];
  if (habits.length === 0) {
    return { success: true, output: "No habits tracked yet. /addhabit [name]" };
  }
  const lines = habits.map((h) => {
    const streak = ctx.db.getHabitStreak(h.id);
    return `${h.done ? "✅" : "⬜"} *#${h.id}* ${h.name}${streak > 1 ? ` 🔥${streak}` : ""}`;
  });
  return { success: true, output: `*Today's Habits:*\n\n${lines.join("\n")}\n\n/check [id] to mark done` };
}

async function handleCheck(args: string, ctx: AgentContext): Promise<AgentResult> {
  const id = parseInt(args, 10);
  if (!id) return { success: false, output: "Usage: /check [habit_id]" };
  const today = getTodayStr();
  ctx.db.logHabit(id, today);
  const streak = ctx.db.getHabitStreak(id);
  return { success: true, output: `✅ Habit #${id} done!${streak > 1 ? ` 🔥 ${streak}-day streak!` : ""}` };
}

async function handleAddHabit(args: string, ctx: AgentContext): Promise<AgentResult> {
  const name = args.trim();
  if (!name) return { success: false, output: "Usage: /addhabit [name]" };
  ctx.db.addHabit(name);
  return { success: true, output: `✅ Habit added: *${name}*` };
}

async function handleRmHabit(args: string, ctx: AgentContext): Promise<AgentResult> {
  const id = parseInt(args, 10);
  if (!id) return { success: false, output: "Usage: /rmhabit [habit_id]" };
  ctx.db.deactivateHabit(id);
  return { success: true, output: `🗑 Habit #${id} deactivated.` };
}

async function handleWork(args: string, ctx: AgentContext): Promise<AgentResult> {
  const note = args.trim() || "dev";
  ctx.db.logWork("work_start", note, note === "shop" ? "shop" : "dev");
  return { success: true, output: `⏱ Dev session started: *${note}*. بالتوفيق!\n\n/breakk for break, /stopwork when done.` };
}

async function handleShop(ctx: AgentContext): Promise<AgentResult> {
  ctx.db.logWork("work_start", "shop", "shop");
  return { success: true, output: "🏪 Shop session started. بالتوفيق!\n\n/stopwork when you leave." };
}

async function handleStopWork(args: string, ctx: AgentContext): Promise<AgentResult> {
  ctx.db.logWork("work_end", args || undefined);
  const today = getTodayStr();
  const stats = ctx.db.getWorkStats(today);
  const byType = Object.entries(stats.byType)
    .map(([t, m]) => `${t}: ${Math.round((m as number) / 60)}h${(m as number) % 60}m`)
    .join(", ");
  return { success: true, output: `⏹ Session ended.\n\n📊 Today: ${stats.totalWorkMinutes} min work, ${stats.totalBreakMinutes} min breaks\n${byType ? `By type: ${byType}` : ""}` };
}

async function handleBreak(ctx: AgentContext): Promise<AgentResult> {
  ctx.db.logWork("break_start");
  return { success: true, output: "☕ Break started. /endbreak when ready." };
}

async function handleEndBreak(ctx: AgentContext): Promise<AgentResult> {
  ctx.db.logWork("break_end");
  return { success: true, output: "💪 Break over. Let's go!" };
}

async function handleStats(ctx: AgentContext): Promise<AgentResult> {
  const today = getTodayStr();
  const stats = ctx.db.getWorkStats(today);
  const workH = (stats.totalWorkMinutes / 60).toFixed(1);
  const breakH = (stats.totalBreakMinutes / 60).toFixed(1);
  const byType = Object.entries(stats.byType)
    .map(([t, m]) => `  ${t}: ${Math.round((m as number) / 60)}h${(m as number) % 60}m`)
    .join("\n");

  let balance = "⚖️ Balanced";
  if (stats.totalWorkMinutes > 600) balance = "🔴 Over 10 hours — stop and rest!";
  else if (stats.totalWorkMinutes > 480) balance = "⚠️ Over 8 hours — consider wrapping up.";
  else if (stats.totalWorkMinutes > 0 && stats.totalBreakMinutes < stats.totalWorkMinutes * 0.1) balance = "⚠️ Take more breaks!";

  return { success: true, output: `📊 *Today's Stats*\n\n⏱ Work: ${workH}h\n☕ Breaks: ${breakH}h\n${byType ? `\n${byType}\n` : ""}\n${balance}` };
}

async function handleSchedule(ctx: AgentContext): Promise<AgentResult> {
  const today = getTodayStr();
  const items = ctx.db.getScheduleForDate(today) as any[];
  if (items.length === 0) {
    return { success: true, output: "📅 Nothing scheduled today.\n\nTell me what to schedule naturally." };
  }
  const lines = items.map((s) => `🕐 *${s.time}* — ${s.title}${s.recurring ? " 🔁" : ""}`);
  return { success: true, output: `📅 *Today's Schedule:*\n\n${lines.join("\n")}` };
}

async function handleNow(ctx: AgentContext): Promise<AgentResult> {
  const { getNowOutput } = await import("../../now");
  const output = await getNowOutput();
  return { success: true, output };
}

async function handleState(args: string, ctx: AgentContext): Promise<AgentResult> {
  const { getCurrentState, setState } = await import("../../state");
  const input = args.trim().toLowerCase();

  const STATE_ALIASES: Record<string, string> = {
    dev: "deep_work", deep: "deep_work", work: "deep_work",
    shop: "shop_mode", meeting: "meeting_mode", admin: "admin_mode",
    low: "low_energy", tired: "low_energy", family: "family_mode",
    prayer: "post_prayer", done: "idle", idle: "idle", reset: "idle",
  };

  if (!input) {
    const current = getCurrentState();
    return { success: true, output: `📍 Current state: *${current.state}*\nSource: ${current.source}${current.note ? `\nNote: ${current.note}` : ""}\n\nValid: ${Object.keys(STATE_ALIASES).join(", ")}` };
  }

  const mapped = STATE_ALIASES[input];
  if (!mapped) {
    return { success: false, output: `Unknown state: ${input}\n\nValid: ${Object.keys(STATE_ALIASES).join(", ")}` };
  }

  const info = setState(mapped as any, "manual");
  return { success: true, output: `📍 State set to *${info.state}*` };
}

async function handleTimeline(ctx: AgentContext): Promise<AgentResult> {
  const { getTimelineOutput } = await import("../../now");
  const output = await getTimelineOutput();
  return { success: true, output };
}

async function handleWeek(ctx: AgentContext): Promise<AgentResult> {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - diff);
  const startStr = weekStart.toISOString().split("T")[0];
  const today = getTodayStr();

  try {
    const progress = ctx.db.getProgressData(startStr, today);
    const lines = [
      `📊 *This Week (${startStr} → ${today})*`,
      ``,
      `📋 Tasks: ${progress.tasks.completed} done / ${progress.tasks.created} created`,
      `⏱ Work: ${progress.work.totalHours}h${Object.entries(progress.work.byType).map(([k, v]) => ` (${k}: ${v}h)`).join("") || ""}`,
      `✅ Habits: ${progress.habits.rate}% completion`,
      `📖 Quran: ${progress.deen.quranPages} pages (${progress.deen.quranDays} days)`,
      `💰 Income: ${progress.finance.total} DH${progress.finance.shopRevenue ? ` + ${progress.finance.shopRevenue} shop` : ""}`,
      `📝 Journal: ${progress.journal.entries} entries`,
    ];

    if (progress.goals.length > 0) {
      lines.push("", "🎯 Goals:");
      for (const g of progress.goals) {
        const pct = g.target_value > 0 ? Math.round((g.current_value / g.target_value) * 100) : 0;
        lines.push(`  ${g.title}: ${pct}% (${g.current_value}/${g.target_value})`);
      }
    }

    return { success: true, output: lines.join("\n") };
  } catch {
    return { success: false, output: "Failed to generate weekly summary." };
  }
}

// ─── Action Handlers ───────────────────────────────────────

async function handleAction(action: Record<string, any>, ctx: AgentContext): Promise<string | void> {
  const today = getTodayStr();
  const db = ctx.db;

  switch (action.type) {
    case "add_task":
      db.addTask(action.title, action.category, action.priority, action.due_date, action.description, undefined, action.project_id, action.estimated_hours);
      break;

    case "complete_task":
      db.completeTask(action.id);
      // Try to move linked Trello card to Done
      if (process.env.TRELLO_API_KEY) {
        try {
          const task = db.getTask(action.id);
          if (task) {
            const { findBoard, searchCards, completeCard } = await import("../../trello");
            const board = await findBoard("tokyo");
            if (board) {
              const cards = await searchCards(board.id, task.title);
              if (cards.length > 0) await completeCard(board.id, cards[0].id);
            }
          }
        } catch {}
      }
      break;

    case "reopen_task": {
      db.reopenTask(action.id);
      const reason = action.reason || "needs recheck";
      if (process.env.TRELLO_API_KEY) {
        try {
          const task = db.getTask(action.id);
          if (task) {
            const { findBoard, searchCards, reopenCard } = await import("../../trello");
            const board = await findBoard("tokyo");
            if (board) {
              const cards = await searchCards(board.id, task.title);
              if (cards.length > 0) await reopenCard(board.id, cards[0].id);
            }
          }
        } catch {}
      }
      return `🔄 Task #${action.id} reopened — ${reason}`;
    }

    case "start_task":
      db.startTask(action.id);
      break;

    case "update_task":
      db.updateTask(action.id, action.fields);
      break;

    case "add_subtask":
      db.addSubtask(action.parent_id, action.title, action.priority);
      break;

    case "delete_task":
      db.deleteTask(action.id);
      break;

    case "add_habit":
      db.addHabit(action.name, action.frequency, action.category);
      break;

    case "remove_habit":
      db.deactivateHabit(action.id);
      break;

    case "log_habit":
      db.logHabit(action.habit_id, today);
      break;

    case "work_start":
      db.logWork("work_start", action.note, action.work_type || "dev", action.project_id);
      break;

    case "work_end":
      db.logWork("work_end", action.note);
      break;

    case "break_start":
      db.logWork("break_start");
      break;

    case "break_end":
      db.logWork("break_end");
      break;

    case "add_schedule":
      db.addScheduleItem(action.title, action.time, action.date, action.day_of_week, action.recurring, action.description);
      break;

    case "show_calendar": {
      const date = action.date || today;
      const activity = db.getDailyActivity(date);
      const dayName = new Date(date).toLocaleDateString("en-US", { weekday: "long" });
      const parts: string[] = [];
      if ((activity.tasksCompleted as any[]).length > 0) parts.push(`✅ ${(activity.tasksCompleted as any[]).length} tasks completed`);
      if (activity.work.totalMinutes > 0) parts.push(`⏱ ${Math.round(activity.work.totalMinutes / 60)}h work`);
      if (activity.quranPages > 0) parts.push(`📖 ${activity.quranPages} Quran pages`);
      if ((activity.journals as any[]).length > 0) parts.push(`📝 ${(activity.journals as any[]).length} journal entries`);
      const habitsD = (activity.habits as any[]).filter((h: any) => h.done).length;
      if (habitsD > 0) parts.push(`✓ ${habitsD}/${activity.habits.length} habits`);
      return `\n📅 *${dayName}, ${date}*\n${parts.join("\n") || "No activity recorded."}`;
    }

    case "show_progress": {
      const period = action.period || "week";
      const now = new Date();
      const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
      let start: string, end: string;
      if (period === "month") {
        start = new Date(y, m, 1).toISOString().split("T")[0];
        end = today;
      } else if (period === "year") {
        start = `${y}-01-01`;
        end = today;
      } else if (period === "lastweek") {
        const day = now.getDay();
        const diff = day === 0 ? 6 : day - 1;
        const thisWeekStart = new Date(y, m, d - diff);
        const lwe = new Date(thisWeekStart);
        lwe.setDate(lwe.getDate() - 1);
        const lws = new Date(lwe);
        lws.setDate(lws.getDate() - 6);
        start = lws.toISOString().split("T")[0];
        end = lwe.toISOString().split("T")[0];
      } else if (period === "lastmonth") {
        start = new Date(y, m - 1, 1).toISOString().split("T")[0];
        end = new Date(y, m, 0).toISOString().split("T")[0];
      } else {
        // default: week
        const day = now.getDay();
        const diff = day === 0 ? 6 : day - 1;
        start = new Date(y, m, d - diff).toISOString().split("T")[0];
        end = today;
      }
      const progress = db.getProgressData(start, end);
      return `\n📊 *${period.charAt(0).toUpperCase() + period.slice(1)} Progress (${start} → ${end})*
Tasks: ${progress.tasks.completed} done / ${progress.tasks.created} created
Work: ${progress.work.totalHours}h (${progress.work.daysWorked} days, avg ${progress.work.avgHoursPerWorkDay}h/day)
Habits: ${progress.habits.rate}% completion
Quran: ${progress.deen.quranPages} pages (${progress.deen.quranDays} days)
Income: ${progress.finance.total} DH (dev: ${progress.finance.devIncome}, shop: ${progress.finance.shopRevenue})
Journal: ${progress.journal.entries} entries`;
    }

    default:
      return;
  }
}

// ─── Context Builder ───────────────────────────────────────

async function buildProductivityContext(db: typeof import("../../db")): Promise<string> {
  const today = getTodayStr();
  const tasks = db.getAllActiveTasks() as any[];
  const habits = db.getHabitLogsForDate(today) as any[];
  const schedule = db.getScheduleForDate(today) as any[];
  const workStats = db.getWorkStats(today);
  const projects = db.getActiveProjects() as any[];
  const clients = db.getActiveClients() as any[];

  const workByType = Object.entries(workStats.byType)
    .map(([type, mins]) => `${type}: ${Math.round((mins as number) / 60)}h${(mins as number) % 60}m`)
    .join(", ") || "nothing tracked";

  return `### Active Tasks (${tasks.length})
${tasks.length > 0
    ? tasks.map((t) => {
        const subs = db.getSubtasks(t.id) as any[];
        let line = `- [${t.priority}][${t.category}] #${t.id} ${t.title}${t.due_date ? ` (due: ${t.due_date})` : ""} — ${t.status}`;
        if (subs.length > 0) line += `\n  Subtasks: ${subs.map((s) => `#${s.id} ${s.title} (${s.status})`).join(", ")}`;
        return line;
      }).join("\n")
    : "No active tasks."}

### Active Projects (${projects.length})
${projects.length > 0
    ? projects.map((p) => {
        const deadline = p.deadline ? ` (due: ${p.deadline})` : "";
        const budget = p.budget ? ` — ${p.budget} ${p.currency}` : "";
        const hours = p.estimated_hours ? ` [${p.actual_hours || 0}/${p.estimated_hours}h]` : "";
        const cl = p.client_name ? `[${p.client_name}]` : `[${p.category}]`;
        return `- #${p.id} ${cl} ${p.name}${deadline}${budget}${hours} — ${p.status}`;
      }).join("\n")
    : "No active projects."}

### Clients (${clients.length})
${clients.length > 0
    ? clients.map((c) => `- #${c.id} ${c.name} (${c.platform})`).join(", ")
    : "No clients."}

### Today's Schedule
${schedule.length > 0 ? schedule.map((s) => `- ${s.time}: ${s.title}${s.recurring ? " 🔁" : ""}`).join("\n") : "Nothing scheduled."}

### Habits Today
${habits.length > 0 ? habits.map((h) => `- ${h.done ? "✅" : "⬜"} ${h.name}`).join("\n") : "No habits tracked."}

### Work Today
Total: ${workStats.totalWorkMinutes} min work, ${workStats.totalBreakMinutes} min breaks
By type: ${workByType}`;
}

// ─── System Prompt Section ─────────────────────────────────

function getProductivityPromptSection(): string {
  return `## Productivity Actions
- {"type": "add_task", "title": "...", "category": "client|product|shop|learning|deen|admin|health|personal", "priority": "low|medium|high|urgent", "due_date": "YYYY-MM-DD", "project_id": number}
- {"type": "complete_task", "id": number}
- {"type": "reopen_task", "id": number, "reason": "why"}
- {"type": "start_task", "id": number}
- {"type": "update_task", "id": number, "fields": {"title": "...", "priority": "...", "due_date": "...", "category": "...", "notes": "...", "status": "pending|in_progress|done"}}
- {"type": "add_subtask", "parent_id": number, "title": "..."}
- {"type": "delete_task", "id": number}
- {"type": "add_habit", "name": "...", "frequency": "daily|weekly", "category": "..."}
- {"type": "remove_habit", "id": number}
- {"type": "log_habit", "habit_id": number}
- {"type": "work_start", "note": "...", "work_type": "dev|shop|client|learning|admin|deen", "project_id": number}
- {"type": "work_end", "note": "..."}
- {"type": "break_start"}
- {"type": "break_end"}
- {"type": "add_schedule", "title": "...", "time": "HH:MM", "date": "YYYY-MM-DD", "day_of_week": "...", "recurring": true|false}
- {"type": "show_calendar", "date": "YYYY-MM-DD"}
- {"type": "show_progress", "period": "week|month|year|lastweek|lastmonth"}`;
}

// ─── Agent Definition ──────────────────────────────────────

const productivityAgent: Agent = {
  name: "productivity",
  domain: "productivity" as AgentDomain,
  description: "Task management, work tracking, habits, schedule, and progress — the owner's productivity engine.",

  handles: ["prayer:approaching"],
  keywords: [
    "task", "done", "begin", "work", "shop", "break", "schedule", "progress",
    "habit", "stats", "مهمة", "خلصت", "شغل", "بدأت", "وقفت", "عادة", "مهام",
  ],
  commands: [
    "tasks", "done", "begin", "edit", "sub", "del",
    "habits", "check", "addhabit", "rmhabit",
    "work", "shop", "stopwork", "breakk", "endbreak", "stats",
    "schedule", "now", "state", "timeline", "week", "n",
  ],
  actions: [
    "add_task", "complete_task", "reopen_task", "start_task", "update_task",
    "add_subtask", "delete_task",
    "add_habit", "remove_habit", "log_habit",
    "work_start", "work_end", "break_start", "break_end",
    "add_schedule", "show_calendar", "show_progress",
  ],

  getSystemPromptSection(): string {
    return getProductivityPromptSection();
  },

  async getContextSection(): Promise<string> {
    // Dynamic import to avoid circular deps — db is resolved at call time
    const db = await import("../../db");
    return buildProductivityContext(db);
  },

  async handleEvent(event: AgentEvent, ctx: AgentContext): Promise<AgentResult> {
    if (event.type === "prayer:approaching") {
      const prayerName = event.data.name || "Prayer";
      const minutes = event.data.minutesUntil || 10;
      const active = ctx.db.getActiveWorkSession();
      if (active) {
        const msg = `🕌 *${prayerName}* in ${minutes} min — wrap up your ${active.work_type || "work"} session and prepare for prayer.`;
        await ctx.sendMessage(msg);
        return { success: true, output: msg };
      }
      return { success: true, output: "", silent: true };
    }
    return { success: true, output: "", silent: true };
  },

  async handleCommand(command: string, args: string, ctx: AgentContext): Promise<AgentResult> {
    switch (command) {
      case "tasks": return handleTasks(ctx);
      case "done": return handleDone(args, ctx);
      case "begin": return handleBegin(args, ctx);
      case "edit": return handleEdit(args, ctx);
      case "sub": return handleSub(args, ctx);
      case "del": return handleDel(args, ctx);
      case "habits": return handleHabits(ctx);
      case "check": return handleCheck(args, ctx);
      case "addhabit": return handleAddHabit(args, ctx);
      case "rmhabit": return handleRmHabit(args, ctx);
      case "work": return handleWork(args, ctx);
      case "shop": return handleShop(ctx);
      case "stopwork": return handleStopWork(args, ctx);
      case "breakk": return handleBreak(ctx);
      case "endbreak": return handleEndBreak(ctx);
      case "stats": return handleStats(ctx);
      case "schedule": return handleSchedule(ctx);
      case "now":
      case "n": return handleNow(ctx);
      case "state": return handleState(args, ctx);
      case "timeline": return handleTimeline(ctx);
      case "week": return handleWeek(ctx);
      default:
        return { success: false, output: `Unknown productivity command: /${command}` };
    }
  },

  async handleAction(action: Record<string, any>, ctx: AgentContext): Promise<string | void> {
    return handleAction(action, ctx);
  },
};

export default productivityAgent;
