// Jev decides the internal actions for an incoming WhatsApp message (forward to
// Telegram? create a task? which category and priority?) in one request. It returns
// null whenever any answer is unsure, so the caller runs the full LLM analysis instead.
import { askJev, jevEnabled } from "./jev";

export interface WAPlanInput {
  sender: string;
  category: string;
  chatType: string;
  message: string;
  history: string;
}

export type TaskCategory = "client" | "shop" | "personal" | "admin";
export type TaskPriority = "low" | "medium" | "high" | "urgent";

export interface WAPlan {
  forward: boolean;
  task: { category: TaskCategory; priority: TaskPriority } | null;
}

// A yes/no is trusted only outside this band; anything in between goes to the LLM.
const NO_BELOW = 0.25;
const YES_ABOVE = 0.75;
const CHOICE_CONFIDENCE = 0.75;

const clear = (p: number | undefined): boolean | null =>
  p === undefined ? null : p < NO_BELOW ? false : p > YES_ABOVE ? true : null;

export async function planWAActions(input: WAPlanInput): Promise<WAPlan | null> {
  if (!jevEnabled()) return null;
  try {
    const a = await askJev(
      {
        sender: input.sender,
        sender_category: input.category,
        chat_type: input.chatType,
        message: input.message,
        recent_conversation: input.history.slice(-4000),
      },
      {
        forward: { type: "noul", instructions: "This message needs the owner's personal attention on Telegram: an urgent or important client matter, or a question that needs a human decision." },
        needs_task: { type: "noul", instructions: "This message contains a work request, dev task, bug report, feature request, deadline, or other actionable item that should become a task." },
        task_category: { type: "choice", instructions: "Which area a task from this message belongs to.", criteria: {
          client: "Work for a software client.", shop: "The shop (sales, stock, customers).",
          personal: "The owner's personal life.", admin: "Admin, paperwork, bills, accounts." } },
        priority: { type: "choice", instructions: "How urgent a task from this message is.", criteria: {
          low: "Whenever.", medium: "This week.", high: "Soon, a client is waiting.", urgent: "Today, something is broken or a deadline is named." } },
      },
    );
    const forward = clear(a.forward?.noul);
    const needsTask = clear(a.needs_task?.noul);
    if (forward === null || needsTask === null) return null;
    if (!needsTask) return { forward, task: null };

    const cat = a.task_category, pri = a.priority;
    if ((cat?.confidence ?? 0) < CHOICE_CONFIDENCE || (pri?.confidence ?? 0) < CHOICE_CONFIDENCE) return null;
    return { forward, task: { category: cat!.choice as TaskCategory, priority: pri!.choice as TaskPriority } };
  } catch (err: any) {
    console.warn("[wa-jev-plan] jev failed, using LLM:", err?.message || err);
    return null;
  }
}
