
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

interface Props {
  data?: number[][];
}

function colorForCount(count: number, max: number): string {
  if (max === 0 || count === 0) return "var(--surface2)";
  const intensity = count / max;
  if (intensity > 0.75) return "var(--blue)";
  if (intensity > 0.5) return "color-mix(in srgb, var(--blue) 70%, var(--surface1))";
  if (intensity > 0.25) return "color-mix(in srgb, var(--blue) 45%, var(--surface1))";
  return "color-mix(in srgb, var(--blue) 20%, var(--surface1))";
}

export default function HabitsHeatmap({ data }: Props) {
  if (!data || data.length === 0) {
    return (
      <div style={{ background: "var(--surface1)", padding: 16, borderRadius: 8 }}>
        <h3 style={{ fontSize: ".88rem", fontWeight: 600, color: "var(--text2)", marginBottom: 12 }}>Activity Heatmap</h3>
        <div style={{ color: "var(--text3)", fontSize: ".82rem", textAlign: "center", padding: 40 }}>No data yet.</div>
      </div>
    );
  }

  const maxCount = Math.max(...data.flat(), 1);

  return (
    <div style={{ background: "var(--surface1)", padding: 16, borderRadius: 8 }}>
      <h3 style={{ fontSize: ".88rem", fontWeight: 600, color: "var(--text2)", marginBottom: 12 }}>Activity Heatmap (Day x Hour)</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {/* Header row with hour labels */}
        <div style={{ display: "flex", marginLeft: 32 }}>
          {HOURS.map((h) => (
            <div key={h} style={{ width: 24, textAlign: "center", fontSize: ".62rem", color: "var(--text3)" }}>
              {h % 3 === 0 ? h : ""}
            </div>
          ))}
        </div>
        {/* Day rows */}
        {DAYS.map((day, dayIdx) => (
          <div key={day} style={{ display: "flex", alignItems: "center" }}>
            <div style={{ width: 30, fontSize: ".68rem", color: "var(--text3)", textAlign: "right", paddingRight: 4 }}>{day}</div>
            {HOURS.map((hour) => {
              const count = data[dayIdx]?.[hour] || 0;
              return (
                <div
                  key={hour}
                  style={{
                    width: 22,
                    height: 22,
                    margin: 1,
                    borderRadius: 3,
                    backgroundColor: colorForCount(count, maxCount),
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  title={`${day} ${hour}:00 — ${count} messages`}
                >
                  {count > 0 && count === maxCount && (
                    <span style={{ fontSize: ".55rem", color: "var(--bg)" }}>{count}</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
