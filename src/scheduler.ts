import cron from "node-cron";
import { InlineKeyboard } from "grammy";
import { getTodayPrayerTimes, getNextPrayer, msUntilTime, prefetchTomorrow } from "./prayer";
import { generateWeeklyReport } from "./reports";
import { formatPromiseSummary } from "./promises";
import { getUpcomingDeadlines, clearOldConversations, getAllActiveTasks, getHabitLogsForDate, getAdhkarStatus, getClientLastContact, getExpenseTotal, getIncomeSummary } from "./db";
import { generateAIDigest } from "./research";
import { checkIdleSessions, updatePromiseStatuses } from "./auto_log";
import { localToday } from "./utils";
import { generateMorningSummary } from "./whatsapp-ai";
import { setJournalPromptTime } from "./index";
import type { Bot } from "grammy";
import { pushReminder } from "./control/push/reminders";

let prayerTimers: NodeJS.Timeout[] = [];
const expenseAlertSentDays = new Set<string>();

async function sendMessage(bot: Bot, chatId: string, text: string, keyboard?: InlineKeyboard) {
  try {
    await bot.api.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: keyboard });
  } catch {
    try {
      await bot.api.sendMessage(chatId, text.replace(/[*_`\[\]]/g, ""), { reply_markup: keyboard });
    } catch (e) {
      console.error("Failed to send scheduled message:", e);
    }
  }
}

async function sendSmartTaskDigest(bot: Bot, chatId: string, mode: "morning" | "work" | "evening") {
  const today = localToday();
  const tasks = getAllActiveTasks() as any[];
  const habits = getHabitLogsForDate(today) as any[];
  const adhkar = getAdhkarStatus(today);

  if (mode === "morning") {
    // Morning: show top 3 urgent tasks + unchecked habits
    const urgentTasks = tasks.filter((t: any) => t.priority === "urgent" || t.priority === "high").slice(0, 3);
    const undoneHabits = habits.filter((h: any) => !h.done).slice(0, 4);

    let text = "🌅 *Your Morning Tasks:*\n\n";
    const kb = new InlineKeyboard();

    if (urgentTasks.length > 0) {
      text += "*Priority tasks:*\n";
      for (const t of urgentTasks) {
        text += `  ${t.priority === "urgent" ? "🔴" : "🟠"} #${t.id} ${t.title}\n`;
        kb.text(`✅ #${t.id} Done`, `task:${t.id}`).row();
      }
    }
    if (undoneHabits.length > 0) {
      text += "\n*Habits:*\n";
      for (const h of undoneHabits) {
        text += `  ⬜ ${h.name}\n`;
        kb.text(`✅ ${h.name}`, `habit:${h.id}`).row();
      }
    }
    if (!adhkar.morning) {
      kb.text("✅ Morning Adhkar", "adhkar:morning").row();
    }

    if (urgentTasks.length > 0 || undoneHabits.length > 0) {
      sendMessage(bot, chatId, text, kb);
    }
  } else if (mode === "work") {
    // Work: show in-progress tasks + start work button
    const inProgress = tasks.filter((t: any) => t.status === "in_progress").slice(0, 3);
    const urgent = tasks.filter((t: any) => t.priority === "urgent" && t.status === "pending").slice(0, 2);
    const workTasks = [...inProgress, ...urgent].slice(0, 4);

    if (workTasks.length === 0) return;

    let text = "💻 *Work Focus:*\n\n";
    const kb = new InlineKeyboard();

    for (const t of workTasks) {
      const flag = t.status === "in_progress" ? "▶️" : "🔴";
      text += `  ${flag} #${t.id} ${t.title}\n`;
      kb.text(`✅ #${t.id} Done`, `task:${t.id}`).row();
    }

    kb.text("⏱ Start Work", "work:start").row();
    sendMessage(bot, chatId, text, kb);
  } else if (mode === "evening") {
    // Evening: show undone habits + adhkar status
    const undoneHabits = habits.filter((h: any) => !h.done);
    const doneCount = habits.filter((h: any) => h.done).length;

    let text = `🌙 *Evening Check-in:*\n\nHabits: ${doneCount}/${habits.length} done\n\n`;
    const kb = new InlineKeyboard();

    if (undoneHabits.length > 0) {
      text += "*Still pending:*\n";
      for (const h of undoneHabits) {
        text += `  ⬜ ${h.name}\n`;
        kb.text(`✅ ${h.name}`, `habit:${h.id}`).row();
      }
    }
    if (!adhkar.evening) {
      kb.text("✅ Evening Adhkar", "adhkar:evening").row();
    }

    text += "\nTap to check off before bed!";
    sendMessage(bot, chatId, text, kb);
  }
}

async function schedulePrayerReminders(bot: Bot, chatId: string) {
  for (const t of prayerTimers) clearTimeout(t);
  prayerTimers = [];

  const times = await getTodayPrayerTimes();

  const prayers = [
    { name: "Fajr", time: times.fajr, emoji: "🌅", msg: "وقت صلاة الفجر. قم وصلِّ! The best way to start your day." },
    { name: "Dhuhr", time: times.dhuhr, emoji: "☀️", msg: "وقت صلاة الظهر. Take a break and pray." },
    { name: "Asr", time: times.asr, emoji: "🌤", msg: "وقت صلاة العصر. Don't let work make you miss it!" },
    { name: "Maghrib", time: times.maghrib, emoji: "🌅", msg: "وقت صلاة المغرب. Pray on time." },
    { name: "Isha", time: times.isha, emoji: "🌙", msg: "وقت صلاة العشاء. End your day right." },
  ];

  for (const prayer of prayers) {
    const ms = msUntilTime(prayer.time);
    if (ms > 0) {
      prayerTimers.push(setTimeout(() => {
        pushReminder("prayer", prayer.name, prayer.name);
        sendMessage(bot, chatId, `${prayer.emoji} *${prayer.name} — ${prayer.time}*\n\n${prayer.msg}`);
      }, ms));
    }
  }

  // Morning adhkar — 30 min after Fajr
  const fajrMs = msUntilTime(times.fajr);
  const morningAdhkarMs = fajrMs + 30 * 60000;
  if (morningAdhkarMs > 0) {
    prayerTimers.push(setTimeout(() => {
      const kb = new InlineKeyboard()
        .text("✅ Done Morning Adhkar", "adhkar:morning")
        .text("✅ Done Quran", "habit:4");
      pushReminder("adhkar", "morning", "Morning");
      sendMessage(bot, chatId, "🤲 *Morning Adhkar Reminder*\n\nTime for morning adhkar and Quran!", kb);
    }, morningAdhkarMs));
  }

  // Evening adhkar — 30 min before Maghrib
  const maghribMs = msUntilTime(times.maghrib);
  const eveningAdhkarMs = maghribMs - 30 * 60000;
  if (eveningAdhkarMs > 0) {
    prayerTimers.push(setTimeout(() => {
      const kb = new InlineKeyboard()
        .text("✅ Done Evening Adhkar", "adhkar:evening");
      pushReminder("adhkar", "evening", "Evening");
      sendMessage(bot, chatId, "🤲 *Evening Adhkar Reminder*\n\nTime for evening adhkar before Maghrib.", kb);
    }, eveningAdhkarMs));
  }

  // After each prayer — post-prayer adhkar button + journal reminder
  const journalPrompts: Record<string, string> = {
    Fajr: "What are you grateful for this morning? What do you want to accomplish today?",
    Dhuhr: "How is your morning going? What did you get done so far?",
    Asr: "Quick check-in — how are you feeling? Any wins or struggles?",
    Maghrib: "What happened today? Any lessons or thoughts worth noting?",
    Isha: "End of day — how was it overall? What will you do better tomorrow?",
  };

  for (const prayer of prayers) {
    const afterPrayerMs = msUntilTime(prayer.time) + 15 * 60000; // 15 min after adhan
    if (afterPrayerMs > 0 && prayer.name !== "Fajr") { // Fajr handled by morning adhkar
      prayerTimers.push(setTimeout(() => {
        const kb = new InlineKeyboard()
          .text("✅ Post-Prayer Adhkar", "adhkar:post_prayer");
        pushReminder("adhkar", `post-${prayer.name}`, "Post-prayer");
        sendMessage(bot, chatId, `🤲 Did you pray *${prayer.name}*? Don't forget post-prayer adhkar.`, kb);
      }, afterPrayerMs));
    }

    // Journal reminder — 20 min after each prayer
    const journalMs = msUntilTime(prayer.time) + 20 * 60000;
    if (journalMs > 0) {
      prayerTimers.push(setTimeout(() => {
        const prompt = journalPrompts[prayer.name] || "Quick journal — what's on your mind?";
        try { setJournalPromptTime(); } catch {}
        pushReminder("journal", prayer.name, prayer.name);
        sendMessage(bot, chatId,
          `*Post-${prayer.name} Journal*\n\n${prompt}\n\n_Just reply with your thoughts — I'll save it as a journal entry._`
        );
      }, journalMs));
    }
  }

  // Morning tasks digest — at Fajr + 45 min (after adhkar)
  const morningTasksMs = fajrMs + 45 * 60000;
  if (morningTasksMs > 0) {
    prayerTimers.push(setTimeout(() => {
      sendSmartTaskDigest(bot, chatId, "morning");
    }, morningTasksMs));
  }

  // After Dhuhr — work tasks reminder
  const dhuhrMs = msUntilTime(times.dhuhr) + 20 * 60000;
  if (dhuhrMs > 0) {
    prayerTimers.push(setTimeout(() => {
      sendSmartTaskDigest(bot, chatId, "work");
    }, dhuhrMs));
  }

  // After Isha — evening habits check
  const ishaMs = msUntilTime(times.isha) + 30 * 60000;
  if (ishaMs > 0) {
    prayerTimers.push(setTimeout(() => {
      sendSmartTaskDigest(bot, chatId, "evening");
    }, ishaMs));
  }

  // Friday Jumu'ah — 1 hour before Dhuhr
  if (new Date().getDay() === 5) {
    const jumuahMs = msUntilTime(times.dhuhr) - 60 * 60000;
    if (jumuahMs > 0) {
      prayerTimers.push(setTimeout(() => {
        pushReminder("deen", "jumuah", "Jumu'ah");
        sendMessage(bot, chatId,
          "🕌 *Jumu'ah Reminder*\n\n" +
          "اللهم صل وسلم على نبينا محمد\n\n" +
          "Don't forget:\n• Ghusl\n• Surah Al-Kahf\n• Extra du'a\n• Go early to the masjid"
        );
      }, jumuahMs));
    }
  }

  console.log(`Prayer reminders set: ${Object.entries(times).map(([k, v]) => `${k}=${v}`).join(", ")}`);
}

export function startScheduler(bot: Bot, generateBriefing: () => Promise<string>, generateReview: () => Promise<string>): void {
  const chatId = process.env.TELEGRAM_USER_ID!;

  // Set up today's prayer reminders immediately
  schedulePrayerReminders(bot, chatId);

  // Midnight: re-fetch prayer times + set next day's reminders
  cron.schedule("0 0 * * *", async () => {
    console.log("Midnight: refreshing prayer times...");
    await schedulePrayerReminders(bot, chatId);
    await prefetchTomorrow();
  });

  // Morning briefing — 5:30 AM
  cron.schedule("30 5 * * *", async () => {
    try {
      const briefing = await generateBriefing();
      await sendMessage(bot, chatId, `🌅 *Morning Briefing*\n\n${briefing}`);
      const promiseSummary = formatPromiseSummary();
      if (promiseSummary) {
        await bot.api.sendMessage(chatId, promiseSummary, { parse_mode: "Markdown" });
      }
    } catch (err) {
      console.error("Morning briefing error:", err);
    }
  });

  // WhatsApp overnight summary — 5:45 AM
  cron.schedule("45 5 * * *", async () => {
    try {
      const waSummary = await generateMorningSummary();
      if (waSummary && waSummary.length > 10) {
        await sendMessage(bot, chatId, `*WhatsApp Overnight Summary*\n\n${waSummary}`);
      }
    } catch (err) {
      console.error("WhatsApp morning summary error:", err);
    }
  });

  // Midday check-in and break reminders replaced by Smart Coach (coach.ts)

  // Evening review — 9:00 PM
  cron.schedule("0 21 * * *", async () => {
    try {
      const review = await generateReview();
      await sendMessage(bot, chatId, `🌙 *Evening Review*\n\n${review}`);
    } catch (err) {
      console.error("Evening review error:", err);
    }
  });

  // Deadline warning — 9 AM
  cron.schedule("0 9 * * *", async () => {
    try {
      const deadlines = getUpcomingDeadlines(3) as any[];
      if (deadlines.length > 0) {
        const lines = deadlines.map((p: any) => `⚠️ *${p.name}*${p.client_name ? ` (${p.client_name})` : ""} — due ${p.deadline}`);
        await sendMessage(bot, chatId, `🔔 *Upcoming Deadlines:*\n\n${lines.join("\n")}`);
      }
    } catch (err) {
      console.error("Deadline warning error:", err);
    }
  });

  // M5.4: Monthly expense vs income overspend alert — 9 AM daily
  cron.schedule("0 9 * * *", async () => {
    try {
      const today = localToday();
      if (expenseAlertSentDays.has(today)) return;

      const now = new Date();
      const mStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
      const totalExpense = getExpenseTotal(mStart, today);
      const incomeSummary = getIncomeSummary(mStart, today);
      const totalIncome = incomeSummary.reduce((sum: number, r: { total: number }) => sum + r.total, 0);

      if (totalIncome <= 0) return; // skip silently — no income means no ratio

      const ratio = totalExpense / totalIncome;
      const pct = Math.round(ratio * 100);
      const expFmt = `${Math.round(totalExpense)} MAD`;
      const incFmt = `${Math.round(totalIncome)} MAD`;

      if (ratio > 1.0) {
        await sendMessage(
          bot,
          chatId,
          `🚨 *Overspending*\n\n${expFmt} spent vs ${incFmt} earned this month (${pct}%).\nYou are over budget — pause non-essential expenses now.`
        );
        expenseAlertSentDays.add(today);
      } else if (ratio > 0.8) {
        await sendMessage(
          bot,
          chatId,
          `⚠️ *Spending alert*\n\n${pct}% of this month's income spent (${expFmt} of ${incFmt}).\nSlow down on discretionary spending.`
        );
        expenseAlertSentDays.add(today);
      }
    } catch (err) {
      console.error("Expense alert error:", err);
    }
  });

  // Weekly report — Sunday 8 PM
  cron.schedule("0 20 * * 0", async () => {
    try {
      const report = await generateWeeklyReport();
      await sendMessage(bot, chatId, `📊 *Weekly Report*\n\n${report}`);
    } catch (err) {
      console.error("Weekly report error:", err);
    }
  });

  // Client follow-up alerts — 10:00 AM
  cron.schedule("0 10 * * *", async () => {
    try {
      const clients = getClientLastContact();
      const overdue = clients.filter(c => c.days_ago >= 5);
      if (overdue.length > 0) {
        const lines = overdue.map(c => {
          const urgency = c.days_ago >= 7 ? "🔴" : "🟡";
          return `${urgency} *${c.client_name}* — ${c.days_ago} days since last contact`;
        });
        await sendMessage(bot, chatId, `👤 *Client Follow-up Needed*\n\n${lines.join("\n")}\n\n_Contact them today!_`);
      }
    } catch (err) {
      console.error("Client followup error:", err);
    }
  });

  // Daily AI Digest — 8:00 AM (after morning routine)
  cron.schedule("0 8 * * *", async () => {
    try {
      const digest = await generateAIDigest();
      if (digest && digest.length > 30) {
        await sendMessage(bot, chatId, digest);
      }
    } catch (err) {
      console.error("AI digest error:", err);
    }
  });

  // Cleanup — Sunday 3 AM
  cron.schedule("0 3 * * 0", () => {
    clearOldConversations(7);
    console.log("Cleared old conversations.");
  });

  cron.schedule("*/15 6-22 * * *", () => {
    checkIdleSessions();
  });

  // Proactive checks — every 15 min during waking hours
  cron.schedule("*/15 7-22 * * *", async () => {
    try {
      const { runProactiveChecks } = await import("./proactive");
      await runProactiveChecks(bot, chatId);
    } catch (err) {
      console.error("Proactive check error:", err);
    }
  });

  // SaaS momentum — Sunday 10 AM
  cron.schedule("0 10 * * 0", async () => {
    try {
      const { checkSaaSMomentum } = await import("./proactive");
      await checkSaaSMomentum(bot, chatId);
    } catch (err) {
      console.error("SaaS momentum check error:", err);
    }
  });

  cron.schedule("0 0 * * *", () => {
    updatePromiseStatuses();
  });

  // The daily per-project "health check" was removed 2026-09-18: it asked a tool-less model about
  // build errors it could not see, one call per project, and only console.logged the guess.

  console.log("Scheduler started with dynamic prayer times.");
}
