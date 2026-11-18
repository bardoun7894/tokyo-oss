import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { WeeklyTrendEntry } from "../types";

export const TRENDS_KEY = ["weekly-trends"] as const;

export function useTrends() {
  return useQuery<WeeklyTrendEntry[]>({
    queryKey: TRENDS_KEY,
    queryFn: () => api<WeeklyTrendEntry[]>("/api/weekly-trends"),
    refetchInterval: 300_000,
    staleTime: 120_000,
  });
}
