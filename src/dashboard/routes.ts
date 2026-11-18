import express, { Router } from "express";
import { isArea } from "../area";
import { parseThumbWidth, ensureThumb, removeThumbs } from "./thumbs";
import { mediaDir as getMediaDir } from "../media-dir";
import { listSettings, validateSetting, saveSetting, setting } from "../settings";
import { clearCachedPrayerTimes } from "../prayer";
import { shouldAutoTranscribe, isWorkContact, isTranscribeSetting, CONTACT_CATEGORIES } from "../auto-transcribe";
import { matchProject } from "../project-registry";
import { isShopGroup } from "../shop-group";
import fs from "fs";
import path from "path";
import * as db from "../db";
import { transcribe } from "../stt";
import { getTodayPrayerTimes, getNextPrayer, getWorkWindows } from "../prayer";
import { getServerStatus } from "../shell";
import { getWhatsAppStatus, getWhatsAppChats, getWhatsAppMessages, sendWhatsAppMessage, startWhatsApp } from "../whatsapp";
import type { WeeklyReportData } from "../types";
import { localToday, localNow, localDateFromTimestamp } from "../utils";
import { getModel, setModel, getModelLabel } from "../ai";
import { runClassification, isClassifying, computeHabits } from "../analyzer";
import { parseSaleAmount } from "../shop-group";
import { buildMonthly, buildWeekday, buildHourly, buildInsights, formatShopAiContext, statsSince, applyStatsSince, shopRealDhInRange, shopDailyRealDh } from "./shop-insights";
import projectsRoutes from "./projects-routes";
import tasksBulkRoutes from "./tasks-bulk-routes";
import obligationsRoutes from "./obligations-routes";
import productsRoutes from "./products-routes";
import contentRoutes from "./content-routes";

const router = Router();

function today(): string {
  return localToday();
}

function monthRange(): { start: string; end: string } {
  const now = localNow();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];
  return { start, end };
}

function weekStart(): string {
  const now = localNow();
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const start = new Date(now);
  start.setDate(start.getDate() - diff);
  return start.toISOString().split("T")[0];
}

function getPeriodRange(period: string): { start: string; end: string } {
  const now = localNow();
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  if (period === "weekly") {
    const day = now.getDay();
    const diff = day === 0 ? 6 : day - 1;
    const start = new Date(y, m, d - diff);
    const end = new Date(y, m, d - diff + 6);
    return { start: start.toISOString().split("T")[0], end: end.toISOString().split("T")[0] };
  }
  if (period === "yearly") {
    return { start: y + "-01-01", end: y + "-12-31" };
  }
  return monthRange();
}

// Shop revenue on the dashboard comes from the shop-group messages, like the Shop page,
// in real dirhams. The shop_sales table is a lagging roll-up of the raw in-chat numbers.
function shopMultiplier(): number {
  const m = Number(setting("SHOP_PRICE_MULTIPLIER"));
  return m > 0 ? m : 10;
}

function shopRealDh(start: string, end: string): number {
  return shopRealDhInRange(collectShopSales(), start, end, shopMultiplier());
}

// Reuses the gatherData pattern from reports.ts
function gatherWeekData(startDate: string, endDate: string): WeeklyReportData {
  const completedTasks = db.getCompletedTasksInRange(startDate, endDate) as any[];
  const tasksByCategory: Record<string, number> = {};
  for (const t of completedTasks) {
    tasksByCategory[t.category] = (tasksByCategory[t.category] || 0) + 1;
  }

  const workStats = db.getWorkStatsForRange(startDate, endDate);
  const habitCompletion = db.getHabitCompletionInRange(startDate, endDate);
  const quranPages = db.getQuranPagesInRange(startDate, endDate);
  const adhkarDays = db.getAdhkarDaysInRange(startDate, endDate);
  const incomeSummary = db.getIncomeSummary(startDate, endDate);
  const shopRevenue = shopRealDh(startDate, endDate);

  let devIncome = 0;
  for (const row of incomeSummary) {
    if (row.source !== "shop") devIncome += row.total;
  }

  return {
    tasksCompleted: completedTasks.length,
    tasksByCategory,
    totalWorkMinutes: workStats.totalMinutes,
    workByType: workStats.byType,
    habitsCompleted: habitCompletion.completed,
    habitsTotal: habitCompletion.total,
    quranPages,
    adhkarDays: { morning: adhkarDays["morning"] || 0, evening: adhkarDays["evening"] || 0 },
    devIncome,
    shopRevenue,
    totalIncome: devIncome + shopRevenue,
  };
}

// ========================
// GET /api/overview
// ========================
router.get("/api/overview", async (_req, res) => {
  try {
    const t = today();

    const tasks = db.getAllActiveTasks() as any[];
    const tasksWithSubs = tasks.map((task) => ({
      ...task,
      subtasks: db.getSubtasks(task.id),
    }));

    const habits = (db.getHabitLogsForDate(t) as any[]).map((h) => ({
      ...h,
      streak: db.getHabitStreak(h.id),
    }));

    const workStats = db.getWorkStats(t);
    const activeSession = db.getActiveWorkSession();

    let prayer = null;
    let workWindows = null;
    let nextPrayer = null;
    try {
      prayer = await getTodayPrayerTimes();
      nextPrayer = await getNextPrayer();
      workWindows = await getWorkWindows();
    } catch {}

    const adhkar = db.getAdhkarStatus(t);
    const quranProgress = db.getQuranProgress();
    const quranToday = db.getQuranPagesInRange(t, t);

    const { start: mStart, end: mEnd } = monthRange();
    const incomeSummary = db.getIncomeSummary(mStart, mEnd);
    const monthShopRevenue = shopRealDh(mStart, mEnd);
    let devIncome = 0;
    for (const row of incomeSummary) {
      if (row.source !== "shop") devIncome += row.total;
    }

    const schedule = db.getScheduleForDate(t) as any[];

    // Additional data for v2
    const completedToday = db.getCompletedTasksForDate(t) as any[];
    const recentJournals = db.getRecentJournals(3) as any[];
    const latestCoaching = db.getLatestCoachingToday();
    const coachingCount = db.getCoachingCountToday();
    const incomeList = db.getIncomeForPeriod(mStart, mEnd) as any[];
    const wStart = weekStart();
    const shopWeekLog = shopDailyRealDh(collectShopSales(), wStart, t, shopMultiplier());
    const activeProjects = db.getActiveProjects() as any[];
    const projectRates = activeProjects
      .filter((p: any) => p.actual_hours > 0)
      .map((p: any) => {
        const inc = db.getIncomeByProject(p.id);
        return { name: p.name, rate: p.actual_hours > 0 ? Math.round(inc / p.actual_hours) : 0, hours: p.actual_hours, income: inc };
      })
      .filter((p: any) => p.income > 0);

    res.json({
      date: t,
      prayer,
      nextPrayer,
      workWindows,
      tasks: {
        active: tasksWithSubs,
        count: tasks.length,
        completedToday,
      },
      habits: {
        items: habits,
        completedCount: habits.filter((h: any) => h.done).length,
        totalCount: habits.length,
      },
      work: {
        totalMinutes: workStats.totalWorkMinutes,
        breakMinutes: workStats.totalBreakMinutes,
        byType: workStats.byType,
        activeSession: activeSession ? {
          ...activeSession,
          project_name: activeSession.project_id ? (db.getProject(activeSession.project_id) as any)?.name || null : null,
        } : null,
      },
      deen: {
        adhkar,
        quranToday,
        quranTotal: quranProgress.totalPages,
        quranDays: quranProgress.daysRead,
      },
      finance: {
        monthDevIncome: devIncome,
        monthShopRevenue,
        monthTotal: devIncome + monthShopRevenue,
        bySource: incomeSummary,
        incomeList,
        shopWeekLog,
        projectRates,
      },
      schedule,
      journal: recentJournals,
      coaching: { latest: latestCoaching || null, countToday: coachingCount },
    });
  } catch (err) {
    console.error("Dashboard overview error:", err);
    res.status(500).json({ error: "Failed to load overview" });
  }
});

// ========================
// GET /api/projects
// ========================
router.get("/api/projects", (_req, res) => {
  try {
    const projects = db.getActiveProjects();
    const deadlines = db.getUpcomingDeadlines(7);
    res.json({ projects, upcomingDeadlines: deadlines });
  } catch (err) {
    console.error("Dashboard projects error:", err);
    res.status(500).json({ error: "Failed to load projects" });
  }
});

// ========================
// GET /api/clients
// ========================
router.get("/api/clients", (_req, res) => {
  try {
    res.json(db.getActiveClients());
  } catch (err) {
    console.error("Dashboard clients error:", err);
    res.status(500).json({ error: "Failed to load clients" });
  }
});

// ========================
// GET /api/weekly-trends
// ========================
router.get("/api/weekly-trends", (_req, res) => {
  try {
    const weeks: (WeeklyReportData & { weekStart: string; weekEnd: string })[] = [];
    const now = new Date();

    for (let i = 1; i <= 4; i++) {
      const day = now.getDay();
      const diff = day === 0 ? 6 : day - 1;
      const end = new Date(now);
      end.setDate(now.getDate() - diff - (i - 1) * 7 - 1);
      const start = new Date(end);
      start.setDate(end.getDate() - 6);

      const startStr = start.toISOString().split("T")[0];
      const endStr = end.toISOString().split("T")[0];
      const data = gatherWeekData(startStr, endStr);
      weeks.push({ weekStart: startStr, weekEnd: endStr, ...data });
    }

    res.json(weeks.reverse());
  } catch (err) {
    console.error("Dashboard trends error:", err);
    res.status(500).json({ error: "Failed to load trends" });
  }
});

// ========================
// GET /api/server
// ========================
router.get("/api/server", async (_req, res) => {
  try {
    const status = await getServerStatus();
    res.json({ status });
  } catch (err) {
    console.error("Dashboard server error:", err);
    res.status(500).json({ error: "Failed to load server status" });
  }
});

// ========================
// GET /api/report/latest
// ========================
router.get("/api/report/latest", (_req, res) => {
  try {
    const report = db.getLatestWeeklyReport();
    res.json(report || { message: "No reports yet" });
  } catch (err) {
    console.error("Dashboard report error:", err);
    res.status(500).json({ error: "Failed to load report" });
  }
});

// ========================
// GET /api/conversations
// ========================
router.get("/api/conversations", (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const conversations = db.getRecentConversations(Math.min(limit, 200));
    res.json(conversations);
  } catch (err) {
    console.error("Dashboard conversations error:", err);
    res.status(500).json({ error: "Failed to load conversations" });
  }
});

// ========================
// GET /api/transcripts
// ========================

router.get("/api/transcripts", (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    res.json({
      items: db.getTranscripts(limit, offset, q),
      total: db.countTranscripts(q),
      pending: db.countUntranscribedAudio(),
      limit,
      offset,
    });
  } catch (err) {
    console.error("Dashboard transcripts error:", err);
    res.status(500).json({ error: "Failed to load transcripts" });
  }
});

// ========================
// GET /api/transcripts/pending
// ========================

router.get("/api/transcripts/pending", (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 25, 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
    res.json({
      items: db.getPendingAudio(limit, offset),
      total: db.countUntranscribedAudio(),
      limit,
      offset,
    });
  } catch (err) {
    console.error("Dashboard pending audio error:", err);
    res.status(500).json({ error: "Failed to load pending audio" });
  }
});

// ========================
// POST /api/transcripts/:id/transcribe
// ========================

router.post("/api/transcripts/:id/transcribe", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Bad id" });

    const row = db.getAudioRow(id);
    if (!row) return res.status(404).json({ error: "No such voice note" });

    // media_path is stored relative to the project root.
    const abs = path.isAbsolute(row.media_path)
      ? row.media_path
      : path.join(__dirname, "..", "..", row.media_path);
    if (!fs.existsSync(abs)) {
      return res.status(410).json({ error: "Audio file is no longer on disk" });
    }

    const ext = (abs.split(".").pop() || "ogg").toLowerCase();
    const result = await transcribe(fs.readFileSync(abs), ext);
    if (!result) {
      // Deliberately not 500: the request was fine, the backend just could not produce
      // a transcript, and the UI needs to tell those apart.
      return res.status(502).json({ error: "Transcription failed — see server logs" });
    }

    const words = result.text.trim().split(/\s+/).filter(Boolean).length;
    const wpm = result.durationSeconds && result.durationSeconds > 0
      ? (words / result.durationSeconds) * 60
      : null;
    db.updateWATranscriptionWithDuration(id, result.text, result.durationSeconds, wpm);

    res.json({ id, transcription: result.text, durationSeconds: result.durationSeconds });
  } catch (err) {
    console.error("Dashboard transcribe error:", err);
    res.status(500).json({ error: "Failed to transcribe" });
  }
});

// ========================
// POST /api/transcripts/upload
// ========================

// express.json() caps at 100kb, which no voice note fits under. A raw body on this one
// route keeps audio uploads working without pulling in a multipart dependency.
router.post(
  "/api/transcripts/upload",
  express.raw({ type: () => true, limit: "25mb" }),
  async (req, res) => {
    try {
      const buf = req.body as Buffer;
      if (!Buffer.isBuffer(buf) || buf.length === 0) {
        return res.status(400).json({ error: "No audio uploaded" });
      }
      const ext = typeof req.query.ext === "string" ? req.query.ext.toLowerCase() : "ogg";
      const result = await transcribe(buf, ext);
      if (!result) {
        return res.status(502).json({ error: "Transcription failed — unsupported format or backend error" });
      }
      res.json({ transcription: result.text, durationSeconds: result.durationSeconds });
    } catch (err) {
      console.error("Dashboard upload transcribe error:", err);
      res.status(500).json({ error: "Failed to transcribe upload" });
    }
  },
);

// ========================
// POST /api/tasks/:id/complete
// ========================
router.post("/api/tasks/:id/complete", (req, res) => {
  try {
    const id = parseInt(req.params.id);
    db.completeTask(id);
    res.json({ ok: true });
  } catch (err) {
    console.error("Complete task error:", err);
    res.status(500).json({ error: "Failed to complete task" });
  }
});

// ========================
// POST /api/tasks/:id/start
// ========================
router.post("/api/tasks/:id/start", (req, res) => {
  try {
    const id = parseInt(req.params.id);
    db.startTask(id);
    res.json({ ok: true });
  } catch (err) {
    console.error("Start task error:", err);
    res.status(500).json({ error: "Failed to start task" });
  }
});

// ========================
// POST /api/tasks/:id/edit
// ========================
router.post("/api/tasks/:id/edit", (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { title, priority, due_date, category, area } = req.body;
    db.updateTask(id, { title, priority, due_date, category });
    if (area !== undefined) {
      if (area !== null && !isArea(area)) { res.status(400).json({ error: "area must be work, personal, learn or null" }); return; }
      db.setTaskArea(id, area);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Edit task error:", err);
    res.status(500).json({ error: "Failed to edit task" });
  }
});

// ========================
// DELETE /api/tasks/:id
// ========================
router.delete("/api/tasks/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id);
    db.deleteTask(id);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete task error:", err);
    res.status(500).json({ error: "Failed to delete task" });
  }
});

// ========================
// POST /api/tasks/:id/subtasks
// ========================
router.post("/api/tasks/:id/subtasks", (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.id)) { res.status(400).json({ error: "Bad id" }); return; }
    const parentId = parseInt(req.params.id);
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    if (title.length < 1 || title.length > 200) { res.status(400).json({ error: "Title must be 1 to 200 characters" }); return; }
    if (!db.getTask(parentId)) { res.status(404).json({ error: "No such task" }); return; }
    const result = db.addSubtask(parentId, title);
    res.json({ ok: true, id: Number(result.lastInsertRowid) });
  } catch (err) {
    console.error("Add subtask error:", err);
    res.status(500).json({ error: "Failed to add subtask" });
  }
});

// ========================
// POST /api/tasks/:id/subtasks/:sid/complete
// ========================
router.post("/api/tasks/:id/subtasks/:sid/complete", (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.id) || !/^\d+$/.test(req.params.sid)) { res.status(400).json({ error: "Bad id" }); return; }
    const sub = db.getTask(parseInt(req.params.sid));
    if (!sub || sub.parent_id !== parseInt(req.params.id)) { res.status(404).json({ error: "No such subtask" }); return; }
    db.completeTask(sub.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("Complete subtask error:", err);
    res.status(500).json({ error: "Failed to complete subtask" });
  }
});

// ========================
// POST /api/tasks
// ========================
router.post("/api/tasks", (req, res) => {
  try {
    const { title, category, priority } = req.body;
    if (!title) { res.status(400).json({ error: "Title required" }); return; }
    const result = db.addTask(title, category || "other", priority || "medium");
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error("Add task error:", err);
    res.status(500).json({ error: "Failed to add task" });
  }
});

// ========================
// POST /api/habits/:id/check
// ========================
router.post("/api/habits/:id/check", (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const done = db.toggleHabit(id, today());
    res.json({ ok: true, done });
  } catch (err) {
    console.error("Toggle habit error:", err);
    res.status(500).json({ error: "Failed to toggle habit" });
  }
});

// ========================
// POST /api/habits
// ========================
router.post("/api/habits", (req, res) => {
  try {
    const { name, frequency, category } = req.body;
    if (!name) { res.status(400).json({ error: "Name required" }); return; }
    db.addHabit(name, frequency, category);
    res.json({ ok: true });
  } catch (err) {
    console.error("Add habit error:", err);
    res.status(500).json({ error: "Failed to add habit" });
  }
});

// ========================
// DELETE /api/habits/:id
// ========================
router.delete("/api/habits/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id);
    db.deactivateHabit(id);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete habit error:", err);
    res.status(500).json({ error: "Failed to delete habit" });
  }
});

// ========================
// POST /api/adhkar/:type
// ========================
router.post("/api/adhkar/:type", (req, res) => {
  try {
    const type = req.params.type;
    if (!["morning", "evening", "post_prayer", "general"].includes(type)) {
      res.status(400).json({ error: "Invalid adhkar type" }); return;
    }
    db.logAdhkar(type);
    res.json({ ok: true });
  } catch (err) {
    console.error("Log adhkar error:", err);
    res.status(500).json({ error: "Failed to log adhkar" });
  }
});

// ========================
// POST /api/work/start
// ========================
router.post("/api/work/start", (req, res) => {
  try {
    const active = db.getActiveWorkSession();
    if (active) { res.status(400).json({ error: "Already in a work session" }); return; }
    const { note, workType, projectId } = req.body || {};
    db.logWork("work_start", note, workType || "dev", projectId || undefined);
    res.json({ ok: true });
  } catch (err) {
    console.error("Start work error:", err);
    res.status(500).json({ error: "Failed to start work" });
  }
});

// ========================
// POST /api/work/stop
// ========================
router.post("/api/work/stop", (req, res) => {
  try {
    const active = db.getActiveWorkSession();
    if (!active) { res.status(400).json({ error: "No active work session" }); return; }
    db.logWork("work_end");
    res.json({ ok: true });
  } catch (err) {
    console.error("Stop work error:", err);
    res.status(500).json({ error: "Failed to stop work" });
  }
});

// ========================
// POST /api/work/break
// ========================
router.post("/api/work/break", (req, res) => {
  try {
    const active = db.getActiveWorkSession();
    if (!active) { res.status(400).json({ error: "No active work session" }); return; }
    const onBreak = db.getActiveBreak();
    if (onBreak) {
      db.logWork("break_end");
      res.json({ ok: true, onBreak: false });
    } else {
      db.logWork("break_start");
      res.json({ ok: true, onBreak: true });
    }
  } catch (err) {
    console.error("Toggle break error:", err);
    res.status(500).json({ error: "Failed to toggle break" });
  }
});

// ========================
// GET /api/work/log — work sessions for the past 7 days
// ========================
router.get("/api/work/log", (_req, res) => {
  try {
    const now = new Date();
    const days: { date: string; totalMinutes: number; sessions: any[] }[] = [];

    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split("T")[0];
      const logs = db.getWorkLogsForDate(dateStr) as any[];

      const sessions: any[] = [];
      let workStart: any = null;

      for (const log of logs) {
        if (log.type === "work_start") {
          workStart = log;
        } else if (log.type === "work_end" && workStart) {
          const mins = (new Date(log.logged_at).getTime() - new Date(workStart.logged_at).getTime()) / 60000;
          // Resolve project name
          let projectName: string | null = null;
          if (workStart.project_id) {
            const proj = db.getProject(workStart.project_id) as any;
            projectName = proj?.name || null;
          }
          sessions.push({
            id: workStart.id,
            work_type: workStart.work_type || "dev",
            note: workStart.note,
            project_id: workStart.project_id,
            project_name: projectName,
            started_at: workStart.logged_at,
            ended_at: log.logged_at,
            minutes: Math.round(mins),
            on_break: false,
          });
          workStart = null;
        }
      }

      // Include currently active session
      if (workStart && i === 0) {
        const mins = (Date.now() - new Date(workStart.logged_at).getTime()) / 60000;
        let projectName: string | null = null;
        if (workStart.project_id) {
          const proj = db.getProject(workStart.project_id) as any;
          projectName = proj?.name || null;
        }
        sessions.push({
          id: workStart.id,
          work_type: workStart.work_type || "dev",
          note: workStart.note,
          project_id: workStart.project_id,
          project_name: projectName,
          started_at: workStart.logged_at,
          ended_at: null,
          minutes: Math.round(mins),
          on_break: false,
        });
      }

      const totalMinutes = sessions.reduce((s, sess) => s + sess.minutes, 0);
      if (sessions.length > 0) {
        days.push({ date: dateStr, totalMinutes, sessions });
      }
    }

    res.json(days);
  } catch (err) {
    console.error("Work log error:", err);
    res.status(500).json({ error: "Failed to load work log" });
  }
});

// ========================
// POST /api/quran
// ========================
router.post("/api/quran", (req, res) => {
  try {
    const { pages } = req.body;
    if (!pages || pages < 1) { res.status(400).json({ error: "Pages required" }); return; }
    db.logQuranReading(pages);
    res.json({ ok: true });
  } catch (err) {
    console.error("Log quran error:", err);
    res.status(500).json({ error: "Failed to log quran" });
  }
});

// ========================
// POST /api/journal
// ========================
router.post("/api/journal", (req, res) => {
  try {
    const { entry, mood } = req.body;
    if (!entry) { res.status(400).json({ error: "Entry required" }); return; }
    db.addJournalEntry(entry, mood);
    res.json({ ok: true });
  } catch (err) {
    console.error("Add journal error:", err);
    res.status(500).json({ error: "Failed to add journal entry" });
  }
});

// ========================
// GET /api/goals
// ========================
router.get("/api/goals", (_req, res) => {
  try {
    const goals = db.getGoals() as any[];
    const enriched = goals.map((goal: any) => {
      const { start, end } = getPeriodRange(goal.period);
      let currentValue = 0;
      switch (goal.metric) {
        case "income": {
          // Dev income from the income table, plus the shop's real-DH sales (same source as /api/shop).
          const summary = db.getIncomeSummary(start, end);
          const dev = summary.filter((r: any) => r.source !== "shop").reduce((s: number, r: any) => s + r.total, 0);
          currentValue = dev + shopRealDh(start, end);
          break;
        }
        case "quran_pages":
          currentValue = db.getQuranPagesInRange(start, end);
          break;
        case "work_hours": {
          const stats = db.getWorkStatsForRange(start, end);
          currentValue = Math.round((stats.totalMinutes / 60) * 10) / 10;
          break;
        }
        case "tasks": {
          const completed = db.getCompletedTasksInRange(start, end) as any[];
          currentValue = completed.length;
          break;
        }
        case "habits": {
          const completion = db.getHabitCompletionInRange(start, end);
          currentValue = completion.completed;
          break;
        }
        case "custom":
          currentValue = goal.current_value || 0;
          break;
      }
      return {
        ...goal,
        currentValue,
        progress: goal.target_value > 0 ? Math.min(100, (currentValue / goal.target_value) * 100) : 0,
      };
    });
    res.json(enriched);
  } catch (err) {
    console.error("Goals error:", err);
    res.status(500).json({ error: "Failed to load goals" });
  }
});

// ========================
// POST /api/goals
// ========================
router.post("/api/goals", (req, res) => {
  try {
    const { title, metric, targetValue, period } = req.body;
    if (!title || !metric || !targetValue) { res.status(400).json({ error: "title, metric, targetValue required" }); return; }
    const result = db.addGoal(title, metric, targetValue, period || "monthly");
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error("Add goal error:", err);
    res.status(500).json({ error: "Failed to add goal" });
  }
});

// ========================
// POST /api/goals/:id/update
// ========================
router.post("/api/goals/:id/update", (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { value } = req.body;
    if (value == null) { res.status(400).json({ error: "value required" }); return; }
    db.updateGoalValue(id, value);
    res.json({ ok: true });
  } catch (err) {
    console.error("Update goal error:", err);
    res.status(500).json({ error: "Failed to update goal" });
  }
});

// ========================
// DELETE /api/goals/:id
// ========================
router.delete("/api/goals/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id);
    db.deleteGoal(id);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete goal error:", err);
    res.status(500).json({ error: "Failed to delete goal" });
  }
});

// ========================
// GET /api/calendar — Date range summaries (must be before :date route)
// ========================
router.get("/api/calendar", (req, res) => {
  try {
    const start = req.query.start as string;
    const end = req.query.end as string;

    if (!start || !end) {
      // Default: current month
      const now = localNow();
      const mStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
      const mEnd = localToday();
      const summaries = db.getDateRangeSummaries(mStart, mEnd);
      res.json({ start: mStart, end: mEnd, days: summaries });
      return;
    }

    const summaries = db.getDateRangeSummaries(start, end);
    res.json({ start, end, days: summaries });
  } catch (err) {
    console.error("Calendar range error:", err);
    res.status(500).json({ error: "Failed to load calendar range" });
  }
});

// ========================
// GET /api/calendar/:date — Full daily activity
// ========================
router.get("/api/calendar/:date", (req, res) => {
  try {
    const date = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });
      return;
    }
    const activity = db.getDailyActivity(date);
    res.json(activity);
  } catch (err) {
    console.error("Calendar date error:", err);
    res.status(500).json({ error: "Failed to load calendar" });
  }
});

// ========================
// GET /api/progress/:period — Progress data (week, month, year)
// ========================
router.get("/api/progress/:period", (req, res) => {
  try {
    const period = req.params.period;
    const { start, end } = getPeriodRange(period);
    const progress = db.getProgressData(start, end);
    res.json({ periodName: period, ...progress });
  } catch (err) {
    console.error("Progress error:", err);
    res.status(500).json({ error: "Failed to load progress" });
  }
});

function historyDays(q: unknown, fallback: number): number {
  const n = parseInt(q as string);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 365) : fallback;
}

// ========================
// GET /api/habits/history, /api/adhkar/history, /api/quran/history — one row per day
// ========================
router.get("/api/habits/history", (req, res) => {
  try {
    res.json(db.getHabitHistory(historyDays(req.query.days, 7)));
  } catch (err) {
    console.error("Habit history error:", err);
    res.status(500).json({ error: "Failed to load habit history" });
  }
});

router.get("/api/adhkar/history", (req, res) => {
  try {
    res.json(db.getAdhkarHistory(historyDays(req.query.days, 30)));
  } catch (err) {
    console.error("Adhkar history error:", err);
    res.status(500).json({ error: "Failed to load adhkar history" });
  }
});

router.get("/api/quran/history", (req, res) => {
  try {
    res.json(db.getQuranHistory(historyDays(req.query.days, 30)));
  } catch (err) {
    console.error("Quran history error:", err);
    res.status(500).json({ error: "Failed to load Quran history" });
  }
});

// ========================
// GET /api/journal — all entries for the Journal page, newest first
// ========================
router.get("/api/journal", (_req, res) => {
  try {
    res.json(db.getRecentJournals(1000));
  } catch (err) {
    console.error("Journal error:", err);
    res.status(500).json({ error: "Failed to load journal" });
  }
});

// ========================
// GET /api/journals — Journal entries with optional date range
// ========================
router.get("/api/journals", (req, res) => {
  try {
    const start = req.query.start as string;
    const end = req.query.end as string;

    if (start && end) {
      res.json(db.getJournalsInRange(start, end));
    } else {
      const limit = parseInt(req.query.limit as string) || 20;
      res.json(db.getRecentJournals(limit));
    }
  } catch (err) {
    console.error("Journals error:", err);
    res.status(500).json({ error: "Failed to load journals" });
  }
});

// ========================
// GET /api/media/:filename — Serve WhatsApp media files
// ========================
router.get("/api/media/:filename", async (req, res) => {
  const filename = req.params.filename;
  // Security: only allow filenames starting with wa_ and no path traversal
  if (!filename.startsWith("wa_") || filename.includes("..") || filename.includes("/")) {
    res.status(400).json({ error: "Invalid filename" });
    return;
  }
  const mediaDir = getMediaDir();
  const filepath = require("path").join(mediaDir, filename);
  if (!require("fs").existsSync(filepath)) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  // ?w=320 serves a cached thumbnail (src/dashboard/thumbs.ts). The gallery asks
  // for one per tile instead of downloading the full photo; anything it cannot
  // resize falls through to the original.
  const width = parseThumbWidth(req.query.w);
  if (width) {
    const thumb = await ensureThumb(mediaDir, filename, width);
    if (thumb) {
      // The name carries the message id, so a given file never changes.
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.sendFile(thumb);
      return;
    }
  }
  res.sendFile(filepath);
});

// ========================
// WhatsApp API
// ========================
// ========================
// WhatsApp media gallery — list, chats, delete
// ========================

/** Basename of a stored media path, or null when the file is no longer on disk. */
function existingMediaFile(mediaPath: string | null): string | null {
  if (!mediaPath) return null;
  const file = require("path").basename(mediaPath);
  return require("fs").existsSync(require("path").join(getMediaDir(), file)) ? file : null;
}

function mediaChatNames(): Map<string, string> {
  const names = new Map<string, string>();
  for (const c of getWhatsAppChats() as { jid: string; name?: string }[]) {
    if (c.name) names.set(c.jid, c.name);
  }
  for (const c of db.getAllWAContacts() as { jid: string; display_name: string | null }[]) {
    if (c.display_name) names.set(c.jid, c.display_name);
  }
  return names;
}

function fallbackChatName(jid: string, isGroup: boolean, senderName: string | null): string {
  if (!isGroup && senderName) return senderName;
  const id = jid.split("@")[0];
  return isGroup ? `Group ${id.slice(-6)}` : `+${id}`;
}

router.get("/api/whatsapp/media/chats", (_req, res) => {
  try {
    const names = mediaChatNames();
    const byJid = new Map<string, { jid: string; name: string; count: number }>();
    for (const r of db.getAllWAMediaPaths()) {
      if (!existingMediaFile(r.media_path)) continue;
      let entry = byJid.get(r.jid);
      if (!entry) {
        entry = { jid: r.jid, name: names.get(r.jid) || "", count: 0 };
        byJid.set(r.jid, entry);
      }
      if (!entry.name && !r.from_me) entry.name = fallbackChatName(r.jid, !!r.is_group, r.sender_name);
      entry.count++;
    }
    const out = [...byJid.values()].map((c) => ({ ...c, name: c.name || fallbackChatName(c.jid, c.jid.endsWith("@g.us"), null) }));
    out.sort((a, b) => b.count - a.count);
    res.json(out);
  } catch (err) {
    console.error("WA media chats error:", err);
    res.status(500).json({ error: "Failed to load media chats" });
  }
});

router.get("/api/whatsapp/media", (req, res) => {
  try {
    const type = req.query.type as string;
    const types = type === "image" ? ["image"] : type === "video" ? ["video"] : ["image", "video"];
    const jid = (req.query.jid as string) || undefined;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 60, 1), 200);
    let beforeId = parseInt(req.query.before as string) || undefined;
    const names = mediaChatNames();

    // Many old rows point at files that were swept from disk — skip those and keep
    // scanning until the page is full or the table runs out.
    const items: unknown[] = [];
    let exhausted = false;
    while (items.length < limit) {
      const batch = db.getWAMediaPage({ types, jid, beforeId, limit: limit * 2 });
      if (batch.length === 0) { exhausted = true; break; }
      for (const r of batch) {
        beforeId = r.id;
        const file = existingMediaFile(r.media_path);
        if (!file) continue;
        items.push({
          id: r.id,
          jid: r.jid,
          chatName: names.get(r.jid) || fallbackChatName(r.jid, !!r.is_group, r.from_me ? null : r.sender_name),
          sender: r.sender_name,
          fromMe: !!r.from_me,
          timestamp: r.timestamp,
          type: r.message_type,
          file,
          caption: (r.content || "").replace(/^\[(Image|Video)\]\s*/, "").trim(),
        });
        if (items.length >= limit) break;
      }
      if (batch.length < limit * 2 && items.length < limit) { exhausted = true; break; }
    }
    res.json({ items, nextBefore: exhausted ? null : beforeId ?? null });
  } catch (err) {
    console.error("WA media list error:", err);
    res.status(500).json({ error: "Failed to load media" });
  }
});

router.post("/api/whatsapp/media/delete", (req, res) => {
  try {
    const raw = (req.body?.ids ?? []) as unknown[];
    const ids = raw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500);
    if (ids.length === 0) {
      res.status(400).json({ error: "No ids given" });
      return;
    }
    let deleted = 0;
    for (const row of db.getWAMediaByIds(ids)) {
      if (!["image", "video"].includes(row.message_type) || !row.media_path) continue;
      const file = require("path").basename(row.media_path);
      try { require("fs").unlinkSync(require("path").join(getMediaDir(), file)); } catch {}
      removeThumbs(getMediaDir(), file);
      db.clearWAMessageMedia(row.id);
      deleted++;
    }
    console.log(`🗑️ Dashboard deleted ${deleted} WhatsApp media file(s)`);
    res.json({ ok: true, deleted });
  } catch (err) {
    console.error("WA media delete error:", err);
    res.status(500).json({ error: "Failed to delete media" });
  }
});

router.get("/api/whatsapp/status", (_req, res) => {
  res.json(getWhatsAppStatus());
});

router.post("/api/whatsapp/connect", async (req, res) => {
  try {
    const { phoneNumber } = req.body || {};
    await startWhatsApp(phoneNumber || undefined);
    res.json({ ok: true });
  } catch (err) {
    console.error("WhatsApp connect error:", err);
    res.status(500).json({ error: "Failed to start WhatsApp" });
  }
});

router.get("/api/whatsapp/chats", (_req, res) => {
  res.json(getWhatsAppChats());
});

router.get("/api/whatsapp/messages/:jid", (req, res) => {
  const jid = req.params.jid;
  const limit = parseInt(req.query.limit as string) || 50;
  res.json(getWhatsAppMessages(jid, limit));
});

router.post("/api/whatsapp/send", async (req, res) => {
  try {
    const { jid, text } = req.body;
    if (!jid || !text) { res.status(400).json({ error: "jid and text required" }); return; }
    await sendWhatsAppMessage(jid, text);
    res.json({ ok: true });
  } catch (err: any) {
    console.error("WhatsApp send error:", err);
    res.status(500).json({ error: err.message || "Failed to send" });
  }
});

// ========================
// Settings API
// ========================
// ========================
// Settings: GET all, POST one. Only keys in src/settings.ts; secrets are never settings.
// ========================
router.get("/api/settings", (_req, res) => {
  try {
    res.json({ settings: listSettings() });
  } catch (err) {
    console.error("settings list error:", err);
    res.status(500).json({ error: "Failed to load settings" });
  }
});

router.post("/api/settings", (req, res) => {
  const { key, value } = req.body || {};
  const problem = typeof key === "string" ? validateSetting(key, value) : "key required";
  if (problem) { res.status(400).json({ error: `${key}: ${problem}` }); return; }
  try {
    saveSetting(key, value);
    if (key.startsWith("PRAYER_")) clearCachedPrayerTimes();
    res.json({ ok: true });
  } catch (err) {
    console.error("settings save error:", err);
    res.status(500).json({ error: "Failed to save setting" });
  }
});

// ========================
// Auto-transcribe (Settings): which contacts' voice notes are transcribed on arrival
// ========================
router.get("/api/settings/auto-transcribe", (_req, res) => {
  try {
    const contacts = db.listVoiceContacts().map((c) => {
      const facts = { category: c.category, matchesProject: !!matchProject(c.name ?? ""), isShopGroup: isShopGroup(c.jid) };
      return {
        jid: c.jid,
        name: c.name || c.jid.split("@")[0],
        category: c.category ?? "other",
        setting: c.auto_transcribe ?? "default",
        work: isWorkContact(facts),
        effective: shouldAutoTranscribe({ ...facts, setting: c.auto_transcribe }),
        voiceNotes: c.voice_notes,
        lastAt: c.last_at,
      };
    });
    res.json({ contacts, categories: CONTACT_CATEGORIES });
  } catch (err) {
    console.error("auto-transcribe list error:", err);
    res.status(500).json({ error: "Failed to load contacts" });
  }
});

router.post("/api/settings/auto-transcribe", (req, res) => {
  const { jid, setting, category, name } = req.body || {};
  if (typeof jid !== "string" || !jid.includes("@")) { res.status(400).json({ error: "jid required" }); return; }
  if (setting !== undefined && !isTranscribeSetting(setting)) { res.status(400).json({ error: "setting must be default, on or off" }); return; }
  if (category !== undefined && !(CONTACT_CATEGORIES as readonly string[]).includes(category)) { res.status(400).json({ error: "unknown category" }); return; }
  if (name !== undefined && typeof name !== "string") { res.status(400).json({ error: "name must be a string" }); return; }
  try {
    if (category !== undefined) db.setWAContactCategory(jid, category);
    if (setting !== undefined) db.setWAAutoTranscribe(jid, setting);
    // A rename changes what the dashboard shows AND what matchProject() sees, so
    // naming a contact after a project is enough to make Default transcribe it.
    if (name !== undefined) db.setWAContactName(jid, name);
    res.json({ ok: true });
  } catch (err) {
    console.error("auto-transcribe save error:", err);
    res.status(500).json({ error: "Failed to save" });
  }
});

router.get("/api/settings/model", (_req, res) => {
  res.json({
    model: getModel(),
    label: getModelLabel(),
    hasKieKey: !!process.env.KIE_API_KEY
  });
});

router.post("/api/settings/model", (req, res) => {
  const { model } = req.body;
  if (model === "kieai" && !process.env.KIE_API_KEY) {
    res.status(400).json({ error: "KIE_API_KEY is not set. Please set it first." });
    return;
  }
  if (model === "claude" || model === "kieai") {
    setModel(model);
    res.json({ ok: true, model, label: getModelLabel() });
  } else {
    res.status(400).json({ error: "Invalid model" });
  }
});

router.post("/api/settings/kie-key", (req, res) => {
  const { key } = req.body;
  if (!key) {
    res.status(400).json({ error: "API key required" });
    return;
  }
  
  // Here we would ideally write this back to .env file too
  // For now we set it in the runtime process memory
  process.env.KIE_API_KEY = key;
  
  try {
    const fs = require("fs");
    const path = require("path");
    const envPath = path.join(__dirname, "..", "..", ".env");
    let envContent = fs.readFileSync(envPath, "utf-8");
    
    if (envContent.includes("KIE_API_KEY=")) {
      // Replace existing
      envContent = envContent.replace(/KIE_API_KEY=.*/g, `KIE_API_KEY=${key}`);
    } else {
      // Append
      envContent += `\nKIE_API_KEY=${key}\n`;
    }
    
    fs.writeFileSync(envPath, envContent);
    res.json({ ok: true });
  } catch (err: any) {
    console.error("Failed to save KIE_API_KEY to .env:", err);
    res.status(500).json({ error: "Failed to persist to .env file" });
  }
});


// ========================
// POST /api/chat-analyzer/classify
// ========================
router.post("/api/chat-analyzer/classify", async (_req, res) => {
  try {
    const limit = parseInt(_req.body?.limit as string) || 10000;
    const result = await runClassification(limit);
    res.json(result);
  } catch (err: any) {
    console.error("Classify error:", err);
    if (err.message === "Classification already in progress") {
      res.status(409).json({ error: err.message });
    } else {
      res.status(500).json({ error: "Classification failed" });
    }
  }
});

// ========================
// GET /api/chat-analyzer/sentiment
// ========================
router.get("/api/chat-analyzer/sentiment", (req, res) => {
  try {
    const period = req.query.period as string || "month";
    const now = new Date();
    let start: string;

    if (period === "week") {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      start = d.toISOString().split("T")[0];
    } else if (period === "year") {
      start = now.getFullYear() + "-01-01";
    } else {
      start = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-01";
    }

    const end = now.toISOString().split("T")[0];
    const overall = db.getSentimentAggregation(start, end);
    const byContact = db.getSentimentByContact();

    res.json({ overall, byContact });
  } catch (err) {
    console.error("Sentiment query error:", err);
    res.status(500).json({ error: "Failed to load sentiment data" });
  }
});

// ========================
// GET /api/chat-analyzer/habits
// ========================
router.get("/api/chat-analyzer/habits", (_req, res) => {
  try {
    const data = computeHabits();
    res.json(data);
  } catch (err) {
    console.error("Habits query error:", err);
    res.status(500).json({ error: "Failed to load habits data" });
  }
});

// ========================
// GET /api/shop  — the seller's shop-group sales
// ========================
// Sales are bare DH numbers posted in the WhatsApp shop group. The group JID
// has changed once already (the old one went silent 2026-04-18), so we read
// every known shop JID and let the message log be the source of truth.
const SHOP_GROUP_JIDS: string[] = (
  process.env.SHOP_GROUP_JIDS ||
  "120363000000000002@g.us,120363000000000001@g.us"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SHOP_TZ = process.env.TIMEZONE || "Africa/Casablanca";

function shopLocalHour(ts: number): number {
  const h = new Date(ts * 1000).toLocaleString("en-GB", {
    timeZone: SHOP_TZ,
    hour: "2-digit",
    hour12: false,
  });
  return parseInt(h, 10) || 0;
}

function shopLocalTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString("en-GB", {
    timeZone: SHOP_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

interface ShopSale {
  id: number;
  amount: number;
  date: string;
  time: string;
  hour: number;
  sender: string;
  senderId: string;
  source: "text" | "voice";
  raw: string;
}

function collectShopSales(): ShopSale[] {
  const rows = db.getShopGroupMessages(SHOP_GROUP_JIDS);
  const sales: ShopSale[] = [];
  for (const r of rows) {
    const isVoice = r.message_type === "audio" || r.message_type === "ptt";
    const text = (isVoice ? r.transcription : r.content) || r.content || "";
    const amount = parseSaleAmount(text);
    if (amount === null) continue;
    sales.push({
      id: r.id,
      amount,
      date: localDateFromTimestamp(r.timestamp),
      time: shopLocalTime(r.timestamp),
      hour: shopLocalHour(r.timestamp),
      sender: r.sender_name || r.sender || "unknown",
      senderId: r.sender || r.sender_name || "unknown",
      source: isVoice ? "voice" : "text",
      raw: text.trim().slice(0, 40),
    });
  }
  return applyStatsSince(sales);
}

router.get("/api/shop", (_req, res) => {
  try {
    const sales = collectShopSales();

    const todayStr = today();
    const weekStr = weekStart();
    const { start: monthStartStr } = monthRange();

    const sum = (list: ShopSale[]) => list.reduce((a, s) => a + s.amount, 0);
    const round2 = (n: number) => Math.round(n * 100) / 100;

    const todaySales = sales.filter((s) => s.date === todayStr);
    const weekSales = sales.filter((s) => s.date >= weekStr);
    const monthSales = sales.filter((s) => s.date >= monthStartStr);

    // Daily series
    const byDate = new Map<string, ShopSale[]>();
    for (const s of sales) {
      const arr = byDate.get(s.date);
      if (arr) arr.push(s);
      else byDate.set(s.date, [s]);
    }
    const daily = [...byDate.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, list]) => ({
        date,
        total: round2(sum(list)),
        count: list.length,
        avg: round2(sum(list) / list.length),
        max: round2(Math.max(...list.map((s) => s.amount))),
      }));

    // Hour / weekday / month rollups all come from the shared insights module,
    // so the dashboard and the WhatsApp AI cannot disagree about the numbers.
    const hourly = buildHourly(sales);
    const monthly = buildMonthly(sales);
    const weekday = buildWeekday(sales);

    // Per-seller breakdown
    // Keyed by LID, not pushname — WhatsApp display names change over time and
    // would otherwise split one person into several "sellers".
    const bySeller = new Map<string, { name: string; total: number; count: number }>();
    for (const s of sales) {
      const cur = bySeller.get(s.senderId) || { name: s.sender, total: 0, count: 0 };
      cur.name = s.sender; // sales are ascending, so this ends on the latest pushname
      cur.total += s.amount;
      cur.count += 1;
      bySeller.set(s.senderId, cur);
    }
    const sellers = [...bySeller.values()]
      .map((v) => ({ name: v.name, total: round2(v.total), count: v.count }))
      .sort((a, b) => b.total - a.total);

    const bestDay = daily.reduce<{ date: string; total: number } | null>(
      (best, d) => (!best || d.total > best.total ? { date: d.date, total: d.total } : best),
      null,
    );

    // Last-7-day average of *active* days, for a "how is today doing" signal
    const last7 = daily.slice(-7);
    const avgDay = last7.length ? round2(sum2(last7) / last7.length) : 0;

    const insights = buildInsights(sales, {
      today: todayStr,
      weekStart: weekStr,
      prevWeekStart: shiftDays(weekStr, -7),
    });

    res.json({
      groupJids: SHOP_GROUP_JIDS,
      statsSince: statsSince() || null,
      totals: {
        today: round2(sum(todaySales)),
        week: round2(sum(weekSales)),
        month: round2(sum(monthSales)),
        all: round2(sum(sales)),
      },
      counts: {
        today: todaySales.length,
        week: weekSales.length,
        month: monthSales.length,
        all: sales.length,
      },
      stats: {
        avgSale: sales.length ? round2(sum(sales) / sales.length) : 0,
        maxSale: sales.length ? round2(Math.max(...sales.map((s) => s.amount))) : 0,
        minSale: sales.length ? round2(Math.min(...sales.map((s) => s.amount))) : 0,
        avgDay,
        activeDays: daily.length,
        firstDate: daily.length ? daily[0].date : null,
        lastDate: daily.length ? daily[daily.length - 1].date : null,
        bestDay,
      },
      sellers,
      daily,
      hourly,
      monthly,
      weekday,
      insights,
      recent: sales.slice(-60).reverse(),
    });
  } catch (err) {
    console.error("Shop query error:", err);
    res.status(500).json({ error: "Failed to load shop data" });
  }
});

/** Shift a YYYY-MM-DD by whole days. Noon UTC dodges any DST edge. */
function shiftDays(date: string, delta: number): string {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// GET /api/shop/ai-context — the same sales, written as a brief a model can
// reason over. Kept next to /api/shop deliberately: one query, one shape of
// truth, two renderings. ?multiplier= overrides the in-chat to real-DH scale.
router.get("/api/shop/ai-context", (req, res) => {
  try {
    const raw = Number(req.query.multiplier);
    const multiplier = raw > 0 ? raw : 10;
    const sales = collectShopSales();
    const todayStr = today();
    const weekStr = weekStart();
    const text = formatShopAiContext({
      sales,
      today: todayStr,
      weekStart: weekStr,
      prevWeekStart: shiftDays(weekStr, -7),
      multiplier,
    });
    if (req.query.format === "text") {
      res.type("text/plain").send(text);
      return;
    }
    res.json({
      multiplier,
      generatedAt: new Date().toISOString(),
      salesCount: sales.length,
      text,
    });
  } catch (err) {
    console.error("Shop AI context error:", err);
    res.status(500).json({ error: "Failed to build shop AI context" });
  }
});

function sum2(list: Array<{ total: number }>): number {
  return list.reduce((a, d) => a + d.total, 0);
}

// Instagram bot dials live in their own router to keep this file readable.
router.use(projectsRoutes);
router.use(tasksBulkRoutes);
router.use(obligationsRoutes);
router.use(productsRoutes);
router.use(contentRoutes);

export default router;
