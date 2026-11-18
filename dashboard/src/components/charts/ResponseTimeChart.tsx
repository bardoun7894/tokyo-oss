import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

interface Props {
  data?: Record<string, { name: string; avgMinutes: number }>;
}

export default function ResponseTimeChart({ data }: Props) {
  if (!data || Object.keys(data).length === 0) {
    return (
      <div style={{ background: "var(--surface1)", padding: 16, borderRadius: 8 }}>
        <h3 style={{ fontSize: ".88rem", fontWeight: 600, color: "var(--text2)", marginBottom: 12 }}>Response Time by Contact</h3>
        <div style={{ color: "var(--text3)", fontSize: ".82rem", textAlign: "center", padding: 40 }}>No data yet.</div>
      </div>
    );
  }

  const chartData = Object.entries(data)
    .map(([jid, d]) => ({
      name: d.name || jid,
      minutes: d.avgMinutes,
    }))
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 12);

  return (
    <div style={{ background: "var(--surface1)", padding: 16, borderRadius: 8 }}>
      <h3 style={{ fontSize: ".88rem", fontWeight: 600, color: "var(--text2)", marginBottom: 12 }}>Response Time by Contact</h3>
      <ResponsiveContainer width="100%" height={Math.max(250, chartData.length * 30)}>
        <BarChart data={chartData} layout="vertical" margin={{ left: 80 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis type="number" tick={{ fontSize: 11, fill: "var(--text3)" }} unit=" min" />
          <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: "var(--text2)" }} width={80} />
          <Tooltip
            contentStyle={{ background: "var(--surface1)", border: "1px solid var(--border)", borderRadius: 6, fontSize: ".8rem" }}
            formatter={(value: any) => [value + " min", "Avg Response"]}
          />
          <Bar dataKey="minutes" fill="var(--blue)" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
