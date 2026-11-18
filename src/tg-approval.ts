// "yes" typed in the Telegram chat answers the newest open card. The inline buttons
// are a shortcut, not the only way: a card that can only be answered by tapping an
// emoji silently expires when the owner replies in words (seen 2026-09-20, a run that
// was never started while the chat claimed it was waiting).

export type Approval = "yes" | "no";

const YES = [
  "y", "yes", "yes please", "yeah", "yep", "yup", "ok", "okay", "k", "sure", "fine",
  "go", "go ahead", "do it", "run", "run it", "start", "approve", "approved", "confirm",
  "deploy", "ship", "ship it", "👍", "✅", "🚀",
  "نعم", "ايه", "إيه", "اه", "آه", "اوك", "أوك", "واخا", "واخة", "موافق", "سير", "سير عليه",
  "دير", "دوز", "طلق", "بسم الله",
  "oui", "vas-y", "ok vas-y", "d'accord",
];

const NO = [
  "n", "no", "nope", "not now", "later", "cancel", "stop", "skip", "don't", "dont", "no thanks",
  "❌", "🚫",
  "لا", "لأ", "ماشي", "ماشي دابا", "بلاتي", "ماتديرش", "سير فحالك",
  "non", "annule", "pas maintenant",
];

const strip = (t: string) => t.trim().toLowerCase().replace(/[!.,؟?…]+$/u, "").replace(/\s+/g, " ");

export function parseApproval(text: string): Approval | null {
  const t = strip(text);
  if (!t || t.length > 24) return null; // a sentence is a request, not an answer
  if (YES.includes(t)) return "yes";
  if (NO.includes(t)) return "no";
  return null;
}

export type PendingKind = "run" | "deploy" | "mission" | "mission_deploy";

export interface PendingRef {
  kind: PendingKind;
  id: string;
  createdAt: number;
  project: string;
}

/** The card the owner is most likely answering: the newest one still open. */
export function mostRecent(items: (PendingRef | null | undefined)[]): PendingRef | null {
  let best: PendingRef | null = null;
  for (const i of items) if (i && (!best || i.createdAt > best.createdAt)) best = i;
  return best;
}
