import * as db from "./db";
import type { Bot } from "grammy";
import { localToday, localNow } from "./utils";

function getMonthRange(): { start: string; end: string } {
  const now = localNow();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];
  return { start, end };
}

export function registerFinanceCommands(bot: Bot): void {
  bot.command("income", async (ctx) => {
    const parts = ctx.match.trim().split(/\s+/);
    const amount = parseFloat(parts[0]);
    if (!amount || isNaN(amount)) {
      await ctx.reply("Usage: /income [amount] [source]\nSources: mostaql, upwork, direct, shop, saas\n\nExample: /income 1500 mostaql");
      return;
    }
    const source = parts[1] || "direct";
    db.logIncome(amount, source);
    await ctx.reply(`💰 Logged: ${amount} DH from ${source}`);
  });

  bot.command("shopsale", async (ctx) => {
    const parts = ctx.match.trim().split(/\s+/);
    const amount = parseFloat(parts[0]);
    if (!amount || isNaN(amount)) {
      await ctx.reply("Usage: /shopsale [revenue] [items_sold]\n\nExample: /shopsale 850 12");
      return;
    }
    const items = parseInt(parts[1], 10) || undefined;
    const today = localToday();
    db.logShopSale(today, amount, items);
    await ctx.reply(`🏪 Shop sale logged: ${amount} DH${items ? ` (${items} items)` : ""}`);
  });

  bot.command("money", async (ctx) => {
    const { start, end } = getMonthRange();
    const incomeSummary = db.getIncomeSummary(start, end);
    const shopSummary = db.getShopSalesSummary(start, end);

    let devTotal = 0;
    const devLines: string[] = [];
    for (const row of incomeSummary) {
      if (row.source !== "shop") {
        devTotal += row.total;
        devLines.push(`  ${row.source}: ${row.total} ${row.currency}`);
      }
    }

    const shopTotal = shopSummary.total || 0;
    const grandTotal = devTotal + shopTotal;

    const month = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });

    let msg = `💰 *Financial Summary — ${month}*\n\n`;
    msg += `👨‍💻 *Dev Income:* ${devTotal} DH\n`;
    if (devLines.length > 0) msg += devLines.join("\n") + "\n";
    msg += `\n🏪 *Shop Revenue:* ${shopTotal} DH`;
    if (shopSummary.days_tracked > 0) msg += ` (${shopSummary.days_tracked} days, ${shopSummary.total_items || "?"} items)`;
    msg += `\n\n📊 *Total:* ${grandTotal} DH`;

    await ctx.reply(msg, { parse_mode: "Markdown" });
  });

  bot.command("shops", async (ctx) => {
    const shops = db.getNeighborhoodShops() as any[];
    if (shops.length === 0) {
      await ctx.reply("No neighborhood shops tracked yet.\n\n/addshop [name] to add one.");
      return;
    }
    const levelEmoji: Record<string, string> = { cold: "🔵", warm: "🟡", hot: "🟠", onboarded: "🟢" };
    const lines = shops.map((s) =>
      `${levelEmoji[s.interest_level] || "⚪"} *#${s.id}* ${s.name}${s.owner_name ? ` (${s.owner_name})` : ""} — ${s.interest_level}`
    );
    await ctx.reply(`🏘 *Neighborhood Shops:*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
  });

  bot.command("addshop", async (ctx) => {
    const name = ctx.match.trim();
    if (!name) {
      await ctx.reply("Usage: /addshop [shop name]\n\nExample: /addshop Abu Ahmad Electronics");
      return;
    }
    const result = db.addNeighborhoodShop(name);
    await ctx.reply(`✅ Shop added: *${name}* — ID #${result.lastInsertRowid}\n\nSet details via chat (owner, phone, interest level).`, { parse_mode: "Markdown" });
  });
}

export function getFinancialContext(): string {
  const { start, end } = getMonthRange();
  const incomeSummary = db.getIncomeSummary(start, end);
  const shopSummary = db.getShopSalesSummary(start, end);

  let devTotal = 0;
  for (const row of incomeSummary) {
    if (row.source !== "shop") devTotal += row.total;
  }
  const shopTotal = shopSummary.total || 0;

  return `Dev: ${devTotal} DH | Shop: ${shopTotal} DH | Total: ${devTotal + shopTotal} DH`;
}
