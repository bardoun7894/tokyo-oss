import * as db from "./db";
import { getCurrentState, type UserState } from "./state";
import { getNextPrayer } from "./prayer";
import { scoreTasks, type ScoringContext } from "./scoring";
import { localToday } from "./utils";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { pushReminder } from "./control/push/reminders";

// Cooldowns to avoid spamming (in ms)
const cooldowns = new Map<string, number>();
const COOLDOWN = {
  unreplied_client: 2 * 60 * 60 * 1000,    // 2 hours
  overdue_promise: 4 * 60 * 60 * 1000,      // 4 hours
  idle_nudge: 45 * 60 * 1000,               // 45 min
  saas_weekly: 7 * 24 * 60 * 60 * 1000,     // weekly
  learning_nudge: 12 * 60 * 60 * 1000,      // 12 hours
  promise_deadline: 3 * 60 * 60 * 1000,     // 3 hours
};

function canSend(key: string, cooldownMs: number): boolean {
  const last = cooldowns.get(key) || 0;
  if (Date.now() - last < cooldownMs) return false;
  cooldowns.set(key, Date.now());
  return true;
}

/**
 * Check if current state allows interruptions
 */
function shouldSuppress(state: UserState, urgency: "critical" | "high" | "normal"): boolean {
  if (urgency === "critical") return false; // Always deliver critical
  if (state === "deep_work" && urgency !== "high") return true;
  if (state === "post_prayer") return true;
  if (state === "family_mode" && urgency === "normal") return true;
  return false;
}

async function sendProactive(bot: Bot, chatId: string, text: string, keyboard?: InlineKeyboard) {
  try {
    await bot.api.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: keyboard });
  } catch {
    try {
      await bot.api.sendMessage(chatId, text.replace(/[*_`\[\]]/g, ""), { reply_markup: keyboard });
    } catch (e) {
      console.error("Proactive send failed:", e);
    }
  }
}

/**
 * Main proactive check — called every 15 min by scheduler
 */
export async function runProactiveChecks(bot: Bot, chatId: string): Promise<void> {
  const state = getCurrentState();

  // 1. Unreplied client messages > 2 hours
  await checkUnrepliedClients(bot, chatId, state.state);

  // 2. Overdue promises
  await checkOverduePromises(bot, chatId, state.state);

  // 3. Promise deadline approaching
  await checkApproachingPromises(bot, chatId, state.state);

  // 4. Idle nudge — suggest next task
  await checkIdleNudge(bot, chatId, state.state);

  // 5. Learning gap
  await checkLearningGap(bot, chatId, state.state);
}

async function checkUnrepliedClients(bot: Bot, chatId: string, state: UserState): Promise<void> {
  if (shouldSuppress(state, "high")) return;
  if (!canSend("unreplied_client", COOLDOWN.unreplied_client)) return;

  const unreplied = db.getUnrepliedByCategory();
  const clientMsgs = (unreplied as any)["client"] || [];
  const oldMsgs = clientMsgs.filter((m: any) => {
    if (!m.timestamp) return false;
    const ageMinutes = (Date.now() / 1000 - m.timestamp) / 60;
    return ageMinutes > 120; // > 2 hours
  });

  if (oldMsgs.length === 0) return;

  const lines = oldMsgs.slice(0, 3).map((m: any) => {
    const ageH = Math.round((Date.now() / 1000 - m.timestamp) / 3600);
    const preview = (m.content || "").slice(0, 40);
    return `  👤 *${m.display_name || m.sender_name}* — "${preview}…" (${ageH}h ago)`;
  });

  const kb = new InlineKeyboard();
  for (const m of oldMsgs.slice(0, 3)) {
    const name = m.display_name || m.sender_name || "?";
    kb.text(`Reply to ${name.slice(0, 15)}`, `wa_reply:${m.jid}`).row();
  }

  await sendProactive(bot, chatId,
    `⚠️ *Unreplied Client Messages*\n\n${lines.join("\n")}\n\n_Reply now to maintain trust._`,
    kb
  );
}

async function checkOverduePromises(bot: Bot, chatId: string, state: UserState): Promise<void> {
  if (shouldSuppress(state, "high")) return;
  if (!canSend("overdue_promise", COOLDOWN.overdue_promise)) return;

  const overdue = db.getOverduePromises() as any[];
  if (overdue.length === 0) return;

  const lines = overdue.slice(0, 3).map((p: any) => {
    return `  🔴 #${p.id} ${p.content}${p.due_date ? ` (was due ${p.due_date})` : ""}`;
  });

  const kb = new InlineKeyboard();
  for (const p of overdue.slice(0, 3)) {
    kb.text(`✅ Kept #${p.id}`, `promise_kept:${p.id}`)
      .text(`❌ Broke #${p.id}`, `promise_broke:${p.id}`).row();
  }

  await sendProactive(bot, chatId,
    `🔴 *Overdue Promises*\n\n${lines.join("\n")}\n\n_Fulfill or acknowledge these. Your word matters._`,
    kb
  );
}

async function checkApproachingPromises(bot: Bot, chatId: string, state: UserState): Promise<void> {
  if (shouldSuppress(state, "high")) return;
  if (!canSend("promise_deadline", COOLDOWN.promise_deadline)) return;

  const dueToday = db.getDueTodayPromises() as any[];
  if (dueToday.length === 0) return;

  const lines = dueToday.slice(0, 3).map((p: any) => {
    return `  🟡 #${p.id} ${p.content}${p.due_context ? ` (${p.due_context})` : ""}`;
  });

  await sendProactive(bot, chatId,
    `🟡 *Promises Due Today*\n\n${lines.join("\n")}\n\n_Handle these before end of day._`
  );
}

async function checkIdleNudge(bot: Bot, chatId: string, state: UserState): Promise<void> {
  if (state !== "idle") return;
  if (!canSend("idle_nudge", COOLDOWN.idle_nudge)) return;

  const nextPrayer = await getNextPrayer();
  if (nextPrayer.minutesUntil < 15) return; // Too close to prayer

  const today = localToday();
  const tasks = db.getAllActiveTasks() as any[];
  if (tasks.length === 0) return;

  const scored = scoreTasks(tasks, {
    windowMinutes: nextPrayer.minutesUntil - 5,
    state,
    today,
  });

  if (scored.length === 0) return;

  const top = scored[0];
  const est = top.task.estimated_hours ? ` (${Math.round(top.task.estimated_hours * 60)} min)` : "";

  const reasons: string[] = [];
  if (top.breakdown.urgency >= 8) reasons.push("urgent deadline");
  if (top.breakdown.trust >= 7) reasons.push("client waiting");
  if (top.breakdown.income >= 7) reasons.push("income impact");

  const why = reasons.length > 0 ? `\n_Why: ${reasons.join(", ")}_` : "";

  const kb = new InlineKeyboard()
    .text(`▶️ Start #${top.task.id}`, `task_start:${top.task.id}`)
    .text("⏭ Skip", "proactive:dismiss");

  await sendProactive(bot, chatId,
    `💡 *You're idle — here's your best move:*\n\n` +
    `▶ *${top.task.title}* #${top.task.id} [${top.task.category}]${est}${why}\n\n` +
    `_${nextPrayer.minutesUntil} min until ${nextPrayer.name}_`,
    kb
  );
}

async function checkLearningGap(bot: Bot, chatId: string, state: UserState): Promise<void> {
  if (shouldSuppress(state, "normal")) return;
  if (!canSend("learning_nudge", COOLDOWN.learning_nudge)) return;

  // Check if any learning this week
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  const startDate = weekStart.toISOString().split("T")[0];
  const endDate = localToday();

  const learningLogs = db.getLearningForPeriod(startDate, endDate) as any[];
  if (learningLogs.length > 0) return; // Already learned this week

  // Only nudge during good learning windows (after Asr or evening)
  const hour = now.getHours();
  if (hour < 16 || hour > 21) return;

  pushReminder("learning", "week", "");
  await sendProactive(bot, chatId,
    `📚 *No learning this week*\n\n` +
    `You haven't logged any learning yet. Even 20 min of AI/marketing study helps.\n\n` +
    `_Try: YouTube tutorial, article, or course._`
  );
}

/**
 * SaaS momentum check — called weekly (Sunday)
 */
export async function checkSaaSMomentum(bot: Bot, chatId: string): Promise<void> {
  if (!canSend("saas_weekly", COOLDOWN.saas_weekly)) return;

  const saasProjects = ["shopdemo"]; // Main SaaS projects
  const staleProjects: string[] = [];

  for (const project of saasProjects) {
    // Check if any agent sessions ran on this project this week
    const sessions = db.getRecentAgentSessions(20) as any[];
    const thisWeek = sessions.filter((s: any) => {
      if (s.project !== project) return false;
      const age = Date.now() - new Date(s.started_at).getTime();
      return age < 7 * 24 * 60 * 60 * 1000;
    });

    // Check if any tasks completed for this project
    const tasks = db.getAllActiveTasks() as any[];
    const projectTasks = tasks.filter((t: any) =>
      t.category === "product" || (t.title && t.title.toLowerCase().includes(project))
    );

    if (thisWeek.length === 0 && projectTasks.length === 0) {
      staleProjects.push(project);
    }
  }

  if (staleProjects.length === 0) return;

  await sendProactive(bot, chatId,
    `🚀 *SaaS Momentum Alert*\n\n` +
    `No activity on: *${staleProjects.join(", ")}* this week.\n\n` +
    `Freelance is consuming all your time. Spend at least 1h today on your product.\n\n` +
    `_Even small progress compounds. Ship something._`
  );
}
