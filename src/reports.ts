import Anthropic from "@anthropic-ai/sdk";
import * as db from "./db";
import { getFinancialContext } from "./finance";
import { getDeenContext } from "./quran";
import type { WeeklyReportData } from "./types";
import { localNow, localToday } from "./utils";
import { currency, shopOn, prayerOn, ownerName, ownerProfile, languageRule } from "./profile";

// Through the proxy gateway (Max subscription) like the rest of Tokyo, not the paid API key.
const anthropic = new Anthropic({
  apiKey: process.env.CLIPROXY_API_KEY || process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.CLIPROXY_API_KEY ? "http://localhost:8317" : undefined,
});

function getWeekRange(): { start: string; end: string } {
  const now = localNow();
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1; // Monday as start
  const start = new Date(now);
  start.setDate(now.getDate() - diff - 7); // Last week Monday
  const end = new Date(start);
  end.setDate(start.getDate() + 6); // Last week Sunday
  return { start: start.toISOString().split("T")[0], end: end.toISOString().split("T")[0] };
}

function getMonthRange(): { start: string; end: string } {
  const now = localNow();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const end = localToday();
  return { start, end };
}

function gatherData(startDate: string, endDate: string): WeeklyReportData {
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
  const shopSummary = db.getShopSalesSummary(startDate, endDate);

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
    shopRevenue: shopSummary.total || 0,
    totalIncome: devIncome + (shopSummary.total || 0),
  };
}

async function generateReport(data: WeeklyReportData, period: string, startDate: string, endDate: string): Promise<string> {
  const prayer = prayerOn();
  const prompt = `Generate a ${period} life report for ${ownerName()}.

${ownerProfile()}

Period: ${startDate} to ${endDate}

DATA:
- Tasks completed: ${data.tasksCompleted} (${Object.entries(data.tasksByCategory).map(([k, v]) => `${k}: ${v}`).join(", ") || "none"})
- Work hours: ${Math.round(data.totalWorkMinutes / 60)}h (${Object.entries(data.workByType).map(([k, v]) => `${k}: ${Math.round(v / 60)}h`).join(", ") || "none tracked"})
- Habits: ${data.habitsCompleted}/${data.habitsTotal} completed
${prayer ? `- Quran: ${data.quranPages} pages read\n- Adhkar: morning ${data.adhkarDays.morning} days, evening ${data.adhkarDays.evening} days\n` : ""}- Work income: ${data.devIncome} ${currency()}
${shopOn() ? `- Shop revenue: ${data.shopRevenue} ${currency()}\n` : ""}- Total: ${data.totalIncome} ${currency()}

Give scores 1-10 for: Productivity, ${prayer ? "Deen, Work-Life-Deen Balance" : "Work-Life Balance"}.
Include: top 3 wins, top 3 priorities for next ${period === "weekly" ? "week" : "month"}, ${prayer ? "one Islamic motivational reminder" : "one short motivational line"}.
Keep it concise but meaningful.${prayer ? " Use some Arabic Islamic phrases naturally (bismillah, alhamdulillah, etc)." : ""} ${languageRule()}
Format for Telegram (Markdown).`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });

  return (response.content[0] as any).text;
}

export async function generateWeeklyReport(): Promise<string> {
  const { start, end } = getWeekRange();
  const data = gatherData(start, end);
  const report = await generateReport(data, "weekly", start, end);

  db.saveWeeklyReport(start, end, report, {
    totalIncome: data.totalIncome,
  });

  return report;
}

export async function generateMonthlyReport(): Promise<string> {
  const { start, end } = getMonthRange();
  const data = gatherData(start, end);
  return generateReport(data, "monthly", start, end);
}

export function registerReportCommands(bot: any): void {
  bot.command("weekly", async (ctx: any) => {
    await ctx.reply("Generating weekly report... 📊");
    try {
      const report = await generateWeeklyReport();
      const chunks = splitMessage(report);
      for (const chunk of chunks) {
        await ctx.reply(chunk, { parse_mode: "Markdown" }).catch(() => ctx.reply(chunk));
      }
    } catch (err) {
      console.error("Weekly report error:", err);
      await ctx.reply("Failed to generate report. Try again later.");
    }
  });

  bot.command("monthly", async (ctx: any) => {
    await ctx.reply("Generating monthly report... 📊");
    try {
      const report = await generateMonthlyReport();
      const chunks = splitMessage(report);
      for (const chunk of chunks) {
        await ctx.reply(chunk, { parse_mode: "Markdown" }).catch(() => ctx.reply(chunk));
      }
    } catch (err) {
      console.error("Monthly report error:", err);
      await ctx.reply("Failed to generate report. Try again later.");
    }
  });
}

function splitMessage(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt === -1) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}
