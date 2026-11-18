import type { Project } from "./index";

export type RepoHost = "server" | "mac";
export type RepoStatus = "active" | "paused" | "completed" | "cancelled";
export type RepoActivity = "active" | "idle" | "stale" | "unknown";
export type ProjectCategory = "client" | "product" | "shop" | "internal";

export const REPO_STATUSES: RepoStatus[] = ["active", "paused", "completed", "cancelled"];
export const PROJECT_CATEGORIES: ProjectCategory[] = ["client", "product", "shop", "internal"];

export interface ProjectRepo {
  id: number;
  host: RepoHost;
  path: string;
  name: string;
  branch: string | null;
  remote_url: string | null;
  last_commit_at: string | null;
  last_commit_subject: string | null;
  commits_7d: number;
  commits_30d: number;
  present: boolean;
  first_seen_at: string;
  last_seen_at: string;
  status: RepoStatus;
  client_id: number | null;
  category: ProjectCategory | null;
  description: string | null;
  hidden: boolean;
  project_id: number | null;
  client_name: string | null;
  project_name: string | null;
  project_deadline: string | null;
  project_budget: number | null;
  project_currency: string | null;
  project_status: string | null;
  project_client_name: string | null;
  activity: RepoActivity;
  daysSince: number | null;
}

export interface RepoSyncHost {
  host: RepoHost;
  last_attempt_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  repo_count: number | null;
}

export interface ManualProject extends Project {
  client_name: string | null;
}

export interface ProjectReposResponse {
  repos: ProjectRepo[];
  hosts: RepoSyncHost[];
  syncing: boolean;
  clients: { id: number; name: string }[];
  projects: ManualProject[];
}

export interface RepoPatch {
  status?: RepoStatus;
  client_id?: number | null;
  category?: ProjectCategory | null;
  description?: string | null;
  hidden?: boolean;
  project_id?: number | null;
}
