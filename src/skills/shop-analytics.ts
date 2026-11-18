import type { Skill } from "./types";
import { localToday } from "../utils";

const skill: Skill = {
  name: "shop-analytics",
  description: "Shop sales trends and performance analysis",
  category: "analytics",
  args: [
    { name: "period", type: "string", description: "week, month, or year (default: month)", required: false, default: "month" },
  ],
  async execute(ctx, args) {
    await ctx.sendUpdate("Analyzing shop data...");

    const period = args.period || "month";
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    let start: string;

    if (period === "year") {
      start = `${y}-01-01`;
    } else if (period === "week") {
      const day = now.getDay();
      const diff = day === 0 ? 6 : day - 1;
      start = new Date(y, m, d - diff).toISOString().split("T")[0];
    } else {
      start = new Date(y, m, 1).toISOString().split("T")[0];
    }

    const end = localToday();
    const progress = ctx.db.getProgressData(start, end);

    // Work hours at the shop
    const shopHours = progress.work.byType.shop || 0;
    const totalWorkHours = progress.work.totalHours || 0;
    const shopPercent = totalWorkHours > 0 ? Math.round((shopHours / totalWorkHours) * 100) : 0;

    // Financial data
    const shopRevenue = progress.finance.shopRevenue || 0;
    const devIncome = progress.finance.devIncome || 0;
    const totalIncome = progress.finance.total || 0;

    // Calculate days
    const daysDiff = Math.ceil((new Date(end).getTime() - new Date(start).getTime()) / 86400000) + 1;
    const avgDaily = daysDiff > 0 ? Math.round(shopRevenue / daysDiff) : 0;

    const report = `*Shop Analytics — ${period.charAt(0).toUpperCase() + period.slice(1)} (${start} to ${end})*

*Revenue*
Shop: ${shopRevenue} DH
Dev: ${devIncome} DH
Total: ${totalIncome} DH
Shop share: ${totalIncome > 0 ? Math.round((shopRevenue / totalIncome) * 100) : 0}%

*Daily Average*
${avgDaily} DH/day (${daysDiff} days)

*Time at Shop*
${shopHours}h of ${totalWorkHours}h total (${shopPercent}%)

*Tasks*
Completed: ${progress.tasks.completed}
Created: ${progress.tasks.created}`;

    return { success: true, output: report };
  },
};

export default skill;
