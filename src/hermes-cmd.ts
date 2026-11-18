import { Bot } from "grammy";
import { startHermes } from "./agents";

// [item 3] Incoming Telegram -> Hermes acts.
// Routed through Tokyo's EXISTING single grammY poller (no second Telegram poller,
// which would conflict with the bot's getUpdates long-poll). The task is executed
// on the server via the working Claude subscription (the official `claude` CLI,
// reused from the /agent background runner), with a Hermes persona + the dev-stack
// skills under /root/.claude/skills. Owner-gated; runs in the background and sends
// the result back to the same chat when done.

const USER_ID = process.env.TELEGRAM_USER_ID;
function isOwner(ctx: any): boolean {
  return !!USER_ID && String(ctx.from?.id) === USER_ID;
}

export function registerHermesCommand(bot: Bot) {
  bot.command("hermes", async (ctx) => {
    if (!isOwner(ctx)) { await ctx.reply("Unauthorized."); return; }
    const task = (ctx.match || "").toString().trim();
    if (!task) {
      await ctx.reply(
        "🧠 *Hermes*\n\n" +
        "Ask Hermes to act on the server (uses your Claude subscription, runs in the background):\n\n" +
        "`/hermes <task>`\n\n" +
        "*Examples:*\n" +
        "  /hermes check disk usage and clean old logs\n" +
        "  /hermes summarize today's shopdemo auto-improve runs\n" +
        "  /hermes what changed in tokyo in the last 24h",
        { parse_mode: "Markdown" }
      );
      return;
    }
    try {
      const chatId = ctx.chat.id;
      const { sessionId } = startHermes(task, async (sid, result, success) => {
        const icon = success ? "✅" : "❌";
        const header = `${icon} *Hermes #${sid}*\n\n`;
        try {
          if (result.length > 3500) {
            await bot.api.sendMessage(chatId, header + result.slice(0, 3500), { parse_mode: "Markdown" });
            await bot.api.sendMessage(chatId, result.slice(3500, 7000));
          } else {
            await bot.api.sendMessage(chatId, header + result, { parse_mode: "Markdown" });
          }
        } catch {
          await bot.api.sendMessage(chatId, `Hermes #${sid}: ${result.slice(0, 4000)}`);
        }
      });
      await ctx.reply(
        `🧠 *Hermes #${sessionId} working...*\n\n_"${task}"_\n\n` +
        `Running in background — I'll send the result when done.`,
        { parse_mode: "Markdown" }
      );
    } catch (err: any) {
      await ctx.reply(`❌ Failed: ${err.message}`);
    }
  });
}
