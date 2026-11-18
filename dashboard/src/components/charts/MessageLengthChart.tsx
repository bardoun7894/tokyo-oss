import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

interface Props {
  data?: { date: string; avgChars: number }[];
}

export default function MessageLengthChart({ data }: Props) {
  if (!data || data.length === 0) {
    return (
      <div style={{ background: "var(--surface1)", padding: 16, borderRadius: 8 }}>
        <h3 style={{ fontSize: ".88rem", fontWeight: 600, color: "var(--text2)", marginBottom: 12 }}>Message Length Trends</h3>
        <div style={{ color: "var(--text3)", fontSize: ".82rem", textAlign: "center", padding: 40 }}>No data yet.</div>
      </div>
    );
  }

  return (
    <div style={{ background: "var(--surface1)", padding: 16, borderRadius: 8 }}>
      <h3 style={{ fontSize: ".88rem", fontWeight: 600, color: "var(--text2)", marginBottom: 12 }}>Message Length Trends (Avg Chars)</h3>
      <ResponsiveContainer width="100%" height={250}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--text3)" }} />
          <YAxis tick={{ fontSize: 11, fill: "var(--text3)" }} />
          <Tooltip
            contentStyle={{ background: "var(--surface1)", border: "1px solid var(--border)", borderRadius: 6, fontSize: ".8rem" }}
          />
          <Line type="monotone" dataKey="avgChars" stroke="var(--amber)" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
