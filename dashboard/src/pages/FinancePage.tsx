import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useOverview } from "../hooks/useOverview";
import { useTrends } from "../hooks/useTrends";
import { StatTile, cx } from "@bardouni/ui";

export default function FinancePage() {
  const navigate = useNavigate();
  const { data: overview } = useOverview();
  const { data: trends } = useTrends();
  const [expandedIncome, setExpandedIncome] = useState(false);

  if (!overview) {
    return (
      <div className="detail-page">
        <div className="loading">Loading finance data...</div>
      </div>
    );
  }

  const f = overview.finance;

  // Dev vs Shop trend
  let maxIncome = 1;
  if (trends && trends.length) {
    for (const week of trends) {
      const total = (week.devIncome || 0) + (week.shopRevenue || 0);
      if (total > maxIncome) maxIncome = total;
    }
  }

  return (
    <div className="detail-page">
      <a className="back-link" onClick={() => navigate("/")}>
        &larr; Back to Dashboard
      </a>
      <h2>Finance</h2>

      {/* Month summary cards */}
      <div className="mb-6 flex flex-wrap gap-4">
        <StatTile
          className="min-w-[140px] flex-1 text-blue"
          label="Dev Income (DH)"
          value={(f.monthDevIncome || 0).toLocaleString()}
        />
        <StatTile
          className="min-w-[140px] flex-1 text-orange"
          label="Shop Revenue (DH)"
          value={(f.monthShopRevenue || 0).toLocaleString()}
        />
        <StatTile
          className="min-w-[140px] flex-1 text-green"
          label="Total (DH)"
          value={(f.monthTotal || 0).toLocaleString()}
        />
      </div>

      {/* Income by source chart */}
      {f.bySource && f.bySource.length > 0 && (
        <div className="mb-6">
          <h3 className="mb-3 text-[.9rem] text-fg2">Income by Source</h3>
          {(() => {
            const maxSource = Math.max(...f.bySource.map((s) => s.total), 1);
            return f.bySource.map((s, i) => (
              <div key={i} className="mb-2 flex items-center gap-2.5">
                <span className="min-w-[100px] flex-none truncate text-[.82rem]">{s.source}</span>
                <div className="h-5 min-w-0 flex-1 overflow-hidden rounded bg-surface2">
                  <div
                    className={cx(
                      "flex h-full items-center rounded pl-2 text-[.72rem] font-semibold text-on-color",
                      i === 0 ? "bg-blue" : i === 1 ? "bg-orange" : i === 2 ? "bg-green" : "bg-accent2",
                    )}
                    style={{ width: `${(s.total / maxSource) * 100}%` }}
                  >
                    {s.total.toLocaleString()}
                  </div>
                </div>
                <span className="min-w-[40px] flex-none text-[.78rem] text-fg3">{s.currency}</span>
              </div>
            ));
          })()}
        </div>
      )}

      {/* Project rates */}
      {f.projectRates && f.projectRates.length > 0 && (
        <div className="mb-6">
          <h3 className="mb-3 text-[.9rem] text-fg2">Project Effective Hourly Rates</h3>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[.82rem]">
              <thead>
                <tr>
                  <th className="border-b border-line p-2 text-left text-fg2">Project</th>
                  <th className="border-b border-line p-2 text-right text-fg2">Hours</th>
                  <th className="border-b border-line p-2 text-right text-fg2">Income</th>
                  <th className="border-b border-line p-2 text-right text-fg2">Rate (DH/h)</th>
                </tr>
              </thead>
              <tbody>
                {f.projectRates.map((pr, i) => (
                  <tr key={i}>
                    <td className="border-b border-line p-2">{pr.name}</td>
                    <td className="border-b border-line p-2 text-right">{pr.hours}h</td>
                    <td className="border-b border-line p-2 text-right text-green">
                      {pr.income.toLocaleString()}
                    </td>
                    <td className="border-b border-line p-2 text-right font-semibold text-accent">
                      {pr.rate} DH/h
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Monthly income table */}
      {f.incomeList && f.incomeList.length > 0 && (
        <div className="mb-6">
          <h3
            className="mb-3 cursor-pointer text-[.9rem] text-fg2"
            onClick={() => setExpandedIncome(!expandedIncome)}
          >
            {expandedIncome ? "\u25BC" : "\u25B6"} Income This Month ({f.incomeList.length} entries)
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[.82rem]">
              <thead>
                <tr>
                  <th className="border-b border-line p-2 text-left text-fg2">Date</th>
                  <th className="border-b border-line p-2 text-left text-fg2">Source</th>
                  <th className="border-b border-line p-2 text-left text-fg2">Description</th>
                  <th className="border-b border-line p-2 text-right text-fg2">Amount</th>
                </tr>
              </thead>
              <tbody>
                {(expandedIncome ? f.incomeList : f.incomeList.slice(0, 10)).map((inc, i) => (
                  <tr key={i}>
                    <td className="border-b border-line p-2 text-fg3">{inc.date}</td>
                    <td className="border-b border-line p-2">{inc.source}</td>
                    <td className="max-w-[280px] truncate border-b border-line p-2 text-fg2">{inc.description || "-"}</td>
                    <td className="border-b border-line p-2 text-right font-semibold text-green">
                      {inc.amount.toLocaleString()} {inc.currency}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!expandedIncome && f.incomeList.length > 10 && (
            <div
              onClick={() => setExpandedIncome(true)}
              className="mt-2 cursor-pointer text-[.78rem] text-accent"
            >
              Show all {f.incomeList.length} entries...
            </div>
          )}
        </div>
      )}

      {/* Shop sales table */}
      {f.shopWeekLog && f.shopWeekLog.length > 0 && (
        <div className="mb-6">
          <h3 className="mb-3 text-[.9rem] text-fg2">Shop Sales This Week</h3>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[.82rem]">
              <thead>
                <tr>
                  <th className="border-b border-line p-2 text-left text-fg2">Date</th>
                  <th className="border-b border-line p-2 text-right text-fg2">Items Sold</th>
                  <th className="border-b border-line p-2 text-right text-fg2">Revenue (DH)</th>
                </tr>
              </thead>
              <tbody>
                {f.shopWeekLog.map((sale, i) => (
                  <tr key={i}>
                    <td className="border-b border-line p-2">{sale.date}</td>
                    <td className="border-b border-line p-2 text-right">
                      {sale.items_sold ?? "-"}
                    </td>
                    <td className="border-b border-line p-2 text-right font-semibold text-orange">
                      {(sale.total_revenue || 0).toLocaleString()}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td className="p-2 font-semibold">Total</td>
                  <td className="p-2 text-right font-semibold">
                    {f.shopWeekLog.reduce((sum, s) => sum + (s.items_sold || 0), 0)}
                  </td>
                  <td className="p-2 text-right font-semibold text-orange">
                    {f.shopWeekLog.reduce((sum, s) => sum + (s.total_revenue || 0), 0).toLocaleString()}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Dev vs Shop trend chart */}
      {trends && trends.length > 0 && (
        <div className="mb-6">
          <h3 className="mb-3 text-[.9rem] text-fg2">Dev vs Shop (4 Weeks)</h3>
          <div className="flex items-end gap-3 overflow-x-auto px-5" style={{ height: 140 }}>
            {trends.map((week, j) => {
              const dev = week.devIncome || 0;
              const shop = week.shopRevenue || 0;
              const devH = Math.max(4, (dev / maxIncome) * 100);
              const shopH = Math.max(4, (shop / maxIncome) * 100);
              return (
                <div key={j} className="flex flex-1 flex-col items-center gap-0.5">
                  <div className="flex items-end gap-1" style={{ height: 100 }}>
                    <div
                      title={`Dev: ${dev.toLocaleString()}`}
                      className="w-6 rounded-t-[3px] bg-blue"
                      style={{ height: `${devH}%` }}
                    />
                    <div
                      title={`Shop: ${shop.toLocaleString()}`}
                      className="w-6 rounded-t-[3px] bg-orange"
                      style={{ height: `${shopH}%` }}
                    />
                  </div>
                  <div className="mt-1 text-[.7rem] text-fg3">{week.weekStart.slice(5)}</div>
                  <div className="text-[.65rem] text-fg3">{(dev + shop).toLocaleString()}</div>
                </div>
              );
            })}
          </div>
          <div className="mt-2 text-center text-[.72rem] text-fg3">
            <span className="text-blue">{"\u25A0"}</span> Dev&nbsp;&nbsp;
            <span className="text-orange">{"\u25A0"}</span> Shop
          </div>
        </div>
      )}
    </div>
  );
}
