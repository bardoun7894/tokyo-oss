import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";

interface Props {
  data?: { date: string; positive: number; negative: number; neutral: number }[];
}

export default function SentimentTimeline({ data }: Props) {
  if (!data || data.length === 0) {
    return (
      <div style={{ background: "var(--surface1)", padding: 16, borderRadius: 8 }}>
        <h3 style={{ fontSize: ".88rem", fontWeight: 600, color: "var(--text2)", marginBottom: 12 }}>Sentiment Over Time</h3>
        <div style={{ color: "var(--text3)", fontSize: ".82rem", textAlign: "center", padding: 40 }}>No data yet. Run classification first.</div>
      </div>
    );
  }

  return (
    <div style={{ background: "var(--surface1)", padding: 16, borderRadius: 8 }}>
      <h3 style={{ fontSize: ".88rem", fontWeight: 600, color: "var(--text2)", marginBottom: 12 }}>Sentiment Over Time</h3>
      <ResponsiveContainer width="100%" height={250}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--text3)" }} />
          <YAxis tick={{ fontSize: 11, fill: "var(--text3)" }} />
          <Tooltip
            contentStyle={{ background: "var(--surface1)", border: "1px solid var(--border)", borderRadius: 6, fontSize: ".8rem" }}
            labelStyle={{ color: "var(--text2)" }}
          />
          <Legend wrapperStyle={{ fontSize: ".78rem" }} />
          <Line type="monotone" dataKey="positive" stroke="var(--green)" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="negative" stroke="var(--red)" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="neutral" stroke="var(--text3)" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
