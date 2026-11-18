import * as db from "./db";
import type { Bot } from "grammy";
import { localToday } from "./utils";

export function registerQuranCommands(bot: Bot): void {
  bot.command("quran", async (ctx) => {
    const parts = ctx.match.trim().split(/\s+/);
    const pages = parseFloat(parts[0]);
    if (!pages || isNaN(pages)) {
      await ctx.reply("Usage: /quran [pages]\n\nExample: /quran 5\nOr chat naturally: \"قرأت 3 صفحات من القرآن\"");
      return;
    }
    const juz = parts[1] ? parseInt(parts[1], 10) : undefined;
    db.logQuranReading(pages, juz);
    const progress = db.getQuranProgress();
    await ctx.reply(
      `📖 Logged ${pages} pages. بارك الله فيك!\n\n` +
      `Total: ${progress.totalPages} pages across ${progress.daysRead} days` +
      (progress.totalPages >= 604 ? "\n🎉 You've completed a full Quran!" : `\n📊 ${((progress.totalPages / 604) * 100).toFixed(1)}% of the Quran`)
    );
  });

  bot.command("quranstats", async (ctx) => {
    const progress = db.getQuranProgress();
    const khatmas = Math.floor((progress.totalPages || 0) / 604);
    const remaining = 604 - ((progress.totalPages || 0) % 604);
    const avgPages = progress.daysRead > 0 ? ((progress.totalPages || 0) / progress.daysRead).toFixed(1) : "0";

    let msg = `📖 *Quran Progress*\n\n`;
    msg += `Total pages read: *${progress.totalPages || 0}*\n`;
    msg += `Days reading: *${progress.daysRead || 0}*\n`;
    msg += `Daily average: *${avgPages} pages*\n`;
    msg += `Khatmas completed: *${khatmas}*\n`;
    msg += `Pages to next khatma: *${remaining}*\n`;

    if (progress.latest) {
      msg += `\nLast reading: ${progress.latest.pages_read} pages${progress.latest.juz ? ` (Juz ${progress.latest.juz})` : ""} — ${progress.latest.date}`;
    }

    await ctx.reply(msg, { parse_mode: "Markdown" });
  });

  bot.command("adhkar", async (ctx) => {
    const type = ctx.match.trim().toLowerCase();
    if (!["morning", "evening"].includes(type)) {
      const today = localToday();
      const status = db.getAdhkarStatus(today);
      await ctx.reply(
        `🤲 *Today's Adhkar:*\n\n` +
        `${status.morning ? "✅" : "⬜"} Morning adhkar\n` +
        `${status.evening ? "✅" : "⬜"} Evening adhkar\n\n` +
        `Mark done: /adhkar morning or /adhkar evening`,
        { parse_mode: "Markdown" }
      );
      return;
    }
    db.logAdhkar(type);
    const emoji = type === "morning" ? "🌅" : "🌙";
    await ctx.reply(`${emoji} ${type.charAt(0).toUpperCase() + type.slice(1)} adhkar logged. جزاك الله خيرا!`);
  });
}

export function getDeenContext(): string {
  const today = localToday();
  const adhkar = db.getAdhkarStatus(today);
  const progress = db.getQuranProgress();

  let ctx = "";
  ctx += `Adhkar: ${adhkar.morning ? "✅" : "⬜"} Morning ${adhkar.evening ? "✅" : "⬜"} Evening\n`;
  ctx += `Quran: ${progress.totalPages || 0} total pages, ${progress.daysRead || 0} days`;
  if (progress.latest) {
    ctx += `, last: ${progress.latest.pages_read}p on ${progress.latest.date}`;
  }
  return ctx;
}
