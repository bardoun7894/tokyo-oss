import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { OverviewResponse } from "../types";

export const OVERVIEW_KEY = ["overview"] as const;

export function useOverview() {
  return useQuery<OverviewResponse>({
    queryKey: OVERVIEW_KEY,
    queryFn: () => api<OverviewResponse>("/api/overview"),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}
