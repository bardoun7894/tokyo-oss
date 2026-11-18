import { EventBus } from "./event-bus";
import type { AgentEvent } from "./event-bus";
import type { AgentContext } from "./types";
import * as db from "../db";
import { parseAmount } from "../parse-amount";

/**
 * Cross-agent pipelines — agents talking to each other.
 * This is where Tokyo becomes the "super me."
 *
 * Pipelines:
 * 1. Bug Pipeline: WhatsApp bug report → DevOps auto-fix → Coaching reports back
 * 2. Task Pipeline: WhatsApp request → Productivity creates task → Coaching tracks promise
 * 3. Payment Pipeline: WhatsApp payment mention → Finance logs income → Coaching confirms
 * 4. Prayer Pipeline: Deen prayer approaching → Productivity wraps work → Coaching nudges
 * 5. Idle Pipeline: Coaching detects idle → Productivity suggests top task
 */
export function registerPipelines(eventBus: EventBus, createContext: () => AgentContext): void {
  console.log("  [pipelines] Registering cross-agent pipelines...");

  // ═══════════════════════════════════════════
  // PIPELINE 1: Bug Report → Auto-Fix → Report
  // ═══════════════════════════════════════════
  // WhatsApp agent detects bug_report intent → Claude Haiku analyzes → Coaching reports result
  eventBus.on("wa:bug_report", async (event: AgentEvent) => {
    const { jid, senderName, content, project } = event.data;
    if (!project) return;

    console.log(`[pipeline] Bug report from ${senderName} on ${project}: "${content?.slice(0, 60)}"`);

    const ctx = createContext();

    // Notify the owner immediately
    await ctx.sendMessage(
      `*Bug Pipeline Started*\n` +
      `From: ${senderName}\n` +
      `Project: ${project}\n` +
      `Issue: ${content?.slice(0, 200)}\n` +
      `Claude is analyzing...`,
    );

    // Auto-analyze bug with Claude Haiku
    try {
      const { runClaudeTask } = await import("../claude-tasks");

      const taskPrompt = `Client "${senderName}" reported a bug via WhatsApp:\n\n${content}\n\n` +
        `1. Read relevant source files\n2. Identify the issue\n3. Suggest a fix\n` +
        `4. Give a SHORT summary (3-5 lines) of what you found`;

      const { result, success } = await runClaudeTask(project, taskPrompt);

      eventBus.fire(EventBus.event("pipeline:bug_fixed", "pipeline", {
        jid, senderName, project, content,
        piResult: result?.slice(0, 2000),
        success,
      }));
    } catch (err: any) {
      console.error("[pipeline] Bug auto-fix failed:", err);
      await ctx.sendMessage(`Bug pipeline failed for ${project}: ${err.message}`);
    }
  });

  // Coaching picks up the fix result and reports
  eventBus.on("pipeline:bug_fixed", async (event: AgentEvent) => {
    const { jid, senderName, project, piResult, success } = event.data;
    const ctx = createContext();

    const status = success ? "Fixed" : "Needs manual attention";
    await ctx.sendMessage(
      `*Bug Pipeline Complete*\n` +
      `Project: ${project}\n` +
      `Status: ${status}\n` +
      `Result: ${piResult?.slice(0, 500) || "No output"}`,
    );

    // Auto-reply disabled — the owner prefers to reply manually
    // The fix result is sent to Telegram above for the owner to review
  });

  // ═══════════════════════════════════════════════
  // PIPELINE 2: Task Request → Create → Track Promise
  // ═══════════════════════════════════════════════
  eventBus.on("wa:client_request", async (event: AgentEvent) => {
    const { jid, senderName, content, project } = event.data;

    console.log(`[pipeline] Client request from ${senderName}: "${content?.slice(0, 60)}"`);

    const ctx = createContext();

    // Create task
    try {
      const title = content?.slice(0, 100) || `Request from ${senderName}`;
      const result = db.addTask(title, "client", "high");
      const taskId = (result as any).lastInsertRowid;

      // Create a promise to track
      try {
        db.addPromise({
          content: `Handle ${senderName}'s request: ${title}`,
          made_to: senderName,
          source_type: "whatsapp",
        });
      } catch {}

      // Notify the owner
      await ctx.sendMessage(
        `*Task Pipeline*\n` +
        `From: ${senderName} (${project || "unknown"})\n` +
        `Task #${taskId}: ${title}\n` +
        `Promise tracked`,
      );

      // Add to Trello if available
      if (process.env.TRELLO_API_KEY && project) {
        try {
          const { findBoard, findList, createCard } = await import("../trello");
          const board = await findBoard("tokyo");
          if (board) {
            const list = await findList(board.id, "Backlog");
            if (list) {
              await createCard(list.id, title, `From: ${senderName}\n${content?.slice(0, 500)}`);
            }
          }
        } catch {}
      }
    } catch (err: any) {
      console.error("[pipeline] Task creation failed:", err);
    }
  });

  // ═══════════════════════════════════════════
  // PIPELINE 3: Payment → Log Income → Confirm
  // ═══════════════════════════════════════════
  eventBus.on("wa:payment", async (event: AgentEvent) => {
    const { jid, senderName, content } = event.data;
    const ctx = createContext();

    try {
      // This used to log every payment as 0 and ask for the amount later, which
      // never happened: every income row ever written was 0, so dev income read
      // zero for months. A row is written only when the message states an
      // amount; otherwise it asks, and writes nothing.
      const parsed = parseAmount(content ?? "");
      if (parsed) {
        db.logIncome(parsed.amount, "direct", undefined, undefined,
          `Payment from ${senderName}`, parsed.currency);
        await ctx.sendMessage(
          `*Payment Pipeline*\n` +
          `From: ${senderName}\n` +
          `Logged ${parsed.amount.toLocaleString()} ${parsed.currency} to income.`,
        );
      } else {
        await ctx.sendMessage(
          `*Payment Pipeline*\n` +
          `From: ${senderName}\n` +
          `No amount in the message, so nothing was logged. Add it on the Finance page.`,
        );
      }
    } catch (err: any) {
      console.error("[pipeline] Payment logging failed:", err);
    }
  });

  // ═══════════════════════════════════════════
  // PIPELINE 4: Prayer → Wrap Work → Nudge
  // ═══════════════════════════════════════════
  eventBus.on("prayer:approaching", async (event: AgentEvent) => {
    const { name, minutesUntil } = event.data;
    const ctx = createContext();

    // Check if there's an active work session
    try {
      const session = db.getActiveWorkSession();
      if (session) {
        await ctx.sendMessage(
          `${name} in ${minutesUntil} min. You have an active work session — consider wrapping up.`,
        );
      }
    } catch {}
  });

  // ═══════════════════════════════════════════
  // PIPELINE 5: Task Completed → Encouragement
  // ═══════════════════════════════════════════
  eventBus.on("task:completed", async (event: AgentEvent) => {
    const { taskId, title } = event.data;
    const ctx = createContext();

    // Count today's completions
    try {
      const { localToday } = await import("../utils");
      const completed = db.getCompletedTasksForDate(localToday()) as any[];
      if (completed.length === 3) {
        await ctx.sendMessage("3 tasks done today. Keep this momentum going.");
      } else if (completed.length === 5) {
        await ctx.sendMessage("5 tasks done. Productive day, mashallah.");
      } else if (completed.length === 10) {
        await ctx.sendMessage("10 tasks done today. Beast mode. Take a break too.");
      }
    } catch {}
  });

  console.log("  [pipelines] 5 cross-agent pipelines registered.");
}
