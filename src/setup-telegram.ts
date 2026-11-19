/**
 * /setup in Telegram: asks the profile questions one by one and saves each answer
 * to the settings table (the same values the dashboard Settings page edits).
 * Never asks for API keys: those stay in .env (`npm run setup`).
 * Only the owner reaches this: the guard in index.ts drops every other sender.
 */
import { InlineKeyboard, type Bot, type Context } from "grammy";
import { SETUP_STEPS, parseAnswer, countryDefaults, type SetupStep } from "./setup-steps";
import { saveSetting, setting, validateSetting } from "./settings";

interface Session { step: number; answers: Record<string, string> }
const sessions = new Map<number, Session>();

function current(step: SetupStep): string | undefined {
  const v = setting(step.key);
  if (step.kind === "bool") return v === "1" ? "yes" : v === "0" ? "no" : undefined;
  return v || undefined;
}

function questionText(step: SetupStep, index: number, answers: Record<string, string>): { text: string; kb: InlineKeyboard } {
  const kb = new InlineKeyboard();
  const lines = [`*${index + 1}/${SETUP_STEPS.length}* ${step.question}`];
  if (step.hint) lines.push(`_${step.hint}_`);
  const now = current(step);
  if (now) lines.push(`Now: ${now}`);
  if (step.kind === "bool") {
    kb.text("Yes", "setup:yes").text("No", "setup:no").row();
  } else {
    const suggestion = step.suggest?.(answers);
    if (suggestion && suggestion.length <= 50) kb.text(`Use ${suggestion}`, `setup:use:${suggestion}`).row();
  }
  kb.text("Skip", "setup:skip").text("Stop", "setup:stop");
  return { text: lines.join("\n"), kb };
}

async function ask(ctx: Context, chatId: number): Promise<void> {
  const s = sessions.get(chatId);
  if (!s) return;
  if (s.step >= SETUP_STEPS.length) {
    sessions.delete(chatId);
    await ctx.reply(finishText(), { parse_mode: "Markdown" });
    return;
  }
  const { text, kb } = questionText(SETUP_STEPS[s.step], s.step, s.answers);
  await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
}

function finishText(): string {
  const yesNo = (k: string) => (setting(k) === "1" ? "on" : "off");
  return [
    "✅ *Profile saved.*",
    "",
    `Name: ${setting("PROFILE_NAME") || "-"}`,
    `Place: ${[setting("PROFILE_CITY"), setting("PROFILE_COUNTRY")].filter(Boolean).join(", ") || "-"}`,
    `Timezone: ${setting("TIMEZONE") || "UTC"}`,
    `Language: ${setting("PROFILE_LANGUAGE") || "same as you write"}`,
    `Currency: ${setting("CURRENCY") || "USD"}`,
    `Work: ${setting("PROFILE_WORK") || "-"}`,
    `Prayer: ${yesNo("FEATURE_PRAYER")} · Shop: ${yesNo("FEATURE_SHOP")} · WhatsApp: ${yesNo("FEATURE_WHATSAPP")}`,
    "",
    "Your answers apply from the next message. Turning a feature on or off fully applies after Tokyo restarts.",
    "Change anything later with /setup or on the dashboard Settings page.",
  ].join("\n");
}

/** Saves one answer. Returns an error to show, or null when the wizard can move on. */
export function applyAnswer(s: Session, raw: string): string | null {
  const step = SETUP_STEPS[s.step];
  const parsed = parseAnswer(step, raw);
  if (parsed.error) return parsed.error;
  if (!parsed.skip && parsed.value !== undefined) {
    const err = validateSetting(step.key, parsed.value);
    if (err) return `That doesn't work: ${err}.`;
    saveSetting(step.key, parsed.value);
    s.answers[step.key] = parsed.value;
    // A known country also sets the prayer calculation method, when it is one of the offered methods.
    if (step.key === "FEATURE_PRAYER" && parsed.value === "1") {
      const method = countryDefaults(s.answers.PROFILE_COUNTRY ?? setting("PROFILE_COUNTRY"))?.prayerMethod;
      if (method && !validateSetting("PRAYER_METHOD", method)) saveSetting("PRAYER_METHOD", method);
    }
  } else if (setting(step.key)) {
    s.answers[step.key] = setting(step.key)!;
  }
  s.step += 1;
  return null;
}

export function registerSetup(bot: Bot): void {
  bot.command("setup", async (ctx) => {
    const chatId = ctx.chat.id;
    sessions.set(chatId, { step: 0, answers: {} });
    await ctx.reply(
      "⚙️ *Setup* — a few questions so Tokyo fits you. Answer by typing, or tap a button. Your API keys are never asked here.",
      { parse_mode: "Markdown" },
    );
    await ask(ctx, chatId);
  });

  bot.callbackQuery(/^setup:(yes|no|skip|stop|use:.+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const s = chatId !== undefined ? sessions.get(chatId) : undefined;
    await ctx.answerCallbackQuery().catch(() => {});
    if (!s || chatId === undefined) return;
    const action = ctx.match[1];
    if (action === "stop") {
      sessions.delete(chatId);
      await ctx.reply("Setup stopped. Answers so far are saved. Send /setup to continue.");
      return;
    }
    const raw = action === "skip" ? "skip" : action.startsWith("use:") ? action.slice(4) : action;
    const err = applyAnswer(s, raw);
    if (err) await ctx.reply(err);
    await ask(ctx, chatId);
  });

  // While a setup is running, plain text answers the current question.
  bot.on("message:text", async (ctx, next) => {
    const s = sessions.get(ctx.chat.id);
    if (!s || ctx.message.text.startsWith("/")) return next();
    const err = applyAnswer(s, ctx.message.text);
    if (err) await ctx.reply(err);
    await ask(ctx, ctx.chat.id);
  });
}

/** True once the owner has given at least a name or their work (from /setup, the dashboard or .env). */
export function profileIsSet(): boolean {
  const name = setting("PROFILE_NAME");
  return Boolean((name && name !== "The owner") || setting("PROFILE_WORK") || process.env.OWNER_NAME);
}
