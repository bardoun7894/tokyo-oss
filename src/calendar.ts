import * as db from "./db";
import { generateBriefing } from "./ai";
import Anthropic from "@anthropic-ai/sdk";
import { localToday, localNow } from "./utils";

const anthropic = new Anthropic({
  apiKey: process.env.CLIPROXY_API_KEY || process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.CLIPROXY_API_KEY ? "http://localhost:8317" : undefined,
});

function todayStr(): string {
  return localToday();
}

function parseDate(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  const today = localNow();

  if (!trimmed || trimmed === "today" || trimmed === "اليوم") {
    return todayStr();
  }
  if (trimmed === "yesterday" || trimmed === "أمس" || trimmed === "البارحة") {
    today.setDate(today.getDate() - 1);
    return today.toISOString().split("T")[0];
  }
  // Match YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  // Match relative: -3 or -3d (3 days ago)
  const relMatch = trimmed.match(/^-(\d+)d?$/);
  if (relMatch) {
    today.setDate(today.getDate() - parseInt(relMatch[1]));
    return today.toISOString().split("T")[0];
  }
  return null;
}

function getPeriodRange(period: string): { start: string; end: string; label: string } {
  const now = localNow();
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();

  if (period === "week" || period === "أسبوع") {
    const day = now.getDay();
    const diff = day === 0 ? 6 : day - 1;
    const start = new Date(y, m, d - diff);
    return {
      start: start.toISOString().split("T")[0],
      end: todayStr(),
      label: `This Week (${start.toISOString().split("T")[0]} → ${todayStr()})`,
    };
  }
  if (period === "lastweek" || period === "الأسبوع الماضي") {
    const day = now.getDay();
    const diff = day === 0 ? 6 : day - 1;
    const thisWeekStart = new Date(y, m, d - diff);
    const lastWeekEnd = new Date(thisWeekStart);
    lastWeekEnd.setDate(lastWeekEnd.getDate() - 1);
    const lastWeekStart = new Date(lastWeekEnd);
    lastWeekStart.setDate(lastWeekStart.getDate() - 6);
    return {
      start: lastWeekStart.toISOString().split("T")[0],
      end: lastWeekEnd.toISOString().split("T")[0],
      label: `Last Week (${lastWeekStart.toISOString().split("T")[0]} → ${lastWeekEnd.toISOString().split("T")[0]})`,
    };
  }
  if (period === "month" || period === "شهر") {
    const start = new Date(y, m, 1);
    return {
      start: start.toISOString().split("T")[0],
      end: todayStr(),
      label: `This Month (${start.toISOString().split("T")[0]} → ${todayStr()})`,
    };
  }
  if (period === "lastmonth" || period === "الشهر الماضي") {
    const start = new Date(y, m - 1, 1);
    const end = new Date(y, m, 0);
    return {
      start: start.toISOString().split("T")[0],
      end: end.toISOString().split("T")[0],
      label: `Last Month (${start.toISOString().split("T")[0]} → ${end.toISOString().split("T")[0]})`,
    };
  }
  if (period === "year" || period === "سنة") {
    return {
      start: `${y}-01-01`,
      end: todayStr(),
      label: `This Year (${y}-01-01 → ${todayStr()})`,
    };
  }
  // Default: this week
  return getPeriodRange("week");
}

function formatDailyCalendar(data: ReturnType<typeof db.getDailyActivity>): string {
  const dayName = new Date(data.date).toLocaleDateString("en-US", { weekday: "long" });
  const lines: string[] = [`📅 *${dayName}, ${data.date}*\n`];

  // Schedule
  if (data.schedule.length > 0) {
    lines.push("🕐 *Schedule*");
    for (const s of data.schedule as any[]) {
      lines.push(`  ${s.time} — ${s.title}${s.recurring ? " 🔁" : ""}`);
    }
    lines.push("");
  }

  // Tasks completed
  if (data.tasksCompleted.length > 0) {
    lines.push(`✅ *Tasks Completed (${data.tasksCompleted.length})*`);
    for (const t of data.tasksCompleted as any[]) {
      lines.push(`  ✓ #${t.id} ${t.title} [${t.category}]`);
    }
    lines.push("");
  }

  // Tasks created
  if (data.tasksCreated.length > 0) {
    const newOnly = (data.tasksCreated as any[]).filter(
      (t: any) => !data.tasksCompleted.some((c: any) => c.id === t.id)
    );
    if (newOnly.length > 0) {
      lines.push(`📋 *Tasks Created (${newOnly.length})*`);
      for (const t of newOnly) {
        lines.push(`  + #${t.id} ${t.title} [${t.status}]`);
      }
      lines.push("");
    }
  }

  // Work
  if (data.work.totalMinutes > 0) {
    const h = Math.floor(data.work.totalMinutes / 60);
    const m = data.work.totalMinutes % 60;
    const byType = Object.entries(data.work.byType)
      .map(([t, mins]) => `${t}: ${Math.floor(mins / 60)}h${mins % 60}m`)
      .join(", ");
    lines.push(`⏱ *Work: ${h}h${m}m*${byType ? ` (${byType})` : ""}`);
    if (data.work.breakMinutes > 0) {
      lines.push(`  ☕ Breaks: ${Math.floor(data.work.breakMinutes / 60)}h${data.work.breakMinutes % 60}m`);
    }
    lines.push("");
  }

  // Habits
  const habitsDone = (data.habits as any[]).filter((h: any) => h.done);
  const habitsTotal = data.habits.length;
  if (habitsTotal > 0) {
    lines.push(`✅ *Habits: ${habitsDone.length}/${habitsTotal}*`);
    for (const h of data.habits as any[]) {
      lines.push(`  ${h.done ? "✅" : "⬜"} ${h.name}`);
    }
    lines.push("");
  }

  // Deen
  const deenItems: string[] = [];
  if (data.quranPages > 0) deenItems.push(`📖 Quran: ${data.quranPages} pages`);
  if (data.adhkar.morning) deenItems.push("🌅 Morning adhkar ✓");
  if (data.adhkar.evening) deenItems.push("🌙 Evening adhkar ✓");
  if (deenItems.length > 0) {
    lines.push("🕌 *Deen*");
    for (const item of deenItems) lines.push(`  ${item}`);
    lines.push("");
  }

  // Finance
  if (data.income.length > 0 || data.shopSales.length > 0) {
    lines.push("💰 *Finance*");
    for (const inc of data.income as any[]) {
      lines.push(`  +${inc.amount} ${inc.currency || "DH"} (${inc.source}${inc.description ? ": " + inc.description : ""})`);
    }
    for (const sale of data.shopSales as any[]) {
      lines.push(`  🏪 Shop: ${sale.total_revenue} DH${sale.items_sold ? ` (${sale.items_sold} items)` : ""}`);
    }
    lines.push("");
  }

  // Journal entries
  if (data.journals.length > 0) {
    lines.push("📝 *Journal*");
    for (const j of data.journals as any[]) {
      const mood = j.mood ? ` [${j.mood}]` : "";
      const energy = j.energy_level ? ` ⚡${j.energy_level}/5` : "";
      lines.push(`  ${mood}${energy} ${j.entry.substring(0, 150)}`);
    }
    lines.push("");
  }

  // Empty day
  if (lines.length <= 1) {
    lines.push("_No activity recorded for this day._");
  }

  return lines.join("\n");
}

function formatProgress(data: ReturnType<typeof db.getProgressData>, label: string): string {
  const lines: string[] = [`📊 *Progress Report — ${label}*\n`];
  const p = data.period;

  // Tasks
  lines.push(`📋 *Tasks*`);
  lines.push(`  Completed: ${data.tasks.completed} | Created: ${data.tasks.created}`);
  if (data.tasks.completed > 0) {
    const cats = Object.entries(data.tasks.byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    lines.push(`  By category: ${cats}`);
  }
  if (data.tasks.completionRate > 0) {
    lines.push(`  Completion rate: ${data.tasks.completionRate}%`);
  }
  lines.push("");

  // Work
  lines.push(`⏱ *Work*`);
  lines.push(`  Total: ${data.work.totalHours}h across ${data.work.daysWorked} days`);
  if (data.work.daysWorked > 0) {
    lines.push(`  Avg: ${data.work.avgHoursPerWorkDay}h/day`);
  }
  if (Object.keys(data.work.byType).length > 0) {
    const types = Object.entries(data.work.byType)
      .map(([k, v]) => `${k}: ${v}h`)
      .join(", ");
    lines.push(`  By type: ${types}`);
  }
  lines.push("");

  // Habits
  lines.push(`✅ *Habits*`);
  lines.push(`  ${data.habits.completed}/${data.habits.total} completions (${data.habits.rate}%)`);
  lines.push("");

  // Deen
  lines.push(`🕌 *Deen*`);
  lines.push(`  📖 Quran: ${data.deen.quranPages} pages across ${data.deen.quranDays} days (avg ${data.deen.quranAvgPerDay}/day)`);
  lines.push(`  🌅 Morning adhkar: ${data.deen.adhkarMorning} days`);
  lines.push(`  🌙 Evening adhkar: ${data.deen.adhkarEvening} days`);
  lines.push("");

  // Finance
  lines.push(`💰 *Finance*`);
  lines.push(`  Dev income: ${data.finance.devIncome} DH`);
  lines.push(`  Shop revenue: ${data.finance.shopRevenue} DH`);
  lines.push(`  Total: ${data.finance.total} DH`);
  if (Object.keys(data.finance.bySource).length > 0) {
    const sources = Object.entries(data.finance.bySource)
      .map(([k, v]) => `${k}: ${v} DH`)
      .join(", ");
    lines.push(`  Breakdown: ${sources}`);
  }
  lines.push("");

  // Journal
  lines.push(`📝 *Journal*`);
  lines.push(`  ${data.journal.entries} entries across ${data.journal.daysJournaled} days`);
  if (data.journal.recentMoods.length > 0) {
    const moodMap: Record<string, string> = { great: "😄", good: "🙂", okay: "😐", bad: "😞", terrible: "😢" };
    const moods = data.journal.recentMoods.map((m: string) => moodMap[m] || m).join(" ");
    lines.push(`  Recent moods: ${moods}`);
  }
  lines.push("");

  // Goals
  if (data.goals.length > 0) {
    lines.push(`🎯 *Goals*`);
    for (const g of data.goals) {
      const pct = g.target_value > 0 ? Math.round((g.current_value / g.target_value) * 100) : 0;
      const bar = progressBar(pct);
      lines.push(`  ${bar} ${g.title} (${g.current_value}/${g.target_value} ${g.metric})`);
    }
  }

  return lines.join("\n");
}

function progressBar(pct: number): string {
  const filled = Math.round(pct / 10);
  const empty = 10 - filled;
  return "▓".repeat(filled) + "░".repeat(empty) + ` ${pct}%`;
}

async function generateProgressInsight(data: ReturnType<typeof db.getProgressData>, label: string): Promise<string> {
  const prompt = `Analyze this ${label} progress data and give a SHORT, motivational insight (3-5 sentences). Compare work types, highlight wins, flag concerns. Use Islamic encouragement naturally. Respond in the user's language context (mix Arabic phrases).

Tasks: ${data.tasks.completed} completed, ${data.tasks.created} created
Work: ${data.work.totalHours}h (${Object.entries(data.work.byType).map(([k, v]) => `${k}: ${v}h`).join(", ")})
Habits: ${data.habits.rate}% completion
Quran: ${data.deen.quranPages} pages, ${data.deen.quranDays} days
Adhkar: morning ${data.deen.adhkarMorning}d, evening ${data.deen.adhkarEvening}d
Income: dev ${data.finance.devIncome} DH, shop ${data.finance.shopRevenue} DH
Journal: ${data.journal.entries} entries`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });
    return (response.content[0] as any).text;
  } catch {
    return "";
  }
}

export function registerCalendarCommands(bot: any): void {
  // /cal [date] — View a day's full activity
  bot.command("cal", async (ctx: any) => {
    const input = ctx.match?.trim() || "";
    const date = parseDate(input) || todayStr();

    try {
      const activity = db.getDailyActivity(date);
      const formatted = formatDailyCalendar(activity);
      await sendSplit(ctx, formatted);
    } catch (err) {
      console.error("Calendar error:", err);
      await ctx.reply("Failed to load calendar. Try again.");
    }
  });

  // /week — Quick calendar summary for this week
  bot.command("calweek", async (ctx: any) => {
    try {
      const { start, end, label } = getPeriodRange("week");
      const summaries = db.getDateRangeSummaries(start, end);

      if (summaries.length === 0) {
        await ctx.reply("📅 No activity recorded this week yet.");
        return;
      }

      const lines: string[] = [`📅 *${label}*\n`];
      for (const day of summaries) {
        const dayName = new Date(day.date).toLocaleDateString("en-US", { weekday: "short" });
        const items: string[] = [];
        if (day.tasksCompleted > 0) items.push(`✅${day.tasksCompleted}`);
        if (day.workMinutes > 0) items.push(`⏱${Math.round(day.workMinutes / 60)}h`);
        if (day.habitsCompleted > 0) items.push(`✓${day.habitsCompleted}/${day.habitsTotal}`);
        if (day.quranPages > 0) items.push(`📖${day.quranPages}p`);
        if (day.journalCount > 0) items.push(`📝${day.journalCount}`);
        if (day.income > 0) items.push(`💰${day.income}`);

        lines.push(`*${dayName} ${day.date}* — ${items.join(" | ") || "minimal"}`);
      }

      lines.push(`\n_/cal [date] for details, /progress week for full report_`);
      await sendSplit(ctx, lines.join("\n"));
    } catch (err) {
      console.error("Cal week error:", err);
      await ctx.reply("Failed to load weekly calendar.");
    }
  });

  // /journal [entry] — Quick journal entry or view recent
  bot.command("journal", async (ctx: any) => {
    const entry = ctx.match?.trim();

    if (!entry) {
      // Show recent journals
      const journals = db.getRecentJournals(10) as any[];
      if (journals.length === 0) {
        await ctx.reply("📝 No journal entries yet.\n\n/journal [your thoughts] to write one.");
        return;
      }

      const lines: string[] = ["📝 *Recent Journal Entries*\n"];
      for (const j of journals) {
        const date = j.logged_at?.split("T")[0] || j.logged_at?.split(" ")[0] || "?";
        const mood = j.mood ? ` [${j.mood}]` : "";
        const energy = j.energy_level ? ` ⚡${j.energy_level}` : "";
        lines.push(`*${date}*${mood}${energy}`);
        lines.push(`  ${j.entry.substring(0, 200)}`);
        lines.push("");
      }
      lines.push("_/journal [your thoughts] to add new entry_");
      await sendSplit(ctx, lines.join("\n"));
      return;
    }

    // Add journal entry
    db.addJournalEntry(entry);
    await ctx.reply(`📝 Journal entry saved!\n\n_"${entry.substring(0, 100)}${entry.length > 100 ? "..." : ""}"_`, { parse_mode: "Markdown" });
  });

  // /progress [week|month|year|lastweek|lastmonth] — Progress review
  bot.command("progress", async (ctx: any) => {
    const period = ctx.match?.trim().toLowerCase() || "week";
    const { start, end, label } = getPeriodRange(period);

    await ctx.reply(`Generating ${label} progress report...`);

    try {
      const data = db.getProgressData(start, end);
      const formatted = formatProgress(data, label);

      // Get AI insight
      const insight = await generateProgressInsight(data, label);

      const full = insight
        ? formatted + "\n\n💡 *Insight*\n" + insight
        : formatted;

      await sendSplit(ctx, full);
    } catch (err) {
      console.error("Progress error:", err);
      await ctx.reply("Failed to generate progress report.");
    }
  });
}

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
