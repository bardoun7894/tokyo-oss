import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { Input, StatTile, cx } from "@bardouni/ui";
import { cur } from "../lib/currency";

// the seller posts his own price in the group; the shop's real price is a fixed
// multiple of it. Default ×10, adjustable and remembered per browser.
const MULT_KEY = "shop_price_multiplier";
const DEFAULT_MULT = 10;

interface DailyRow { date: string; total: number; count: number; avg: number; max: number }
interface HourlyRow { hour: number; total: number; count: number; avg: number; activeDays: number }
interface MonthlyRow {
  month: string; total: number; count: number; avg: number; max: number;
  activeDays: number; avgPerActiveDay: number; best: { date: string; total: number } | null;
}
interface WeekdayRow {
  dow: number; name: string; total: number; count: number;
  avg: number; activeDays: number; avgPerActiveDay: number;
}
interface Insights {
  medianSale: number; p90Sale: number;
  peakHour: HourlyRow | null; quietHour: HourlyRow | null;
  bestWeekday: WeekdayRow | null; worstWeekday: WeekdayRow | null;
  avgPerActiveDay: number; salesPerActiveDay: number;
  daysSinceLastSale: number | null; longestGapDays: number; currentStreakDays: number;
  monthOverMonthPct: number | null; weekOverWeekPct: number | null;
  trend: "up" | "down" | "flat" | "unknown";
  monthToDate: { month: string; total: number; count: number; daysElapsed: number; projectedTotal: number } | null;
  voiceSharePct: number;
}
interface SaleRow { id: number; amount: number; date: string; time: string; hour: number; sender: string; source: string; raw: string }

interface ShopResponse {
  groupJids: string[];
  statsSince: string | null;
  totals: { today: number; week: number; month: number; all: number };
  counts: { today: number; week: number; month: number; all: number };
  stats: {
    avgSale: number; maxSale: number; minSale: number; avgDay: number;
    activeDays: number; firstDate: string | null; lastDate: string | null;
    bestDay: { date: string; total: number } | null;
  };
  sellers: Array<{ name: string; total: number; count: number }>;
  daily: DailyRow[];
  hourly: HourlyRow[];
  monthly: MonthlyRow[];
  weekday: WeekdayRow[];
  insights: Insights;
  recent: SaleRow[];
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 1 : 0 });
}

function monthLabel(month: string): string {
  const d = new Date(month + "-01T12:00:00");
  return d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

/** Signed percentage, rendered green when up and red when down. */
function Delta({ pct, suffix }: { pct: number | null; suffix: string }) {
  if (pct === null) return <span className="text-fg3">no prior period</span>;
  return (
    <span className={pct >= 0 ? "text-green" : "text-red"}>
      {pct >= 0 ? "+" : ""}{pct}% {suffix}
    </span>
  );
}

function dayLabel(date: string): string {
  const d = new Date(date + "T12:00:00");
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

// Same `color="var(--x)"` call sites as before; mapped to the matching
// Tailwind token class so the kit's StatTile still renders each KPI's
// own accent color instead of the flat default.
const KPI_COLOR: Record<string, string> = {
  "var(--green)": "text-green",
  "var(--blue)": "text-blue",
  "var(--accent2)": "text-accent2",
  "var(--orange)": "text-orange",
  "var(--text)": "text-fg",
  "var(--amber)": "text-amber",
  "var(--red)": "text-red",
};

function Kpi({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return <StatTile className={cx("min-w-[150px] flex-1", KPI_COLOR[color] || "text-fg")} label={label} value={value} sub={sub} />;
}

function Signal({ label, value, note, color }: { label: string; value: React.ReactNode; note?: string; color?: string }) {
  return (
    <div className="mb-3">
      <div className="text-[.7rem] tracking-[.06em] text-fg3 uppercase">{label}</div>
      <div className="text-[1.05rem] font-semibold capitalize" style={{ color: color || "var(--text)" }}>{value}</div>
      {note && <div className="text-[.72rem] text-fg3">{note}</div>}
    </div>
  );
}

export default function ShopPage() {
  const navigate = useNavigate();
  const [mult, setMult] = useState<number>(() => {
    const raw = Number(localStorage.getItem(MULT_KEY));
    return raw > 0 ? raw : DEFAULT_MULT;
  });

  // Sales land in the DB the moment the seller posts them, so keep the page hot:
  // poll while it is open, and refetch the instant the tab regains focus.
  const { data, isLoading, error, dataUpdatedAt, isFetching } = useQuery<ShopResponse>({
    queryKey: ["shop"],
    queryFn: () => api<ShopResponse>("/api/shop"),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    staleTime: 0,
  });

  function changeMult(v: number) {
    const n = v > 0 ? v : DEFAULT_MULT;
    setMult(n);
    try { localStorage.setItem(MULT_KEY, String(n)); } catch { /* ignore */ }
  }

  if (isLoading) return <div className="detail-page"><div className="loading">Loading shop data...</div></div>;
  if (error || !data) return <div className="detail-page"><div className="loading">Failed to load shop data.</div></div>;

  const x = (n: number) => n * mult;
  const { totals, counts, stats, daily, hourly, monthly, weekday, insights, recent, sellers } = data;

  // Continuous 30-day axis: days with no sales must show as zero, not vanish.
  const last30 = fillDays(daily, 30, stats.lastDate);
  const maxDaily = Math.max(...last30.map((d) => d.total), 1);
  const maxHourly = Math.max(...hourly.map((h) => h.total), 1);
  const maxMonthly = Math.max(...monthly.map((m) => m.total), 1);
  const maxWeekday = Math.max(...weekday.map((w) => w.total), 1);
  const trendColor =
    insights.trend === "up" ? "var(--green)" : insights.trend === "down" ? "var(--red)" : "var(--text2)";
  const trendArrow = insights.trend === "up" ? "\u2191" : insights.trend === "down" ? "\u2193" : "\u2192";
  const todayVsAvg = stats.avgDay > 0 ? ((totals.today - stats.avgDay) / stats.avgDay) * 100 : 0;

  return (
    <div className="detail-page">
      <a className="back-link" onClick={() => navigate("/")}>&larr; Back to Dashboard</a>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0">
          Shop &mdash; Seller's Sales
          <span className={cx("ml-2.5 text-[.7rem] font-medium", isFetching ? "text-amber" : "text-fg3")}>
            {isFetching ? "updating\u2026" : `live \u00b7 ${new Date(dataUpdatedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`}
          </span>
        </h2>
        <label className="flex flex-wrap items-center gap-2 text-[.82rem] text-fg2">
          WhatsApp price &times;
          <Input
            type="number"
            min={1}
            step={1}
            value={mult}
            onChange={(e) => changeMult(Number(e.target.value))}
            className="w-[70px] flex-none"
          />
          <span className="text-fg3">= real {cur()}</span>
        </label>
      </div>

      {/* KPI row — real amount on top, raw WhatsApp figure underneath */}
      <div className="mb-5 flex flex-wrap gap-3">
        <Kpi label="Today" value={`${fmt(x(totals.today))} ${cur()}`} sub={`${counts.today} sales · ${fmt(totals.today)} in chat`} color="var(--green)" />
        <Kpi label="This week" value={`${fmt(x(totals.week))} ${cur()}`} sub={`${counts.week} sales · ${fmt(totals.week)} in chat`} color="var(--blue)" />
        <Kpi label="This month" value={`${fmt(x(totals.month))} ${cur()}`} sub={`${counts.month} sales · ${fmt(totals.month)} in chat`} color="var(--accent2)" />
        <Kpi
          label={data.statsSince ? "Since the move" : "All time"}
          value={`${fmt(x(totals.all))} ${cur()}`}
          sub={`${counts.all} sales · ${stats.activeDays} active days`}
          color="var(--orange)"
        />
      </div>

      {/* Secondary stats */}
      <div className="mb-6 flex flex-wrap gap-3">
        <Kpi label="Avg sale" value={`${fmt(x(stats.avgSale))} ${cur()}`} sub={`${fmt(stats.avgSale)} in chat`} color="var(--text)" />
        <Kpi label="Biggest sale" value={`${fmt(x(stats.maxSale))} ${cur()}`} sub={`smallest ${fmt(x(stats.minSale))} ${cur()}`} color="var(--text)" />
        <Kpi
          label="Avg day (last 7)"
          value={`${fmt(x(stats.avgDay))} ${cur()}`}
          sub={totals.today > 0 ? `today ${todayVsAvg >= 0 ? "+" : ""}${todayVsAvg.toFixed(0)}%` : "no sales yet today"}
          color={todayVsAvg >= 0 ? "var(--green)" : "var(--red)"}
        />
        <Kpi
          label="Best day"
          value={stats.bestDay ? `${fmt(x(stats.bestDay.total))} ${cur()}` : "—"}
          sub={stats.bestDay ? dayLabel(stats.bestDay.date) : ""}
          color="var(--amber)"
        />
      </div>

      {/* Signals — the read on the numbers, not the numbers themselves */}
      <h3 className="mb-3 text-[.9rem] text-fg2">Signals</h3>
      <div className="grid grid-2 mb-6">
        <div className="rounded-lg border border-line bg-surface p-4">
          <Signal label="Trend" value={`${trendArrow} ${insights.trend}`} color={trendColor}
            note="last 3 active days vs the 3 before" />
          <Signal label="Week on week" value={<Delta pct={insights.weekOverWeekPct} suffix="vs last week" />} />
          <Signal label="Month on month" value={<Delta pct={insights.monthOverMonthPct} suffix="vs previous month" />} />
          {insights.monthToDate && (
            <Signal
              label={`${monthLabel(insights.monthToDate.month)} pace`}
              value={`${fmt(x(insights.monthToDate.projectedTotal))} ${cur()}`}
              note={`${fmt(x(insights.monthToDate.total))} ${cur()} after ${insights.monthToDate.daysElapsed} days`}
            />
          )}
        </div>
        <div className="rounded-lg border border-line bg-surface p-4">
          <Signal
            label="Busiest hour"
            value={insights.peakHour ? `${String(insights.peakHour.hour).padStart(2, "0")}:00` : "\u2014"}
            note={insights.peakHour ? `${fmt(x(insights.peakHour.total))} ${cur()} over ${insights.peakHour.count} sales` : ""}
          />
          <Signal
            label="Strongest weekday (per day worked)"
            value={insights.bestWeekday ? insights.bestWeekday.name : "\u2014"}
            note={
              insights.bestWeekday
                ? `${fmt(x(insights.bestWeekday.avgPerActiveDay))} ${cur()} per day worked \u00b7 ` +
                  `${insights.bestWeekday.activeDays} day${insights.bestWeekday.activeDays === 1 ? "" : "s"} logged`
                : ""
            }
          />
          <Signal
            label="Typical sale"
            value={`${fmt(x(insights.medianSale))} ${cur()}`}
            note={`median \u00b7 top 10% above ${fmt(x(insights.p90Sale))} ${cur()}`}
          />
          <Signal
            label="Rhythm"
            value={`${insights.currentStreakDays}-day run`}
            note={`${insights.salesPerActiveDay} sales per active day \u00b7 longest silence ${insights.longestGapDays} days`}
          />
        </div>
      </div>

      {/* By month + by weekday */}
      <div className="grid grid-2 mb-6">
        <div className="rounded-lg border border-line bg-surface p-4">
          <h3 className="mb-3 text-[.9rem] text-fg2">By month</h3>
          {monthly.length === 0 && <div className="text-[.8rem] text-fg3">No months yet.</div>}
          {[...monthly].reverse().map((m) => (
            <div key={m.month} className="mb-3">
              <div className="mb-1 flex justify-between text-[.8rem]">
                <span>{monthLabel(m.month)}</span>
                <span className="font-semibold text-green">{fmt(x(m.total))} {cur()}</span>
              </div>
              <div className="h-[18px] overflow-hidden rounded bg-surface2">
                <div style={{ width: `${(m.total / maxMonthly) * 100}%`, background: "linear-gradient(90deg, var(--accent2), var(--blue))" }} className="h-full rounded" />
              </div>
              <div className="mt-0.5 text-[.7rem] text-fg3">
                {m.count} sales over {m.activeDays} active day{m.activeDays === 1 ? "" : "s"}
                {" \u00b7 "}{fmt(x(m.avgPerActiveDay))} {cur()} per day worked
                {m.best && <> {" \u00b7 "}best {dayLabel(m.best.date)} at {fmt(x(m.best.total))} {cur()}</>}
              </div>
            </div>
          ))}
        </div>

        <div className="rounded-lg border border-line bg-surface p-4">
          <h3 className="mb-3 text-[.9rem] text-fg2">
            By weekday {data.statsSince ? "(since the move)" : "(all time)"}
          </h3>
          {weekday.map((w) => (
            <div key={w.dow} className="mb-[7px] flex items-center gap-2.5">
              <span className={cx("min-w-[78px] shrink-0 text-[.78rem]", w.count ? "text-fg" : "text-fg3")}>
                {w.name.slice(0, 3)}
              </span>
              <div className="h-[18px] min-w-0 flex-1 overflow-hidden rounded bg-surface2">
                <div style={{ width: `${(w.total / maxWeekday) * 100}%`, minWidth: w.total > 0 ? 2 : 0 }} className="h-full rounded bg-accent" />
              </div>
              <span className="min-w-[74px] shrink-0 text-right text-[.74rem] text-fg2">
                {w.count ? `${fmt(x(w.total))} ${cur()}` : "\u2014"}
              </span>
              <span className="min-w-[58px] shrink-0 text-right text-[.7rem] text-fg3">
                {w.count ? `${w.activeDays}d \u00b7 ${w.count}\u00d7` : ""}
              </span>
            </div>
          ))}
          <p className="mt-2.5 mb-0 text-[.7rem] text-fg3">
            Bars are totals, so a weekday that has come round more often sits higher without being a
            better day &mdash; check the day-count on the right before reading a winner. The Signals
            panel ranks by revenue per day worked, which is the fair comparison.
          </p>
        </div>
      </div>

      {/* Daily chart */}
      <h3 className="mb-3 text-[.9rem] text-fg2">
        Daily revenue {last30.length ? `(${last30[0].date} \u2192 ${last30[last30.length - 1].date})` : ""}
      </h3>
      <div className="mb-6 rounded-lg border border-line bg-surface p-4">
        <div className="flex items-end gap-1.5 overflow-x-auto" style={{ height: 200 }}>
          {last30.map((d) => (
            <div key={d.date} className="flex h-full flex-col items-center justify-end gap-1" style={{ flex: "1 0 28px" }}>
              <div className="text-[.68rem] whitespace-nowrap text-fg2">{fmt(x(d.total))}</div>
              <div
                title={`${d.date} — ${fmt(x(d.total))} ${cur()} over ${d.count} sales`}
                className="w-full rounded-t"
                style={{
                  height: `${Math.max((d.total / maxDaily) * 100, 2)}%`,
                  background: "linear-gradient(180deg, var(--green), var(--blue))",
                  minHeight: 3,
                }}
              />
              <div className="h-[26px] origin-center -rotate-45 text-[.62rem] whitespace-nowrap text-fg3">
                {d.date.slice(5)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Hourly + sellers */}
      <div className="grid grid-2 mb-6">
        <div className="rounded-lg border border-line bg-surface p-4">
          <h3 className="mb-3 text-[.9rem] text-fg2">
            Busiest hours {data.statsSince ? "(since the move)" : "(all time)"}
          </h3>
          <div className="flex items-end gap-0.5" style={{ height: 130 }}>
            {hourly.map((h) => (
              <div
                key={h.hour}
                title={`${String(h.hour).padStart(2, "0")}:00 — ${fmt(x(h.total))} ${cur()} over ${h.count} sales on ${h.activeDays} day${h.activeDays === 1 ? "" : "s"} (avg ${fmt(x(h.avg))} ${cur()} per sale)`}
                className="flex h-full flex-1 flex-col justify-end"
              >
                <div className={cx("rounded-t-[3px]", h.total > 0 ? "bg-accent" : "bg-surface2")} style={{ height: `${(h.total / maxHourly) * 100}%`, minHeight: 2 }} />
                <div className="mt-[3px] text-center text-[.58rem] text-fg3">{h.hour % 3 === 0 ? h.hour : ""}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-line bg-surface p-4">
          <h3 className="mb-3 text-[.9rem] text-fg2">Who logged the sales</h3>
          {sellers.map((s, i) => (
            <div key={s.name} className="mb-2 flex items-center gap-2.5">
              <span className="min-w-[90px] shrink-0 truncate text-[.82rem]">{s.name}</span>
              <div className="h-5 min-w-0 flex-1 overflow-hidden rounded bg-surface2">
                <div
                  className={cx("flex h-full items-center rounded pl-2 text-[.72rem] font-semibold text-on-color", i === 0 ? "bg-green" : "bg-accent2")}
                  style={{ width: `${(s.total / (sellers[0]?.total || 1)) * 100}%` }}
                >
                  {fmt(x(s.total))} {cur()}
                </div>
              </div>
              <span className="min-w-[46px] shrink-0 text-[.74rem] text-fg3">{s.count}×</span>
            </div>
          ))}
        </div>
      </div>

      {/* Daily table */}
      <h3 className="mb-3 text-[.9rem] text-fg2">Day by day</h3>
      <div className="mb-6 overflow-x-auto rounded-lg border border-line bg-surface p-1">
        <table className="w-full border-collapse text-[.82rem]">
          <thead>
            <tr className="text-left text-fg3">
              <th className="px-3 py-2">Day</th>
              <th className="px-3 py-2 text-right">Revenue ({cur()})</th>
              <th className="px-3 py-2 text-right">In chat</th>
              <th className="px-3 py-2 text-right">Sales</th>
              <th className="px-3 py-2 text-right">Avg</th>
              <th className="px-3 py-2 text-right">Biggest</th>
            </tr>
          </thead>
          <tbody>
            {[...daily].reverse().map((d) => (
              <tr key={d.date} className="border-t border-line">
                <td className="px-3 py-2">{dayLabel(d.date)}</td>
                <td className="px-3 py-2 text-right font-semibold text-green">{fmt(x(d.total))}</td>
                <td className="px-3 py-2 text-right text-fg3">{fmt(d.total)}</td>
                <td className="px-3 py-2 text-right">{d.count}</td>
                <td className="px-3 py-2 text-right text-fg2">{fmt(x(d.avg))}</td>
                <td className="px-3 py-2 text-right text-fg2">{fmt(x(d.max))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Recent sales */}
      <h3 className="mb-3 text-[.9rem] text-fg2">Recent sales</h3>
      <div className="overflow-x-auto rounded-lg border border-line bg-surface p-1">
        <table className="w-full border-collapse text-[.82rem]">
          <thead>
            <tr className="text-left text-fg3">
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">By</th>
              <th className="px-3 py-2 text-right">Chat</th>
              <th className="px-3 py-2 text-right">Real ({cur()})</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((s) => (
              <tr key={s.id} className="border-t border-line">
                <td className="px-3 py-2 text-fg2">{d2(s.date)} {s.time}</td>
                <td className="max-w-[220px] truncate px-3 py-2">
                  {s.sender}
                  {s.source === "voice" && <span className="ml-1.5 text-[.68rem] text-fg3">voice</span>}
                </td>
                <td className="px-3 py-2 text-right text-fg3">{s.raw}</td>
                <td className="px-3 py-2 text-right font-semibold text-green">{fmt(x(s.amount))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-[.72rem] text-fg3">
        Read live from the WhatsApp message log ({data.groupJids.join(", ")}). Refreshes every minute.
        {data.statsSince && (
          <>
            {" "}Statistics start at {dayLabel(data.statsSince)}, when the shop moved to the current
            group. Sales logged in the old group before that date are still stored, but are left out
            of every figure on this page so they cannot skew an average.
          </>
        )}
      </p>
    </div>
  );
}


/**
 * Build a continuous day axis for the chart.
 *
 * Window = the last `days` calendar days, but anchored to the first day inside
 * that window that actually has sales — otherwise a shop that started logging
 * last week shows three weeks of dead bars. Gaps *inside* the window are
 * zero-filled, because a day with no sales is real information.
 */
function fillDays(daily: DailyRow[], days: number, endDate: string | null): DailyRow[] {
  if (!daily.length) return [];

  const end = endDate || daily[daily.length - 1].date;
  const endD = new Date(end + "T12:00:00");
  const cutoffD = new Date(endD);
  cutoffD.setDate(endD.getDate() - (days - 1));
  const cutoff = ymd(cutoffD);

  const inWindow = daily.filter((d) => d.date >= cutoff && d.date <= end);
  const anchor = inWindow.length ? inWindow[0].date : daily[daily.length - 1].date;

  const byDate = new Map(daily.map((d) => [d.date, d]));
  const out: DailyRow[] = [];
  const cur = new Date(anchor + "T12:00:00");
  while (cur <= endD) {
    const key = ymd(cur);
    out.push(byDate.get(key) || { date: key, total: 0, count: 0, avg: 0, max: 0 });
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + m + "-" + day;
}

function d2(date: string): string {
  return date.slice(5).replace("-", "/");
}
