import crypto from "crypto";
import { localToday } from "../../utils";
import { wanted } from "./dispatcher";
import { GateCounter, serialize, type ReminderSection } from "./format";
import type { PushStore } from "./store";

// Reminders are time events, not state to diff (plan section 1): each Telegram reminder send site calls pushReminder()
// beside it, and a sink (set by wirePush) queues one outbox row per device. pushReminder never throws and never waits, so
// the Telegram send beside it cannot be affected by push.

export type ReminderKind = "obligation-ahead" | "obligation-due" | "obligation-overdue" | "prayer" | "adhkar" | "journal" | "deen" | "learning";

export interface ReminderEvent {
  /** `reminder:<kind>:<ref>:<date>` (plan section 5). */
  key: string;
  date: string;
  event: { type: "reminder"; id: string; title: string; section?: ReminderSection };
}
export type ReminderSink = (r: ReminderEvent) => void | Promise<void>;

/** `r_` + 12 hex of `kind:ref:date`: the same reminder on the same day is the same id. */
export function reminderId(kind: ReminderKind, ref: string, date: string): string {
  return "r_" + crypto.createHash("sha256").update(`${kind}:${ref}:${date}`).digest("hex").slice(0, 12);
}

/** The Life section a reminder of this kind opens: obligations in Finance, prayer, adhkar and deen nudges in Deen, journal in Journal, the rest in Today. */
export function reminderSection(kind: ReminderKind): ReminderSection {
  switch (kind) {
    case "obligation-ahead": case "obligation-due": case "obligation-overdue": return "finance";
    case "prayer": case "adhkar": case "deen": return "deen";
    case "journal": return "journal";
    default: return "today";
  }
}

/** A fixed template per kind plus the obligation or prayer name; nothing else (no amount, no message text) can get in. */
export function reminderLabel(kind: ReminderKind, name: string): string {
  const n = name.replace(/\//g, "-").trim();
  switch (kind) {
    case "obligation-ahead": return `${n} due soon`;
    case "obligation-due": return `${n} due today`;
    case "obligation-overdue": return `${n} overdue`;
    case "prayer": return `${n} prayer`;
    case "adhkar": return `${n} adhkar`;
    case "journal": return `${n} journal`;
    case "deen": return `${n} reminder`;
    case "learning": return "Learning nudge";
  }
}

let sink: ReminderSink | null = null;
export function setReminderSink(s: ReminderSink | null): void { sink = s; }

export function pushReminder(kind: ReminderKind, refId: string, label: string): void {
  try {
    if (!sink) return;
    const date = localToday();
    const out = sink({
      key: `reminder:${kind}:${refId}:${date}`, date,
      event: { type: "reminder", id: reminderId(kind, refId, date), title: `Reminder: ${reminderLabel(kind, label)}`, section: reminderSection(kind) },
    });
    if (out && typeof out.catch === "function") out.catch(() => {});
  } catch {
    // push must never disturb the Telegram send beside this call
  }
}

/** The live sink: one outbox row per registered device with reminders on; the dispatcher sends them on its next tick. */
export function reminderSink(o: {
  store: PushStore; enabled: () => boolean; format: () => "up" | "ntfy"; now: () => number; counter?: GateCounter;
}): ReminderSink {
  return (r) => {
    if (!o.enabled()) return;
    const built = serialize(r.event, o.format(), o.counter);
    if (!built.ok) return;
    for (const ep of o.store.list()) {
      if (!wanted(o.store.getPrefs(ep.deviceId), r.event)) continue;
      o.store.enqueue(ep.deviceId, r.key, "reminder", built.payload, o.now());
    }
  };
}
