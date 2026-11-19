import "dotenv/config";
import { Bot } from "grammy";
import { initDatabase } from "./db";
import * as db from "./db";
import { initPrayerTable } from "./prayer";
import { chat, generateBriefing, setModel, getModel, getModelLabel } from "./ai";
import { startScheduler } from "./scheduler";
import { registerClientCommands } from "./clients";
import { registerFinanceCommands } from "./finance";
import { registerQuranCommands } from "./quran";
import { registerReportCommands } from "./reports";
import { registerCalendarCommands } from "./calendar";
import { registerResearchCommands } from "./research";
import { registerTrelloCommands } from "./trello";
import { localToday } from "./utils";
import { extractPromises, formatPromisesOutput } from "./promises";
import { startCoaching } from "./coach";
import { runCommand, getServerStatus } from "./shell";
import { startDashboard } from "./dashboard/server";
import { startWhatsApp, sendWhatsAppMessage } from "./whatsapp";
import { loadSkills, listSkills, getSkill, executeSkill } from "./skills";
import { setTelegramForwarder, detectWAIntent, getIntentSuggestion, draftWAReply, setAutoReplyRule, isAutoReplyEnabled, setGlobalAutoReply, isGlobalAutoReplyEnabled } from "./whatsapp-ai";
import { getNowOutput, getTimelineOutput } from "./now";
import { initStateTable, getCurrentState, setState, endCurrentState, type UserState } from "./state";
import { createOrchestrator } from "./orchestrator";
import { loadAllAgents } from "./agents/loader";
import { registerPipelines } from "./agents/pipelines";
import { setEventBus } from "./whatsapp-ai";
import { logServerCommand, notifyConfirmation, setAutoLogBot } from "./auto_log";
import { registerLaptopBridge, PENDING_TTL_MS } from "./laptop-bridge";
import { registerMacCommand } from "./mac-command";
import { registerClaudeRunner } from "./claude-runner";
import { setAutoDispatchBot } from "./wa-auto-dispatch";
import { initMissionWiring } from "./mission-wiring";
import { registerSdkReply, consumeSdkCorrection } from "./sdk-reply";
import { listLaptopQueue, purgeExpiredLaptopPending } from "./db";
import { initTgAudio, transcribeTelegramAudio, resolveAudioExt, isAudioDocument } from "./tg_audio";
import { registerSocialCommands } from "./social";
import { recordTelegramOk, recordTelegramError } from "./channel-health";
import { telegramFeedRecorder } from "./control/feed";
import { liveFeed } from "./control/feed-live";

// Validate env
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const USER_ID = process.env.TELEGRAM_USER_ID;
import { isOwnerUpdate } from "./tg-guard";
import { handleApprovalText } from "./tg-approve";
import { setShopChatFn } from "./shop-group";
import { startObligationReminders } from "./obligation-reminders";
import { registerSetup, profileIsSet } from "./setup-telegram";
import { applyStoredTimezone } from "./settings";
import { ownerName, currency, prayerOn, shopOn, whatsappOn } from "./profile";

if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}
if (!process.env.CLIPROXY_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  console.error("Missing CLIPROXY_API_KEY or ANTHROPIC_API_KEY in .env");
  process.exit(1);
}

// Init
initDatabase();
applyStoredTimezone(); // a timezone saved from /setup or the dashboard wins over .env
initPrayerTable();
initStateTable();
const bot = new Bot(BOT_TOKEN);

// Nothing reaches a handler unless it comes from the owner: this chat runs shell
// commands, Claude runs and deploys. See src/tg-guard.ts.
bot.use(async (ctx, next) => {
  if (isOwnerUpdate(ctx.from?.id, USER_ID)) return next();
  console.warn(`[telegram] dropped update from ${ctx.from?.id ?? "unknown"} (@${ctx.from?.username ?? "?"})`);
  if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Not authorized" }).catch(() => {});
});

// /setup wizard: registered first so its text answers are not taken as chat.
registerSetup(bot);

// Track every Telegram API call for the loopback status endpoint, and keep what was
// sent to the owner for the Control app's feed. The result is re-thrown on error, so
// the bot's behaviour is unchanged; the feed recorder never throws.
const recordFeed = telegramFeedRecorder(liveFeed, USER_ID);
bot.api.config.use(async (prev, method, payload, signal) => {
  try {
    const r = await prev(method, payload, signal);
    recordTelegramOk(method);
    if ((r as any)?.ok) recordFeed(method, payload, (r as any).result);
    return r;
  } catch (err) {
    recordTelegramError(method, err);
    throw err;
  }
});

registerLaptopBridge(bot, (ctx) => isOwnerUpdate(ctx.from?.id, USER_ID));
purgeExpiredLaptopPending(PENDING_TTL_MS); // clean stale confirmations from before last restart
registerClaudeRunner(bot);
setAutoDispatchBot(bot);
initMissionWiring(bot);
registerSdkReply(bot);
registerSocialCommands(bot);
// Must sit above the catch-all callback_query handler or the /ig buttons are swallowed.

// Wire tg_audio helper with production deps
(async () => {
  const { transcribe } = await import("./stt");
  initTgAudio({
    chat,
    transcribe,
    sendSplit,
    bot,
    botToken: BOT_TOKEN!,
  });
})();

// ==================
// INLINE BUTTON CALLBACKS
// ==================

bot.callbackQuery(/^task:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  try {
    db.completeTask(id);
    await ctx.answerCallbackQuery({ text: `✅ Task #${id} done!` });
    // Update the message to show it's done
    const text = ctx.callbackQuery.message?.text || "";
    const updated = text.replace(new RegExp(`(#${id}\\s+.+)`), `✅ ~$1~ (done)`);
    try { await ctx.editMessageText(updated, { parse_mode: "Markdown" }); } catch {}
  } catch (e) {
    await ctx.answerCallbackQuery({ text: "Failed to complete task" });
  }
});

bot.callbackQuery(/^habit:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const today = localToday();
  try {
    db.logHabit(id, today);
    const streak = db.getHabitStreak(id);
    await ctx.answerCallbackQuery({ text: `✅ Habit done!${streak > 1 ? ` 🔥${streak} streak` : ""}` });
    try {
      const text = ctx.callbackQuery.message?.text || "";
      await ctx.editMessageText(text + `\n\n✅ Checked!`, { parse_mode: "Markdown" });
    } catch {}
  } catch (e) {
    await ctx.answerCallbackQuery({ text: "Failed to check habit" });
  }
});

bot.callbackQuery(/^adhkar:(\w+)$/, async (ctx) => {
  const type = ctx.match[1];
  try {
    db.logAdhkar(type);
    const label = type === "morning" ? "Morning" : type === "evening" ? "Evening" : "Post-prayer";
    await ctx.answerCallbackQuery({ text: `✅ ${label} adhkar logged!` });
    try {
      const text = ctx.callbackQuery.message?.text || "";
      await ctx.editMessageText(text + `\n\n✅ ${label} adhkar done!`, { parse_mode: "Markdown" });
    } catch {}
  } catch (e) {
    await ctx.answerCallbackQuery({ text: "Failed to log adhkar" });
  }
});

bot.callbackQuery("work:start", async (ctx) => {
  try {
    const active = db.getActiveWorkSession();
    if (active) {
      await ctx.answerCallbackQuery({ text: "Already in a work session!" });
      return;
    }
    db.logWork("work_start", undefined, "dev");
    await ctx.answerCallbackQuery({ text: "⏱ Work started!" });
    try { await ctx.editMessageText(ctx.callbackQuery.message?.text + "\n\n⏱ Work session started!", { parse_mode: "Markdown" }); } catch {}
  } catch (e) {
    await ctx.answerCallbackQuery({ text: "Failed to start work" });
  }
});

bot.callbackQuery(/^promise_kept:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  db.fulfillPromise(id);
  await ctx.answerCallbackQuery({ text: "✅ Promise fulfilled!" });
  try {
    const text = ctx.callbackQuery.message?.text || "";
    await ctx.editMessageText(text + "\n\n✅ Fulfilled!", { parse_mode: "Markdown" });
  } catch {}
});

bot.callbackQuery(/^promise_broke:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  db.breakPromise(id);
  await ctx.answerCallbackQuery({ text: "❌ Marked as broken" });
});

// ==================
// M2.5 — Activity Event Confirmation Callbacks
// ==================

bot.callbackQuery(/^confirm_event:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  try {
    db.confirmActivityEvent(id);
    await ctx.answerCallbackQuery({ text: "✅ Confirmed" });
    try { await ctx.editMessageText("✅ Confirmed", { parse_mode: "Markdown" }); } catch {}
  } catch (e) {
    await ctx.answerCallbackQuery({ text: "Failed to confirm" });
  }
});

bot.callbackQuery(/^change_event:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  try {
    await ctx.answerCallbackQuery({ text: "Pick a category" });
    const keyboard = {
      inline_keyboard: [
        [
          { text: "💻 Dev", callback_data: `change_category:${id}:dev` },
          { text: "🏪 Shop", callback_data: `change_category:${id}:shop` },
        ],
        [
          { text: "👤 Client", callback_data: `change_category:${id}:client` },
          { text: "🏠 Personal", callback_data: `change_category:${id}:personal` },
        ],
        [
          { text: "📋 Admin", callback_data: `change_category:${id}:admin` },
        ],
      ],
    };
    try {
      await ctx.editMessageText(`🔄 *Change category for event #${id}*`, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      });
    } catch {
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
      } catch {}
    }
  } catch (e) {
    await ctx.answerCallbackQuery({ text: "Failed" });
  }
});

bot.callbackQuery(/^change_category:(\d+):(\w+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const cat = ctx.match[2];
  try {
    db.confirmActivityEvent(id, cat);
    await ctx.answerCallbackQuery({ text: `✅ Set to ${cat}` });
    try { await ctx.editMessageText(`✅ Confirmed as *${cat}*`, { parse_mode: "Markdown" }); } catch {}
  } catch (e) {
    await ctx.answerCallbackQuery({ text: "Failed to update" });
  }
});

bot.callbackQuery(/^ignore_event:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  try {
    db.rejectActivityEvent(id);
    await ctx.answerCallbackQuery({ text: "❌ Ignored" });
    try { await ctx.editMessageText("❌ Ignored", { parse_mode: "Markdown" }); } catch {}
  } catch (e) {
    await ctx.answerCallbackQuery({ text: "Failed to ignore" });
  }
});

// Catch-all for unknown callbacks
bot.on("callback_query:data", async (ctx) => {
  await ctx.answerCallbackQuery();
});

// ==================
// CORE COMMANDS
// ==================

bot.command("start", async (ctx) => {
  await ctx.reply(
    `🏙 *Tokyo — Your Life OS*

${prayerOn() ? "بسم الله الرحمن الرحيم\n\n" : ""}Hi ${ownerName()}! I keep your tasks, habits, goals, journal and money${whatsappOn() ? ", plus your WhatsApp," : ""} in one place.
${prayerOn() ? "\n🕌 Prayer times are always priority.\n📖 Quran & adhkar tracked daily.\n" : ""}
💰 Amounts are in ${currency()}.${shopOn() ? " Shop sales come from your WhatsApp group." : ""}

${profileIsSet() ? "Change your profile any time with /setup." : "👉 First time? Send /setup and tell me about you (2 minutes)."}

Type /help for commands, or just *talk naturally*:
_"New client project, due Friday"_
_"Spent 200 on groceries"_
_"Remind me to call the bank tomorrow at 10"_`,
    { parse_mode: "Markdown" }
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    `*Tokyo Commands:*

⚙️ /setup — Your profile: name, country, language, currency, work, features
${prayerOn() ? `
🕌 *Deen*
/adhkar — Adhkar status / mark done
/quran [pages] — Log Quran reading
/quranstats — Quran progress
` : ""}
📋 *Tasks*
/tasks — Active tasks
/done [id] — Complete task
/begin [id] — Start task
/edit [id] [field] [value] — Edit task
/sub [parent_id] [title] — Add subtask
/del [id] — Delete task

✅ *Habits*
/habits — Today's habits
/check [id] — Mark habit done
/addhabit [name] — Add habit
/rmhabit [id] — Remove habit

⏱ *Work*
/work [project] — Start work session
${shopOn() ? "/shop — Start shop session\n" : ""}/stopwork — End session
/breakk — Start break
/endbreak — End break
/stats — Today's stats

👤 *Clients & Projects*
/clients — List clients
/projects — List projects
/newclient [name] [platform] — Add client
/newproject [client_id] [name] — Add project

💰 *Finance*
/income [amount] [source] — Log income
/money — Monthly summary
${shopOn() ? "/shopsale [amount] — Log shop sale\n/shops — Neighborhood shops\n/addshop [name] — Track a shop\n" : ""}
📊 *Reports*
/briefing — Morning briefing (AI)
/review — Evening review (AI)
/weekly — Weekly report
/monthly — Monthly report

📅 *Calendar & Progress*
/cal [date] — Day's full activity (today, yesterday, -3, 2026-03-20)
/calweek — Week calendar overview
/journal [entry] — Write journal / view recent
/progress [period] — Progress report (week, month, year, lastweek, lastmonth)

📅 /schedule — Today's schedule

🔍 *AI Research (auto daily 8AM)*
/digest — AI daily digest (repos + tools + news)
/trending — Trending AI repos
/tools — New AI tools & frameworks
/news — AI news (Hacker News)
/youtube [query] — Search YouTube

📋 *Trello*
/trello — All boards
/trello [board name] — Show board cards

🖥 *Server*
/server — Server status (CPU, RAM, Docker, PM2)
/run [cmd] — Run shell command
/mac — Mac status, /mac shot, /mac open [App], /mac run [cmd]

🤖 *AI Model*
/model — Show current AI model
/model claude — Switch to Claude
/model kieai — Switch to GPT-5.4 (kie.ai)

🔧 *Pi Agent*
/pi [project] [prompt] — Run Pi coding agent
/expert [name] [project] — Run expert analysis
  experts: code-review, debug, deploy-check, project-status, security-audit, client-update

🤖 *Claude Agent*
/agent [project] [task] — Run Claude Code agent
/agents — List agent sessions

⚡ *Skills (Multi-Step Workflows)*
/skills — List available skills
/skill <name> [args] — Run a skill

📱 *WhatsApp*
/contacts — WhatsApp contacts & categories
/wa rules — Active reply rules
/wa ignore <jid> — Mute a chat
/wa notify <jid> — Forward to Telegram
/wa auto <jid|all> <keyword> <reply> — Auto-reply
/wa recent — Recent messages

🎤 Send a voice message to talk naturally!

💬 Or just type naturally!`,
    { parse_mode: "Markdown" }
  );
});

// ==================
// TASK COMMANDS
// ==================

bot.command("tasks", async (ctx) => {
  const tasks = db.getAllActiveTasks() as any[];
  if (tasks.length === 0) {
    await ctx.reply("No active tasks. Talk to me to add one!");
    return;
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

  await ctx.reply(`📋 *Active Tasks:*\n\n${sections.join("\n\n")}`, { parse_mode: "Markdown" });
});

bot.command("done", async (ctx) => {
  const id = parseInt(ctx.match, 10);
  if (!id) { await ctx.reply("Usage: /done [task_id]"); return; }
  const task = db.getTask(id);
  if (!task) { await ctx.reply(`Task #${id} not found.`); return; }
  db.completeTask(id);
  await ctx.reply(`✅ Task #${id} done!`);
});

bot.command("begin", async (ctx) => {
  const id = parseInt(ctx.match, 10);
  if (!id) { await ctx.reply("Usage: /begin [task_id]"); return; }
  const task = db.getTask(id);
  if (!task) { await ctx.reply(`Task #${id} not found.`); return; }
  db.startTask(id);
  await ctx.reply(`▶️ Task #${id} in progress. بالتوفيق!`);
});

bot.command("edit", async (ctx) => {
  const parts = ctx.match.trim().split(/\s+/);
  const id = parseInt(parts[0], 10);
  const field = parts[1];
  const value = parts.slice(2).join(" ");
  if (!id || !field || !value) {
    await ctx.reply("Usage: /edit [id] [field] [value]\n\nFields: title, priority, due_date, category, notes\n\nExample: /edit 3 priority urgent");
    return;
  }
  const task = db.getTask(id);
  if (!task) { await ctx.reply(`Task #${id} not found.`); return; }
  const allowed = ["title", "priority", "due_date", "category", "notes", "status"];
  if (!allowed.includes(field)) {
    await ctx.reply(`Invalid field. Use: ${allowed.join(", ")}`);
    return;
  }
  db.updateTask(id, { [field]: value });
  await ctx.reply(`✏️ Task #${id} updated: ${field} = ${value}`);
});

bot.command("sub", async (ctx) => {
  const parts = ctx.match.trim().split(/\s+/);
  const parentId = parseInt(parts[0], 10);
  const title = parts.slice(1).join(" ");
  if (!parentId || !title) {
    await ctx.reply("Usage: /sub [parent_task_id] [subtask title]\n\nExample: /sub 3 Design database schema");
    return;
  }
  const parent = db.getTask(parentId);
  if (!parent) { await ctx.reply(`Parent task #${parentId} not found.`); return; }
  const result = db.addSubtask(parentId, title);
  await ctx.reply(`✅ Subtask added under #${parentId}: *${title}* — ID #${result.lastInsertRowid}`, { parse_mode: "Markdown" });
});

bot.command("del", async (ctx) => {
  const id = parseInt(ctx.match, 10);
  if (!id) { await ctx.reply("Usage: /del [task_id]"); return; }
  const task = db.getTask(id);
  if (!task) { await ctx.reply(`Task #${id} not found.`); return; }
  db.deleteTask(id);
  await ctx.reply(`🗑 Task #${id} deleted.`);
});

// ==================
// HABIT COMMANDS
// ==================

bot.command("habits", async (ctx) => {
  const today = localToday();
  const habits = db.getHabitLogsForDate(today) as any[];
  if (habits.length === 0) {
    await ctx.reply("No habits tracked yet. /addhabit [name]");
    return;
  }
  const lines = habits.map((h) => {
    const streak = db.getHabitStreak(h.id);
    return `${h.done ? "✅" : "⬜"} *#${h.id}* ${h.name}${streak > 1 ? ` 🔥${streak}` : ""}`;
  });
  await ctx.reply(`*Today's Habits:*\n\n${lines.join("\n")}\n\n/check [id] to mark done`, { parse_mode: "Markdown" });
});

bot.command("check", async (ctx) => {
  const id = parseInt(ctx.match, 10);
  if (!id) { await ctx.reply("Usage: /check [habit_id]"); return; }
  const today = localToday();
  db.logHabit(id, today);
  const streak = db.getHabitStreak(id);
  await ctx.reply(`✅ Habit #${id} done!${streak > 1 ? ` 🔥 ${streak}-day streak!` : ""}`);
});

bot.command("addhabit", async (ctx) => {
  const name = ctx.match.trim();
  if (!name) { await ctx.reply("Usage: /addhabit [name]"); return; }
  db.addHabit(name);
  await ctx.reply(`✅ Habit added: *${name}*`, { parse_mode: "Markdown" });
});

bot.command("rmhabit", async (ctx) => {
  const id = parseInt(ctx.match, 10);
  if (!id) { await ctx.reply("Usage: /rmhabit [habit_id]"); return; }
  db.deactivateHabit(id);
  await ctx.reply(`🗑 Habit #${id} deactivated.`);
});

// ==================
// WORK TRACKING
// ==================

bot.command("work", async (ctx) => {
  const note = ctx.match.trim() || "dev";
  db.logWork("work_start", note, note === "shop" ? "shop" : "dev");
  await ctx.reply(`⏱ Dev session started: *${note}*. بالتوفيق!\n\n/breakk for break, /stopwork when done.`, { parse_mode: "Markdown" });
});

bot.command("shop", async (ctx) => {
  db.logWork("work_start", "shop", "shop");
  await ctx.reply("🏪 Shop session started. بالتوفيق!\n\n/stopwork when you leave.");
});

bot.command("stopwork", async (ctx) => {
  db.logWork("work_end", ctx.match || undefined);
  const today = localToday();
  const stats = db.getWorkStats(today);
  const byType = Object.entries(stats.byType)
    .map(([t, m]) => `${t}: ${Math.round(m / 60)}h${m % 60}m`)
    .join(", ");
  await ctx.reply(`⏹ Session ended.\n\n📊 Today: ${stats.totalWorkMinutes} min work, ${stats.totalBreakMinutes} min breaks\n${byType ? `By type: ${byType}` : ""}`);
});

bot.command("breakk", async (ctx) => {
  db.logWork("break_start");
  await ctx.reply("☕ Break started. /endbreak when ready.");
});

bot.command("endbreak", async (ctx) => {
  db.logWork("break_end");
  await ctx.reply("💪 Break over. Let's go!");
});

bot.command("queue", async (ctx) => {
  try {
    const rows = listLaptopQueue(15);
    if (rows.length === 0) {
      await ctx.reply("No laptop tasks yet.");
      return;
    }
    const lines = rows.map((r) => {
      const icon = r.status === "pending" ? "⏳" : r.status === "running" ? "▶️" : r.status === "done" ? "✅" : "❌";
      const layerIcon = r.layer === "tech-company" ? "🏢" : "🔧";
      const age = Math.round((Date.now() - r.created_at) / 60000);
      const prompt = (r.prompt || "").slice(0, 60).replace(/\n/g, " ");
      return `${icon} ${layerIcon} #${r.id} [${r.project}] (${age}m ago) ${r.status}\n   ${prompt}`;
    });
    const summary = `🗂 *Laptop task queue* (last 15)\n\n${lines.join("\n\n")}`;
    await ctx.reply(summary.slice(0, 4000), { parse_mode: "Markdown" });
  } catch (err: any) {
    await ctx.reply(`tasks error: ${err?.message || err}`);
  }
});

bot.command("stats", async (ctx) => {
  const today = localToday();
  const stats = db.getWorkStats(today);
  const workH = (stats.totalWorkMinutes / 60).toFixed(1);
  const breakH = (stats.totalBreakMinutes / 60).toFixed(1);
  const byType = Object.entries(stats.byType)
    .map(([t, m]) => `  ${t}: ${Math.round(m / 60)}h${m % 60}m`)
    .join("\n");

  let balance = "⚖️ Balanced";
  if (stats.totalWorkMinutes > 600) balance = "🔴 Over 10 hours — stop and rest!";
  else if (stats.totalWorkMinutes > 480) balance = "⚠️ Over 8 hours — consider wrapping up.";
  else if (stats.totalWorkMinutes > 0 && stats.totalBreakMinutes < stats.totalWorkMinutes * 0.1) balance = "⚠️ Take more breaks!";

  await ctx.reply(
    `📊 *Today's Stats*\n\n⏱ Work: ${workH}h\n☕ Breaks: ${breakH}h\n${byType ? `\n${byType}\n` : ""}\n${balance}`,
    { parse_mode: "Markdown" }
  );
});

// ==================
// SCHEDULE
// ==================

bot.command("schedule", async (ctx) => {
  const today = localToday();
  const items = db.getScheduleForDate(today) as any[];
  if (items.length === 0) {
    await ctx.reply("📅 Nothing scheduled today.\n\nTell me what to schedule naturally.");
    return;
  }
  const lines = items.map((s) => `🕐 *${s.time}* — ${s.title}${s.recurring ? " 🔁" : ""}`);
  await ctx.reply(`📅 *Today's Schedule:*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
});

// ==================

bot.command(["now", "n"], async (ctx) => {
  try {
    const output = await getNowOutput();
    await ctx.reply(output, { parse_mode: "Markdown" }).catch(() => ctx.reply(output));
  } catch (err) {
    console.error("/now error:", err);
    await ctx.reply("Failed to generate /now output. Try again?");
  }
});

const STATE_ALIASES: Record<string, UserState> = {
  dev: "deep_work",
  deep: "deep_work",
  work: "deep_work",
  shop: "shop_mode",
  meeting: "meeting_mode",
  admin: "admin_mode",
  low: "low_energy",
  tired: "low_energy",
  family: "family_mode",
  prayer: "post_prayer",
  done: "idle",
  idle: "idle",
  reset: "idle",
};

bot.command("state", async (ctx) => {
  const input = ctx.match.trim().toLowerCase();

  if (!input) {
    const current = getCurrentState();
    const buttons = [
      [
        { text: "💻 Dev", callback_data: "state_set:deep_work" },
        { text: "🏪 Shop", callback_data: "state_set:shop_mode" },
        { text: "📁 Admin", callback_data: "state_set:admin_mode" },
      ],
      [
        { text: "😴 Low Energy", callback_data: "state_set:low_energy" },
        { text: "👨‍👩‍👧 Family", callback_data: "state_set:family_mode" },
        { text: "🕌 Prayer", callback_data: "state_set:post_prayer" },
      ],
      [
        { text: "✅ Done/Idle", callback_data: "state_set:idle" },
      ],
    ];
    await ctx.reply(
      `📍 Current state: *${current.state}*\nSource: ${current.source}${current.note ? `\nNote: ${current.note}` : ""}\n\nTap to change:`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } }
    );
    return;
  }

  const mapped = STATE_ALIASES[input];
  if (!mapped) {
    const valid = Object.keys(STATE_ALIASES).join(", ");
    await ctx.reply(`Unknown state: ${input}\n\nValid: ${valid}`);
    return;
  }

  const info = setState(mapped, "manual");
  await ctx.reply(`📍 State set to *${info.state}*`, { parse_mode: "Markdown" });
});

bot.command("timeline", async (ctx) => {
  try {
    const output = await getTimelineOutput();
    await ctx.reply(output, { parse_mode: "Markdown" }).catch(() => ctx.reply(output));
  } catch (err) {
    console.error("/timeline error:", err);
    await ctx.reply("Failed to generate timeline. Try again?");
  }
});

bot.callbackQuery(/^state_set:(.+)$/, async (ctx) => {
  const rawState = ctx.match[1];
  const info = setState(rawState as UserState, "manual");
  await ctx.answerCallbackQuery({ text: `📍 State: ${info.state}` });
  try {
    const text = ctx.callbackQuery.message?.text || "";
    await ctx.editMessageText(
      text.replace(/Current state: \*\w+\*/, `Current state: *${info.state}*`),
      { parse_mode: "Markdown", reply_markup: ctx.callbackQuery.message?.reply_markup }
    );
  } catch {}
});

// ==================
// PROMISE COMMANDS
// ==================


bot.command("promises", async (ctx) => {
  db.updatePromiseStatuses();
  const output = formatPromisesOutput();
  await sendSplit(ctx, output);
});

bot.command("kept", async (ctx) => {
  const id = parseInt(ctx.match, 10);
  if (!id) { await ctx.reply("Usage: /kept [promise_id]"); return; }
  const promises = db.getPromises() as any[];
  if (!promises.find((p: any) => p.id === id)) { await ctx.reply(`Promise #${id} not found.`); return; }
  db.fulfillPromise(id);
  await ctx.reply(`✅ Promise #${id} fulfilled! أحسنت`);
});

bot.command("broke", async (ctx) => {
  const id = parseInt(ctx.match, 10);
  if (!id) { await ctx.reply("Usage: /broke [promise_id]"); return; }
  const promises = db.getPromises() as any[];
  if (!promises.find((p: any) => p.id === id)) { await ctx.reply(`Promise #${id} not found.`); return; }
  db.breakPromise(id);
  await ctx.reply(`❌ Promise #${id} marked as broken. Learn from it.`);
});

// AGENT ORCHESTRATOR
// ==================

import { startAgent, stopAgent, listSessions, getProjectNames, formatSessionList } from "./agents";
import { parseAgentCommand, type Harness } from "./agent-harness";
import { randomUUID as newAgentRunId } from "crypto";
import { registerHermesCommand } from "./hermes-cmd";
registerHermesCommand(bot);

// /agent starts processes on the server and the Mac, so only the owner may use it.
function isAgentOwner(ctx: any): boolean {
  return !!process.env.TELEGRAM_USER_ID && String(ctx.from?.id) === process.env.TELEGRAM_USER_ID;
}

// dsh edits files and runs commands, so a dsh run waits for a tap; zen only reads.
const AGENT_CONFIRM_TTL_MS = 5 * 60 * 1000;
const pendingAgentRuns = new Map<string, { chatId: number; project: string; prompt: string; harness: Harness; createdAt: number }>();

async function runAgentAndReport(chatId: number, project: string, prompt: string, harness: Harness) {
  const { sessionId, isNewSession } = startAgent(project, prompt, async (sid, result, success) => {
    // Callback when agent finishes — send result to Telegram
    const icon = success ? "✅" : "❌";
    const header = `${icon} *Agent #${sid} — ${project}* (${harness})\n\n`;
    try {
      // Split long output into multiple messages
      if (result.length > 3500) {
        await bot.api.sendMessage(chatId, header + result.slice(0, 3500), { parse_mode: "Markdown" });
        await bot.api.sendMessage(chatId, result.slice(3500, 7000));
      } else {
        await bot.api.sendMessage(chatId, header + result, { parse_mode: "Markdown" });
      }
    } catch {
      // Fallback without markdown if it fails
      await bot.api.sendMessage(chatId, `Agent #${sid} (${project}, ${harness}): ${result.slice(0, 4000)}`);
    }
  }, harness);

  const action = isNewSession ? "Started" : "Continued";
  await bot.api.sendMessage(
    chatId,
    `🤖 *Agent #${sessionId} ${action}* on *${project}* (${harness})\n\n` +
    `_"${prompt}"_\n\n` +
    `Running in background — I'll send the result when done.`,
    { parse_mode: "Markdown" }
  );
}

bot.command("agent", async (ctx) => {
  if (!isAgentOwner(ctx)) { await ctx.reply("Unauthorized."); return; }
  const cmd = parseAgentCommand(String(ctx.match ?? ""));

  if (cmd.kind === "help") {
    await ctx.reply(
      `🤖 *Agent Orchestrator*\n\n` +
      `/agent [project] [task] — quick model answer (zen, server projects)\n` +
      `/agent dsh [project] [task] — DeepSeek Harness coding agent (asks first)\n` +
      `/agents — list all sessions\n` +
      `/agent stop [id] — stop a running session\n\n` +
      `Projects: ${getProjectNames().join(", ")}\n\n` +
      `*Examples:*\n` +
      `  /agent shopdemo summarize the open issues\n` +
      `  /agent dsh shopdemo fix the login bug\n` +
      `  /agent dsh up add dark mode\n` +
      `  /agent stop 1`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (cmd.kind === "stop") {
    if (!cmd.id) { await ctx.reply("Usage: /agent stop [session_id]"); return; }
    const stopped = stopAgent(cmd.id);
    await ctx.reply(stopped ? `🛑 Agent #${cmd.id} stopped.` : `Agent #${cmd.id} not found or not running.`);
    return;
  }

  if (!getProjectNames().includes(cmd.project)) {
    await ctx.reply(`Unknown project: *${cmd.project}*\n\nAvailable: ${getProjectNames().join(", ")}`, { parse_mode: "Markdown" });
    return;
  }

  const chatId = ctx.chat.id;
  if (cmd.harness === "zen") {
    try {
      await runAgentAndReport(chatId, cmd.project, cmd.prompt, cmd.harness);
    } catch (err: any) {
      await ctx.reply(`❌ Failed: ${err.message}`);
    }
    return;
  }

  for (const [id, p] of pendingAgentRuns) {
    if (Date.now() - p.createdAt > AGENT_CONFIRM_TTL_MS) pendingAgentRuns.delete(id);
  }
  const runId = newAgentRunId().slice(0, 8);
  pendingAgentRuns.set(runId, { chatId, project: cmd.project, prompt: cmd.prompt, harness: cmd.harness, createdAt: Date.now() });
  await ctx.reply(
    `🐋 *dsh on ${cmd.project}*\n\n_"${cmd.prompt}"_\n\n` +
    `DeepSeek Harness can edit files and run commands in this project. Run it?`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Run", callback_data: `agent_yes:${runId}` },
          { text: "❌ Cancel", callback_data: `agent_no:${runId}` },
        ]],
      },
    }
  );
});

bot.callbackQuery(/^agent_yes:(\S+)$/, async (ctx) => {
  if (!isAgentOwner(ctx)) { await ctx.answerCallbackQuery({ text: "Unauthorized" }); return; }
  const runId = ctx.match[1];
  const p = pendingAgentRuns.get(runId);
  pendingAgentRuns.delete(runId);
  if (!p || Date.now() - p.createdAt > AGENT_CONFIRM_TTL_MS) {
    await ctx.answerCallbackQuery({ text: "Expired or already handled" });
    return;
  }
  await ctx.answerCallbackQuery({ text: "Starting…" });
  await ctx.editMessageText(`🐋 *Approved* — dsh on ${p.project}…`, { parse_mode: "Markdown" }).catch(() => {});
  runAgentAndReport(p.chatId, p.project, p.prompt, p.harness).catch((err) => {
    bot.api.sendMessage(p.chatId, `❌ Failed: ${err?.message || err}`).catch(() => {});
  });
});

bot.callbackQuery(/^agent_no:(\S+)$/, async (ctx) => {
  pendingAgentRuns.delete(ctx.match[1]);
  await ctx.answerCallbackQuery({ text: "Cancelled" });
  await ctx.editMessageText("❌ Cancelled.").catch(() => {});
});

bot.command("agents", async (ctx) => {
  const sessions = listSessions(10);
  const list = formatSessionList(sessions);
  await ctx.reply(`🤖 *Agent Sessions:*\n\n${list}`, { parse_mode: "Markdown" });
});

// ==================
// SKILLS
// ==================

bot.command("skills", async (ctx) => {
  const skills = listSkills();
  if (skills.length === 0) {
    await ctx.reply("No skills loaded.");
    return;
  }
  const byCategory = new Map<string, typeof skills>();
  for (const s of skills) {
    const list = byCategory.get(s.category) || [];
    list.push(s);
    byCategory.set(s.category, list);
  }
  let msg = "⚡ *Available Skills:*\n\n";
  for (const [cat, items] of byCategory) {
    msg += `*${cat.toUpperCase()}*\n`;
    for (const s of items) {
      const argsStr = s.args.filter(a => a.required).map(a => a.name).join(", ");
      msg += `  \`${s.name}\`${argsStr ? ` [${argsStr}]` : ""} — ${s.description}\n`;
    }
    msg += "\n";
  }
  msg += "Run: `/skill <name> [args]`";
  await ctx.reply(msg, { parse_mode: "Markdown" });
});

bot.command("skill", async (ctx) => {
  const input = ctx.match.trim();
  if (!input) {
    await ctx.reply("Usage: /skill <name> [args]\n\nSee /skills for available skills.");
    return;
  }
  const parts = input.split(/\s+/);
  const name = parts[0];
  const skill = getSkill(name);
  if (!skill) {
    await ctx.reply(`Unknown skill: *${name}*\n\nUse /skills to see available skills.`, { parse_mode: "Markdown" });
    return;
  }
  const args: Record<string, any> = {};
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].includes("=")) {
      const [k, ...v] = parts[i].split("=");
      args[k] = v.join("=");
    } else if (skill.args[i - 1]) {
      args[skill.args[i - 1].name] = parts[i];
    }
  }
  await ctx.reply(`⚡ Running skill: *${name}*...`, { parse_mode: "Markdown" });
  const result = await executeSkill(name, args, bot, ctx.chat.id);
  await sendSplit(ctx, `${result.success ? "✅" : "❌"} *${name}*\n\n${result.output}`);
});

// ==================
// WHATSAPP AI
// ==================

// Pending WA reply state: maps chatId to jid awaiting reply text
const pendingWaReply = new Map<number, string>();

// Drafts: keyed by Telegram message_id of the draft preview message
const waDrafts = new Map<number, { jid: string; draft: string; contactName: string }>();

bot.callbackQuery(/^wa_task:(.+):(.+)$/, async (ctx) => {
  const jid = ctx.match[1];
  const encodedContent = ctx.match[2];
  const content = decodeURIComponent(encodedContent);
  const contact = db.getWAContactCategory(jid);
  const contactCategory = contact?.category || "other";
  const intent = detectWAIntent(content, contactCategory);
  const category = intent === "shop_order" ? "shop" : intent === "bug_report" ? "client" : contactCategory === "shop" ? "shop" : "client";
  const priority = intent === "bug_report" ? "high" : "medium";
  const result = db.addTask(content.slice(0, 200), category, priority);
  const taskId = result.lastInsertRowid as number;
  db.updateTask(taskId, { source_type: "whatsapp" });
  await ctx.answerCallbackQuery({ text: `✅ Task #${taskId} created!` });
  try {
    const text = ctx.callbackQuery.message?.text || "";
    await ctx.editMessageText(text + `\n\n✅ Task #${taskId} created [${category}/${priority}]`, { parse_mode: "Markdown" });
  } catch {}
});

bot.callbackQuery(/^wa_schedule:(.+)$/, async (ctx) => {
  const jid = ctx.match[1];
  await ctx.answerCallbackQuery({ text: "📅 Use /schedule to set a time" });
  try {
    const text = ctx.callbackQuery.message?.text || "";
    await ctx.editMessageText(text + "\n\n📅 Send /schedule with date/time to schedule", { parse_mode: "Markdown" });
  } catch {}
});

bot.callbackQuery(/^wa_reply:(.+)$/, async (ctx) => {
  const jid = ctx.match[1];
  pendingWaReply.set(ctx.chat!.id, jid);
  await ctx.answerCallbackQuery({ text: "Type your reply..." });
  await ctx.reply(`Type your reply to *${jid.split("@")[0]}*:`, { parse_mode: "Markdown" });
});

bot.callbackQuery(/^wa_ignore:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Ignored" });
  try { await ctx.editMessageReplyMarkup(undefined); } catch {}
});

bot.callbackQuery(/^wa_mute:(.+)$/, async (ctx) => {
  const jid = ctx.match[1];
  db.addWARule(jid, "ignore");
  await ctx.answerCallbackQuery({ text: `Muted ${jid.split("@")[0]}` });
  try { await ctx.editMessageReplyMarkup(undefined); } catch {}
});

bot.callbackQuery(/^wa_draft:(.+)$/, async (ctx) => {
  const jid = ctx.match[1];
  await ctx.answerCallbackQuery({ text: "Drafting…" });

  // Extract the incoming message content from the forwarded Telegram message.
  // Format is: `icon *[WhatsApp]* name(...):\n"content"\nIntent: ...`
  const fullText = ctx.callbackQuery.message?.text || "";
  const quoteMatch = fullText.match(/"([\s\S]*?)"/);
  const incoming = quoteMatch ? quoteMatch[1] : fullText;

  const contact = db.getWAContactCategory(jid) as any;
  const contactName = contact?.display_name || jid.split("@")[0];
  const category = contact?.category || "other";

  try {
    const draft = await draftWAReply(jid, incoming, contactName, category);
    const preview = `*Draft reply to ${contactName}*\n\n${draft}`;
    const sent = await ctx.reply(preview, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "Send", callback_data: "wa_send_draft" },
          { text: "Edit", callback_data: "wa_edit_draft" },
          { text: "Redraft", callback_data: "wa_redraft_draft" },
          { text: "Discard", callback_data: "wa_discard_draft" },
        ]],
      },
    });
    waDrafts.set(sent.message_id, { jid, draft, contactName });
  } catch (err: any) {
    console.error("Draft generation failed:", err);
    await ctx.reply(`Draft failed: ${err.message}`);
  }
});

bot.callbackQuery("wa_send_draft", async (ctx) => {
  const msgId = ctx.callbackQuery.message?.message_id;
  const entry = msgId ? waDrafts.get(msgId) : undefined;
  if (!entry) {
    await ctx.answerCallbackQuery({ text: "Draft expired" });
    return;
  }
  try {
    await sendWhatsAppMessage(entry.jid, entry.draft);
    waDrafts.delete(msgId!);
    await ctx.answerCallbackQuery({ text: "Sent" });
    try {
      await ctx.editMessageText(
        `*Sent to ${entry.contactName}*\n\n${entry.draft}`,
        { parse_mode: "Markdown" },
      );
    } catch {}
  } catch (err: any) {
    await ctx.answerCallbackQuery({ text: "Failed" });
    await ctx.reply(`Send failed: ${err.message}`);
  }
});

bot.callbackQuery("wa_edit_draft", async (ctx) => {
  const msgId = ctx.callbackQuery.message?.message_id;
  const entry = msgId ? waDrafts.get(msgId) : undefined;
  if (!entry) {
    await ctx.answerCallbackQuery({ text: "Draft expired" });
    return;
  }
  pendingWaReply.set(ctx.chat!.id, entry.jid);
  waDrafts.delete(msgId!);
  await ctx.answerCallbackQuery({ text: "Type your edit" });
  await ctx.reply(
    `*Edit and send to ${entry.contactName}*\nCurrent draft:\n\`\`\`\n${entry.draft}\n\`\`\`\nType your version now.`,
    { parse_mode: "Markdown" },
  );
});

bot.callbackQuery("wa_redraft_draft", async (ctx) => {
  const msgId = ctx.callbackQuery.message?.message_id;
  const entry = msgId ? waDrafts.get(msgId) : undefined;
  if (!entry) {
    await ctx.answerCallbackQuery({ text: "Draft expired" });
    return;
  }
  await ctx.answerCallbackQuery({ text: "Redrafting" });

  const contact = db.getWAContactCategory(entry.jid) as any;
  const category = contact?.category || "other";

  try {
    const newDraft = await draftWAReply(entry.jid, entry.draft, entry.contactName, category);
    entry.draft = newDraft;
    waDrafts.set(msgId!, entry);
    try {
      await ctx.editMessageText(
        `*Draft reply to ${entry.contactName}* (redraft)\n\n${newDraft}`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[
              { text: "Send", callback_data: "wa_send_draft" },
              { text: "Edit", callback_data: "wa_edit_draft" },
              { text: "Redraft", callback_data: "wa_redraft_draft" },
              { text: "Discard", callback_data: "wa_discard_draft" },
            ]],
          },
        },
      );
    } catch {}
  } catch (err: any) {
    await ctx.reply(`Redraft failed: ${err.message}`);
  }
});

bot.callbackQuery("wa_discard_draft", async (ctx) => {
  const msgId = ctx.callbackQuery.message?.message_id;
  if (msgId) waDrafts.delete(msgId);
  await ctx.answerCallbackQuery({ text: "Discarded" });
  try { await ctx.editMessageText("Draft discarded"); } catch {}
});

bot.callbackQuery(/^wa_autoreply:(.+)$/, async (ctx) => {
  const jid = ctx.match[1];
  const currentlyOn = isAutoReplyEnabled(jid);
  setAutoReplyRule(jid, !currentlyOn);
  const contact = db.getWAContactCategory(jid) as any;
  const name = contact?.display_name || jid.split("@")[0];
  const newState = !currentlyOn ? "ON" : "OFF";
  await ctx.answerCallbackQuery({ text: `Auto-Reply ${newState}` });
  await ctx.reply(
    `Auto-Reply for *${name}* is now *${newState}*.\n\n` +
    (newState === "ON"
      ? "Every incoming message from this contact will be answered in your voice using your last 25 messages as style examples. You will still see each auto-reply forwarded to this chat."
      : "Messages from this contact will go back to normal forwarding."),
    { parse_mode: "Markdown" },
  );
});

bot.command("autoreply", async (ctx) => {
  const arg = ctx.match?.trim();
  if (!arg) {
    const globalState = isGlobalAutoReplyEnabled() ? "ON" : "OFF";
    await ctx.reply(
      "*Auto-Reply*\n\n" +
      `Global: *${globalState}*\n\n` +
      "Usage:\n" +
      "`/autoreply global on` — reply to *every* incoming 1-on-1 message\n" +
      "`/autoreply global off` — stop global auto-reply\n" +
      "`/autoreply list` — show contacts with auto-reply enabled\n" +
      "`/autoreply on <phone_or_name>` — enable for a contact\n" +
      "`/autoreply off <phone_or_name>` — disable for a contact\n\n" +
      "Examples:\n" +
      "`/autoreply on 212612345678`\n" +
      "`/autoreply on محمد`\n\n" +
      "Safeguards: groups are always skipped, 2-min cooldown per contact, every auto-reply is forwarded here as `[AUTO] name`.",
      { parse_mode: "Markdown" },
    );
    return;
  }

  const parts = arg.split(/\s+/);
  const action = parts[0]?.toLowerCase();

  if (action === "global") {
    const sub = parts[1]?.toLowerCase();
    if (sub !== "on" && sub !== "off") {
      await ctx.reply("Usage: `/autoreply global on` or `/autoreply global off`", { parse_mode: "Markdown" });
      return;
    }
    setGlobalAutoReply(sub === "on");
    await ctx.reply(
      `Global auto-reply is now *${sub.toUpperCase()}*.\n\n` +
      (sub === "on"
        ? "Every incoming 1-on-1 message will be replied to in your voice using your last 25 messages to that person as style examples. Groups are skipped. Every auto-reply is forwarded here as `[AUTO] name` so you can catch mistakes. Cooldown: 2 min per contact."
        : "Incoming messages will go back to normal forwarding with Draft/Reply buttons."),
      { parse_mode: "Markdown" },
    );
    return;
  }

  if (action === "list") {
    const rules = db.getWARules(true) as any[];
    const autos = rules.filter((r) => r.rule_type === "auto_reply");
    if (autos.length === 0) {
      await ctx.reply("No auto-reply rules active.");
      return;
    }
    const lines = autos.map((r) => {
      const contact = db.getWAContactCategory(r.jid) as any;
      const name = contact?.display_name || r.jid.split("@")[0];
      return `• ${name} — \`${r.jid}\``;
    });
    await ctx.reply(`*Auto-Reply enabled for:*\n${lines.join("\n")}`, { parse_mode: "Markdown" });
    return;
  }

  if (action !== "on" && action !== "off") {
    await ctx.reply("Usage: /autoreply on|off|list [phone_or_name]");
    return;
  }

  const query = parts.slice(1).join(" ").trim();
  if (!query) {
    await ctx.reply("Give me a phone number or part of a name to match.");
    return;
  }

  // Try to resolve query → jid
  let jid: string | null = null;
  let resolvedName = query;

  // 1) Phone number lookup
  if (/^\d{6,}$/.test(query.replace(/\D/g, ""))) {
    const digits = query.replace(/\D/g, "");
    const candidates = ((db as any).default.prepare(
      "SELECT DISTINCT m.jid, COALESCE(c.display_name, m.sender_name) AS name FROM whatsapp_messages m LEFT JOIN whatsapp_contacts c ON c.jid = m.jid WHERE m.jid LIKE ? LIMIT 5"
    ).all(`%${digits}%`)) as any[];
    if (candidates.length === 1) {
      jid = candidates[0].jid;
      resolvedName = candidates[0].name || digits;
    } else if (candidates.length === 0) {
      // No messages yet — construct a fallback jid
      jid = `${digits}@s.whatsapp.net`;
      resolvedName = digits;
    } else {
      await ctx.reply(`Multiple matches for ${digits}:\n${candidates.map((c) => `• ${c.name} — ${c.jid}`).join("\n")}\n\nUse the exact jid.`);
      return;
    }
  } else {
    // 2) Name search across display_name and sender_name
    const candidates = ((db as any).default.prepare(
      "SELECT DISTINCT m.jid, COALESCE(c.display_name, m.sender_name) AS name FROM whatsapp_messages m LEFT JOIN whatsapp_contacts c ON c.jid = m.jid WHERE c.display_name LIKE ? OR m.sender_name LIKE ? GROUP BY m.jid LIMIT 5"
    ).all(`%${query}%`, `%${query}%`)) as any[];
    if (candidates.length === 0) {
      await ctx.reply(`No contact found matching "${query}". Give me the phone number instead (e.g. \`/autoreply on 212612345678\`).`, { parse_mode: "Markdown" });
      return;
    }
    if (candidates.length > 1) {
      await ctx.reply(`Multiple matches for "${query}":\n${candidates.map((c) => `• ${c.name} — \`${c.jid}\``).join("\n")}\n\nRun the command again with the phone number to disambiguate.`, { parse_mode: "Markdown" });
      return;
    }
    jid = candidates[0].jid;
    resolvedName = candidates[0].name || query;
  }

  if (!jid) {
    await ctx.reply("Could not resolve contact.");
    return;
  }

  setAutoReplyRule(jid, action === "on");
  await ctx.reply(
    `Auto-Reply for *${resolvedName}* is now *${action.toUpperCase()}*.\n\`${jid}\``,
    { parse_mode: "Markdown" },
  );
});

// /contact and /contacts both work
bot.command(["contacts", "contact"], async (ctx) => {
  const categorized = db.getAllWAContacts() as any[];
  const recent = (db.getRecentWAMessages(200) as any[]);
  const contactMap = new Map<string, { name: string; count: number }>();
  for (const m of recent) {
    const e = contactMap.get(m.jid);
    if (e) e.count++;
    else contactMap.set(m.jid, { name: m.sender_name, count: 1 });
  }
  const catMap = new Map(categorized.map((c: any) => [c.jid, c]));
  const catEmoji: Record<string, string> = { client: "👤", shop: "🏪", family: "👨‍👩‍👧", personal: "🏠", other: "📱" };

  const tagged: string[] = [];
  const untagged: string[] = [];
  for (const [jid, info] of contactMap) {
    const cat = catMap.get(jid) as any;
    if (cat) {
      tagged.push(`${catEmoji[cat.category] || "📱"} *${cat.display_name || info.name}* [${cat.category}]`);
    } else {
      untagged.push(`⚪ ${info.name} (${info.count} msgs)`);
    }
  }

  const lines = ["📱 *WhatsApp Contacts*\n"];
  if (tagged.length) { lines.push("*Labeled:*"); lines.push(...tagged); lines.push(""); }
  if (untagged.length) { lines.push(`*Not labeled (${untagged.length}):*`); lines.push(...untagged); }
  if (!tagged.length && !untagged.length) lines.push("No WhatsApp contacts yet.");
  lines.push("\n_Tell me naturally: \"حفوصة is my wife Farah\", \"Androtetouan is a client\"_");
  await sendSplit(ctx, lines.join("\n"));
});

bot.command("wa", async (ctx) => {
  const input = ctx.match.trim();

  if (!input || input === "help") {
    await ctx.reply(
      `*WhatsApp AI Commands:*\n\n` +
      `/wa rules — List active rules\n` +
      `/wa ignore <jid> — Ignore a chat\n` +
      `/wa notify <jid> — Forward messages to Telegram\n` +
      `/wa auto <jid|all> <keyword> <response> — Auto-reply rule\n` +
      `/wa del <rule_id> — Delete a rule\n` +
      `/wa recent — Recent messages`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  const parts = input.split(/\s+/);
  const cmd = parts[0];

  if (cmd === "rules") {
    const rules = db.getWARules();
    if (rules.length === 0) {
      await ctx.reply("No active WhatsApp rules.");
      return;
    }
    const lines = rules.map((r: any) => {
      const target = r.jid ? r.jid.split("@")[0] : "ALL";
      return `#${r.id} [${r.rule_type}] ${target} — ${r.condition || "*"} → ${(r.response || "").slice(0, 50)}`;
    });
    await ctx.reply(`*WhatsApp Rules:*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
  } else if (cmd === "ignore") {
    const jid = parts[1];
    if (!jid) { await ctx.reply("Usage: /wa ignore <jid or phone@s.whatsapp.net>"); return; }
    const fullJid = jid.includes("@") ? jid : `${jid}@s.whatsapp.net`;
    db.addWARule(fullJid, "ignore");
    await ctx.reply(`Ignoring ${fullJid.split("@")[0]}`);
  } else if (cmd === "notify") {
    const jid = parts[1];
    if (!jid) { await ctx.reply("Usage: /wa notify <jid>"); return; }
    const fullJid = jid.includes("@") ? jid : `${jid}@s.whatsapp.net`;
    db.addWARule(fullJid, "notify");
    await ctx.reply(`Forwarding messages from ${fullJid.split("@")[0]} to Telegram`);
  } else if (cmd === "auto") {
    const jid = parts[1];
    const keyword = parts[2];
    const response = parts.slice(3).join(" ");
    if (!jid || !keyword || !response) {
      await ctx.reply("Usage: /wa auto <jid|all> <keyword> <response>");
      return;
    }
    const fullJid = jid === "all" ? null : (jid.includes("@") ? jid : `${jid}@s.whatsapp.net`);
    db.addWARule(fullJid, "auto_reply", keyword, response);
    await ctx.reply(`Auto-reply rule added: "${keyword}" → "${response}"`);
  } else if (cmd === "del") {
    const id = parseInt(parts[1]);
    if (!id) { await ctx.reply("Usage: /wa del <rule_id>"); return; }
    db.deleteWARule(id);
    await ctx.reply(`Rule #${id} deleted.`);
  } else if (cmd === "recent") {
    const messages = db.getRecentWAMessages(15);
    if (messages.length === 0) {
      await ctx.reply("No recent WhatsApp messages.");
      return;
    }
    const lines = messages.map((m: any) => {
      const name = m.sender_name || m.sender?.split("@")[0] || "?";
      const time = new Date(m.timestamp * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      const replied = m.replied ? " ✓" : "";
      return `${time} *${name}*: ${m.content.slice(0, 80)}${replied}`;
    });
    await ctx.reply(`*Recent WhatsApp:*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
  } else {
    // Check if this is a reply to a pending WA conversation
    await ctx.reply("Unknown /wa command. Try /wa help");
  }
});

// ==================
// AI MEMORY
// ==================

bot.command("memory", async (ctx) => {
  const stats = db.getAiMemoryStats();
  await ctx.reply(
    `🧠 *AI Memory Stats:*\n\n` +
    `Total memories: ${stats.total}\n` +
    `From Claude: ${stats.fromClaude}\n` +
    `From local model: ${stats.fromLocal}\n\n` +
    `Mode: ${process.env.USE_LOCAL_AI === "true" ? "Local-first + Claude fallback" : "Claude only"}`,
    { parse_mode: "Markdown" }
  );
});


// ==================
// SERVER & SHELL
// ==================

function isOwner(ctx: any): boolean {
  return String(ctx.from?.id) === USER_ID;
}

bot.command("server", async (ctx) => {
  if (!isOwner(ctx)) { await ctx.reply("Unauthorized."); return; }
  await ctx.reply("Checking server...");
  const status = await getServerStatus();
  await ctx.reply(`🖥 *Server Status*\n\n${status}`, { parse_mode: "Markdown" }).catch(() => ctx.reply(status));
});

bot.command("run", async (ctx) => {
  if (!isOwner(ctx)) { await ctx.reply("Unauthorized."); return; }
  const cmd = ctx.match.trim();
  if (!cmd) { await ctx.reply("Usage: /run [command]\n\nExample: /run docker ps"); return; }
  const result = await runCommand(cmd);
  const output = result.stdout || result.stderr || "(no output)";
  const prefix = result.code === 0 ? "✅" : `❌ Exit code: ${result.code}`;
  await sendSplit(ctx, `${prefix}\n\`\`\`\n${output}\n\`\`\``);

  // M2.2 — auto-log successful server commands as activity events
  if (result.code === 0) {
    try {
      const eventId = logServerCommand(cmd, result.code);
      // High-confidence events log silently. Only nudge for confirmation if medium.
      const event = db.getUnconfirmedEvents().find((e: any) => e.id === eventId);
      if (event && event.confidence === "medium") {
        await notifyConfirmation(eventId);
      }
    } catch (err) {
      console.error("Failed to log /run activity event:", err);
    }
  }
});

bot.command("pi", async (ctx) => {
  if (!isOwner(ctx)) { await ctx.reply("Unauthorized."); return; }
  // TODO: Pi agent removed (runPi from pi-agent)
  await ctx.reply(`🔧 *Pi Agent* - This feature has been removed. Pi agent is no longer available.`, { parse_mode: "Markdown" });
});

bot.command("expert", async (ctx) => {
  if (!isOwner(ctx)) { await ctx.reply("Unauthorized."); return; }
  const input = ctx.match.trim();
  if (!input) {
    const { listExperts } = await import("./experts");
    const experts = listExperts();
    const list = experts.map(e => `  *${e.name}* — ${e.description}`).join("\n");
    await ctx.reply(
      `🧠 *Expert Agents*\n\n` +
      `/expert [name] [project] [context]\n\n` +
      `Available:\n${list}\n\n` +
      `Projects: ${getProjectNames().join(", ")}\n\n` +
      `*Examples:*\n` +
      `  /expert code-review shopdemo\n` +
      `  /expert debug clinic login page broken\n` +
      `  /expert deploy-check billing\n` +
      `  /expert client-update studio`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  const parts = input.split(/\s+/);
  const expertName = parts[0].toLowerCase();
  const project = (parts[1] || "").toLowerCase();
  const context = parts.slice(2).join(" ") || undefined;

  if (!project) {
    await ctx.reply(`Usage: /expert ${expertName} [project] [context]`);
    return;
  }

  await ctx.reply(`🧠 *${expertName}* analyzing *${project}*...${context ? `\n_"${context}"_` : ""}`, { parse_mode: "Markdown" });
  const chatId = ctx.chat.id;

  try {
    const { runExpert } = await import("./experts");
    const { result, success, expert } = await runExpert(expertName, project, context);
    const icon = success ? "🧠" : "❌";
    const truncated = result.length > 3500 ? result.slice(0, 3500) + "\n...(truncated)" : result;
    try {
      await bot.api.sendMessage(chatId, `${icon} *${expert} — ${project}*\n\n${truncated}`, { parse_mode: "Markdown" });
    } catch {
      await bot.api.sendMessage(chatId, `${icon} ${expert} (${project}):\n\n${truncated}`);
    }
  } catch (err: any) {
    await bot.api.sendMessage(chatId, `❌ Expert failed: ${err.message}`);
  }
});

registerMacCommand(bot, isOwner); // /mac and /laptop

// ==================
// REGISTER MODULE COMMANDS
// ==================

registerClientCommands(bot);
registerFinanceCommands(bot);
if (prayerOn()) registerQuranCommands(bot);
registerReportCommands(bot);
registerCalendarCommands(bot);
registerResearchCommands(bot);
registerTrelloCommands(bot);

// ==================
// AI MODEL SWITCH
// ==================

bot.command("model", async (ctx) => {
  if (!isOwner(ctx)) { await ctx.reply("Unauthorized."); return; }
  const input = ctx.match.trim().toLowerCase();
  if (!input) {
    await ctx.reply(
      `🤖 *Current AI Model:* ${getModelLabel()}\n\n` +
      `/model pi — Switch to Pi Agent (DeepSeek V4 Pro)\n` +
      `/model kieai — Switch to GPT-5.4 (kie.ai)`,
      { parse_mode: "Markdown" }
    );
    return;
  }
  if (input === "pi" || input === "claude" || input === "deepseek") {
    setModel("pi");
    await ctx.reply("🤖 Switched to *Pi Agent (DeepSeek V4 Pro)*", { parse_mode: "Markdown" });
  } else if (input === "kieai" || input === "kie" || input === "gpt5" || input === "gpt" || input === "gpt-5-4" || input === "gpt5.4") {
    if (!process.env.KIE_API_KEY) {
      await ctx.reply("❌ KIE_API_KEY not set in .env. Add it via the Dashboard first.");
      return;
    }
    setModel("kieai");
    await ctx.reply("🤖 Switched to *GPT-5.4 (kie.ai)*", { parse_mode: "Markdown" });
  } else {
    await ctx.reply("Unknown model. Use: `/model claude` or `/model kieai`", { parse_mode: "Markdown" });
  }
});

// ==================
// AI REPORTS
// ==================

bot.command("briefing", async (ctx) => {
  await ctx.reply("Generating briefing...");
  try {
    const briefing = await generateBriefing("morning");
    await sendSplit(ctx, `🌅 *Morning Briefing*\n\n${briefing}`);
  } catch (err) {
    console.error("Briefing error:", err);
    await ctx.reply("Failed to generate. Try again.");
  }
});

bot.command("review", async (ctx) => {
  await ctx.reply("Generating review...");
  try {
    const review = await generateBriefing("evening");
    await sendSplit(ctx, `🌙 *Evening Review*\n\n${review}`);
  } catch (err) {
    console.error("Review error:", err);
    await ctx.reply("Failed to generate. Try again.");
  }
});

// ==================
// VOICE MESSAGES
// ==================


bot.command("week", async (ctx) => {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - diff);
  const startStr = weekStart.toISOString().split("T")[0];
  const today = localToday();

  try {
    const progress = db.getProgressData(startStr, today);

    const lines = [
      `\ud83d\udcca *This Week (${startStr} \u2192 ${today})*`,
      ``,
      `\ud83d\udccb Tasks: ${progress.tasks.completed} done / ${progress.tasks.created} created`,
      `\u23f1 Work: ${progress.work.totalHours}h${Object.entries(progress.work.byType).map(([k, v]) => ` (${k}: ${v}h)`).join("") || ""}`,
      `\u2705 Habits: ${progress.habits.rate}% completion`,
      ...(prayerOn() ? [`\ud83d\udcd6 Quran: ${progress.deen.quranPages} pages (${progress.deen.quranDays} days)`] : []),
      `\ud83d\udcb0 Income: ${progress.finance.total} ${currency()}${shopOn() && progress.finance.shopRevenue ? ` + ${progress.finance.shopRevenue} shop` : ""}`,
      `\ud83d\udcdd Journal: ${progress.journal.entries} entries`,
    ];

    if (progress.goals.length > 0) {
      lines.push("", "\ud83c\udfaf Goals:");
      for (const g of progress.goals) {
        const pct = g.target_value > 0 ? Math.round((g.current_value / g.target_value) * 100) : 0;
        lines.push(`  ${g.title}: ${pct}% (${g.current_value}/${g.target_value})`);
      }
    }

    await sendSplit(ctx, lines.join("\n"));
  } catch (err) {
    await ctx.reply("Failed to generate weekly summary.");
  }
});

// ==================
// AUDIO TRANSCRIPTION HANDLERS
// ==================

// Voice PTT messages (always .ogg from Telegram)
bot.on("message:voice", async (ctx) => {
  await transcribeTelegramAudio(ctx, "ogg");
});

// Audio file attachments (music, recordings, etc.)
bot.on("message:audio", async (ctx) => {
  const audio = ctx.message.audio;
  if (audio.duration > 600) {
    await ctx.reply("Audio too long (>10min). Trim and resend.");
    return;
  }
  const ext = resolveAudioExt(audio.mime_type, audio.file_name);
  await transcribeTelegramAudio(ctx, ext);
});

// Circular video notes (always .mp4; mp4 now in laptop allowlist)
bot.on("message:video_note", async (ctx) => {
  await transcribeTelegramAudio(ctx, "mp4");
});

// Document attachments — only handle audio mimetypes/extensions; no reply for non-audio
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  if (!isAudioDocument(doc.mime_type, doc.file_name)) return;
  const ext = resolveAudioExt(doc.mime_type, doc.file_name);
  await transcribeTelegramAudio(ctx, ext);
});

// ==================
// NATURAL LANGUAGE (catch-all)
// ==================

// Track if last bot message was a journal prompt — exported for scheduler
export let lastJournalPromptTime = 0;
export function setJournalPromptTime() { lastJournalPromptTime = Date.now(); }

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  // "yes" / "ok" / "واخا" answers the newest open card (run, deploy, mission).
  // The inline buttons are a shortcut, not the only way to answer.
  const approval = await handleApprovalText(ctx.chat.id, text).catch((err) => {
    console.error("[telegram] approval failed:", err?.message || err);
    return null;
  });
  if (approval) {
    await ctx.reply(approval);
    return;
  }

  // SDK-quick correction flow: if the user clicked "✏️ Correct" on a mirrored
  // sdk-quick reply, consume this message as the corrected reply and resend to WA.
  const consumed = await consumeSdkCorrection(ctx.chat.id, text);
  if (consumed) {
    await ctx.reply("✅ Correction sent to WA.");
    return;
  }

  // Check if this is a reply to a pending WhatsApp conversation
  const waJid = pendingWaReply.get(ctx.chat.id);
  if (waJid) {
    pendingWaReply.delete(ctx.chat.id);
    try {
      await sendWhatsAppMessage(waJid, text);
      await ctx.reply(`Sent to ${waJid.split("@")[0]}`);
    } catch (err: any) {
      await ctx.reply(`Failed to send: ${err.message}`);
    }
    return;
  }

  // Auto-save as journal if recent journal prompt was sent (within 10 min)
  if (lastJournalPromptTime && Date.now() - lastJournalPromptTime < 10 * 60000) {
    lastJournalPromptTime = 0;
    try {
      db.addJournalEntry(text);
      await ctx.reply(`Saved to journal. Jazak Allah khayr.`, { parse_mode: "Markdown" });
      return;
    } catch (err) {
      console.error("Failed to save journal entry:", err);
    }
  }

  const detectedPromises = extractPromises(text);
  for (const p of detectedPromises) {
    db.addPromise({
      content: p.content,
      made_to: p.madeTo,
      due_date: p.dueDate,
      due_context: p.dueContext,
      source_type: "chat",
    });
    await ctx.reply(`📋 Promise detected: "${p.content}"${p.dueContext ? ` (${p.dueContext})` : ""}`);
  }

  try {
    const response = await chat(text, bot, ctx.chat.id);
    await sendSplit(ctx, response);
  } catch (err) {
    console.error("AI chat error:", err);
    await ctx.reply("Sorry, something went wrong. Try again?");
  }
});

// ==================
// HELPERS
// ==================

async function sendSplit(ctx: any, text: string) {
  if (text.length <= 4000) {
    await ctx.reply(text, { parse_mode: "Markdown" }).catch(() => ctx.reply(text));
    return;
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= 4000) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf("\n", 4000);
    if (splitAt === -1) splitAt = 4000;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  for (const chunk of chunks) {
    await ctx.reply(chunk, { parse_mode: "Markdown" }).catch(() => ctx.reply(chunk));
  }
}

// ==================
// VOICE COACH COMMAND
// ==================

bot.command("voice_coach", async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply("Not authorized.");
  await ctx.reply("Voice coach is disabled.");
});

// ==================
// ERROR HANDLING & START
// ==================

bot.catch((err) => {
  console.error("Bot error:", err);
});

async function main() {
  console.log("🏙 Tokyo Life OS starting...");
  loadSkills();

  // Initialize multi-agent system
  const orchestrator = createOrchestrator(bot);
  loadAllAgents(orchestrator);
  orchestrator.wireAll();
  await orchestrator.initAll();
  await orchestrator.refreshPrayer();
  // Connect event bus to WhatsApp AI for cross-agent pipelines
  setEventBus(orchestrator.eventBus);
  registerPipelines(orchestrator.eventBus, () => orchestrator.createContext({ name: "pipeline" } as any));

  // M2.5 — give auto_log a handle to the bot so it can send confirmation prompts
  if (USER_ID) setAutoLogBot(bot, USER_ID);

  if (USER_ID) {
    startScheduler(
      bot,
      () => generateBriefing("morning"),
      () => generateBriefing("evening")
    );
    startCoaching(bot, USER_ID);
  } else {
    console.warn("No TELEGRAM_USER_ID — scheduled messages disabled.");
  }

  startDashboard(parseInt(process.env.DASHBOARD_PORT || "3030"));
  startObligationReminders();

  // Setup WhatsApp → Telegram forwarding
  if (USER_ID) {
    setTelegramForwarder(async (msg) => {
      const chatId = parseInt(USER_ID!);
      const icon = msg.isGroup ? "👥" : "💬";
      const contact = db.getWAContactCategory(msg.jid);
      const contactCategory = contact?.category || "other";
      const intent = detectWAIntent(msg.content, contactCategory);
      const suggestion = getIntentSuggestion(intent, msg.senderName);
      const intentLabel = intent.replace(/_/g, " ");
      const header = `${icon} *[WhatsApp]* ${msg.senderName}${msg.isGroup ? ` (${msg.chatName})` : ""}:`;
      const intentLine = `\uD83D\uDCCB Intent: ${intentLabel}`;
      const text = `${header}\n"${msg.content.slice(0, 400)}"\n${intentLine}`;
      const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
      if (suggestion) {
        keyboard.push([{ text: suggestion.label, callback_data: `wa_task:${msg.jid}:${encodeURIComponent(msg.content.slice(0, 100))}` }]);
      }
      if (intent === "meeting") {
        keyboard.push([{ text: "📅 Schedule Meeting", callback_data: `wa_schedule:${msg.jid}` }]);
      }
      keyboard.push([
        { text: "Draft", callback_data: `wa_draft:${msg.jid}` },
        { text: "Reply", callback_data: `wa_reply:${msg.jid}` },
      ]);
      const autoOn = isAutoReplyEnabled(msg.jid);
      keyboard.push([
        { text: autoOn ? "Auto-Reply: ON" : "Auto-Reply: OFF", callback_data: `wa_autoreply:${msg.jid}` },
      ]);
      keyboard.push([
        { text: "Ignore", callback_data: `wa_ignore:${msg.jid}` },
        { text: "Mute", callback_data: `wa_mute:${msg.jid}` },
      ]);
      await bot.api.sendMessage(chatId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard },
      }).catch(() =>
        bot.api.sendMessage(chatId, `[WhatsApp] ${msg.senderName}: ${msg.content.slice(0, 500)}`)
      );
    });
  }

  // Auto-reconnect WhatsApp on boot (uses persisted auth in whatsapp-auth/).
  // If no registered session exists, startWhatsApp() is a no-op and the user
  // can pair from the dashboard. Safe to call unconditionally.

  // Wire shop group AI chat function (uses the same chat() from ai.ts)
  setShopChatFn(async (prompt: string) => chat(prompt, bot, parseInt(USER_ID || "0")));

  if (whatsappOn()) startWhatsApp().catch((err) => console.error("WhatsApp auto-start failed:", err));
  else console.log("WhatsApp bridge off (FEATURE_WHATSAPP=0)");

  // Voice-coach scheduler — disabled by user
  // (was: scoreBatch loop + 21:00 digest)

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received — shutting down gracefully...`);
    try { bot.stop(); } catch (err) { console.error("Bot stop error:", err); }
    try { const dbInstance = await import("./db"); dbInstance.default.close(); } catch (err) { console.error("DB close error:", err); }
    console.log("🏙 Tokyo shut down.");
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await bot.start();
  console.log("🏙 Tokyo is running!");
}

main();
