import Anthropic from "@anthropic-ai/sdk";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { Classification } from "./classifier";
import { geminiChat } from "./gemini-client";
import { sendWhatsAppMessage } from "./whatsapp";
import * as db from "./db";
import { settingOn } from "./settings";
import type { ProjectRef } from "./project-registry";

const claude = new Anthropic({
  apiKey: process.env.CLIPROXY_API_KEY || process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.CLIPROXY_API_KEY ? "http://localhost:8317" : undefined,
});

const CHAT_ID = parseInt(process.env.TELEGRAM_USER_ID || "0");

export interface SdkReplyInput {
  content: string;
  sender_name: string;
  jid: string;
  is_group: boolean;
}

/**
 * Layer 1 — SDK-quick reply.
 * Calls the chosen SDK, auto-sends reply to WA, mirrors to Telegram with Undo/Correct buttons.
 */
export async function sdkReply(
  bot: Bot,
  msg: SdkReplyInput,
  classification: Classification,
  project: ProjectRef,
): Promise<number | null> {
  // Master pause switch (dashboard: WhatsApp -> auto-reply). Nothing goes to the
  // contact while it is off; the message still lands on Telegram.
  if (!settingOn("WA_AUTO_REPLIES")) {
    console.log(`[sdk-reply] paused (WA_AUTO_REPLIES=0) - nothing sent to ${msg.sender_name}`);
    await bot.api
      .sendMessage(CHAT_ID, `WA auto-reply is off.\n*${msg.sender_name}*: ${msg.content.slice(0, 300)}`, { parse_mode: "Markdown" })
      .catch(() => {});
    return null;
  }

  const started = Date.now();
  const systemPrompt = buildSystemPrompt(project, msg.sender_name);
  const userMsg = msg.content.trim();

  let replyText = "";
  let actualProvider: "claude" | "gemini" = classification.provider;
  let actualModel = classification.model;
  let fallbackReason: string | null = null;

  try {
    if (classification.provider === "gemini") {
      const result = await geminiChat(
        systemPrompt,
        [{ role: "user", content: userMsg }],
        500,
        classification.model,
      );
      replyText = result.text;
      actualProvider = result.provider;
      actualModel = result.model;
      if (result.usedFallback) fallbackReason = result.reason ?? "gemini_fallback";
    } else {
      const response = await claude.messages.create({
        model: classification.model,
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: "user", content: userMsg }],
      });
      replyText = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
    }
  } catch (err: any) {
    await notifyProviderFailure(bot, msg, err?.message || String(err));
    return null;
  }

  if (!replyText) {
    await notifyProviderFailure(bot, msg, "empty_reply");
    return null;
  }

  try {
    await sendWhatsAppMessage(msg.jid, replyText);
  } catch (err: any) {
    await notifyProviderFailure(bot, msg, `wa_send_failed: ${err?.message || err}`);
    return null;
  }

  const latency = Date.now() - started;
  const id = db.insertSdkReply({
    wa_jid: msg.jid,
    sender_name: msg.sender_name,
    content_preview: msg.content,
    layer: classification.layer,
    provider: actualProvider,
    model: actualModel,
    reply: replyText,
    fallback_reason: fallbackReason,
    latency_ms: latency,
  });

  await mirrorToTelegram(bot, msg, replyText, classification, actualProvider, actualModel, latency, id);
  return id;
}

function buildSystemPrompt(project: ProjectRef, senderName: string): string {
  return [
    `You are Tokyo, a personal assistant speaking on behalf of the user to a WhatsApp contact named "${senderName}".`,
    `This contact is linked to the "${project.name}" project.`,
    `Reply concisely and directly in the same language the contact used. Arabic, English, French, and Darija are all supported.`,
    `Do not promise code changes, deploys, or technical work — those need the user's approval (a different flow handles them).`,
    `Do not invent facts about the project's current state. If asked about status, say you'll check with the user.`,
    `Keep replies under ~3 short sentences unless the question clearly needs more.`,
    `Never reveal that you are an AI or that you are automated — just reply naturally as the user's assistant.`,
  ].join(" ");
}

async function mirrorToTelegram(
  bot: Bot,
  msg: SdkReplyInput,
  reply: string,
  classification: Classification,
  provider: string,
  model: string,
  latencyMs: number,
  replyId: number,
): Promise<void> {
  if (!CHAT_ID) return;
  const preview = msg.content.length > 300 ? msg.content.slice(0, 300) + "…" : msg.content;
  const replyPreview = reply.length > 400 ? reply.slice(0, 400) + "…" : reply;

  const header = `💬 \`sdk-quick · ${provider}/${model} · ${latencyMs}ms\``;
  const body =
    `WA from *${escape(msg.sender_name)}*${msg.is_group ? " (group)" : ""}:\n` +
    `"${escape(preview)}"\n` +
    `─────\n` +
    `Tokyo replied:\n` +
    `"${escape(replyPreview)}"`;
  const text = `${header}\n${body}`;

  const keyboard = new InlineKeyboard()
    .text("↩️ Undo", `sdk_undo:${replyId}`)
    .text("✏️ Correct", `sdk_correct:${replyId}`);

  try {
    await bot.api.sendMessage(CHAT_ID, text, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  } catch {
    await bot.api.sendMessage(CHAT_ID, text.replace(/[*_`]/g, ""), {
      reply_markup: keyboard,
    });
  }
}

async function notifyProviderFailure(
  bot: Bot,
  msg: SdkReplyInput,
  reason: string,
): Promise<void> {
  if (!CHAT_ID) return;
  const text =
    `⚠️ sdk-quick reply FAILED for WA from ${msg.sender_name}\n` +
    `reason: \`${reason}\`\n` +
    `message: "${msg.content.slice(0, 200)}"\n` +
    `(no WA reply sent — review and respond manually)`;
  await bot.api.sendMessage(CHAT_ID, text, { parse_mode: "Markdown" }).catch(() => {
    bot.api.sendMessage(CHAT_ID, text.replace(/[*_`]/g, ""));
  });
}

function escape(s: string): string {
  return s.replace(/([_*`\[\]])/g, "\\$1");
}

// =============================
// Undo / Correct callbacks
// =============================

const UNDO_TTL_MS = 15 * 60 * 1000;
const pendingCorrection = new Map<number, { sdkReplyId: number; at: number }>();

export function registerSdkReply(bot: Bot): void {
  bot.callbackQuery(/^sdk_undo:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const row = db.getSdkReply(id);
    if (!row) {
      await ctx.answerCallbackQuery({ text: "Not found" });
      return;
    }
    if (row.undo === 1) {
      await ctx.answerCallbackQuery({ text: "Already undone" });
      return;
    }
    if (Date.now() - row.created_at > UNDO_TTL_MS) {
      await ctx.answerCallbackQuery({ text: "Too late — send a new WA message" });
      return;
    }

    const undoNote =
      "↩️ please disregard my last message — let me clarify in a moment";
    try {
      await sendWhatsAppMessage(row.wa_jid, undoNote);
    } catch (err: any) {
      await ctx.answerCallbackQuery({ text: `WA send failed: ${err?.message}` });
      return;
    }

    db.markSdkReplyUndo(id);
    await ctx.answerCallbackQuery({ text: "Undone" });
    try {
      await ctx.editMessageText(
        `~~${(ctx.callbackQuery.message as any)?.text || ""}~~\n\n↩️ Undone — follow-up WA sent.`,
      );
    } catch {
      /* ignore */
    }
  });

  bot.callbackQuery(/^sdk_correct:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const row = db.getSdkReply(id);
    if (!row) {
      await ctx.answerCallbackQuery({ text: "Not found" });
      return;
    }
    if (Date.now() - row.created_at > UNDO_TTL_MS) {
      await ctx.answerCallbackQuery({ text: "Too late to correct" });
      return;
    }
    const chatId = ctx.chat?.id || CHAT_ID;
    pendingCorrection.set(chatId, { sdkReplyId: id, at: Date.now() });
    await ctx.answerCallbackQuery({ text: "Send the corrected text as a reply" });
    await ctx.reply(
      `✏️ Send the corrected reply for WA from ${row.sender_name || "contact"} as your next message. (5 min window.)`,
    );
  });
}

/**
 * If the user has a pending correction for this chat, treat the text as the new reply,
 * resend it to WA, mark the row corrected, and return true (so caller can short-circuit).
 */
export async function consumeSdkCorrection(
  chatId: number,
  text: string,
): Promise<boolean> {
  const entry = pendingCorrection.get(chatId);
  if (!entry) return false;
  if (Date.now() - entry.at > 5 * 60 * 1000) {
    pendingCorrection.delete(chatId);
    return false;
  }
  pendingCorrection.delete(chatId);

  const row = db.getSdkReply(entry.sdkReplyId);
  if (!row) return false;

  try {
    await sendWhatsAppMessage(row.wa_jid, text);
  } catch (err: any) {
    // surfaced to caller via return false; they can still handle as normal text
    console.error("[sdk-correct] WA send failed:", err?.message);
    return false;
  }

  db.markSdkReplyCorrected(entry.sdkReplyId, text);
  return true;
}
