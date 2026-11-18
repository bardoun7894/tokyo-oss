import { useState, useEffect, useRef } from "react";
import type { OverviewResponse } from "../../types";
import { Link, useLocation } from "react-router-dom";
import { settingsSectionFor } from "../../hooks/useSettings";
import { ThemeToggle } from "./ThemeToggle";

interface HeaderProps {
  overview: OverviewResponse | null;
}

export default function Header({ overview }: HeaderProps) {
  const [clock, setClock] = useState("");
  const [prayerText, setPrayerText] = useState("--");
  const [prayerColor, setPrayerColor] = useState("var(--green)");
  const { pathname } = useLocation();

  const loadedAtRef = useRef<number>(Date.now());
  const baseMinsRef = useRef<number>(0);
  const prayerNameRef = useRef<string>("");

  // Update snapshot when overview changes
  useEffect(() => {
    if (overview?.nextPrayer) {
      loadedAtRef.current = Date.now();
      baseMinsRef.current = overview.nextPrayer.minutesUntil;
      prayerNameRef.current = overview.nextPrayer.name;
    }
  }, [overview]);

  // Clock + prayer countdown ticker
  useEffect(() => {
    function tick() {
      const now = new Date();
      const dateStr = now.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      const timeStr = now.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      setClock(`${dateStr} ${timeStr}`);

      // Prayer countdown
      if (prayerNameRef.current) {
        const elapsed = Math.floor(
          (Date.now() - loadedAtRef.current) / 60000
        );
        const remaining = baseMinsRef.current - elapsed;
        if (remaining <= 0) {
          setPrayerText(`${prayerNameRef.current} NOW`);
          setPrayerColor("var(--red)");
        } else {
          const h = Math.floor(remaining / 60);
          const m = remaining % 60;
          setPrayerText(
            `${prayerNameRef.current} in ${h > 0 ? `${h}h ` : ""}${m}m`
          );
          setPrayerColor(remaining <= 15 ? "var(--amber)" : "var(--green)");
        }
      }
    }

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const coaching = overview?.coaching;

  return (
    <>
      <div className="header">
        <h1>Tokyo Dashboard</h1>
        <div className="header-right" style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
          {coaching?.latest && (
            <span
              className="coaching-badge"
              title={coaching.latest.message_summary || ""}
            >
              {"\u{1F9E0}"} {coaching.countToday} today
            </span>
          )}
          <span>{clock}</span>
          <div className="prayer-next" style={{ color: prayerColor }}>
            {prayerText}
          </div>
          <ThemeToggle compact />
          <Link to={`/settings#${settingsSectionFor(pathname)}`} className="flex items-center text-xl no-underline" title="Settings for this page" aria-label="Settings">
            ⚙️
          </Link>
        </div>
      </div>
    </>
  );
}
