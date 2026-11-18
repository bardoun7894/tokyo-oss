/**
 * Daily nudge for bills that are due or overdue.
 *
 * Runs once a morning. Each obligation gets at most one message per period per
 * stage (ahead / due / overdue), claimed in the database, so a restart or a
 * second run cannot send the same reminder twice.
 */
import cron from "node-cron";
import * as db from "./db";
import { needsReminder } from "./obligations";
import { localToday } from "./utils";
import { pushReminder } from "./control/push/reminders";

const DAYS_AHEAD = 2;

function stageOf(daysUntilDue: number): "ahead" | "due" | "overdue" {
  if (daysUntilDue > 0) return "ahead";
  return daysUntilDue === 0 ? "due" : "overdue";
}

function line(name: string, counterparty: string | null, amount: number, currency: string, days: number): string {
  const who = counterparty ? ` (${counterparty})` : "";
  const sum = amount > 0 ? ` — ${amount.toLocaleString()} ${currency}` : "";
  if (days > 0) return `⏳ ${name}${who}${sum} due in ${days} day${days === 1 ? "" : "s"}`;
  if (days === 0) return `📌 ${name}${who}${sum} is due today`;
  return `⚠️ ${name}${who}${sum} is ${-days} day${days === -1 ? "" : "s"} overdue`;
}

export async function sendDueReminders(today = localToday()): Promise<string[]> {
  const sent: string[] = [];
  for (const o of db.listObligations()) {
    const status = needsReminder(o, db.listObligationPayments(o.id), today, DAYS_AHEAD);
    if (!status) continue;
    const stage = stageOf(status.daysUntilDue);
    // Overdue nudges once a day; the other two once per period.
    const key = stage === "overdue" ? `overdue-${today}` : stage;
    if (!db.claimObligationReminder(o.id, status.period, key)) continue;
    sent.push(line(o.name, o.counterparty, o.amount, o.currency, status.daysUntilDue));
    pushReminder(`obligation-${stage}`, String(o.id), o.name);
  }
  if (sent.length) await notify(sent.join("\n"));
  return sent;
}

async function notify(body: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_USER_ID;
  if (!token || !chatId) {
    console.warn("[obligations] TELEGRAM_USER_ID not set — reminder not sent:\n" + body);
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: `*To pay*\n${body}`, parse_mode: "Markdown" }),
    });
  } catch (err: any) {
    console.error("[obligations] reminder send failed:", err?.message || err);
  }
}

export function startObligationReminders(): void {
  cron.schedule("0 9 * * *", () => {
    sendDueReminders().catch((err) => console.error("[obligations] reminder run failed:", err));
  });
  console.log("💸 Obligation reminders scheduled for 09:00 daily");
}
