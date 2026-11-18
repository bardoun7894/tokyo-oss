import { useNavigate } from "react-router-dom";
import { useTrends } from "../hooks/useTrends";
import type { WeeklyTrendEntry } from "../types";

interface MetricDef {
  key: keyof WeeklyTrendEntry;
  label: string;
  fmt: (v: number) => string;
  color: string;
}

const METRICS: MetricDef[] = [
  { key: "totalWorkMinutes", label: "Work Hours", fmt: (v) => `${(v / 60).toFixed(1)}h`, color: "var(--blue)" },
  { key: "tasksCompleted", label: "Tasks Done", fmt: (v) => String(v), color: "var(--green)" },
  { key: "totalIncome", label: "Income (DH)", fmt: (v) => v.toLocaleString(), color: "var(--amber)" },
  { key: "quranPages", label: "Quran Pages", fmt: (v) => String(v), color: "var(--accent2)" },
  { key: "habitsCompleted", label: "Habits Done", fmt: (v) => String(v), color: "var(--green)" },
  { key: "devIncome", label: "Dev Income", fmt: (v) => v.toLocaleString(), color: "var(--blue)" },
  { key: "shopRevenue", label: "Shop Revenue", fmt: (v) => v.toLocaleString(), color: "var(--orange)" },
];

const SVG_W = 300;
const SVG_H = 100;
const PAD = 12;

function Chart({ values, color, label, fmt }: { values: number[]; color: string; label: string; fmt: (v: number) => string }) {
  const max = Math.max(...values, 1);
  const coords = values.map((v, i) => {
    const x = PAD + (i / (values.length - 1 || 1)) * (SVG_W - 2 * PAD);
    const y = SVG_H - PAD - (v / max) * (SVG_H - 2 * PAD);
    return { x, y, v };
  });
  const points = coords.map((c) => `${c.x},${c.y}`).join(" ");

  // Area fill
  const areaPoints = [
    `${coords[0]?.x ?? PAD},${SVG_H - PAD}`,
    ...coords.map((c) => `${c.x},${c.y}`),
    `${coords[coords.length - 1]?.x ?? SVG_W - PAD},${SVG_H - PAD}`,
  ].join(" ");

  return (
    <div className="mb-5 rounded-lg bg-surface1 p-3.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[.88rem] font-semibold">{label}</span>
        <span style={{ color }} className="font-semibold">{fmt(values[values.length - 1] || 0)}</span>
      </div>
      <svg width="100%" height={SVG_H} viewBox={`0 0 ${SVG_W} ${SVG_H}`} preserveAspectRatio="none">
        <polygon points={areaPoints} fill={color} opacity="0.1" />
        <polyline points={points} fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        {coords.map((c, i) => (
          <g key={i}>
            <circle cx={c.x} cy={c.y} r={4} fill={color} />
            <text x={c.x} y={c.y - 8} fill="var(--text2)" fontSize="9" textAnchor="middle">{fmt(c.v)}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export default function TrendsPage() {
  const navigate = useNavigate();
  const { data: weeks, isLoading, isError } = useTrends();

  if (isLoading) {
    return (
      <div className="detail-page">
        <div className="loading">Loading trends...</div>
      </div>
    );
  }

  if (isError || !weeks || weeks.length === 0) {
    return (
      <div className="detail-page">
        <a className="back-link" onClick={() => navigate("/")}>
          &larr; Back to Dashboard
        </a>
        <h2>Trends</h2>
        <div className="loading">{isError ? "Failed to load trends" : "No trend data"}</div>
      </div>
    );
  }

  return (
    <div className="detail-page">
      <a className="back-link" onClick={() => navigate("/")}>
        &larr; Back to Dashboard
      </a>
      <h2>Weekly Trends (Last {weeks.length} Weeks)</h2>

      {/* Week labels */}
      <div className="mb-4 flex justify-between px-3.5 text-xs text-fg3">
        {weeks.map((w, i) => (
          <span key={i}>{w.weekStart.slice(5)} - {w.weekEnd.slice(5)}</span>
        ))}
      </div>

      {/* Charts for each metric */}
      {METRICS.map((met) => {
        const values = weeks.map((w) => (w[met.key] as number) || 0);
        return (
          <Chart key={met.key} values={values} color={met.color} label={met.label} fmt={met.fmt} />
        );
      })}

      {/* Detailed table */}
      <h3 className="mt-6 mb-3 text-[.9rem] text-fg2">Weekly Data Table</h3>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[.78rem]">
          <thead>
            <tr>
              <th className="border-b border-line px-2 py-2 text-left text-fg2">Week</th>
              <th className="border-b border-line px-2 py-2 text-right text-fg2">Work</th>
              <th className="border-b border-line px-2 py-2 text-right text-fg2">Tasks</th>
              <th className="border-b border-line px-2 py-2 text-right text-fg2">Habits</th>
              <th className="border-b border-line px-2 py-2 text-right text-fg2">Quran</th>
              <th className="border-b border-line px-2 py-2 text-right text-fg2">Income</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w, i) => (
              <tr key={i}>
                <td className="border-b border-line px-2 py-2">{w.weekStart.slice(5)}</td>
                <td className="border-b border-line px-2 py-2 text-right text-blue">
                  {(w.totalWorkMinutes / 60).toFixed(1)}h
                </td>
                <td className="border-b border-line px-2 py-2 text-right text-green">
                  {w.tasksCompleted}
                </td>
                <td className="border-b border-line px-2 py-2 text-right">
                  {w.habitsCompleted}/{w.habitsTotal}
                </td>
                <td className="border-b border-line px-2 py-2 text-right text-accent2">
                  {w.quranPages}
                </td>
                <td className="border-b border-line px-2 py-2 text-right text-amber">
                  {w.totalIncome.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Adhkar summary */}
      {weeks.some((w) => w.adhkarDays) && (
        <div className="mt-6">
          <h3 className="mb-3 text-[.9rem] text-fg2">Adhkar Days per Week</h3>
          {weeks.map((w, i) => (
            <div key={i} className="flex flex-wrap gap-3 py-1 text-[.82rem]">
              <span className="min-w-20">{w.weekStart.slice(5)}</span>
              <span>Morning: {w.adhkarDays?.morning ?? 0}/7</span>
              <span>Evening: {w.adhkarDays?.evening ?? 0}/7</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
