import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { postApi } from "../../api/client";
import { useToast } from "../ui/Toast";
import type { OverviewResponse, ApiOkResponse } from "../../types";

function fmtMin(m: number): string {
  if (!m) return "0m";
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
}

interface RightNowStripProps {
  overview: OverviewResponse | null;
}

export default function RightNowStrip({ overview }: RightNowStripProps) {
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  // Live prayer countdown
  const [prayerCountdown, setPrayerCountdown] = useState("");
  const [prayerColor, setPrayerColor] = useState("var(--green)");
  const loadedAtRef = useRef<number>(Date.now());
  const baseMinsRef = useRef<number>(0);
  const prayerNameRef = useRef<string>("");

  useEffect(() => {
    if (overview?.nextPrayer) {
      loadedAtRef.current = Date.now();
      baseMinsRef.current = overview.nextPrayer.minutesUntil;
      prayerNameRef.current = overview.nextPrayer.name;
    }
  }, [overview]);

  useEffect(() => {
    function tick() {
      if (!prayerNameRef.current) return;
      const elapsed = Math.floor((Date.now() - loadedAtRef.current) / 60000);
      const remaining = baseMinsRef.current - elapsed;
      if (remaining <= 0) {
        setPrayerCountdown(`${prayerNameRef.current} NOW`);
        setPrayerColor("var(--red)");
      } else {
        const h = Math.floor(remaining / 60);
        const m = remaining % 60;
        setPrayerCountdown(
          `${prayerNameRef.current} in ${h > 0 ? `${h}h ` : ""}${m}m`
        );
        setPrayerColor(remaining <= 15 ? "var(--amber)" : "var(--green)");
      }
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const stopMutation = useMutation({
    mutationFn: () => postApi<ApiOkResponse>("/api/work/stop"),
    onSuccess: () => {
      showToast("Work stopped!");
      queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const breakMutation = useMutation({
    mutationFn: () => postApi<{ ok: true; onBreak: boolean }>("/api/work/break"),
    onSuccess: (data) => {
      showToast(data.onBreak ? "Break started!" : "Break ended!");
      queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const quickStartMutation = useMutation({
    mutationFn: () =>
      postApi<ApiOkResponse>("/api/work/start", { workType: "dev" }),
    onSuccess: () => {
      showToast("Work started!");
      queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  if (!overview) {
    return (
      <div className="right-now">
        <div className="rn-item">
          <span className="rn-label">Loading...</span>
        </div>
      </div>
    );
  }

  const { work, tasks, habits } = overview;
  const activeSession = work.activeSession;
  const topTask = tasks.active.length > 0 ? tasks.active[0] : null;

  return (
    <div className="right-now" id="right-now">
      {/* Work status */}
      {activeSession ? (
        <div className="rn-item">
          <span className="pulse" />
          <span className="rn-value" style={{ color: "var(--green)" }}>
            Working: {activeSession.project_name || activeSession.note || activeSession.work_type} &mdash;{" "}
            {fmtMin(Math.round(activeSession.minutes_active))}
          </span>
          <button
            className="rn-btn"
            style={{ background: "var(--red)", color: "var(--on-color)", marginLeft: 6 }}
            onClick={() => stopMutation.mutate()}
          >
            Stop
          </button>
          <button
            className="rn-btn"
            style={{ background: "var(--amber)", marginLeft: 4 }}
            onClick={() => breakMutation.mutate()}
          >
            Break
          </button>
        </div>
      ) : (
        <div className="rn-item">
          <span className="rn-value" style={{ color: "var(--text3)" }}>
            Not working
          </span>
          <button
            className="rn-btn"
            style={{ marginLeft: 6 }}
            onClick={() => quickStartMutation.mutate()}
          >
            Start
          </button>
        </div>
      )}

      {/* Prayer countdown */}
      {overview.nextPrayer && (
        <div className="rn-item">
          <span style={{ color: prayerColor }}>
            {"\u23F0"} {prayerCountdown}
          </span>
        </div>
      )}

      {/* Most urgent task */}
      {topTask && (
        <div className="rn-item">
          <span>
            {"\u{1F3AF}"} #{topTask.id}{" "}
            {topTask.title.length > 30
              ? topTask.title.slice(0, 30) + "..."
              : topTask.title}
            {topTask.priority === "urgent" && (
              <span style={{ color: "var(--red)" }}> (urgent)</span>
            )}
            {topTask.due_date && (
              <span className="task-due"> {topTask.due_date}</span>
            )}
          </span>
        </div>
      )}

      {/* Habits count */}
      <div className="rn-item">
        <span>
          {"\u2705"} {habits.completedCount}/{habits.totalCount} habits
        </span>
      </div>
    </div>
  );
}
