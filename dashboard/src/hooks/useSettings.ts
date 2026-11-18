import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, postApi } from "../api/client";

export interface SettingItem {
  key: string;
  section: "profile" | "modules" | "ai" | "whatsapp" | "jobhunt";
  label: string;
  type: "bool" | "number" | "text" | "select";
  help?: string;
  on?: string;
  off?: string;
  onUnlessOff?: boolean;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  value: string;
  source: "dashboard" | "env" | "default";
}

export const SETTINGS_KEY = ["settings"] as const;

export function useSettings() {
  return useQuery<SettingItem[]>({
    queryKey: SETTINGS_KEY,
    queryFn: () => api<{ settings: SettingItem[] }>("/api/settings").then((d) => d.settings),
    staleTime: 60_000,
  });
}

export function useSaveSetting() {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, { key: string; value: string | null }>({
    mutationFn: (body) => postApi("/api/settings", body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SETTINGS_KEY }),
  });
}

export function isOn(s: SettingItem): boolean {
  return s.onUnlessOff ? s.value !== s.off : s.value === s.on;
}

// Sidebar paths -> module switch id (MODULE_<ID>).
const PATH_MODULE: Record<string, string> = {
  "/tasks": "tasks", "/work": "work", "/habits": "habits", "/deen": "deen", "/finance": "finance",
  "/money": "money", "/shop": "shop", "/projects": "projects", "/goals": "goals", "/journal": "journal", "/schedule": "schedule",
  "/whatsapp": "whatsapp", "/instagram": "instagram", "/chat": "chat", "/media": "media",
  "/transcripts": "transcripts", "/content": "content", "/trends": "trends", "/chat-analytics": "analytics", "/server": "server",
};

/** (path) => whether that page is switched on. Everything shows until settings load. */
export function useModuleVisible(): (path: string) => boolean {
  const { data } = useSettings();
  return (path: string) => {
    const id = PATH_MODULE[path];
    if (!id || !data) return true;
    const s = data.find((d) => d.key === `MODULE_${id.toUpperCase()}`);
    return s ? isOn(s) : true;
  };
}

/** Which Settings section the gear should open on a given page. */
export function settingsSectionFor(pathname: string): string {
  if (pathname.startsWith("/deen")) return "profile";
  if (["/whatsapp", "/transcripts", "/shop"].some((p) => pathname.startsWith(p))) return "whatsapp";
  if (pathname.startsWith("/tasks") || pathname.startsWith("/journal")) return "ai";
  return "modules";
}
