import cron from "node-cron";
import * as db from "./db";
import { getNextPrayer, getWorkWindows } from "./prayer";
import { generateCoaching } from "./ai";
import type { Bot } from "grammy";
import type { CoachingScenario } from "./types";

const DAILY_AI_CAP = 6;

// Cooldowns in minutes
const COOLDOWNS: Record<CoachingScenario, number> = {
  prayer_wrapup: 60,
  overwork: 120,
  next_action: 180,
  deadline_urgent: 240,
  deen_reminder: 720,
  learning_window: 720,
  deadline_soon: 720,
  midweek_check: 10080,
  marketing_nudge: 10080,
  balance_check: 4320,
};

function getRiyadhHour(): number {
  return parseInt(new Date().toLocaleString("en-US", { timeZone: "Asia/Riyadh", hour: "numeric", hour12: false }), 10);
}

function getRiyadhDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Riyadh" }); // YYYY-MM-DD
}

async function sendMessage(bot: Bot, chatId: string, text: string) {
  try {
    await bot.api.sendMessage(chatId, text, { parse_mode: "Markdown" });
  } catch {
    try {
      await bot.api.sendMessage(chatId, text.replace(/[*_`\[\]]/g, ""));
    } catch (e) {
      console.error("Coach send failed:", e);
    }
  }
}

function shouldSend(scenario: CoachingScenario): boolean {
  // Check daily AI cap (templates don't count)
  const noAiScenarios: CoachingScenario[] = ["prayer_wrapup", "overwork"];
  if (!noAiScenarios.includes(scenario) && db.getCoachingCountToday() >= DAILY_AI_CAP) {
    return false;
  }

  // Check cooldown
  const last = db.getLastCoachingMessage(scenario);
  if (last) {
    const lastTime = new Date(last.sent_at).getTime();
    const elapsed = (Date.now() - lastTime) / 60000;
    if (elapsed < COOLDOWNS[scenario]) return false;
  }

  return true;
}

function isOnBreak(): boolean {
  // Check if there's a break_start after the most recent work_start (with no break_end after it)
  const row = db.getActiveWorkSession();
  if (!row) return false;
  const breakCheck = (db as any).default.prepare(`
    SELECT id FROM work_logs
    WHERE type = 'break_start'
    AND id > ?
    AND id > COALESCE((SELECT MAX(id) FROM work_logs WHERE type = 'break_end'), 0)
    LIMIT 1
  `).get(row.id);
  return !!breakCheck;
}

// ========================
// TIME-SENSITIVE (no AI)
// ========================

async function checkTimeSensitive(bot: Bot, chatId: string): Promise<void> {
  try {
    const next = await getNextPrayer();
    const session = db.getActiveWorkSession();
    const onBreak = isOnBreak();

    // 1. Prayer wrap-up: next prayer in 10-15 min + actively working (not on break)
    if (session && !onBreak && next.minutesUntil > 0 && next.minutesUntil <= 15) {
      if (shouldSend("prayer_wrapup")) {
        await sendMessage(bot, chatId,
          `⏰ *${next.name} in ${next.minutesUntil} min*\n\nWrap up and prepare for salah. حي على الصلاة`
        );
        db.logCoachingMessage("prayer_wrapup", `${next.name} in ${next.minutesUntil}min`);
      }
    }

    // 2. Overwork: active session 3h+ without break (not currently on break)
    if (session && !onBreak && session.minutes_active > 180) {
      if (shouldSend("overwork")) {
        const hours = (session.minutes_active / 60).toFixed(1);
        await sendMessage(bot, chatId,
          `⚠️ *${hours}h without a break!*\n\nTake 10 min — stretch, drink water, make dhikr.\nسبحان الله وبحمده\n\n/breakk to start a break.`
        );
        db.logCoachingMessage("overwork", `${hours}h continuous work`);
      }
    }
  } catch (err) {
    console.error("Time-sensitive check error:", err);
  }
}

// ========================
// SMART AI COACH
// ========================

async function evaluateAndCoach(bot: Bot, chatId: string): Promise<void> {
  try {
    const scenarios = await getAllEligibleScenarios();

    // Iterate through sorted scenarios, send the first one that passes cooldown
    for (const scenario of scenarios) {
      if (!shouldSend(scenario.type)) continue;

      const message = await generateCoaching(scenario.prompt);
      if (message && message.trim()) {
        const emoji = getScenarioEmoji(scenario.type);
        await sendMessage(bot, chatId, `${emoji} *Coach*\n\n${message}`);
        db.logCoachingMessage(scenario.type, message.substring(0, 200));
      }
      return; // Only send one per evaluation
    }
  } catch (err) {
    console.error("Coach evaluation error:", err);
  }
}

function getScenarioEmoji(scenario: CoachingScenario): string {
  const emojis: Record<CoachingScenario, string> = {
    prayer_wrapup: "⏰",
    overwork: "⚠️",
    next_action: "🎯",
    deadline_urgent: "🔴",
    deadline_soon: "🟡",
    deen_reminder: "📖",
    learning_window: "💡",
    midweek_check: "📊",
    marketing_nudge: "📈",
    balance_check: "⚖️",
  };
  return emojis[scenario] || "🧠";
}

interface ScoredScenario {
  type: CoachingScenario;
  priority: number;
  prompt: string;
}

async function getAllEligibleScenarios(): Promise<ScoredScenario[]> {
  const now = new Date();
  const today = getRiyadhDate();
  const hour = getRiyadhHour();
  const dayOfWeek = now.getDay(); // 0=Sunday
  const scenarios: ScoredScenario[] = [];

  // Priority 3: Deadline urgent (within 24 hours)
  const urgentDeadlines = db.getUpcomingDeadlines(1) as any[];
  if (urgentDeadlines.length > 0) {
    const p = urgentDeadlines[0];
    const hoursLeft = Math.round((new Date(p.deadline).getTime() - Date.now()) / 3600000);
    if (hoursLeft > 0) { // Guard: skip already-passed deadlines
      scenarios.push({
        type: "deadline_urgent",
        priority: 3,
        prompt: `URGENT: Project '${p.name}'${p.client_name ? ` for ${p.client_name}` : ""} is due in ${hoursLeft} hours. Progress: ${p.actual_hours || 0}/${p.estimated_hours || "?"}h logged. What should the owner do RIGHT NOW to deliver on time? If it looks tight, suggest what to communicate to the client. 3 sentences max, urgent tone.`,
      });
    }
  }

  // Priority 4: Next action (no active work session during waking hours)
  const session = db.getActiveWorkSession();
  if (!session && hour >= 6 && hour <= 20) {
    try {
      const next = await getNextPrayer();
      const windows = await getWorkWindows();
      const nowMins = now.getHours() * 60 + now.getMinutes();
      const currentWindow = windows.find((w) => {
        const [sh, sm] = w.start.split(":").map(Number);
        const [eh, em] = w.end.split(":").map(Number);
        return nowMins >= sh * 60 + sm && nowMins < eh * 60 + em;
      });

      if (currentWindow) {
        scenarios.push({
          type: "next_action",
          priority: 4,
          prompt: `The owner has a ${currentWindow.durationMinutes}-minute work window (${currentWindow.start}-${currentWindow.end}, ${currentWindow.label}) before ${next.name}. Looking at his active tasks and deadlines, what is the ONE most important thing he should do right now? Name the exact task or project. If the window is short (<60 min), suggest something quick. 2-3 sentences, direct.`,
        });
      }
    } catch {
      // Skip if prayer time fetch fails
    }
  }

  // Priority 5: Deen reminder — check both adhkar and Quran independently
  const adhkar = db.getAdhkarStatus(today);
  const quranToday = db.getQuranPagesInRange(today, today);

  if (hour >= 12 && !adhkar.morning) {
    scenarios.push({
      type: "deen_reminder",
      priority: 5,
      prompt: `It's already past noon and the owner hasn't done his morning adhkar today. Give a warm, encouraging Islamic reminder about the importance of morning adhkar. Include one short relevant hadith if possible. 2 sentences, encouraging not preachy.`,
    });
  }
  if (hour >= 16 && quranToday === 0) {
    const quranProgress = db.getQuranProgress();
    scenarios.push({
      type: "deen_reminder",
      priority: 5,
      prompt: `It's ${hour}:00 and the owner hasn't read any Quran today. He's read ${quranProgress.totalPages || 0} pages total. Give a warm Islamic reminder about daily Quran reading. Mention the reward. 2 sentences, motivating.`,
    });
  }

  // Priority 6: Learning window (short work window + no learning today)
  if (hour >= 8 && hour <= 20) {
    try {
      const windows = await getWorkWindows();
      const nowMins = now.getHours() * 60 + now.getMinutes();
      const shortWindow = windows.find((w) => {
        const [sh, sm] = w.start.split(":").map(Number);
        const [eh, em] = w.end.split(":").map(Number);
        return nowMins >= sh * 60 + sm && nowMins < eh * 60 + em && w.durationMinutes <= 90;
      });

      if (shortWindow) {
        const todayStats = db.getWorkStats(today);
        const learningMins = todayStats.byType["learning"] || 0;
        if (learningMins === 0) {
          scenarios.push({
            type: "learning_window",
            priority: 6,
            prompt: `The owner has a short ${shortWindow.durationMinutes}-minute work window (${shortWindow.start}-${shortWindow.end}). He hasn't done any learning today. Suggest ONE specific marketing learning activity (he's a beginner building an e-commerce marketplace for neighborhood shops). Be specific — a topic to research, a small experiment, or a practical exercise. 2 sentences.`,
          });
        }
      }
    } catch {
      // Skip
    }
  }

  // Priority 7: Deadline soon (3 days, not already urgent)
  const soonDeadlines = db.getUpcomingDeadlines(3) as any[];
  const nonUrgent = soonDeadlines.filter((p) => {
    const hoursLeft = (new Date(p.deadline).getTime() - Date.now()) / 3600000;
    return hoursLeft > 24;
  });
  if (nonUrgent.length > 0) {
    const p = nonUrgent[0];
    const daysLeft = Math.round((new Date(p.deadline).getTime() - Date.now()) / 86400000);
    scenarios.push({
      type: "deadline_soon",
      priority: 7,
      prompt: `Project '${p.name}'${p.client_name ? ` (${p.client_name})` : ""} is due in ${daysLeft} days. Progress: ${p.actual_hours || 0}/${p.estimated_hours || "?"}h. Quick status check — is he on track? What should he prioritize? 2 sentences.`,
    });
  }

  // Priority 8: Midweek check (Wednesday only)
  if (dayOfWeek === 3 && hour >= 12 && hour <= 16) {
    scenarios.push({
      type: "midweek_check",
      priority: 8,
      prompt: `It's Wednesday — mid-week check. Look at the owner's active tasks, projects, and deadlines. Which ones are falling behind? Which are on track? Give a focused reality check. 3-4 sentences.`,
    });
  }

  // Priority 9: Marketing nudge (once per week)
  if (hour >= 10 && hour <= 18) {
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7)); // Monday
    const weekStats = db.getWorkStatsForRange(weekStart.toISOString().split("T")[0], today);
    const learningThisWeek = weekStats.byType["learning"] || 0;
    if (learningThisWeek === 0) {
      scenarios.push({
        type: "marketing_nudge",
        priority: 9,
        prompt: `The owner hasn't done any learning this week. He wants to learn marketing (beginner) and has a neighborhood e-commerce marketplace idea. Give him ONE practical, actionable marketing micro-task for today — something concrete that takes 30 minutes or less. Relate it to his clothing shop or marketplace idea. 2-3 sentences.`,
      });
    }
  }

  // Priority 10: Balance check
  if (hour >= 14 && hour <= 20) {
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const recentStats = db.getWorkStatsForRange(threeDaysAgo.toISOString().split("T")[0], today);
    const devHours = Math.round((recentStats.byType["dev"] || 0) / 60);
    const shopHours = Math.round((recentStats.byType["shop"] || 0) / 60);

    if ((devHours > 0 && shopHours === 0) || (shopHours > 0 && devHours === 0)) {
      scenarios.push({
        type: "balance_check",
        priority: 10,
        prompt: `Last 3 days: dev=${devHours}h, shop=${shopHours}h. There's an imbalance — the owner needs time for both dev work and the shop. Brief advice on adjusting. 2-3 sentences.`,
      });
    }
  }

  // Sort by priority (lowest number = highest priority)
  scenarios.sort((a, b) => a.priority - b.priority);
  return scenarios;
}

// ========================
// START
// ========================

export function startCoaching(bot: Bot, chatId: string): void {
  // Smart AI coach — every 2 hours during waking hours
  cron.schedule("0 6,8,10,12,14,16,18,20 * * *", async () => {
    await evaluateAndCoach(bot, chatId);
  });

  // Time-sensitive alerts — every 15 min, no AI calls
  cron.schedule("*/15 6-22 * * *", async () => {
    await checkTimeSensitive(bot, chatId);
  });

  console.log("Coaching engine started (AI every 2h, alerts every 15min).");
}
