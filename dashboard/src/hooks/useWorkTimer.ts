import { useState, useEffect, useRef } from "react";
import type { ActiveSession } from "../types";

/**
 * Takes the active work session and returns a live-ticking HH:MM:SS string.
 * When there is no active session, returns null.
 *
 * The timer captures the snapshot time when the session data was received,
 * then adds real elapsed seconds on top of `minutes_active` to produce
 * a smoothly ticking display.
 */
export function useWorkTimer(activeSession: ActiveSession | null): string | null {
  const snapshotRef = useRef<number>(Date.now());
  const baseMinutesRef = useRef<number>(0);
  const [display, setDisplay] = useState<string | null>(null);

  // Reset snapshot whenever the session changes
  useEffect(() => {
    if (activeSession) {
      snapshotRef.current = Date.now();
      baseMinutesRef.current = activeSession.minutes_active;
    } else {
      setDisplay(null);
    }
  }, [activeSession]);

  // Tick every second
  useEffect(() => {
    if (!activeSession) return;

    function tick() {
      const elapsedMs = Date.now() - snapshotRef.current;
      const totalMinutes = baseMinutesRef.current + elapsedMs / 60_000;
      const totalSeconds = Math.floor(totalMinutes * 60);

      const h = Math.floor(totalSeconds / 3600);
      const m = Math.floor((totalSeconds % 3600) / 60);
      const s = totalSeconds % 60;

      const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);

      if (h > 0) {
        setDisplay(`${h}:${pad(m)}:${pad(s)}`);
      } else {
        setDisplay(`${m}:${pad(s)}`);
      }
    }

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [activeSession]);

  return display;
}
