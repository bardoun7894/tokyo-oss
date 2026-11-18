import * as db from "./db";
import dbInstance from "./db";
import { localToday } from "./utils";
import type { Bot } from "grammy";

const DEV_PROJECTS = new Set(["shopdemo", "erpdemo", "billing", "studio", "lab", "tokyo", "clinic"]);

// Command classification — see roadmap M2.2
const DEPLOY_PATTERNS = /\b(deploy|docker\s+(compose|build|up|restart)|git\s+pull|systemctl\s+restart)\b/i;
const BUILD_PATTERNS = /\b(build|npm\s+run\s+build|tsc|webpack|vite\s+build)\b/i;
const RESTART_PATTERNS = /\b(restart|pm2\s+(restart|reload))\b/i;

export function classifyServerCommand(command: string): "deploy" | "build" | "restart" | "other" {
  if (DEPLOY_PATTERNS.test(command)) return "deploy";
  if (BUILD_PATTERNS.test(command)) return "build";
  if (RESTART_PATTERNS.test(command)) return "restart";
  return "other";
}

// Telegram bot reference — set by index.ts via setAutoLogBot()
let autoLogBot: Bot | null = null;
let autoLogChatId: string | null = null;

export function setAutoLogBot(bot: Bot, chatId?: string) {
  autoLogBot = bot;
  if (chatId) autoLogChatId = chatId;
}

export function logAgentActivity(project: string, durationMinutes: number, result: string): void {
  const category = DEV_PROJECTS.has(project.toLowerCase()) ? "dev" : "dev";
  db.createActivityEvent({
    source: "agent",
    event_type: "agent_session",
    confidence: "high",
    title: `Agent: ${project} (${Math.round(durationMinutes)}min)`,
    project: project.toLowerCase(),
    category,
    duration_minutes: Math.round(durationMinutes),
    metadata: JSON.stringify({ result_summary: result.slice(0, 500) }),
  });
}

/**
 * Log a successful server command (M2.2). Always high-confidence — auto-logs silently.
 * Returns the inserted event id.
 */
export function logServerCommand(command: string, exitCode: number): number {
  const eventType = classifyServerCommand(command);
  const result = db.createActivityEvent({
    source: "server_command",
    event_type: eventType,
    confidence: "high",
    title: command.slice(0, 200),
    category: "dev",
    duration_minutes: 1,
    metadata: JSON.stringify({ command: command.slice(0, 500), exit_code: exitCode }),
  });
  return Number((result as any).lastInsertRowid);
}

export function logTaskAction(taskId: number, action: string, project?: string): void {
  db.createActivityEvent({
    source: "task",
    event_type: action,
    confidence: "high",
    title: `Task #${taskId} ${action}`,
    project: project?.toLowerCase(),
    category: project ? "dev" : "client",
    metadata: JSON.stringify({ task_id: taskId, action }),
    related_id: taskId,
  });
}

export function logWABurst(jid: string, contactName: string, category: string, messageCount: number, durationMinutes: number): void {
  const eventCategory = category === "client" ? "client" : category === "shop" ? "shop" : "personal";
  db.createActivityEvent({
    source: "whatsapp",
    event_type: "burst",
    confidence: "medium",
    title: `Messaged ${contactName} (${Math.round(durationMinutes)}min, ${messageCount} msgs)`,
    category: eventCategory,
    duration_minutes: Math.round(durationMinutes),
    metadata: JSON.stringify({ jid, contact_name: contactName, message_count: messageCount }),
  });
}

export function checkIdleSessions(): void {
  const session = db.getActiveWorkSession();
  if (!session) return;

  if (session.minutes_active > 180) {
    const lastOverwork = db.getLastCoachingMessage("overwork");
    if (!lastOverwork || (Date.now() - new Date(lastOverwork.sent_at).getTime()) > 3600000) {
      db.logCoachingMessage("overwork", `Work session active for ${Math.round(session.minutes_active)} minutes.`);
    }
  }

  const today = localToday();
  const events = db.getActivityEventsForDate(today).filter((e: any) => e.source !== "scheduler");
  if (events.length > 0) {
    const idleMinutes = (Date.now() - new Date(events[0].logged_at).getTime()) / 60000;
    if (idleMinutes > 30 && session.minutes_active > 60) {
      db.logWork("work_end", "Auto-closed: idle 30+ min");
      db.createActivityEvent({
        source: "scheduler",
        event_type: "auto_close",
        confidence: "medium",
        title: `Auto-closed session (idle ${Math.round(idleMinutes)}min)`,
        category: "admin",
        duration_minutes: Math.round(session.minutes_active),
      });
    }
  }
}

export function updatePromiseStatuses(): void {
  db.updatePromiseStatuses();
}

/**
 * Look up a single activity_event by id.
 */
export function getActivityEvent(id: number): any | null {
  const row = dbInstance.prepare("SELECT * FROM activity_events WHERE id = ?").get(id);
  return (row as any) ?? null;
}

/**
 * Send a Telegram confirmation prompt for a medium-confidence activity event (M2.5).
 * The user gets inline buttons to confirm, change category, or ignore.
 */
export async function notifyConfirmation(eventId: number): Promise<void> {
  if (!autoLogBot || !autoLogChatId) {
    console.warn("[auto_log] notifyConfirmation: bot not initialized — skipping");
    return;
  }
  const event = getActivityEvent(eventId);
  if (!event) {
    console.warn(`[auto_log] notifyConfirmation: event ${eventId} not found`);
    return;
  }

  const title = event.title || "(unknown activity)";
  const category = event.category || "dev";
  const minutes = event.duration_minutes ?? "?";
  const text =
    `📝 *Detected Activity*\n` +
    `${title}\n` +
    `Likely: ${category} (${minutes}m)`;

  const keyboard = {
    inline_keyboard: [[
      { text: "✅ Confirm", callback_data: `confirm_event:${eventId}` },
      { text: "🔄 Change", callback_data: `change_event:${eventId}` },
      { text: "❌ Ignore", callback_data: `ignore_event:${eventId}` },
    ]],
  };

  try {
    await autoLogBot.api.sendMessage(autoLogChatId, text, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  } catch (err) {
    try {
      await autoLogBot.api.sendMessage(autoLogChatId, text.replace(/[*_`\[\]]/g, ""), {
        reply_markup: keyboard,
      });
    } catch (e) {
      console.error("[auto_log] notifyConfirmation send failed:", e);
    }
  }
}

export function formatConfirmationMessage(event: any): string {
  const parts: string[] = ["📝 *Detected Activity*\n\n"];

  if (event.source === "whatsapp") {
    const meta = event.metadata ? JSON.parse(event.metadata) : {};
    parts.push(`You messaged ${meta.contact_name || "someone"} (${event.category}) for ${event.duration_minutes} min`);
    if (meta.message_count) parts.push(` (${meta.message_count} messages)`);
    parts.push(".");
  } else if (event.source === "agent") {
    parts.push(`Agent session on *${event.project}* for ${event.duration_minutes} min.`);
  } else if (event.source === "server") {
    const meta = event.metadata ? JSON.parse(event.metadata) : {};
    parts.push(`Server command: \`${meta.command || event.title}\` (${meta.exit_code === 0 ? "success" : "failed"}).`);
  } else {
    parts.push(`${event.title || "Unknown activity"} (${event.source}, ${event.event_type}).`);
  }

  return parts.join("");
}
