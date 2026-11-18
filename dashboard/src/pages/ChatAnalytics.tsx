import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, postApi } from "../api/client";
import SentimentTimeline from "../components/charts/SentimentTimeline";
import SentimentByContact from "../components/charts/SentimentByContact";
import ResponseTimeChart from "../components/charts/ResponseTimeChart";
import FrequencyChart from "../components/charts/FrequencyChart";
import HabitsHeatmap from "../components/charts/HabitsHeatmap";
import MessageLengthChart from "../components/charts/MessageLengthChart";
import { useToast } from "../components/ui/Toast";
import { Button } from "@bardouni/ui";

interface SentimentResponse {
  overall: { date: string; positive: number; negative: number; neutral: number }[];
  byContact: Record<string, { name: string; positive: number; negative: number; neutral: number }>;
}

interface HabitsResponse {
  responseTime: Record<string, { name: string; avgMinutes: number }>;
  frequency: { date: string; count: number }[];
  heatmap: number[][];
  messageLength: { date: string; avgChars: number }[];
}

export default function ChatAnalyticsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const sentimentQuery = useQuery<SentimentResponse>({
    queryKey: ["chat-sentiment"],
    queryFn: () => api<SentimentResponse>("/api/chat-analyzer/sentiment?period=month"),
    refetchInterval: false,
  });

  const habitsQuery = useQuery<HabitsResponse>({
    queryKey: ["chat-habits"],
    queryFn: () => api<HabitsResponse>("/api/chat-analyzer/habits"),
    refetchInterval: false,
  });

  const classifyMutation = useMutation({
    mutationFn: (limit: number) =>
      postApi<{ classified: number; skipped: number; errors: number; elapsedMs: number }>(
        "/api/chat-analyzer/classify",
        { limit }
      ),
    onSuccess: (data) => {
      showToast(
        `Classified ${data.classified} messages in ${(data.elapsedMs / 1000).toFixed(1)}s` +
          (data.errors > 0 ? ` (${data.errors} errors)` : ""),
        "info"
      );
      queryClient.invalidateQueries({ queryKey: ["chat-sentiment"] });
      queryClient.invalidateQueries({ queryKey: ["chat-habits"] });
    },
    onError: (err: Error) => {
      showToast(err.message, "error");
    },
  });

  const hasSentimentData =
    sentimentQuery.data &&
    (sentimentQuery.data.overall.length > 0 || Object.keys(sentimentQuery.data.byContact).length > 0);

  const hasHabitsData =
    habitsQuery.data &&
    (Object.keys(habitsQuery.data.responseTime).length > 0 ||
      habitsQuery.data.frequency.length > 0 ||
      habitsQuery.data.messageLength.length > 0);

  return (
    <div className="detail-page">
      <a className="back-link" onClick={() => navigate("/")}>
        &larr; Back to Dashboard
      </a>

      <div className="mb-4 flex items-center justify-between">
        <h2>Chat Analyzer</h2>
        <Button
          variant="primary"
          onClick={() => classifyMutation.mutate(10000)}
          disabled={classifyMutation.isPending}
        >
          {classifyMutation.isPending ? "Classifying..." : "Run Classification"}
        </Button>
      </div>

      {classifyMutation.isPending && (
        <div className="mb-4 rounded-lg bg-surface1 p-3 text-[.82rem] text-blue">
          Classifying messages... This may take a few minutes for 10,000 messages.
        </div>
      )}

      {/* Sentiment Section */}
      <h3 className="mt-6 mb-3 text-[.9rem] font-semibold text-fg2">
        Sentiment Analysis
      </h3>

      {sentimentQuery.isLoading ? (
        <div className="loading">Loading sentiment data...</div>
      ) : sentimentQuery.isError ? (
        <div className="loading">Failed to load sentiment data</div>
      ) : !hasSentimentData ? (
        <div className="rounded-lg bg-surface1 p-6 text-center">
          <div className="mb-3 text-[.85rem] text-fg3">
            No sentiment data yet. Run classification to analyze your messages.
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <SentimentTimeline data={sentimentQuery.data?.overall} />
          <SentimentByContact data={sentimentQuery.data?.byContact} />
        </div>
      )}

      {/* Habits Section */}
      <h3 className="mt-8 mb-3 text-[.9rem] font-semibold text-fg2">
        Communication Habits
      </h3>

      {habitsQuery.isLoading ? (
        <div className="loading">Loading habits data...</div>
      ) : habitsQuery.isError ? (
        <div className="loading">Failed to load habits data</div>
      ) : !hasHabitsData ? (
        <div className="rounded-lg bg-surface1 p-6 text-center">
          <div className="text-[.85rem] text-fg3">
            No habit data available. Messages are needed to compute habits.
          </div>
        </div>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <FrequencyChart data={habitsQuery.data?.frequency} />
            <ResponseTimeChart data={habitsQuery.data?.responseTime} />
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <HabitsHeatmap data={habitsQuery.data?.heatmap} />
            <MessageLengthChart data={habitsQuery.data?.messageLength} />
          </div>
        </>
      )}
    </div>
  );
}
