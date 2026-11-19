import * as db from "./db";
import type { Bot } from "grammy";
import { currency, shopOn, prayerOn } from "./profile";

export function registerClientCommands(bot: Bot): void {
  bot.command("clients", async (ctx) => {
    const clients = db.getActiveClients() as any[];
    if (clients.length === 0) {
      await ctx.reply("No clients yet. Add one with /newclient [name] [platform]\n\nPlatforms: mostaql, upwork, direct");
      return;
    }
    const platformEmoji: Record<string, string> = { mostaql: "🟢", upwork: "🟣", direct: "🔵", other: "⚪" };
    const lines = clients.map((c) => `${platformEmoji[c.platform] || "⚪"} *#${c.id}* ${c.name} (${c.platform})`);
    await ctx.reply(`👤 *Clients:*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
  });

  bot.command("projects", async (ctx) => {
    const projects = db.getActiveProjects() as any[];
    if (projects.length === 0) {
      await ctx.reply("No active projects. Add one with /newproject [client_id] [name]");
      return;
    }
    const lines = projects.map((p) => {
      const deadline = p.deadline ? ` (due: ${p.deadline})` : "";
      const budget = p.budget ? ` — ${p.budget} ${p.currency}` : "";
      const hours = p.estimated_hours ? ` [${p.actual_hours || 0}/${p.estimated_hours}h]` : "";
      const client = p.client_name ? ` [${p.client_name}]` : "";
      return `📦 *#${p.id}*${client} ${p.name}${deadline}${budget}${hours}`;
    });
    await ctx.reply(`📦 *Active Projects:*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
  });

  bot.command("newclient", async (ctx) => {
    const parts = ctx.match.trim().split(/\s+/);
    const platform = ["mostaql", "upwork", "direct", "other"].includes(parts[parts.length - 1])
      ? parts.pop()!
      : "direct";
    const name = parts.join(" ");
    if (!name) {
      await ctx.reply("Usage: /newclient [name] [platform]\nPlatforms: mostaql, upwork, direct, other\n\nExample: /newclient Ahmad mostaql");
      return;
    }
    const result = db.addClient(name, platform);
    await ctx.reply(`✅ Client added: *${name}* (${platform}) — ID #${result.lastInsertRowid}`, { parse_mode: "Markdown" });
  });

  bot.command("newproject", async (ctx) => {
    const parts = ctx.match.trim().split(/\s+/);
    const clientId = parseInt(parts[0], 10);
    const name = parts.slice(1).join(" ");
    if (!clientId || !name) {
      await ctx.reply(`Usage: /newproject [client_id] [project name]\n\nExample: /newproject 1 E-commerce website\n\nSet budget/deadline via chat: "set project 1 budget 2500 ${currency()} deadline 2026-04-15"`);
      return;
    }
    const client = db.getClient(clientId) as any;
    if (!client) {
      await ctx.reply(`Client #${clientId} not found. Use /clients to see your clients.`);
      return;
    }
    const result = db.addProject(name, clientId);
    await ctx.reply(`✅ Project created: *${name}* for ${client.name} — ID #${result.lastInsertRowid}\n\nSet details via chat or AI.`, { parse_mode: "Markdown" });
  });
}
