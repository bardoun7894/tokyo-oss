import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useOverview, OVERVIEW_KEY } from "../hooks/useOverview";
import { api, postApi } from "../api/client";
import { useToast } from "../components/ui/Toast";
import { Button, Input, Select, Textarea } from "@bardouni/ui";
import type { JournalEntry, ApiOkResponse } from "../types";

const MOODS = [
  { value: "", label: "All Moods" },
  { value: "great", label: "Great" },
  { value: "good", label: "Good" },
  { value: "okay", label: "Okay" },
  { value: "tired", label: "Tired" },
  { value: "stressed", label: "Stressed" },
];

const MOOD_WRITE_OPTIONS = [
  { value: "", label: "Select mood" },
  { value: "great", label: "Great" },
  { value: "good", label: "Good" },
  { value: "okay", label: "Okay" },
  { value: "tired", label: "Tired" },
  { value: "stressed", label: "Stressed" },
];

export default function JournalPage() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const { data: overview } = useOverview();

  const [allEntries, setAllEntries] = useState<JournalEntry[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterMood, setFilterMood] = useState("");

  // New entry
  const [text, setText] = useState("");
  const [mood, setMood] = useState("");

  useEffect(() => {
    api<JournalEntry[]>("/api/journal")
      .then((data) => {
        setAllEntries(data || []);
        setEntriesLoading(false);
      })
      .catch(() => {
        // Fall back to overview entries
        setAllEntries(overview?.journal || []);
        setEntriesLoading(false);
      });
  }, [overview]);

  const submitMutation = useMutation<ApiOkResponse, Error, { entry: string; mood?: string }>({
    mutationFn: (data) =>
      postApi<ApiOkResponse>("/api/journal", {
        entry: data.entry,
        mood: data.mood,
      }),
    onSuccess: () => {
      showToast("Journal saved!");
      setText("");
      setMood("");
      queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });
      // Refresh
      api<JournalEntry[]>("/api/journal")
        .then((data) => setAllEntries(data || []))
        .catch(() => {});
    },
    onError: (err) => showToast(err.message || "Failed", "error"),
  });

  function handleSubmit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    submitMutation.mutate({
      entry: trimmed,
      mood: mood || undefined,
    });
  }

  // Use allEntries if loaded, otherwise fall back to overview
  const entries = allEntries.length > 0 ? allEntries : (overview?.journal || []);

  // Filter
  const filtered = entries.filter((e) => {
    if (filterMood && e.mood !== filterMood) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!e.entry.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  // Mood stats
  const moodCounts: Record<string, number> = {};
  for (const e of entries) {
    const m = e.mood || "unset";
    moodCounts[m] = (moodCounts[m] || 0) + 1;
  }

  return (
    <div className="detail-page">
      <a className="back-link" onClick={() => navigate("/")}>
        &larr; Back to Dashboard
      </a>
      <h2>Journal</h2>

      {/* New entry form */}
      <div className="mb-5 rounded-lg bg-surface2 p-3.5">
        <div className="mb-2 text-[.85rem] font-semibold">New Entry</div>
        <Textarea
          placeholder="Write something..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="min-h-[80px] w-full"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Select value={mood} onChange={(e) => setMood(e.target.value)}>
            {MOOD_WRITE_OPTIONS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </Select>
          <Button variant="primary" className="font-semibold" onClick={handleSubmit} disabled={submitMutation.isPending}>
            Save Entry
          </Button>
        </div>
      </div>

      {/* Mood summary */}
      {Object.keys(moodCounts).length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2.5">
          {Object.entries(moodCounts).map(([m, count]) => (
            <div key={m} className="rounded-md bg-surface2 px-3 py-1.5 text-[.78rem]">
              <span className="font-semibold">{m}</span>: {count}
            </div>
          ))}
        </div>
      )}

      {/* Search & filter */}
      <div className="mb-4 flex flex-wrap gap-2">
        <Input
          type="text"
          placeholder="Search entries..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="min-w-[200px] flex-1"
        />
        <Select value={filterMood} onChange={(e) => setFilterMood(e.target.value)}>
          {MOODS.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </Select>
      </div>

      {/* Entries list */}
      {entriesLoading ? (
        <div className="loading">Loading journal entries...</div>
      ) : filtered.length === 0 ? (
        <div className="p-5 text-center text-fg3">
          {entries.length === 0 ? "No journal entries yet." : "No entries match your filter."}
        </div>
      ) : (
        filtered.map((e) => (
          <div key={e.id} className="mb-2 rounded-lg bg-surface1 px-3.5 py-3">
            <div className="text-[.88rem] leading-normal break-words whitespace-pre-wrap">{e.entry}</div>
            <div className="mt-2 flex flex-wrap gap-3">
              {e.mood && (
                <span className="rounded bg-surface2 px-2 py-0.5 text-[.78rem] text-accent2">
                  {e.mood}
                </span>
              )}
              <span className="text-[.75rem] text-fg3">
                {e.logged_at || ""}
              </span>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
