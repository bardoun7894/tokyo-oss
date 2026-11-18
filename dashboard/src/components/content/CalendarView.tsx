import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import { useToast } from "../ui/Toast";
import { PLATFORM_SHORT, type CalendarEvent } from "./types";

interface Props {
  onOpen: (itemId: number) => void;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export default function CalendarView({ onOpen }: Props) {
  const { showToast } = useToast();
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [events, setEvents] = useState<CalendarEvent[]>([]);

  useEffect(() => {
    api<{ events: CalendarEvent[] }>(`/api/content/calendar?month=${monthKey(cursor)}`)
      .then((r) => setEvents(r.events || []))
      .catch((err: Error) => showToast(err.message || "Failed to load calendar", "error"));
  }, [cursor, showToast]);

  // Six Monday-first weeks covering the month.
  const days = useMemo(() => {
    const first = new Date(cursor);
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
    return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }, [cursor]);

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of events) {
      const k = dayKey(new Date(e.at));
      map.set(k, [...(map.get(k) || []), e]);
    }
    return map;
  }, [events]);

  const todayKey = dayKey(new Date());
  const label = cursor.toLocaleString("en-GB", { month: "long", year: "numeric" });

  return (
    <div className="cs-calendar">
      <div className="cs-cal-head">
        <button onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))} aria-label="Previous month">&#8249;</button>
        <strong>{label}</strong>
        <button onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))} aria-label="Next month">&#8250;</button>
        <button
          onClick={() => {
            const now = new Date();
            setCursor(new Date(now.getFullYear(), now.getMonth(), 1));
          }}
        >
          Today
        </button>
        <div className="cs-spacer" />
        <span className="cs-legend"><i className="k-scheduled" /> Scheduled</span>
        <span className="cs-legend"><i className="k-posted" /> Posted</span>
        <span className="cs-legend"><i className="k-failed" /> Failed</span>
      </div>
      <div className="cs-cal-scroll">
        <div className="cs-cal-grid">
          {WEEKDAYS.map((w) => (
            <div key={w} className="cs-cal-wd">{w}</div>
          ))}
          {days.map((d) => {
            const k = dayKey(d);
            const list = byDay.get(k) || [];
            return (
              <div key={k} className={`cs-cal-day${d.getMonth() !== cursor.getMonth() ? " out" : ""}${k === todayKey ? " today" : ""}`}>
                <span className="cs-cal-num">{d.getDate()}</span>
                {list.map((e, i) => (
                  <button key={i} className={`cs-ev k-${e.kind}`} onClick={() => onOpen(e.itemId)} title={`${e.title} — ${e.kind}`}>
                    <span className="cs-ev-time">
                      {new Date(e.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <span className="cs-ev-title">{e.title}</span>
                    {e.platforms.length > 0 && (
                      <span className="cs-ev-plat">{e.platforms.map((p) => PLATFORM_SHORT[p]).join(" ")}</span>
                    )}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
