import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, postApi, deleteApi } from "../api/client";
import type { Goal, ApiOkResponse, GoalMetric, GoalPeriod } from "../types";

export const GOALS_KEY = ["goals"] as const;

export function useGoals() {
  return useQuery<Goal[]>({
    queryKey: GOALS_KEY,
    queryFn: () => api<Goal[]>("/api/goals"),
    refetchInterval: 300_000,
    staleTime: 60_000,
  });
}

export function useCreateGoal() {
  const queryClient = useQueryClient();

  return useMutation<
    ApiOkResponse,
    Error,
    { title: string; metric: GoalMetric; targetValue: number; period: GoalPeriod }
  >({
    mutationFn: (data) => postApi<ApiOkResponse>("/api/goals", {
      title: data.title,
      metric: data.metric,
      targetValue: data.targetValue,
      period: data.period,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: GOALS_KEY });
    },
  });
}

export function useUpdateGoalValue() {
  const queryClient = useQueryClient();

  return useMutation<
    ApiOkResponse,
    Error,
    { id: number; value: number }
  >({
    mutationFn: ({ id, value }) =>
      postApi<ApiOkResponse>(`/api/goals/${id}/update`, { value }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: GOALS_KEY });
    },
  });
}

export function useDeleteGoal() {
  const queryClient = useQueryClient();

  return useMutation<ApiOkResponse, Error, number>({
    mutationFn: (id) => deleteApi<ApiOkResponse>(`/api/goals/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: GOALS_KEY });
    },
  });
}
