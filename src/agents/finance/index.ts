import type { Agent, AgentContext, AgentResult, AgentDomain } from "../types";
import type { AgentEvent } from "../event-bus";
import { localToday, localNow } from "../../utils";
import { currency, shopOn } from "../../profile";

// ─── Helpers ───────────────────────────────────────────────

function getTodayStr(): string {
  return localToday();
}

function getMonthRange(): { start: string; end: string } {
  const now = localNow();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];
  return { start, end };
}

// ─── Command Handlers ──────────────────────────────────────

async function handleIncome(args: string, ctx: AgentContext): Promise<AgentResult> {
  const parts = args.trim().split(/\s+/);
  const amount = parseFloat(parts[0]);
  if (!amount || isNaN(amount)) {
    return { success: false, output: `Usage: /income [amount] [source]\nSources: direct (salary, cash, transfers), upwork, mostaql, saas, other${shopOn() ? ", shop" : ""}\n\nExample: /income 1500 direct` };
  }
  const source = parts[1] || "direct";
  ctx.db.logIncome(amount, source);
  return { success: true, output: `💰 Logged: ${amount} ${currency()} from ${source}` };
}

async function handleShopSale(args: string, ctx: AgentContext): Promise<AgentResult> {
  const parts = args.trim().split(/\s+/);
  const amount = parseFloat(parts[0]);
  if (!amount || isNaN(amount)) {
    return { success: false, output: "Usage: /shopsale [revenue] [items_sold]\n\nExample: /shopsale 850 12" };
  }
  const items = parseInt(parts[1], 10) || undefined;
  const today = getTodayStr();
  ctx.db.logShopSale(today, amount, items);
  return { success: true, output: `🏪 Shop sale logged: ${amount} ${currency()}${items ? ` (${items} items)` : ""}` };
}

async function handleMoney(ctx: AgentContext): Promise<AgentResult> {
  const { start, end } = getMonthRange();
  const incomeSummary = ctx.db.getIncomeSummary(start, end);
  const shopSummary = ctx.db.getShopSalesSummary(start, end);

  let devTotal = 0;
  const devLines: string[] = [];
  for (const row of incomeSummary) {
    if (row.source !== "shop") {
      devTotal += row.total;
      devLines.push(`  ${row.source}: ${row.total} ${row.currency}`);
    }
  }

  const shopTotal = shopSummary.total || 0;
  const grandTotal = devTotal + (shopOn() ? shopTotal : 0);

  const month = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });

  let msg = `💰 *Financial Summary — ${month}*\n\n`;
  const cur = currency();
  msg += `💼 *Work Income:* ${devTotal} ${cur}\n`;
  if (devLines.length > 0) msg += devLines.join("\n") + "\n";
  if (shopOn()) {
    msg += `\n🏪 *Shop Revenue:* ${shopTotal} ${cur}`;
    if (shopSummary.days_tracked > 0) msg += ` (${shopSummary.days_tracked} days, ${shopSummary.total_items || "?"} items)`;
  }
  msg += `\n\n📊 *Total:* ${grandTotal} ${cur}`;

  return { success: true, output: msg };
}

async function handleShops(ctx: AgentContext): Promise<AgentResult> {
  const shops = ctx.db.getNeighborhoodShops() as any[];
  if (shops.length === 0) {
    return { success: true, output: "No neighborhood shops tracked yet.\n\n/addshop [name] to add one." };
  }
  const levelEmoji: Record<string, string> = { cold: "🔵", warm: "🟡", hot: "🟠", onboarded: "🟢" };
  const lines = shops.map((s) =>
    `${levelEmoji[s.interest_level] || "⚪"} *#${s.id}* ${s.name}${s.owner_name ? ` (${s.owner_name})` : ""} — ${s.interest_level}`
  );
  return { success: true, output: `🏘 *Neighborhood Shops:*\n\n${lines.join("\n")}` };
}

async function handleAddShop(args: string, ctx: AgentContext): Promise<AgentResult> {
  const name = args.trim();
  if (!name) {
    return { success: false, output: "Usage: /addshop [shop name]\n\nExample: /addshop Abu Ahmad Electronics" };
  }
  const result = ctx.db.addNeighborhoodShop(name);
  return { success: true, output: `✅ Shop added: *${name}* — ID #${result.lastInsertRowid}\n\nSet details via chat (owner, phone, interest level).` };
}

// ─── Action Handlers ───────────────────────────────────────

async function handleAction(action: Record<string, any>, ctx: AgentContext): Promise<string | void> {
  const today = getTodayStr();
  const db = ctx.db;

  switch (action.type) {
    case "log_income":
      db.logIncome(action.amount, action.source, action.date, action.project_id, action.description, action.currency);
      break;

    case "log_shop_sale":
      db.logShopSale(today, action.revenue, action.items_sold, action.notes);
      break;

    case "add_shop":
      db.addNeighborhoodShop(action.name, action.owner_name, action.phone, action.category, action.notes);
      break;

    case "update_shop":
      db.updateNeighborhoodShop(action.id, action.fields);
      break;

    case "log_expense": {
      db.logExpense(action.amount, action.category, action.description, action.date, action.currency || currency(), action.recurring);
      return `💸 Logged: ${action.amount} ${action.currency || currency()} — ${action.category}${action.description ? ` (${action.description})` : ""}`;
    }

    case "show_expenses": {
      const period = action.period || "month";
      const now = new Date();
      let start: string;
      if (period === "week") {
        const d = now.getDay();
        const diff = d === 0 ? 6 : d - 1;
        const ws = new Date(now);
        ws.setDate(now.getDate() - diff);
        start = ws.toISOString().split("T")[0];
      } else if (period === "year") {
        start = `${now.getFullYear()}-01-01`;
      } else {
        start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
      }
      const end = today;
      const summary = db.getExpenseSummary(start, end);
      const total = db.getExpenseTotal(start, end);
      if (summary.length === 0) return `\n💸 No expenses logged (${period}).`;
      const lines = summary.map((s: any) => `  ${s.category}: ${s.total} ${s.currency} (${s.count}x)`);
      return `\n💸 *Expenses (${period}: ${start} → ${end})*\n\n${lines.join("\n")}\n\n*Total: ${total} ${currency()}*`;
    }

    default:
      return;
  }
}

// ─── Context Builder ───────────────────────────────────────

function buildFinanceContext(db: typeof import("../../db")): string {
  const { start, end } = getMonthRange();
  const today = getTodayStr();
  const incomeSummary = db.getIncomeSummary(start, end);
  const shopSummary = db.getShopSalesSummary(start, end);

  let devTotal = 0;
  for (const row of incomeSummary) {
    if (row.source !== "shop") devTotal += row.total;
  }
  const shopTotal = shopSummary.total || 0;

  const cur = currency();
  const financialLine = shopOn()
    ? `Work: ${devTotal} ${cur} | Shop: ${shopTotal} ${cur} | Total: ${devTotal + shopTotal} ${cur}`
    : `Work income: ${devTotal} ${cur}`;

  // Expenses context
  let expenseCtx = "No expense data.";
  try {
    const now = new Date();
    const mStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
    const total = db.getExpenseTotal(mStart, today);
    const summary = db.getExpenseSummary(mStart, today);
    if (total > 0) {
      expenseCtx = `Total: ${total} ${cur}\n${summary.map((s: any) => `- ${s.category}: ${s.total} ${cur}`).join("\n")}`;
    } else {
      expenseCtx = "No expenses logged this month.";
    }
  } catch {}

  return `### Financial (This Month)
${financialLine}

### Expenses (This Month)
${expenseCtx}`;
}

// ─── System Prompt Section ─────────────────────────────────

function getFinancePromptSection(): string {
  const shop = shopOn();
  return `## Finance Actions
All amounts are in ${currency()} unless the user names another currency.
- {"type": "log_income", "amount": number, "source": "direct|upwork|mostaql|saas|${shop ? "shop|" : ""}other" (salary and transfers are "direct"), "project_id": number, "description": "..."}
${shop ? `- {"type": "log_shop_sale", "revenue": number, "items_sold": number, "notes": "..."}
- {"type": "add_shop", "name": "...", "owner_name": "...", "category": "...", "interest_level": "cold|warm|hot"}
- {"type": "update_shop", "id": number, "fields": {"interest_level": "...", "notes": "..."}}
` : ""}- {"type": "log_expense", "amount": number, "category": "rent|food|internet|transport|${shop ? "shop_supplies|" : ""}tools|health|family|other", "description": "...", "currency": "${currency()}"}
- {"type": "show_expenses", "period": "month|week|year"}`;
}

// ─── Agent Definition ──────────────────────────────────────

const financeAgent: Agent = {
  name: "finance",
  domain: "finance" as AgentDomain,
  description: "Financial tracker — income, expenses, shop sales, and neighborhood shop management.",

  handles: [],
  keywords: [
    "income", "money", "expense", "sale", "shop", "revenue",
    "دخل", "بعت", "فلوس", "مصروف", "ريال", "درهم", "جنيه",
  ],
  commands: ["income", "shopsale", "money", "shops", "addshop"],
  actions: ["log_income", "log_shop_sale", "add_shop", "update_shop", "log_expense", "show_expenses"],

  getSystemPromptSection(): string {
    return getFinancePromptSection();
  },

  async getContextSection(): Promise<string> {
    const db = await import("../../db");
    return buildFinanceContext(db);
  },

  async handleEvent(_event: AgentEvent, _ctx: AgentContext): Promise<AgentResult> {
    return { success: true, output: "", silent: true };
  },

  async handleCommand(command: string, args: string, ctx: AgentContext): Promise<AgentResult> {
    switch (command) {
      case "income": return handleIncome(args, ctx);
      case "shopsale": return handleShopSale(args, ctx);
      case "money": return handleMoney(ctx);
      case "shops": return handleShops(ctx);
      case "addshop": return handleAddShop(args, ctx);
      default:
        return { success: false, output: `Unknown finance command: /${command}` };
    }
  },

  async handleAction(action: Record<string, any>, ctx: AgentContext): Promise<string | void> {
    return handleAction(action, ctx);
  },
};

export default financeAgent;
