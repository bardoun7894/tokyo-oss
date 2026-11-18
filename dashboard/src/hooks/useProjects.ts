import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, postApi } from "../api/client";
import type { ProjectsResponse } from "../types";
import type { ProjectReposResponse, RepoPatch } from "../types/projects";

export const PROJECTS_KEY = ["projects"] as const;
export const PROJECT_REPOS_KEY = ["project-repos"] as const;

/** Manual projects (deadlines, budget, hours). */
export function useProjects() {
  return useQuery<ProjectsResponse>({
    queryKey: PROJECTS_KEY,
    queryFn: () => api<ProjectsResponse>("/api/projects"),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

/** Git-synced repos plus sync state and edit lookups. */
export function useProjectRepos() {
  return useQuery<ProjectReposResponse>({
    queryKey: PROJECT_REPOS_KEY,
    queryFn: () => api<ProjectReposResponse>("/api/project-repos"),
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });
}

export function useSyncProjectRepos() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => postApi<ProjectReposResponse>("/api/project-repos/sync"),
    onSuccess: (data) => qc.setQueryData(PROJECT_REPOS_KEY, data),
  });
}

export function useUpdateProjectRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: RepoPatch }) =>
      postApi<{ ok: boolean }>(`/api/project-repos/${id}`, patch as Record<string, unknown>),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: PROJECT_REPOS_KEY });
      const prev = qc.getQueryData<ProjectReposResponse>(PROJECT_REPOS_KEY);
      if (prev) {
        qc.setQueryData<ProjectReposResponse>(PROJECT_REPOS_KEY, {
          ...prev,
          repos: prev.repos.map((r) => (r.id === id ? { ...r, ...patch } : r)),
        });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(PROJECT_REPOS_KEY, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: PROJECT_REPOS_KEY }),
  });
}
