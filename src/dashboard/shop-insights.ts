/**
 * Shop analytics rollups.
 *
 * The dashboard and the WhatsApp AI assistant both need the same view of
 * the seller sales: what happened this hour, this day, this month, and how that
 * compares to normal. Keeping the maths in one module means the two cannot
 * drift apart, and the AI is fed exactly the numbers the dashboard shows.
 *
 * Amounts here are the raw in-chat figures. The x10 real-DH conversion is a
 * presentation concern and stays in the UI.
 */

/**
 * Sales before this date are excluded from every statistic.
 *
 * the seller moved to a new WhatsApp group on 2026-08-22. The single day logged in
 * the old group (2026-04-18) is real, but it sits 125 days before anything else
 * and drags every average, every weekday comparison and the month-over-month
 * figure with it. Excluded, not deleted: the rows stay in shop_sale_items.
 *
 * Empty string means no cutoff. Set SHOP_STATS_SINCE in .env to move it.
 */
export function statsSince(): string {
  return (process.env.SHOP_STATS_SINCE || "").trim();
}

/** Drop anything before the stats epoch. A no-op when no epoch is configured. */
export function applyStatsSince<T extends { date: string }>(sales: T[]): T[] {
  const since = statsSince();
  return since ? sales.filter((s) => s.date >= since) : sales;
}

export interface ShopSaleLike {
  amount: number;
  date: string; // YYYY-MM-DD, shop-local
  hour: number; // 0-23, shop-local
  sender: string;
  source: string;
}

export interface MonthlyRow {
  month: string;
  total: number;
  count: number;
  avg: number;
  max: number;
  activeDays: number;
  avgPerActiveDay: number;
  best: { date: string; total: number } | null;
}

export interface WeekdayRow {
  dow: number;
  name: string;
  total: number;
  count: number;
  avg: number;
  activeDays: number;
  avgPerActiveDay: number;
}

export interface HourRow {
  hour: number;
  total: number;
  count: number;
  avg: number;
  activeDays: number;
}

export interface ShopInsights {
  medianSale: number;
  p90Sale: number;
  peakHour: HourRow | null;
  quietHour: HourRow | null;
  bestWeekday: WeekdayRow | null;
  worstWeekday: WeekdayRow | null;
  avgPerActiveDay: number;
  salesPerActiveDay: number;
  daysSinceLastSale: number | null;
  longestGapDays: number;
  currentStreakDays: number;
  monthOverMonthPct: number | null;
  weekOverWeekPct: number | null;
  trend: "up" | "down" | "flat" | "unknown";
  monthToDate: { month: string; total: number; count: number; daysElapsed: number; projectedTotal: number } | null;
  voiceSharePct: number;
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const round2 = (n: number) => Math.round(n * 100) / 100;
const sum = (list: ShopSaleLike[]) => round2(list.reduce((a, s) => a + s.amount, 0));

/** Day of week for a shop-local YYYY-MM-DD. Noon UTC dodges any DST edge. */
function dowOf(date: string): number {
  return new Date(date + "T12:00:00Z").getUTCDay();
}

function daysBetween(a: string, b: string): number {
  const ms = new Date(b + "T12:00:00Z").getTime() - new Date(a + "T12:00:00Z").getTime();
  return Math.round(ms / 86400000);
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return round2(sorted[idx]);
}

function pctChange(prev: number, cur: number): number | null {
  if (!prev) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

function groupBy<T>(list: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const item of list) {
    const k = key(item);
    const arr = m.get(k);
    if (arr) arr.push(item);
    else m.set(k, [item]);
  }
  return m;
}

/** Calendar-month rollup, oldest first. Months with no sales are simply absent. */
export function buildMonthly(sales: ShopSaleLike[]): MonthlyRow[] {
  return [...groupBy(sales, (s) => s.date.slice(0, 7)).entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([month, list]) => {
      const byDay = groupBy(list, (s) => s.date);
      let best: { date: string; total: number } | null = null;
      for (const [date, dayList] of byDay) {
        const t = sum(dayList);
        if (!best || t > best.total) best = { date, total: t };
      }
      const total = sum(list);
      const activeDays = byDay.size;
      return {
        month,
        total,
        count: list.length,
        avg: round2(total / list.length),
        max: round2(Math.max(...list.map((s) => s.amount))),
        activeDays,
        avgPerActiveDay: round2(total / activeDays),
        best,
      };
    });
}

/** Sunday-indexed weekday rollup. Every day is present, even at zero. */
export function buildWeekday(sales: ShopSaleLike[]): WeekdayRow[] {
  const byDow = groupBy(sales, (s) => String(dowOf(s.date)));
  return WEEKDAY_NAMES.map((name, dow) => {
    const list = byDow.get(String(dow)) || [];
    const total = sum(list);
    const activeDays = new Set(list.map((s) => s.date)).size;
    return {
      dow,
      name,
      total,
      count: list.length,
      avg: list.length ? round2(total / list.length) : 0,
      activeDays,
      avgPerActiveDay: activeDays ? round2(total / activeDays) : 0,
    };
  });
}

/** 24-slot hour rollup. activeDays lets you tell "one huge day" from "every day". */
export function buildHourly(sales: ShopSaleLike[]): HourRow[] {
  const byHour = groupBy(sales, (s) => String(s.hour));
  return Array.from({ length: 24 }, (_, hour) => {
    const list = byHour.get(String(hour)) || [];
    const total = sum(list);
    return {
      hour,
      total,
      count: list.length,
      avg: list.length ? round2(total / list.length) : 0,
      activeDays: new Set(list.map((s) => s.date)).size,
    };
  });
}

export function buildInsights(
  sales: ShopSaleLike[],
  opts: { today: string; weekStart: string; prevWeekStart: string },
): ShopInsights {
  const empty: ShopInsights = {
    medianSale: 0, p90Sale: 0, peakHour: null, quietHour: null,
    bestWeekday: null, worstWeekday: null, avgPerActiveDay: 0, salesPerActiveDay: 0,
    daysSinceLastSale: null, longestGapDays: 0, currentStreakDays: 0,
    monthOverMonthPct: null, weekOverWeekPct: null, trend: "unknown",
    monthToDate: null, voiceSharePct: 0,
  };
  if (!sales.length) return empty;

  const amounts = sales.map((s) => s.amount).sort((a, b) => a - b);
  const days = [...new Set(sales.map((s) => s.date))].sort();
  const dayTotals = days.map((d) => ({ date: d, total: sum(sales.filter((s) => s.date === d)) }));

  const hourly = buildHourly(sales).filter((h) => h.count > 0);
  const weekday = buildWeekday(sales).filter((w) => w.count > 0);
  const monthly = buildMonthly(sales);

  // Longest silence between two active days — the April-to-August group move
  // shows up here, which is exactly the kind of gap worth surfacing.
  let longestGap = 0;
  for (let i = 1; i < days.length; i++) {
    longestGap = Math.max(longestGap, daysBetween(days[i - 1], days[i]) - 1);
  }

  // Consecutive active days ending on the most recent one.
  let streak = 1;
  for (let i = days.length - 1; i > 0; i--) {
    if (daysBetween(days[i - 1], days[i]) === 1) streak++;
    else break;
  }

  // Trend: last 3 active days against the 3 before them. Active days, not
  // calendar days, so a closed shop does not read as a collapse.
  const recent3 = dayTotals.slice(-3);
  const prev3 = dayTotals.slice(-6, -3);
  const recentAvg = recent3.length ? recent3.reduce((a, d) => a + d.total, 0) / recent3.length : 0;
  const prevAvg = prev3.length ? prev3.reduce((a, d) => a + d.total, 0) / prev3.length : 0;
  let trend: ShopInsights["trend"] = "unknown";
  if (prev3.length && recent3.length) {
    const delta = prevAvg ? (recentAvg - prevAvg) / prevAvg : 0;
    trend = delta > 0.1 ? "up" : delta < -0.1 ? "down" : "flat";
  }

  const thisWeek = sales.filter((s) => s.date >= opts.weekStart);
  const prevWeek = sales.filter((s) => s.date >= opts.prevWeekStart && s.date < opts.weekStart);

  const curMonth = opts.today.slice(0, 7);
  const mtd = monthly.find((m) => m.month === curMonth) || null;
  const daysElapsed = Number(opts.today.slice(8, 10));
  const daysInMonth = new Date(
    Number(curMonth.slice(0, 4)),
    Number(curMonth.slice(5, 7)),
    0,
  ).getDate();

  const total = sum(sales);
  const voice = sales.filter((s) => s.source === "voice").length;

  return {
    medianSale: percentile(amounts, 50),
    p90Sale: percentile(amounts, 90),
    peakHour: hourly.length ? hourly.reduce((a, h) => (h.total > a.total ? h : a)) : null,
    quietHour: hourly.length ? hourly.reduce((a, h) => (h.total < a.total ? h : a)) : null,
    // Ranked by avgPerActiveDay, never by total. A weekday that has simply come
    // round more often since logging started accumulates a bigger total without
    // being a better day: with two Saturdays logged and one of everything else,
    // ranking on total crowns Saturday while it is in fact fourth per day worked.
    bestWeekday: weekday.length
      ? weekday.reduce((a, w) => (w.avgPerActiveDay > a.avgPerActiveDay ? w : a))
      : null,
    worstWeekday: weekday.length
      ? weekday.reduce((a, w) => (w.avgPerActiveDay < a.avgPerActiveDay ? w : a))
      : null,
    avgPerActiveDay: round2(total / days.length),
    salesPerActiveDay: Math.round((sales.length / days.length) * 10) / 10,
    daysSinceLastSale: daysBetween(days[days.length - 1], opts.today),
    longestGapDays: longestGap,
    currentStreakDays: streak,
    monthOverMonthPct:
      monthly.length >= 2
        ? pctChange(monthly[monthly.length - 2].total, monthly[monthly.length - 1].total)
        : null,
    weekOverWeekPct: pctChange(sum(prevWeek), sum(thisWeek)),
    trend,
    monthToDate: mtd
      ? {
          month: mtd.month,
          total: mtd.total,
          count: mtd.count,
          daysElapsed,
          projectedTotal: round2((mtd.total / Math.max(daysElapsed, 1)) * daysInMonth),
        }
      : null,
    voiceSharePct: Math.round((voice / sales.length) * 100),
  };
}

// ---------------------------------------------------------------------------
// AI context
// ---------------------------------------------------------------------------

export interface ShopAiContextInput {
  sales: ShopSaleLike[];
  today: string;
  weekStart: string;
  prevWeekStart: string;
  /** In-chat figure x multiplier = real dirhams. */
  multiplier: number;
}

/**
 * A dense, plain-text brief the model can reason over.
 *
 * Written for a model, not a dashboard: every number is labelled, both the
 * in-chat figure and the real-DH value are given so the model never has to
 * guess which scale it is looking at, and the patterns (peak hour, best
 * weekday, gaps) are stated outright rather than left to be inferred from a
 * table. Kept compact enough to sit inside a chat prompt.
 */
export function formatShopAiContext(input: ShopAiContextInput): string {
  const { sales, today, multiplier } = input;
  if (!sales.length) return "No sales have ever been logged for this shop.";

  const dh = (n: number) => `${Math.round(n * multiplier)} DH`;
  const both = (n: number) => `${dh(n)} (${round2(n)} in chat)`;
  // Secondary figures use dh() alone: nesting both() inside a parenthesis
  // produces "(2030 DH (203 in chat) per day)", which is hard to read.
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const monthly = buildMonthly(sales);
  const weekday = buildWeekday(sales);
  const hourly = buildHourly(sales);
  const ins = buildInsights(sales, input);

  const days = [...new Set(sales.map((s) => s.date))].sort();
  const dayTotals = days.map((d) => ({ date: d, total: sum(sales.filter((s) => s.date === d)) }));

  const lines: string[] = [];

  const since = statsSince();
  lines.push(`SHOP SALES BRIEF (as of ${today})`);
  lines.push(
    `Scale: the seller posts a short number in WhatsApp; real price = that number x ${multiplier}. Both are given below.`,
  );
  if (since) {
    lines.push(
      `Window: every figure below covers ${since} onward, the date the shop moved to its current ` +
        `WhatsApp group. Older sales exist in the database but are deliberately excluded, so do not ` +
        `describe these numbers as the shop's whole history.`,
    );
  }
  lines.push("");

  lines.push("TOTALS");
  lines.push(
    `  ${since ? "since " + since : "all time"}: ${both(sum(sales))} over ${plural(sales.length, "sale")} ` +
      `on ${plural(days.length, "active day")}`,
  );
  lines.push(`  first sale ${days[0]}, latest sale ${days[days.length - 1]}`);
  lines.push(`  typical sale: median ${both(ins.medianSale)}, 90th percentile ${both(ins.p90Sale)}`);
  lines.push(`  typical active day: ${both(ins.avgPerActiveDay)} across ${ins.salesPerActiveDay} sales`);
  lines.push("");

  lines.push("BY MONTH");
  for (const m of monthly) {
    lines.push(
      `  ${m.month}: ${both(m.total)} | ${plural(m.count, "sale")} | ${plural(m.activeDays, "active day")} | ` +
        `${dh(m.avgPerActiveDay)} per active day` +
        (m.best ? ` | best day ${m.best.date} at ${dh(m.best.total)}` : ""),
    );
  }
  if (ins.monthOverMonthPct !== null) {
    lines.push(`  month over month: ${ins.monthOverMonthPct >= 0 ? "+" : ""}${ins.monthOverMonthPct}%`);
  }
  if (ins.monthToDate) {
    lines.push(
      `  ${ins.monthToDate.month} so far: ${both(ins.monthToDate.total)} after ${ins.monthToDate.daysElapsed} days, ` +
        `on pace for ${both(ins.monthToDate.projectedTotal)} if the rest of the month matches`,
    );
  }
  lines.push("");

  lines.push("BY DAY (most recent 14 active days, newest last)");
  for (const d of dayTotals.slice(-14)) {
    const list = sales.filter((s) => s.date === d.date);
    lines.push(
      `  ${d.date} (${WEEKDAY_NAMES[dowOf(d.date)]}): ${both(d.total)} over ${plural(list.length, "sale")}`,
    );
  }
  lines.push("");

  lines.push(`BY WEEKDAY (${since ? "since " + since : "all time"})`);
  for (const w of weekday) {
    if (!w.count) {
      lines.push(`  ${w.name}: no sales ever logged`);
      continue;
    }
    lines.push(
      `  ${w.name}: ${both(w.total)} over ${plural(w.count, "sale")} on ${plural(w.activeDays, "day")} ` +
        `worked, ${dh(w.avgPerActiveDay)} per day worked`,
    );
  }
  lines.push("");

  lines.push(
    `BY HOUR (${since ? "since " + since : "all time"}, shop local time, only hours with sales)`,
  );
  for (const h of hourly) {
    if (!h.count) continue;
    lines.push(
      `  ${String(h.hour).padStart(2, "0")}:00 - ${both(h.total)} over ${plural(h.count, "sale")} ` +
        `on ${plural(h.activeDays, "day")}`,
    );
  }
  lines.push("");

  lines.push("PATTERNS");
  if (ins.peakHour) {
    lines.push(
      `  busiest hour: ${String(ins.peakHour.hour).padStart(2, "0")}:00, ${both(ins.peakHour.total)} in total`,
    );
  }
  if (ins.bestWeekday) {
    lines.push(
      `  strongest weekday: ${ins.bestWeekday.name} at ${dh(ins.bestWeekday.avgPerActiveDay)} per day worked ` +
        `(measured per day worked, not by total, so a weekday that has come round more often does not win on volume alone)`,
    );
  }
  if (ins.worstWeekday) {
    lines.push(
      `  weakest weekday that has any sales: ${ins.worstWeekday.name} at ${dh(ins.worstWeekday.avgPerActiveDay)} per day worked`,
    );
  }
  lines.push(`  recent trend: ${ins.trend} (last 3 active days vs the 3 before)`);
  if (ins.weekOverWeekPct !== null) {
    lines.push(`  week over week: ${ins.weekOverWeekPct >= 0 ? "+" : ""}${ins.weekOverWeekPct}%`);
  }
  lines.push(`  current run of consecutive active days: ${plural(ins.currentStreakDays, "day")}`);
  lines.push(`  longest silence between active days: ${plural(ins.longestGapDays, "day")}`);
  lines.push(`  days since the last logged sale: ${ins.daysSinceLastSale}`);
  lines.push(`  ${ins.voiceSharePct}% of sales arrived as voice notes rather than typed`);
  lines.push("");

  lines.push("CAVEATS");
  lines.push("  Only sales the seller actually posts in the group exist here; anything unlogged is invisible.");
  if (days.length < 14) {
    lines.push(
      `  Only ${days.length} days have ever been logged, so weekday and hour patterns rest on one or ` +
        `two observations each. Treat them as early hints, not established habits.`,
    );
  }
  lines.push("  A day absent from BY DAY had no logged sales, which may mean closed or may mean not reported.");
  lines.push(
    `  The x${multiplier} scale is a convention, not a recorded price. Quote the real DH figure but say it is derived.`,
  );

  return lines.join("\n");
}

/** Real dirhams sold in [start, end] (YYYY-MM-DD, inclusive): in-chat figure x multiplier. */
export function shopRealDhInRange(sales: { amount: number; date: string }[], start: string, end: string, multiplier: number): number {
  let total = 0;
  for (const s of sales) if (s.date >= start && s.date <= end) total += s.amount;
  return Math.round(total * multiplier * 10) / 10;
}

/** Per-day real-DH sales in [start, end], newest first — the shape of the old shop_sales rows. */
export function shopDailyRealDh(
  sales: { amount: number; date: string }[], start: string, end: string, multiplier: number,
): { date: string; total_revenue: number; items_sold: number }[] {
  const byDate = new Map<string, { total: number; count: number }>();
  for (const s of sales) {
    if (s.date < start || s.date > end) continue;
    const d = byDate.get(s.date) ?? { total: 0, count: 0 };
    d.total += s.amount;
    d.count += 1;
    byDate.set(s.date, d);
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, d]) => ({ date, total_revenue: Math.round(d.total * multiplier * 10) / 10, items_sold: d.count }));
}
