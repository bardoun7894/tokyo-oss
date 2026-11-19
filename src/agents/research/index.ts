import type { Agent, AgentContext, AgentResult } from "../types";
import type { AgentEvent } from "../event-bus";
import { currency, shopOn, prayerOn } from "../../profile";

/**
 * Research Agent — the owner's knowledge scout.
 * AI research, Trello, calendar views, learning tracking.
 */
const researchAgent: Agent = {
  name: "research",
  domain: "research",
  description: "The owner's knowledge scout — AI research, Trello, calendar views, learning tracking",

  handles: [],

  keywords: [
    "trending", "news", "youtube", "trello", "board", "card",
    "learning", "digest", "tools", "calendar", "cal", "research",
  ],

  commands: [
    "digest", "trending", "tools", "news", "youtube",
    "trello", "cal", "calweek",
  ],

  actions: [
    "search_trending", "search_news", "search_youtube",
    "trello_boards", "trello_board", "trello_add_card",
    "trello_search", "trello_complete_card", "trello_reopen_card",
    "log_learning", "show_learning",
  ],

  // ─── System Prompt ───────────────────────────────────────────

  getSystemPromptSection(): string {
    return `## Research & Knowledge Actions
- {"type": "search_trending", "topic": "ai|tools"} — Search trending AI repos or AI tools on GitHub. Use when user asks "what's trending", "new AI tools", "trending", "شنو جديد".
- {"type": "search_news", "filter": "optional keyword"} — Search AI/tech news from Hacker News. Use when user asks "AI news", "tech news", "what's new in AI", "أخبار التقنية".
- {"type": "search_youtube", "query": "search terms"} — Search YouTube videos. Use when user asks "find video about X", "youtube tutorial for Y", "ابحث في يوتيوب".
- {"type": "log_learning", "title": "what was learned", "type": "course|book|video|article|tutorial|practice|other", "topic": "AI|marketing|dev|etc", "source": "URL or name", "minutes_spent": number} — Log a learning activity. Use when user says "I learned about RAG", "watched a tutorial", "تعلمت", "قرأت مقال".
- {"type": "show_learning"} — Show recent learning log. Use when user asks "what did I learn", "learning progress", "شنو تعلمت".

## Trello Actions
- {"type": "trello_boards"} — Show all Trello boards.
- {"type": "trello_board", "board": "board name"} — Show lists and cards in a Trello board.
- {"type": "trello_add_card", "board": "board name", "list": "list name", "title": "card title", "description": "optional", "due": "YYYY-MM-DD"} — Add a card to Trello.
- {"type": "trello_search", "query": "search text"} — Search for cards in Tokyo Life OS board. Use when user asks "find card", "search trello".
- {"type": "trello_complete_card", "query": "card name to find"} — Move a Trello card to Done. Use when user says "trello done [card]", "complete card [name]".
- {"type": "trello_reopen_card", "query": "card name", "list": "target list name"} — Move a card back from Done. Use when user says "reopen card", "not done", "client said not done".`;
  },

  // ─── Context ─────────────────────────────────────────────────

  async getContextSection(): Promise<string> {
    const db = await import("../../db");

    // Learning (Recent)
    let learningCtx = "No learning data.";
    try {
      const items = db.getRecentLearning(3);
      if (items.length > 0) {
        learningCtx = items.map((l: any) =>
          `- ${l.title} [${l.type}]${l.topic ? ` \u2014 ${l.topic}` : ""} (${l.date})`
        ).join("\n");
      } else {
        learningCtx = "No learning logged. Track what you learn!";
      }
    } catch { /* no learning data */ }

    return `### Learning (Recent)
${learningCtx}`;
  },

  // ─── Commands ────────────────────────────────────────────────

  async handleCommand(command: string, args: string, ctx: AgentContext): Promise<AgentResult> {
    switch (command) {
      case "digest": {
        await ctx.sendMessage("\uD83D\uDD0D Generating AI digest...");
        try {
          const { generateAIDigest } = await import("../../research");
          const digest = await generateAIDigest();
          return { success: true, output: digest };
        } catch (err) {
          console.error("Digest error:", err);
          return { success: false, output: "Failed to generate digest." };
        }
      }

      case "trending": {
        await ctx.sendMessage("\uD83D\uDD0D Searching trending AI repos...");
        try {
          const { fetchAITrending, formatRepos } = await import("../../research");
          const repos = await fetchAITrending();
          return { success: true, output: formatRepos(repos, "\uD83D\uDD25 *Trending AI Repos (last 3 days)*") };
        } catch (err) {
          console.error("Trending error:", err);
          return { success: false, output: "Failed to fetch trending repos." };
        }
      }

      case "tools": {
        await ctx.sendMessage("\uD83D\uDD0D Searching new AI tools...");
        try {
          const { fetchAITools, formatRepos } = await import("../../research");
          const tools = await fetchAITools();
          return { success: true, output: formatRepos(tools, "\uD83D\uDEE0 *New AI Tools & Frameworks (this week)*") };
        } catch (err) {
          console.error("Tools error:", err);
          return { success: false, output: "Failed to fetch tools." };
        }
      }

      case "news": {
        await ctx.sendMessage("\uD83D\uDD0D Fetching AI news...");
        try {
          const { fetchAINews, formatNews } = await import("../../research");
          const stories = await fetchAINews();
          return { success: true, output: formatNews(stories, "\uD83D\uDCF0 *AI News (Hacker News)*") };
        } catch (err) {
          console.error("News error:", err);
          return { success: false, output: "Failed to fetch news." };
        }
      }

      case "youtube": {
        const query = args.trim() || "AI tools 2026";
        await ctx.sendMessage("\uD83D\uDD0D Searching YouTube...");
        try {
          const { searchYouTube, formatYouTube } = await import("../../research");
          const videos = await searchYouTube(query);
          return { success: true, output: formatYouTube(videos, `\uD83C\uDFAC *YouTube \u2014 "${query}"*`) };
        } catch (err) {
          console.error("YouTube error:", err);
          return { success: false, output: "Failed to search YouTube." };
        }
      }

      case "trello": {
        const arg = args.trim().toLowerCase();
        const trelloKey = process.env.TRELLO_API_KEY;
        const trelloToken = process.env.TRELLO_TOKEN;

        if (!trelloKey || !trelloToken) {
          return { success: false, output: "Trello not configured. Add TRELLO_API_KEY and TRELLO_TOKEN to .env" };
        }

        try {
          const { formatBoards, findBoard, formatBoard } = await import("../../trello");

          if (!arg || arg === "boards") {
            const text = await formatBoards();
            return { success: true, output: text };
          }

          // Show specific board
          const board = await findBoard(arg);
          if (!board) {
            return { success: false, output: `Board "${arg}" not found. Use /trello to see all boards.` };
          }
          const text = await formatBoard(board.id);
          return { success: true, output: `\uD83D\uDCCB *${board.name}*\n\n${text}` };
        } catch (err: any) {
          console.error("Trello error:", err);
          return { success: false, output: `Trello error: ${err.message}` };
        }
      }

      case "cal": {
        const input = args.trim();
        try {
          const db = await import("../../db");
          const { localToday, localNow } = await import("../../utils");

          // Parse date
          let date: string;
          const trimmed = input.toLowerCase();
          if (!trimmed || trimmed === "today" || trimmed === "\u0627\u0644\u064A\u0648\u0645") {
            date = localToday();
          } else if (trimmed === "yesterday" || trimmed === "\u0623\u0645\u0633" || trimmed === "\u0627\u0644\u0628\u0627\u0631\u062D\u0629") {
            const d = localNow();
            d.setDate(d.getDate() - 1);
            date = d.toISOString().split("T")[0];
          } else if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
            date = trimmed;
          } else {
            const relMatch = trimmed.match(/^-(\d+)d?$/);
            if (relMatch) {
              const d = localNow();
              d.setDate(d.getDate() - parseInt(relMatch[1]));
              date = d.toISOString().split("T")[0];
            } else {
              date = localToday();
            }
          }

          const activity = db.getDailyActivity(date);
          const dayName = new Date(date).toLocaleDateString("en-US", { weekday: "long" });
          const lines: string[] = [`\uD83D\uDCC5 *${dayName}, ${date}*\n`];

          // Schedule
          if (activity.schedule.length > 0) {
            lines.push("\uD83D\uDD50 *Schedule*");
            for (const s of activity.schedule as any[]) {
              lines.push(`  ${s.time} \u2014 ${s.title}${s.recurring ? " \uD83D\uDD01" : ""}`);
            }
            lines.push("");
          }

          // Tasks completed
          if (activity.tasksCompleted.length > 0) {
            lines.push(`\u2705 *Tasks Completed (${activity.tasksCompleted.length})*`);
            for (const t of activity.tasksCompleted as any[]) {
              lines.push(`  \u2713 #${t.id} ${t.title} [${t.category}]`);
            }
            lines.push("");
          }

          // Tasks created
          if (activity.tasksCreated.length > 0) {
            const newOnly = (activity.tasksCreated as any[]).filter(
              (t: any) => !(activity.tasksCompleted as any[]).some((c: any) => c.id === t.id)
            );
            if (newOnly.length > 0) {
              lines.push(`\uD83D\uDCCB *Tasks Created (${newOnly.length})*`);
              for (const t of newOnly) {
                lines.push(`  + #${t.id} ${t.title} [${t.status}]`);
              }
              lines.push("");
            }
          }

          // Work
          if (activity.work.totalMinutes > 0) {
            const h = Math.floor(activity.work.totalMinutes / 60);
            const m = activity.work.totalMinutes % 60;
            const byType = Object.entries(activity.work.byType)
              .map(([t, mins]) => `${t}: ${Math.floor((mins as number) / 60)}h${(mins as number) % 60}m`)
              .join(", ");
            lines.push(`\u23F1 *Work: ${h}h${m}m*${byType ? ` (${byType})` : ""}`);
            if (activity.work.breakMinutes > 0) {
              lines.push(`  \u2615 Breaks: ${Math.floor(activity.work.breakMinutes / 60)}h${activity.work.breakMinutes % 60}m`);
            }
            lines.push("");
          }

          // Habits
          const habitsDone = (activity.habits as any[]).filter((h: any) => h.done);
          if (activity.habits.length > 0) {
            lines.push(`\u2705 *Habits: ${habitsDone.length}/${activity.habits.length}*`);
            for (const h of activity.habits as any[]) {
              lines.push(`  ${h.done ? "\u2705" : "\u2B1C"} ${h.name}`);
            }
            lines.push("");
          }

          // Deen
          const deenItems: string[] = [];
          if (activity.quranPages > 0) deenItems.push(`\uD83D\uDCD6 Quran: ${activity.quranPages} pages`);
          if (activity.adhkar.morning) deenItems.push("\uD83C\uDF05 Morning adhkar \u2713");
          if (activity.adhkar.evening) deenItems.push("\uD83C\uDF19 Evening adhkar \u2713");
          if (deenItems.length > 0) {
            lines.push("\uD83D\uDD4C *Deen*");
            for (const item of deenItems) lines.push(`  ${item}`);
            lines.push("");
          }

          // Finance
          if (activity.income.length > 0 || activity.shopSales.length > 0) {
            lines.push("\uD83D\uDCB0 *Finance*");
            for (const inc of activity.income as any[]) {
              lines.push(`  +${inc.amount} ${inc.currency || currency()} (${inc.source}${inc.description ? ": " + inc.description : ""})`);
            }
            for (const sale of activity.shopSales as any[]) {
              if (shopOn()) lines.push(`  \uD83C\uDFEA Shop: ${sale.total_revenue} ${currency()}${sale.items_sold ? ` (${sale.items_sold} items)` : ""}`);
            }
            lines.push("");
          }

          // Journal entries
          if (activity.journals.length > 0) {
            lines.push("\uD83D\uDCDD *Journal*");
            for (const j of activity.journals as any[]) {
              const mood = j.mood ? ` [${j.mood}]` : "";
              const energy = j.energy_level ? ` \u26A1${j.energy_level}/5` : "";
              lines.push(`  ${mood}${energy} ${j.entry.substring(0, 150)}`);
            }
            lines.push("");
          }

          // Empty day
          if (lines.length <= 1) {
            lines.push("_No activity recorded for this day._");
          }

          return { success: true, output: lines.join("\n") };
        } catch (err) {
          console.error("Calendar error:", err);
          return { success: false, output: "Failed to load calendar. Try again." };
        }
      }

      case "calweek": {
        try {
          const db = await import("../../db");
          const { localToday, localNow } = await import("../../utils");
          const now = localNow();
          const day = now.getDay();
          const diff = day === 0 ? 6 : day - 1;
          const weekStart = new Date(now);
          weekStart.setDate(now.getDate() - diff);
          const start = weekStart.toISOString().split("T")[0];
          const end = localToday();
          const label = `This Week (${start} \u2192 ${end})`;

          const summaries = db.getDateRangeSummaries(start, end);

          if (summaries.length === 0) {
            return { success: true, output: "\uD83D\uDCC5 No activity recorded this week yet." };
          }

          const lines: string[] = [`\uD83D\uDCC5 *${label}*\n`];
          for (const dayData of summaries) {
            const dayName = new Date(dayData.date).toLocaleDateString("en-US", { weekday: "short" });
            const items: string[] = [];
            if (dayData.tasksCompleted > 0) items.push(`\u2705${dayData.tasksCompleted}`);
            if (dayData.workMinutes > 0) items.push(`\u23F1${Math.round(dayData.workMinutes / 60)}h`);
            if (dayData.habitsCompleted > 0) items.push(`\u2713${dayData.habitsCompleted}/${dayData.habitsTotal}`);
            if (dayData.quranPages > 0) items.push(`\uD83D\uDCD6${dayData.quranPages}p`);
            if (dayData.journalCount > 0) items.push(`\uD83D\uDCDD${dayData.journalCount}`);
            if (dayData.income > 0) items.push(`\uD83D\uDCB0${dayData.income}`);

            lines.push(`*${dayName} ${dayData.date}* \u2014 ${items.join(" | ") || "minimal"}`);
          }

          lines.push(`\n_/cal [date] for details, /progress week for full report_`);
          return { success: true, output: lines.join("\n") };
        } catch (err) {
          console.error("Cal week error:", err);
          return { success: false, output: "Failed to load weekly calendar." };
        }
      }

      default:
        return { success: false, output: `Unknown research command: ${command}` };
    }
  },

  // ─── Events ──────────────────────────────────────────────────

  async handleEvent(_event: AgentEvent, _ctx: AgentContext): Promise<AgentResult> {
    // Research agent does not handle events
    return { success: true, output: "", silent: true };
  },

  // ─── Actions ─────────────────────────────────────────────────

  async handleAction(action: Record<string, any>, _ctx: AgentContext): Promise<string | void> {
    switch (action.type) {
      case "search_trending": {
        const { fetchAITrending, fetchAITools, formatRepos } = await import("../../research");
        const topic = action.topic || "ai";
        let repos;
        if (topic === "tools") {
          repos = await fetchAITools();
        } else {
          repos = await fetchAITrending();
        }
        return formatRepos(repos, `\n\uD83D\uDD25 *Trending AI Repos*`);
      }

      case "search_news": {
        const { fetchAINews, fetchHNTopStories, formatNews } = await import("../../research");
        let stories;
        if (action.filter) {
          stories = await fetchHNTopStories(action.filter, 10);
        } else {
          stories = await fetchAINews();
        }
        return formatNews(stories, `\n\uD83D\uDCF0 *AI/Tech News*`);
      }

      case "search_youtube": {
        const { searchYouTube, formatYouTube } = await import("../../research");
        const videos = await searchYouTube(action.query, 8);
        return formatYouTube(videos, `\n\uD83C\uDFAC *YouTube \u2014 "${action.query}"*`);
      }

      case "trello_boards": {
        const { formatBoards } = await import("../../trello");
        return await formatBoards();
      }

      case "trello_board": {
        const { findBoard, formatBoard } = await import("../../trello");
        const board = await findBoard(action.board || "");
        if (!board) return `\uD83D\uDCCB Board "${action.board}" not found.`;
        const text = await formatBoard(board.id);
        return `\n\uD83D\uDCCB *${board.name}*\n\n${text}`;
      }

      case "trello_add_card": {
        const { findBoard, findList, createCard } = await import("../../trello");
        const board = await findBoard(action.board || "");
        if (!board) return `\uD83D\uDCCB Board "${action.board}" not found.`;
        const list = await findList(board.id, action.list || "To Do");
        if (!list) return `\uD83D\uDCCB No list found in ${board.name}.`;
        const card = await createCard(list.id, action.title, action.description, action.due);
        return `\uD83D\uDCCB Card created in *${board.name}* \u2192 *${list.name}*:\n*${card.name}*${card.due ? ` (due: ${card.due.split("T")[0]})` : ""}\n${card.url}`;
      }

      case "trello_search": {
        const { findBoard, searchCards } = await import("../../trello");
        const board = await findBoard("tokyo");
        if (!board) return "\uD83D\uDCCB Tokyo board not found.";
        const cards = await searchCards(board.id, action.query || "");
        if (cards.length === 0) return `\uD83D\uDCCB No cards found for "${action.query}".`;
        const lines = cards.slice(0, 10).map((c: any) => {
          const due = c.due ? ` \u23F0${c.due.split("T")[0]}` : "";
          return `\u2022 *${c.name}*${due}\n  ${c.url}`;
        });
        return `\n\uD83D\uDCCB *Trello \u2014 "${action.query}"* (${cards.length})\n\n${lines.join("\n")}`;
      }

      case "trello_complete_card": {
        const { findBoard, searchCards, completeCard } = await import("../../trello");
        const board = await findBoard("tokyo");
        if (!board) return "\uD83D\uDCCB Board not found.";
        const cards = await searchCards(board.id, action.query || "");
        if (cards.length === 0) return `\uD83D\uDCCB Card "${action.query}" not found.`;
        await completeCard(board.id, cards[0].id);
        return `\u2705 Trello card moved to Done: *${cards[0].name}*`;
      }

      case "trello_reopen_card": {
        const { findBoard, searchCards, reopenCard } = await import("../../trello");
        const board = await findBoard("tokyo");
        if (!board) return "\uD83D\uDCCB Board not found.";
        const cards = await searchCards(board.id, action.query || "");
        if (cards.length === 0) return `\uD83D\uDCCB Card "${action.query}" not found.`;
        await reopenCard(board.id, cards[0].id, action.list);
        return `\uD83D\uDD04 Trello card reopened: *${cards[0].name}* \u2192 ${action.list || "In Progress"}`;
      }

      case "log_learning": {
        const db = await import("../../db");
        db.logLearning(action.title, action.type, action.topic, action.source, action.notes, action.minutes_spent);
        return `\uD83D\uDCDA Logged: *${action.title}*${action.topic ? ` [${action.topic}]` : ""}${action.minutes_spent ? ` (${action.minutes_spent}min)` : ""}`;
      }

      case "show_learning": {
        const db = await import("../../db");
        const items = db.getRecentLearning(10);
        if (items.length === 0) return `\n\uD83D\uDCDA No learning logged yet. Tell me what you learned!`;
        const lines = items.map((l: any) => {
          const mins = l.minutes_spent ? ` (${l.minutes_spent}min)` : "";
          return `\u2022 *${l.title}*${mins}\n  ${l.type}${l.topic ? ` \u2014 ${l.topic}` : ""} \u2014 ${l.date}`;
        });
        return `\n\uD83D\uDCDA *Recent Learning*\n\n${lines.join("\n")}`;
      }

      default:
        return undefined;
    }
  },
};

export default researchAgent;
