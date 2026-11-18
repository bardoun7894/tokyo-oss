import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useOverview, OVERVIEW_KEY } from "../hooks/useOverview";
import { api, postApi } from "../api/client";
import { useToast } from "../components/ui/Toast";
import type { ApiOkResponse } from "../types";
import PrayerTimeline from "../components/cards/PrayerTimeline";
import { Button, Input, StatTile } from "@bardouni/ui";

interface AdhkarHistoryEntry {
  date: string;
  morning: boolean;
  evening: boolean;
  post_prayer: boolean;
}

interface QuranHistoryEntry {
  date: string;
  pages: number;
}

export default function DeenPage() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const { data: overview } = useOverview();

  const [quranPages, setQuranPages] = useState("1");
  const [adhkarHistory, setAdhkarHistory] = useState<AdhkarHistoryEntry[]>([]);
  const [quranHistory, setQuranHistory] = useState<QuranHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api<AdhkarHistoryEntry[]>("/api/adhkar/history?days=30").catch(() => []),
      api<QuranHistoryEntry[]>("/api/quran/history?days=30").catch(() => []),
    ]).then(([adhkar, quran]) => {
      setAdhkarHistory(adhkar || []);
      setQuranHistory(quran || []);
      setHistoryLoading(false);
    });
  }, []);

  const adhkarMutation = useMutation({
    mutationFn: (type: string) =>
      postApi<ApiOkResponse>(`/api/adhkar/${type}`),
    onSuccess: () => {
      showToast("Adhkar logged!");
      queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  const quranMutation = useMutation({
    mutationFn: (pages: number) =>
      postApi<ApiOkResponse>("/api/quran", { pages }),
    onSuccess: (_data, pages) => {
      showToast(`${pages} pages logged!`);
      setQuranPages("1");
      queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });
    },
    onError: (err: Error) => showToast(err.message, "error"),
  });

  function handleLogQuran() {
    const pages = parseInt(quranPages);
    if (!pages || pages < 1) return;
    quranMutation.mutate(pages);
  }

  if (!overview) {
    return (
      <div className="detail-page">
        <div className="loading">Loading deen data...</div>
      </div>
    );
  }

  const d = overview.deen;
  const total = d.quranTotal || 0;
  const khatmaPct = Math.min(100, ((total % 604) / 604) * 100);
  const khatmas = Math.floor(total / 604);
  const avgPagesPerDay = d.quranDays > 0 ? (total / d.quranDays).toFixed(1) : "0";
  const pagesLeft = 604 - (total % 604);
  const daysToComplete = d.quranDays > 0 ? Math.ceil(pagesLeft / (total / d.quranDays)) : 0;

  // Max pages for chart
  const maxPages = Math.max(...quranHistory.map((e) => e.pages), 1);

  return (
    <div className="detail-page">
      <a className="back-link" onClick={() => navigate("/")}>
        &larr; Back to Dashboard
      </a>
      <h2>Deen</h2>

      <div className="mb-4">
        <PrayerTimeline overview={overview ?? null} />
      </div>

      {/* Adhkar status */}
      <div className="mb-6">
        <h3 className="mb-3 text-[.9rem] text-fg2">Adhkar Today</h3>
        <div className="flex flex-wrap gap-3">
          {[
            { key: "morning", label: "Morning", done: d.adhkar.morning },
            { key: "evening", label: "Evening", done: d.adhkar.evening },
            { key: "post_prayer", label: "Post-Prayer", done: d.adhkar.postPrayer },
            { key: "general", label: "General", done: d.adhkar.general },
          ].map((item) => (
            <div
              key={item.key}
              onClick={() => adhkarMutation.mutate(item.key)}
              className={item.done
                ? "cursor-pointer rounded-lg bg-green px-5 py-3 text-[.88rem] font-semibold text-on-color transition-colors"
                : "cursor-pointer rounded-lg bg-surface2 px-5 py-3 text-[.88rem] font-semibold text-fg transition-colors"}
            >
              {item.done ? "\u2705" : "\u2B1C"} {item.label}
            </div>
          ))}
        </div>
      </div>

      {/* Quran stats */}
      <div className="mb-6">
        <h3 className="mb-3 text-[.9rem] text-fg2">Quran Progress</h3>
        <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <StatTile label="Pages Today" value={d.quranToday || 0} />
          <StatTile label="Total Pages" value={total} />
          <StatTile label="Khatmas" value={khatmas} />
          <StatTile label="Days Reading" value={d.quranDays || 0} />
          <StatTile label="Avg Pages/Day" value={avgPagesPerDay} />
        </div>

        {/* Khatma progress bar */}
        <div className="mb-3">
          <div className="mb-1 flex justify-between text-[.82rem]">
            <span>Current Khatma Progress</span>
            <span className="text-green">{khatmaPct.toFixed(1)}%</span>
          </div>
          <div className="progress h-3">
            <div className="fill green" style={{ width: `${khatmaPct.toFixed(1)}%` }} />
          </div>
          <div className="mt-1 text-xs text-fg3">
            {total % 604} / 604 pages &middot; {pagesLeft} pages left
            {daysToComplete > 0 && ` &middot; ~${daysToComplete} days to complete at current pace`}
          </div>
        </div>

        {/* Log quran pages */}
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            max={30}
            value={quranPages}
            onChange={(e) => setQuranPages(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleLogQuran(); }}
            className="w-20"
          />
          <Button variant="primary" onClick={handleLogQuran}>
            Log Pages
          </Button>
        </div>
      </div>

      {/* Monthly quran reading chart */}
      {!historyLoading && quranHistory.length > 0 && (
        <div className="mb-6">
          <h3 className="mb-3 text-[.9rem] text-fg2">Quran Reading (Last 30 Days)</h3>
          <div className="flex h-[100px] items-end gap-0.5 px-1">
            {quranHistory.map((entry) => {
              const h = Math.max(2, (entry.pages / maxPages) * 80);
              return (
                <div
                  key={entry.date}
                  title={`${entry.date}: ${entry.pages} pages`}
                  style={{ height: h }}
                  className={entry.pages > 0 ? "min-w-1 flex-1 rounded-t-sm bg-green" : "min-w-1 flex-1 rounded-t-sm bg-surface2"}
                />
              );
            })}
          </div>
          <div className="mt-1 flex justify-between text-[.6rem] text-fg3">
            <span>{quranHistory[0]?.date?.slice(5)}</span>
            <span>{quranHistory[quranHistory.length - 1]?.date?.slice(5)}</span>
          </div>
        </div>
      )}

      {/* Adhkar history */}
      {!historyLoading && adhkarHistory.length > 0 && (
        <div>
          <h3 className="mb-3 text-[.9rem] text-fg2">Adhkar History (Last 30 Days)</h3>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[.78rem]">
              <thead>
                <tr>
                  <th className="border-b border-line px-2 py-1.5 text-left text-fg2">Date</th>
                  <th className="border-b border-line px-2 py-1.5 text-center text-fg2">Morning</th>
                  <th className="border-b border-line px-2 py-1.5 text-center text-fg2">Evening</th>
                  <th className="border-b border-line px-2 py-1.5 text-center text-fg2">Post-Prayer</th>
                </tr>
              </thead>
              <tbody>
                {adhkarHistory.map((entry) => (
                  <tr key={entry.date}>
                    <td className="border-b border-line px-2 py-1">{entry.date}</td>
                    <td className="border-b border-line px-2 py-1 text-center">
                      {entry.morning ? "\u2705" : "\u2B1C"}
                    </td>
                    <td className="border-b border-line px-2 py-1 text-center">
                      {entry.evening ? "\u2705" : "\u2B1C"}
                    </td>
                    <td className="border-b border-line px-2 py-1 text-center">
                      {entry.post_prayer ? "\u2705" : "\u2B1C"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
