/**
 * WhatsApp Shop-Group Sales Tracker
 *
 * the seller posts individual sale amounts as bare numbers in the Myshop group.
 * Tokyo logs each number as a sale and replies with totals on trigger words.
 * General questions get an AI reply via the chat() function.
 */

import Database from "better-sqlite3";
import { execFileSync } from "child_process";
import * as db from "./db";
import { formatShopAiContext, applyStatsSince, statsSince } from "./dashboard/shop-insights";
import { setting, settingOn } from "./settings";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// The shop group has moved once already: the original group went silent
// 2026-04-18 and the seller moved to a new one on 2026-08-21. Track every JID the
// shop has ever used so history and triggers keep working across the move.
export const MYSHOP_GROUP_JIDS: string[] = (
  process.env.MYSHOP_GROUP_JIDS ||
  process.env.MYSHOP_GROUP_JID ||
  ""
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** The group Tokyo replies in — the first (current) JID. */
export const MYSHOP_GROUP_JID = MYSHOP_GROUP_JIDS[0];

// Announce the wiring at startup. A stale MYSHOP_GROUP_JID in .env once silently
// pointed this at a dead group, and the only symptom was total silence.
console.log(
  `shop-group: watching ${MYSHOP_GROUP_JIDS.length} group(s), replying in ${MYSHOP_GROUP_JID}` +
  (settingOn("SHOP_AI_REPLIES") ? " (AI replies ON)" : " (AI replies off)")
);

// Announce the stats epoch for the same reason the JIDs are announced: a value
// silently set in .env that hides history is worth one line in the log.
console.log(
  statsSince()
    ? `shop-group: statistics start at ${statsSince()} (earlier sales stay in the DB but are excluded)`
    : "shop-group: statistics cover all logged sales",
);

/** Brand name used in the totals reply header (prefix emoji 🛒 is added separately) */
const SHOP_DISPLAY_NAME = "My Shop";
/** Full brand name with emoji, used in AI prompt context */
const SHOP_FULL_NAME = "My Shop 🛒";

export function isShopGroup(jid: string): boolean {
  return settingOn("FEATURE_SHOP") && MYSHOP_GROUP_JIDS.includes(jid);
}

// ---------------------------------------------------------------------------
// Outgoing-message-id tracker
// ---------------------------------------------------------------------------
// Bounded set of message ids Tokyo has sent into the shop group, so we can
// skip them when baileys echoes them back as incoming events.
//
// Behavior matrix:
//   Incoming bare number from the seller (fromMe=0) → log sale ✓
//   Incoming bare number from owner (fromMe=1)  → log sale ✓ (owner entering on the seller's behalf)
//   Trigger word "احسب" from owner             → totals reply ✓ (fixed)
//   General question "ما هي الارباح" from owner → AI reply ✓ (fixed)
//   Tokyo's own totals/AI message echoing back  → skipped via isOurOutgoing ✓
//   Non-shop-group message                       → unchanged ✓
const outgoingIds = new Set<string>();
const MAX_OUTGOING_TRACKED = 200;

export function markOutgoing(messageId: string | undefined | null): void {
  if (!messageId) return;
  if (outgoingIds.size >= MAX_OUTGOING_TRACKED) {
    // Evict oldest (insertion order) — Set preserves insertion order
    const first = outgoingIds.values().next().value;
    if (first) outgoingIds.delete(first);
  }
  outgoingIds.add(messageId);
}

export function isOurOutgoing(messageId: string | undefined | null): boolean {
  return !!messageId && outgoingIds.has(messageId);
}



// ---------------------------------------------------------------------------
// Chat function injection (avoids circular dependency with ai.ts)
// ---------------------------------------------------------------------------

/**
 * Type for the chat injection point.
 * Production: import { chat } from "./ai" and pass chat.
 * Tests: pass a mock that resolves immediately.
 */
export type ChatFn = (prompt: string) => Promise<string>;

let _chatFn: ChatFn | null = null;

/** Called by index.ts at startup to wire in the AI chat function. */
export function setShopChatFn(fn: ChatFn): void {
  _chatFn = fn;
}

// ---------------------------------------------------------------------------
// parseSaleAmount
// ---------------------------------------------------------------------------

/**
 * Returns a positive number if the text is a single numeric token
 * (optionally followed by a currency suffix). Returns null otherwise.
 *
 * Accepted:   "450", "20.2", "10,4", "25dh", "25 DH", "100 درهم", "25 MAD"
 * Rejected:   multi-line, extra words, negatives, 0, >100000
 */
export function parseSaleAmount(text: string): number | null {
  const t = text.trim();

  // Reject multi-line early
  if (t.includes("\n") || t.includes("\r")) return null;

  // Regex: optional sign NOT allowed. Number with optional decimal (dot or comma).
  // Optional currency suffix.
  const match = t.match(
    /^(\d{1,6}(?:[.,]\d{1,2})?)\s*(dh|mad|درهم)?$/i
  );
  if (!match) return null;

  // Normalize European decimal (comma → dot)
  const numStr = match[1].replace(",", ".");
  const n = parseFloat(numStr);

  if (isNaN(n) || n <= 0 || n > 100000) return null;

  return n;
}

// ---------------------------------------------------------------------------
// Python-backed decimal sum
// ---------------------------------------------------------------------------

/**
 * Type for the exec injection point — accepts execFileSync signature.
 * Tests pass a mock; production uses the real execFileSync.
 */
export type ExecFn = (cmd: string, args: string[], opts: { input: string; encoding: "utf8" }) => string;

/**
 * Sum an array of amounts using Python's Decimal to avoid JS float drift.
 * e.g. [10.4, 20.2, 2.7, 100.5, 47.6] → 181.40 (not 181.39999...)
 *
 * Accepts an optional execFn injection point for unit tests.
 * Falls back to JS sum rounded to 2 decimals if python3 throws.
 */
export function sumDhPython(amounts: number[], execFn?: ExecFn): number {
  if (amounts.length === 0) return 0;

  const exec: ExecFn = execFn ?? ((cmd, args, opts) =>
    execFileSync(cmd, args, opts) as unknown as string
  );

  const input = amounts.join("\n");
  try {
    const out = exec("python3", ["-c",
      "import sys; from decimal import Decimal; " +
      "print(sum(Decimal(l.strip()) for l in sys.stdin if l.strip()))"
    ], { input, encoding: "utf8" });
    return parseFloat(out.trim());
  } catch (err) {
    console.error("shop-group: python3 sum failed, falling back to JS:", err);
    const jsSum = amounts.reduce((a, b) => a + b, 0);
    return Math.round(jsSum * 100) / 100;
  }
}

// ---------------------------------------------------------------------------
// Trigger detection
// ---------------------------------------------------------------------------

export const CALCULATE_TRIGGERS: string[] = [
  "calculate",
  "total",
  "totals",
  "sum",
  "احسب",
  "المجموع",
  "الحساب",
  "كم",
  "combien",
];

// Explicit slash / bang commands. Checked as a whole-message match, because
// \b word boundaries don't work against a leading "/" or "!".
const COMMAND_TRIGGERS = new Set([
  "/sum", "!sum",
  "/total", "!total",
  "/totals", "!totals",
  "/today", "!today",
  "/7ssab", "!7ssab",
]);

// Arabic triggers that don't support \b word boundary (unicode chars)
const ARABIC_TRIGGERS = new Set(["احسب", "المجموع", "الحساب", "كم"]);

// Arabic triggers that are valid only when the entire message is just that trigger
// (e.g. "كم" alone = "how much" → show totals; "كم بعنا اليوم?" = general question)
const ARABIC_STANDALONE_TRIGGERS = new Set(["كم"]);

/**
 * Returns true if text is a pure calculate trigger.
 * Latin triggers use \b word boundary to avoid false positives (calculator).
 * Arabic-standalone triggers only match when the message IS the trigger word (stripped of punctuation).
 * Other Arabic triggers use plain contains.
 */
export function isTriggerMessage(text: string): boolean {
  const lower = text.toLowerCase().trim();
  // Strip trailing punctuation for standalone checks
  const stripped = lower.replace(/[؟?!.،,]+$/, "").trim();
  if (COMMAND_TRIGGERS.has(lower) || COMMAND_TRIGGERS.has(stripped)) return true;
  for (const trigger of CALCULATE_TRIGGERS) {
    if (ARABIC_STANDALONE_TRIGGERS.has(trigger)) {
      // Only match if the entire message is just this word (possibly with punctuation)
      if (stripped === trigger) return true;
    } else if (ARABIC_TRIGGERS.has(trigger)) {
      if (lower.includes(trigger)) return true;
    } else {
      if (new RegExp(`\\b${trigger}\\b`, "i").test(text)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// formatTotals
// ---------------------------------------------------------------------------

function fmtAmount(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatTotals(totals: db.ShopSaleTotals): string {
  return (
    `🛒 ${SHOP_DISPLAY_NAME} — Totals (${process.env.TIMEZONE || "UTC"})\n\n` +
    `Today: ${fmtAmount(totals.today.amount)} DH (${totals.today.count} items)\n` +
    `This week: ${fmtAmount(totals.week.amount)} DH (${totals.week.count} items)\n` +
    `This month: ${fmtAmount(totals.month.amount)} DH (${totals.month.count} items)\n` +
    `All-time: ${fmtAmount(totals.allTime.amount)} DH (${totals.allTime.count} items)`
  );
}

// ---------------------------------------------------------------------------
// Build AI prompt for general questions
// ---------------------------------------------------------------------------

function buildShopChatPrompt(
  userMessage: string,
  totals: db.ShopSaleTotals,
  recentItems: Array<{ amount_dh: number; sender_name: string | null; logged_date: string }>,
  dbOverride?: Database.Database,
): string {
  const todayItems = recentItems
    .slice(0, 10)
    .map((r, i) => `  ${i + 1}. ${fmtAmount(r.amount_dh)} DH (${r.sender_name || "unknown"})`)
    .join("\n");

  return (
    `You are Tokyo's shop assistant for a small shop called "${SHOP_FULL_NAME}".\n` +
    `The shop owner's partner the seller logs each sale as a bare DH number in this group.\n` +
    `Answer in the language of the question (any language or dialect).\n` +
    `Keep reply under 800 characters.\n` +
    `Ground every claim in the brief below. If it does not answer the question, say so\n` +
    `rather than inventing a number.\n\n` +
    `${buildShopBrief(dbOverride)}\n\n` +
    `Today's totals as logged: ${fmtAmount(totals.today.amount)} DH over ${totals.today.count} items.\n` +
    `Last ${recentItems.slice(0, 10).length} sales today:\n${todayItems || "  (none yet)"}\n\n` +
    `User message: ${userMessage}`
  );
}

/**
 * The hour / day / month brief the dashboard shows, rendered for the model.
 *
 * Shares shop-insights with /api/shop, so an answer in WhatsApp and the number
 * on the dashboard come from the same arithmetic. Falls back to a short note
 * rather than throwing: a broken brief must not cost the user their reply.
 */
function buildShopBrief(dbOverride?: Database.Database): string {
  try {
    const rows = db.getAllShopSaleItems(dbOverride);
    if (!rows.length) return "No sales have been logged yet.";
    const { localToday, weekStartDate } = require("./utils");
    const weekStart: string = weekStartDate();
    const prev = new Date(weekStart + "T12:00:00Z");
    prev.setUTCDate(prev.getUTCDate() - 7);
    // Resolve the hour in the shop's timezone explicitly, exactly as /api/shop
    // does. getHours() would agree only for as long as the server clock happens
    // to be set to the same zone, and would silently shift the whole BY HOUR
    // table the day that stops being true.
    const tz = process.env.TIMEZONE || "UTC";
    const hourOf = (ts: number) =>
      parseInt(
        new Date(ts * 1000).toLocaleString("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }),
        10,
      ) || 0;
    const sales = applyStatsSince(
      rows.map((r) => ({
        amount: r.amount_dh,
        date: r.logged_date,
        hour: hourOf(r.timestamp),
        sender: r.sender_name || "unknown",
        source: r.source || "text",
      })),
    );
    if (!sales.length) return "No sales have been logged since the stats start date.";
    return formatShopAiContext({
      sales,
      today: localToday(),
      weekStart,
      prevWeekStart: prev.toISOString().slice(0, 10),
      multiplier: Number(setting("SHOP_PRICE_MULTIPLIER")) > 0
        ? Number(setting("SHOP_PRICE_MULTIPLIER"))
        : 10,
    });
  } catch (err) {
    console.error("shop-group: could not build sales brief:", err);
    return "Sales brief unavailable for this reply.";
  }
}

// ---------------------------------------------------------------------------
// handleShopGroupMessage
// ---------------------------------------------------------------------------

export interface ShopGroupMsg {
  jid: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: number;
  fromMe: boolean;
  transcription?: string;
  messageId?: string | null;
}

export async function handleShopGroupMessage(
  msg: ShopGroupMsg,
  sock: any,
  dbOverride?: Database.Database,
  chatFn?: ChatFn,
): Promise<void> {
  if (!isShopGroup(msg.jid)) return;
  if (isOurOutgoing(msg.messageId)) return; // Tokyo's own echo; skip.

  const text = (msg.transcription || msg.content || "").trim();
  if (!text) return;

  // Our own totals reply contains the word "Totals", which is itself a trigger.
  // The outgoing-id set normally catches the echo, but it is in-memory and lost
  // on restart — so also recognise the reply by its header and never act on it.
  if (text.startsWith(`\u{1F6D2} ${SHOP_DISPLAY_NAME}`)) return;

  const source: "text" | "voice" = msg.transcription ? "voice" : "text";

  // --- Undo: remove last sale ---
  const undoText = text.toLowerCase();
  if (undoText === "undo" || undoText === "!undo") {
    const removed = db.deleteLastShopSaleItem(msg.jid, dbOverride);
    if (removed && sock) {
      try {
        await sock.sendMessage(msg.jid, {
          text: `Removed last entry: ${fmtAmount(removed.amount_dh)} DH`,
        });
      } catch (err) {
        console.error("shop-group: failed to send undo reply:", err);
      }
    } else if (!removed) {
      console.log("shop-group: undo called but no items to remove");
    }
    return;
  }

  // --- Parse sale amount ---
  const amount = parseSaleAmount(text);
  if (amount !== null) {
    try {
      db.logShopSaleItem(
        {
          jid: msg.jid,
          sender: msg.sender || null,
          senderName: msg.senderName || null,
          amount,
          source,
          rawContent: text.slice(0, 60),
          timestamp: msg.timestamp,
        },
        dbOverride,
      );
      console.log(`shop-group: Logged ${amount} DH from ${msg.senderName}`);
    } catch (err) {
      console.error("shop-group: failed to log sale item:", err);
    }
    return;
  }

  // --- Trigger: send totals ---
  if (isTriggerMessage(text)) {
    if (!sock) {
      console.log("shop-group: trigger received but sock is null — skipping reply");
      return;
    }
    try {
      const totals = db.getShopItemsTotals(dbOverride);
      const reply = formatTotals(totals);
      const sent = await sock.sendMessage(msg.jid, { text: reply });
      markOutgoing(sent?.key?.id ?? null);
      console.log(`shop-group: totals sent to ${msg.jid} (trigger: "${text.slice(0, 20)}")`);
    } catch (err) {
      console.error("shop-group: failed to send totals:", err);
    }
    return;
  }

  // --- General question: answer via AI ---
  // Guard: message >=5 chars and a chatFn is available.
  // fromMe=true is fine here — it means the owner typed from their own phone.
  // Tokyo's own echoes are already filtered at the top via isOurOutgoing.
  // Use injected parameter (tests) or the module-level fn set by index.ts (production)
  // Off by default: enabling the group for /sum should not also turn Tokyo into
  // a chatbot that answers every unrelated message the seller sends.
  // Set SHOP_AI_REPLIES=1 to turn free-form answers back on.
  const aiRepliesEnabled = settingOn("SHOP_AI_REPLIES");
  const effectiveChatFn = chatFn ?? _chatFn ?? null;
  if (aiRepliesEnabled && text.length >= 5 && effectiveChatFn) {
    try {
      const totals = db.getShopItemsTotals(dbOverride);
      const { localToday } = require("./utils");
      const todayItems = db.getShopItemsForDate(localToday(), dbOverride);
      const prompt = buildShopChatPrompt(text, totals, todayItems, dbOverride);
      const response = await effectiveChatFn(prompt);
      const reply = response.slice(0, 1000);
      if (sock && reply) {
        const sent = await sock.sendMessage(msg.jid, { text: reply });
        markOutgoing(sent?.key?.id ?? null);
      }
    } catch (err) {
      console.error("shop-group: AI reply failed (silent):", err);
      // Stay silent — don't spam group with error messages
    }
  }
}
