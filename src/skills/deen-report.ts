import type { Skill } from "./types";
import { localToday } from "../utils";

const skill: Skill = {
  name: "deen-report",
  description: "Islamic practice report: Quran progress, adhkar, habit streaks",
  category: "deen",
  args: [
    { name: "period", type: "string", description: "week, month, or year (default: week)", required: false, default: "week" },
  ],
  async execute(ctx, args) {
    await ctx.sendUpdate("Gathering deen data...");

    const period = args.period || "week";
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    let start: string, end: string;

    if (period === "month") {
      start = new Date(y, m, 1).toISOString().split("T")[0];
      end = localToday();
    } else if (period === "year") {
      start = `${y}-01-01`;
      end = localToday();
    } else {
      const day = now.getDay();
      const diff = day === 0 ? 6 : day - 1;
      start = new Date(y, m, d - diff).toISOString().split("T")[0];
      end = localToday();
    }

    const progress = ctx.db.getProgressData(start, end);
    const habits = ctx.db.getHabitLogsForDate(localToday()) as any[];
    const deenHabits = habits.filter((h: any) => h.category === "deen");

    // Calculate days in period
    const daysDiff = Math.ceil((new Date(end).getTime() - new Date(start).getTime()) / 86400000) + 1;

    const quranPages = progress.deen.quranPages;
    const quranDays = progress.deen.quranDays;
    const quranRate = daysDiff > 0 ? Math.round((quranDays / daysDiff) * 100) : 0;
    const pagesPerDay = quranDays > 0 ? (quranPages / quranDays).toFixed(1) : "0";

    // Generate AI encouragement
    const response = await ctx.ai.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 500,
      messages: [{
        role: "user",
        content: `Give a short (3-4 sentences), encouraging Islamic summary of this deen progress. Be warm but honest. Use Islamic phrases.

Period: ${period} (${start} to ${end}, ${daysDiff} days)
Quran: ${quranPages} pages read on ${quranDays} out of ${daysDiff} days (${pagesPerDay} pages/day average)
Adhkar: morning done ${progress.deen.adhkarMorning || 0} days, evening done ${progress.deen.adhkarEvening || 0} days
Deen habits today: ${deenHabits.map((h: any) => `${h.name}: ${h.done ? "done" : "not yet"}`).join(", ") || "none tracked"}

At this pace, Quran khatma (604 pages) would take: ${quranPages > 0 ? Math.ceil(604 / (quranPages / daysDiff)) : "∞"} days`,
      }],
    });

    const encouragement = (response.content[0] as any).text;

    const report = `*Deen Report — ${period.charAt(0).toUpperCase() + period.slice(1)} (${start} to ${end})*

*Quran*
Pages: ${quranPages} (${pagesPerDay} pages/day avg)
Days read: ${quranDays}/${daysDiff} (${quranRate}%)
Khatma pace: ${quranPages > 0 ? Math.ceil(604 / (quranPages / daysDiff)) + " days" : "N/A"}

*Adhkar*
Morning: ${progress.deen.adhkarMorning || 0}/${daysDiff} days
Evening: ${progress.deen.adhkarEvening || 0}/${daysDiff} days

*Today's Deen Habits*
${deenHabits.length > 0 ? deenHabits.map((h: any) => `${h.done ? "+" : "-"} ${h.name}`).join("\n") : "No deen habits tracked"}

---
${encouragement}`;

    return { success: true, output: report };
  },
};

export default skill;
