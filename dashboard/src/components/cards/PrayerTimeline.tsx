import { useState, useEffect } from "react";
import type { OverviewResponse } from "../../types";

function timeToMin(t: string): number {
  if (!t) return 0;
  const parts = t.split(":").map(Number);
  return parts[0] * 60 + parts[1];
}

function nowMin(): number {
  const n = new Date();
  return n.getHours() * 60 + n.getMinutes();
}

interface PrayerTimelineProps {
  overview: OverviewResponse | null;
}

interface PrayerInfo {
  name: string;
  time: string;
}

export default function PrayerTimeline({ overview }: PrayerTimelineProps) {
  const [currentMin, setCurrentMin] = useState(nowMin);

  useEffect(() => {
    const id = setInterval(() => setCurrentMin(nowMin()), 30000);
    return () => clearInterval(id);
  }, []);

  const [collapsed, setCollapsed] = useState(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem("tokyo_collapsed") || "{}"
      );
      return !!saved["prayer"];
    } catch {
      return false;
    }
  });

  function toggleCollapse() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        const saved = JSON.parse(
          localStorage.getItem("tokyo_collapsed") || "{}"
        );
        saved["prayer"] = next;
        localStorage.setItem("tokyo_collapsed", JSON.stringify(saved));
      } catch {
        // ignore
      }
      return next;
    });
  }

  if (!overview || !overview.prayer) {
    return (
      <div className="card" id="prayer-card">
        <h2
          className={`card-header${collapsed ? " collapsed" : ""}`}
          data-card="prayer"
          onClick={toggleCollapse}
        >
          <span>{"\u{1F54C}"}</span> Prayer Timeline
        </h2>
        <div className={`card-body${collapsed ? " collapsed" : ""}`}>
          <div className="loading">Prayer times unavailable</div>
        </div>
      </div>
    );
  }

  const p = overview.prayer;
  const prayers: PrayerInfo[] = [
    { name: "Fajr", time: p.fajr },
    { name: "Dhuhr", time: p.dhuhr },
    { name: "Asr", time: p.asr },
    { name: "Maghrib", time: p.maghrib },
    { name: "Isha", time: p.isha },
  ];

  const dayStart = timeToMin(p.fajr) - 30;
  const dayEnd = timeToMin("22:30");
  const span = dayEnd - dayStart;

  function pct(m: number): number {
    return Math.max(0, Math.min(100, ((m - dayStart) / span) * 100));
  }

  const nowP = pct(currentMin);

  return (
    <div className="card" id="prayer-card">
      <h2
        className={`card-header${collapsed ? " collapsed" : ""}`}
        data-card="prayer"
        onClick={toggleCollapse}
      >
        <span>{"\u{1F54C}"}</span> Prayer Timeline
      </h2>
      <div className={`card-body${collapsed ? " collapsed" : ""}`}>
        <div className="prayer-bar">
          {/* Work windows */}
          {overview.workWindows?.map((w, i) => {
            const l = pct(timeToMin(w.start));
            const r = pct(timeToMin(w.end));
            return (
              <div
                key={i}
                className="window"
                style={{ left: `${l}%`, width: `${r - l}%` }}
              />
            );
          })}

          {/* Prayer markers */}
          {prayers.map((pr) => {
            const pos = pct(timeToMin(pr.time));
            return (
              <div key={pr.name} className="marker" style={{ left: `${pos}%` }}>
                <span className="marker-label" style={{ left: `${pos}%` }}>
                  {pr.name}
                </span>
              </div>
            );
          })}

          {/* Now line */}
          <div className="now-line" style={{ left: `${nowP}%` }} />
        </div>

        {/* Times row */}
        <div className="prayer-times-row">
          {prayers.map((pr) => (
            <span key={pr.name}>
              {pr.name} {pr.time}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
