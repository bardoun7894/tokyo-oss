import { OWNER_PROFILE } from "../../owner-profile";
import type { Agent, AgentContext, AgentResult } from "../types";
import type { AgentEvent } from "../event-bus";

/**
 * Coaching Agent — the owner's inner voice.
 * Proactive coaching, reports, promises, journaling, briefings.
 */
const coachingAgent: Agent = {
  name: "coaching",
  domain: "coaching",
  description: "The owner's inner voice — proactive coaching, reports, promises, journaling, briefings",

  handles: ["prayer:time", "task:completed"],

  keywords: [
    "briefing", "review", "weekly", "journal", "progress",
    "promise", "goal", "report", "coaching", "monthly", "kept", "broke",
  ],

  commands: [
    "briefing", "review", "weekly", "monthly",
    "promises", "kept", "broke", "progress", "journal",
  ],

  actions: ["journal", "client_followups"],

  // ─── System Prompt ───────────────────────────────────────────

  getSystemPromptSection(): string {
    return `You are Tokyo — a personal life & work management assistant for the owner.

${OWNER_PROFILE}

## Task categories
- "client" — freelance dev projects
- "product" — SaaS/products (SaaS, side projects)
- "shop" — selling work, shop duties, inventory, suppliers
- "learning" — AI, marketing, new tech, Islamic knowledge
- "deen" — religious duties, Quran, Islamic learning
- "admin" — invoices, proposals, server maintenance
- "health" — exercise, meals, sleep, breaks
- "personal" — family, errands, social

## Important behavior
- Morning briefing: start with Fajr/prayer status, then priorities across all 3 roles, deadlines
- Evening review: what got done, work-life-deen balance (1-10), time split dev/shop/learning
- If 10+ hours or skips breaks/prayers, push back firmly
- Track client deadlines separately from product goals
- Help estimate time and set milestones for new projects
- Suggest marketing tips when relevant (beginner level, practical)
- Respond in user's language (Arabic or English)
- Keep messages short and actionable
- When scheduling, check Work Windows — suggest times that don't conflict with prayers

## Journal & Follow-up Actions
- {"type": "journal", "entry": "...", "mood": "great|good|okay|bad|terrible", "energy_level": 1-5, "category": "general|marketing|deen|tech"} — Save a journal entry.
- {"type": "client_followups"} — Show client follow-up status. Use when user asks "client status", "who should I contact", "follow up", "متابعة العملاء".`;
  },

  // ─── Context ─────────────────────────────────────────────────

  async getContextSection(): Promise<string> {
    const db = await import("../../db");
    const { localToday } = await import("../../utils");
    const today = localToday();

    const journals = db.getRecentJournals(3) as any[];
    const journalCtx = journals.length > 0
      ? journals.map((j: any) => `- ${j.mood ? `[${j.mood}] ` : ""}${j.entry.substring(0, 100)}`).join("\n")
      : "No recent entries.";

    // Goals
    let goalsCtx = "No goals set.";
    try {
      const goals = db.getGoals();
      if (goals.length > 0) {
        goalsCtx = goals.map((g: any) => {
          const progress = g.target_value > 0 ? Math.round((g.current_value / g.target_value) * 100) : 0;
          const bar = "\u2588".repeat(Math.floor(progress / 10)) + "\u2591".repeat(10 - Math.floor(progress / 10));
          return `- ${g.title} [${g.metric}]: ${bar} ${progress}% (${g.current_value}/${g.target_value}, ${g.period})`;
        }).join("\n");
      }
    } catch { /* no goals data */ }

    // Promises summary
    let promiseCtx = "";
    try {
      const { formatPromiseSummary } = await import("../../promises");
      promiseCtx = formatPromiseSummary();
    } catch { /* no promise data */ }

    // Last weekly report
    let reportCtx = "No weekly reports yet.";
    try {
      const report = db.getLatestWeeklyReport() as any;
      if (report) {
        reportCtx = `Week ${report.week_start} to ${report.week_end}:\nProductivity: ${report.productivity_score}/10 | Deen: ${report.deen_score}/10 | Balance: ${report.balance_score}/10\nIncome: ${report.total_income} DH\n\n${report.report_text.slice(0, 300)}...`;
      }
    } catch { /* no report data */ }

    // Recent progress
    let progressCtx = "No progress data available.";
    try {
      const now = new Date();
      const day = now.getDay();
      const diff = day === 0 ? 6 : day - 1;
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - diff);
      const startStr = weekStart.toISOString().split("T")[0];
      const progress = db.getProgressData(startStr, today);
      progressCtx = `Tasks: ${progress.tasks.completed} done / ${progress.tasks.created} created
Work: ${progress.work.totalHours}h (${Object.entries(progress.work.byType).map(([k, v]) => `${k}: ${v}h`).join(", ") || "none"})
Habits: ${progress.habits.rate}% completion
Quran: ${progress.deen.quranPages} pages (${progress.deen.quranDays} days)
Journal: ${progress.journal.entries} entries`;
    } catch { /* no progress data */ }

    // Client follow-ups
    let clientCtx = "No active clients.";
    try {
      const clients = db.getClientLastContact();
      if (clients.length > 0) {
        clientCtx = clients.map((c: any) => {
          const icon = c.days_ago >= 7 ? "\uD83D\uDD34" : c.days_ago >= 3 ? "\uD83D\uDFE1" : "\uD83D\uDFE2";
          return `${icon} ${c.client_name}: last contact ${c.days_ago} days ago (${c.last_contact})`;
        }).join("\n");
      }
    } catch { /* no client data */ }

    return `### Recent Journal
${journalCtx}

### Goals
${goalsCtx}

### Promises
${promiseCtx || "No active promises."}

### Last Weekly Report
${reportCtx}

### Recent Progress (This Week)
${progressCtx}

### Client Follow-ups
${clientCtx}`;
  },

  // ─── Commands ────────────────────────────────────────────────

  async handleCommand(command: string, args: string, ctx: AgentContext): Promise<AgentResult> {
    switch (command) {
      case "briefing": {
        await ctx.sendMessage("Generating morning briefing... \u2615");
        try {
          const { generateBriefing } = await import("../../ai");
          const briefing = await generateBriefing("morning");
          return { success: true, output: `\uD83C\uDF05 *Morning Briefing*\n\n${briefing}` };
        } catch (err) {
          console.error("Briefing error:", err);
          return { success: false, output: "Failed to generate briefing. Try again later." };
        }
      }

      case "review": {
        await ctx.sendMessage("Generating evening review... \uD83C\uDF19");
        try {
          const { generateBriefing } = await import("../../ai");
          const review = await generateBriefing("evening");
          return { success: true, output: `\uD83C\uDF19 *Evening Review*\n\n${review}` };
        } catch (err) {
          console.error("Review error:", err);
          return { success: false, output: "Failed to generate review. Try again later." };
        }
      }

      case "weekly": {
        await ctx.sendMessage("Generating weekly report... \uD83D\uDCCA");
        try {
          const { generateWeeklyReport } = await import("../../reports");
          const report = await generateWeeklyReport();
          return { success: true, output: report };
        } catch (err) {
          console.error("Weekly report error:", err);
          return { success: false, output: "Failed to generate report. Try again later." };
        }
      }

      case "monthly": {
        await ctx.sendMessage("Generating monthly report... \uD83D\uDCCA");
        try {
          const { generateMonthlyReport } = await import("../../reports");
          const report = await generateMonthlyReport();
          return { success: true, output: report };
        } catch (err) {
          console.error("Monthly report error:", err);
          return { success: false, output: "Failed to generate report. Try again later." };
        }
      }

      case "promises": {
        const { formatPromisesOutput } = await import("../../promises");
        const output = formatPromisesOutput();
        return { success: true, output };
      }

      case "kept": {
        const id = parseInt(args, 10);
        if (!id) return { success: false, output: "Usage: /kept [promise_id]" };
        const db = await import("../../db");
        db.fulfillPromise(id);
        return { success: true, output: `\u2705 Promise #${id} fulfilled! \u0623\u062D\u0633\u0646\u062A` };
      }

      case "broke": {
        const id = parseInt(args, 10);
        if (!id) return { success: false, output: "Usage: /broke [promise_id]" };
        const db = await import("../../db");
        db.breakPromise(id);
        return { success: true, output: `\u274C Promise #${id} marked as broken. Learn from it.` };
      }

      case "progress": {
        const period = args.trim().toLowerCase() || "week";
        await ctx.sendMessage(`Generating ${period} progress report...`);
        try {
          const db = await import("../../db");
          const { localToday, localNow } = await import("../../utils");
          const today = localToday();
          const now = localNow();
          const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();

          let start: string, end: string, label: string;
          if (period === "month" || period === "\u0634\u0647\u0631") {
            start = new Date(y, m, 1).toISOString().split("T")[0];
            end = today;
            label = `This Month (${start} \u2192 ${end})`;
          } else if (period === "lastweek" || period === "\u0627\u0644\u0623\u0633\u0628\u0648\u0639 \u0627\u0644\u0645\u0627\u0636\u064A") {
            const day = now.getDay();
            const diff = day === 0 ? 6 : day - 1;
            const thisWeekStart = new Date(y, m, d - diff);
            const lastWeekEnd = new Date(thisWeekStart);
            lastWeekEnd.setDate(lastWeekEnd.getDate() - 1);
            const lastWeekStart = new Date(lastWeekEnd);
            lastWeekStart.setDate(lastWeekStart.getDate() - 6);
            start = lastWeekStart.toISOString().split("T")[0];
            end = lastWeekEnd.toISOString().split("T")[0];
            label = `Last Week (${start} \u2192 ${end})`;
          } else if (period === "lastmonth" || period === "\u0627\u0644\u0634\u0647\u0631 \u0627\u0644\u0645\u0627\u0636\u064A") {
            start = new Date(y, m - 1, 1).toISOString().split("T")[0];
            end = new Date(y, m, 0).toISOString().split("T")[0];
            label = `Last Month (${start} \u2192 ${end})`;
          } else if (period === "year" || period === "\u0633\u0646\u0629") {
            start = `${y}-01-01`;
            end = today;
            label = `This Year (${start} \u2192 ${end})`;
          } else {
            // Default: this week
            const day = now.getDay();
            const diff = day === 0 ? 6 : day - 1;
            start = new Date(y, m, d - diff).toISOString().split("T")[0];
            end = today;
            label = `This Week (${start} \u2192 ${end})`;
          }

          const data = db.getProgressData(start, end);
          const lines: string[] = [`\uD83D\uDCCA *Progress Report \u2014 ${label}*\n`];

          lines.push(`\uD83D\uDCCB *Tasks*`);
          lines.push(`  Completed: ${data.tasks.completed} | Created: ${data.tasks.created}`);
          if (data.tasks.completed > 0) {
            const cats = Object.entries(data.tasks.byCategory)
              .sort((a, b) => (b[1] as number) - (a[1] as number))
              .map(([k, v]) => `${k}: ${v}`)
              .join(", ");
            lines.push(`  By category: ${cats}`);
          }
          if (data.tasks.completionRate > 0) {
            lines.push(`  Completion rate: ${data.tasks.completionRate}%`);
          }
          lines.push("");

          lines.push(`\u23F1 *Work*`);
          lines.push(`  Total: ${data.work.totalHours}h across ${data.work.daysWorked} days`);
          if (data.work.daysWorked > 0) {
            lines.push(`  Avg: ${data.work.avgHoursPerWorkDay}h/day`);
          }
          if (Object.keys(data.work.byType).length > 0) {
            const types = Object.entries(data.work.byType).map(([k, v]) => `${k}: ${v}h`).join(", ");
            lines.push(`  By type: ${types}`);
          }
          lines.push("");

          lines.push(`\u2705 *Habits*`);
          lines.push(`  ${data.habits.completed}/${data.habits.total} completions (${data.habits.rate}%)`);
          lines.push("");

          lines.push(`\uD83D\uDD4C *Deen*`);
          lines.push(`  \uD83D\uDCD6 Quran: ${data.deen.quranPages} pages across ${data.deen.quranDays} days (avg ${data.deen.quranAvgPerDay}/day)`);
          lines.push(`  \uD83C\uDF05 Morning adhkar: ${data.deen.adhkarMorning} days`);
          lines.push(`  \uD83C\uDF19 Evening adhkar: ${data.deen.adhkarEvening} days`);
          lines.push("");

          lines.push(`\uD83D\uDCB0 *Finance*`);
          lines.push(`  Dev income: ${data.finance.devIncome} DH`);
          lines.push(`  Shop revenue: ${data.finance.shopRevenue} DH`);
          lines.push(`  Total: ${data.finance.total} DH`);
          if (Object.keys(data.finance.bySource).length > 0) {
            const sources = Object.entries(data.finance.bySource).map(([k, v]) => `${k}: ${v} DH`).join(", ");
            lines.push(`  Breakdown: ${sources}`);
          }
          lines.push("");

          lines.push(`\uD83D\uDCDD *Journal*`);
          lines.push(`  ${data.journal.entries} entries across ${data.journal.daysJournaled} days`);
          if (data.journal.recentMoods.length > 0) {
            const moodMap: Record<string, string> = { great: "\uD83D\uDE04", good: "\uD83D\uDE42", okay: "\uD83D\uDE10", bad: "\uD83D\uDE1E", terrible: "\uD83D\uDE22" };
            const moods = data.journal.recentMoods.map((mm: string) => moodMap[mm] || mm).join(" ");
            lines.push(`  Recent moods: ${moods}`);
          }
          lines.push("");

          if (data.goals.length > 0) {
            lines.push(`\uD83C\uDFAF *Goals*`);
            for (const g of data.goals) {
              const pct = g.target_value > 0 ? Math.round((g.current_value / g.target_value) * 100) : 0;
              const filled = Math.round(pct / 10);
              const empty = 10 - filled;
              const bar = "\u2593".repeat(filled) + "\u2591".repeat(empty) + ` ${pct}%`;
              lines.push(`  ${bar} ${g.title} (${g.current_value}/${g.target_value} ${g.metric})`);
            }
          }

          return { success: true, output: lines.join("\n") };
        } catch (err) {
          console.error("Progress error:", err);
          return { success: false, output: "Failed to generate progress report." };
        }
      }

      case "journal": {
        const db = await import("../../db");
        const entry = args.trim();

        if (!entry) {
          // Show recent journals
          const journals = db.getRecentJournals(10) as any[];
          if (journals.length === 0) {
            return { success: true, output: "\uD83D\uDCDD No journal entries yet.\n\n/journal [your thoughts] to write one." };
          }
          const lines: string[] = ["\uD83D\uDCDD *Recent Journal Entries*\n"];
          for (const j of journals) {
            const date = j.logged_at?.split("T")[0] || j.logged_at?.split(" ")[0] || "?";
            const mood = j.mood ? ` [${j.mood}]` : "";
            const energy = j.energy_level ? ` \u26A1${j.energy_level}` : "";
            lines.push(`*${date}*${mood}${energy}`);
            lines.push(`  ${j.entry.substring(0, 200)}`);
            lines.push("");
          }
          lines.push("_/journal [your thoughts] to add new entry_");
          return { success: true, output: lines.join("\n") };
        }

        // Add journal entry
        db.addJournalEntry(entry);
        return {
          success: true,
          output: `\uD83D\uDCDD Journal entry saved!\n\n_"${entry.substring(0, 100)}${entry.length > 100 ? "..." : ""}"_`,
        };
      }

      default:
        return { success: false, output: `Unknown coaching command: ${command}` };
    }
  },

  // ─── Events ──────────────────────────────────────────────────

  async handleEvent(event: AgentEvent, ctx: AgentContext): Promise<AgentResult> {
    switch (event.type) {
      case "prayer:time": {
        // Post-prayer coaching nudge (gentle reminder to use the time well)
        const prayerName = event.data.prayer || "prayer";
        try {
          const { generateCoaching } = await import("../../ai");
          const coaching = await generateCoaching(
            `The owner just finished ${prayerName} prayer. Give a short, encouraging post-prayer coaching nudge. Suggest what to work on next based on context. 2-3 sentences max.`
          );
          if (coaching) {
            return { success: true, output: coaching };
          }
        } catch (err) {
          console.error("Post-prayer coaching error:", err);
        }
        return { success: true, output: "", silent: true };
      }

      case "task:completed": {
        const taskTitle = event.data.title || "task";
        return {
          success: true,
          output: `\u2705 *${taskTitle}* done! \u0623\u062D\u0633\u0646\u062A \u2014 keep the momentum going.`,
        };
      }

      default:
        return { success: true, output: "", silent: true };
    }
  },

  // ─── Actions ─────────────────────────────────────────────────

  async handleAction(action: Record<string, any>, ctx: AgentContext): Promise<string | void> {
    const db = await import("../../db");

    switch (action.type) {
      case "journal": {
        db.addJournalEntry(action.entry, action.mood, action.energy_level, action.category);
        return undefined; // Default behavior (no special return, AI confirms)
      }

      case "client_followups": {
        const clients = db.getClientLastContact();
        if (clients.length === 0) return `\n\uD83D\uDC64 No active clients.`;
        const lines = clients.map((c: any) => {
          const urgency = c.days_ago >= 7 ? "\uD83D\uDD34" : c.days_ago >= 3 ? "\uD83D\uDFE1" : "\uD83D\uDFE2";
          return `${urgency} *${c.client_name}* \u2014 last contact: ${c.last_contact} (${c.days_ago} days ago)`;
        });
        return `\n\uD83D\uDC64 *Client Follow-ups*\n\n${lines.join("\n")}`;
      }

      default:
        return undefined;
    }
  },

  // ─── Schedule ────────────────────────────────────────────────

  // No registerSchedule: scheduler.ts already runs these jobs (briefing, review, deadlines,
  // expense alert, follow-ups, weekly report, cleanup, proactive checks, SaaS momentum).
  // Registering them here too sent every one of them twice. Removed 2026-09-18.
};

export default coachingAgent;
