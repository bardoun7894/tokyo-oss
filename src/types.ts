export interface PrayerTimes {
  fajr: string;
  sunrise: string;
  dhuhr: string;
  asr: string;
  maghrib: string;
  isha: string;
}

export interface NextPrayer {
  name: string;
  time: string;
  minutesUntil: number;
}

export interface TimeSlot {
  start: string;
  end: string;
  durationMinutes: number;
  label: string;
}

export interface Client {
  id: number;
  name: string;
  platform: "mostaql" | "upwork" | "direct" | "other";
  contact_info: string | null;
  notes: string | null;
  active: number;
  created_at: string;
}

export interface Project {
  id: number;
  client_id: number | null;
  name: string;
  description: string | null;
  category: "client" | "product" | "shop" | "internal";
  status: "proposal" | "active" | "paused" | "completed" | "cancelled";
  budget: number | null;
  currency: string;
  deadline: string | null;
  estimated_hours: number | null;
  actual_hours: number;
  created_at: string;
  completed_at: string | null;
}

export interface IncomeEntry {
  id: number;
  amount: number;
  currency: string;
  source: "mostaql" | "upwork" | "direct" | "shop" | "saas" | "other";
  project_id: number | null;
  description: string | null;
  date: string;
}

export interface ShopSale {
  id: number;
  date: string;
  total_revenue: number;
  items_sold: number | null;
  notes: string | null;
}

export interface QuranEntry {
  id: number;
  date: string;
  juz: number | null;
  surah: string | null;
  pages_read: number | null;
  notes: string | null;
}

export type CoachingScenario =
  | "prayer_wrapup"
  | "overwork"
  | "next_action"
  | "deadline_urgent"
  | "deadline_soon"
  | "deen_reminder"
  | "learning_window"
  | "midweek_check"
  | "marketing_nudge"
  | "balance_check";

export interface WeeklyReportData {
  tasksCompleted: number;
  tasksByCategory: Record<string, number>;
  totalWorkMinutes: number;
  workByType: Record<string, number>;
  habitsCompleted: number;
  habitsTotal: number;
  quranPages: number;
  adhkarDays: { morning: number; evening: number };
  devIncome: number;
  shopRevenue: number;
  totalIncome: number;
}
