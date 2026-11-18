// ========================
// Prayer
// ========================

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

export interface WorkWindow {
  start: string;
  end: string;
  durationMinutes: number;
  label: string;
}

// ========================
// Tasks
// ========================

export interface Subtask {
  id: number;
  task_id: number;
  title: string;
  status: "pending" | "done";
}

export type Area = "work" | "personal" | "learn";

export interface Task {
  id: number;
  title: string;
  category: string;
  area: Area | null;
  priority: "low" | "medium" | "high" | "urgent";
  status: string;
  due_date: string | null;
  project_id: number | null;
  created_at: string;
  subtasks: Subtask[];
}

export interface CompletedTask {
  id: number;
  title: string;
  category: string;
  completed_at: string;
}

// ========================
// Habits
// ========================

export interface HabitItem {
  id: number;
  name: string;
  frequency: string;
  category: string | null;
  done: boolean;
  streak: number;
}

// ========================
// Work
// ========================

export interface ActiveSession {
  id: number;
  note: string | null;
  work_type: string;
  minutes_active: number;
  project_id: number | null;
  project_name: string | null;
}

// ========================
// Deen
// ========================

export interface AdhkarStatus {
  morning: boolean;
  evening: boolean;
  postPrayer: boolean;
  general: boolean;
}

// ========================
// Finance
// ========================

export interface IncomeSourceSummary {
  source: string;
  total: number;
  currency: string;
}

export interface IncomeEntry {
  id: number;
  amount: number;
  currency: string;
  source: string;
  description: string | null;
  date: string;
}

export interface ShopSaleEntry {
  date: string;
  total_revenue: number;
  items_sold: number | null;
}

export interface ProjectRate {
  name: string;
  rate: number;
  hours: number;
  income: number;
}

// ========================
// Schedule
// ========================

export interface ScheduleItem {
  id: number;
  title: string;
  time: string;
  recurring: boolean;
}

// ========================
// Journal
// ========================

export interface JournalEntry {
  id: number;
  entry: string;
  mood: string | null;
  logged_at: string;
}

// ========================
// Coaching
// ========================

export interface CoachingData {
  latest: {
    message_summary: string;
  } | null;
  countToday: number;
}

// ========================
// Overview (GET /api/overview)
// ========================

export interface OverviewResponse {
  date: string;
  prayer: PrayerTimes | null;
  nextPrayer: NextPrayer | null;
  workWindows: WorkWindow[] | null;
  tasks: {
    active: Task[];
    count: number;
    completedToday: CompletedTask[];
  };
  habits: {
    items: HabitItem[];
    completedCount: number;
    totalCount: number;
  };
  work: {
    totalMinutes: number;
    breakMinutes: number;
    byType: Record<string, number>;
    activeSession: ActiveSession | null;
  };
  deen: {
    adhkar: AdhkarStatus;
    quranToday: number;
    quranTotal: number;
    quranDays: number;
  };
  finance: {
    monthDevIncome: number;
    monthShopRevenue: number;
    monthTotal: number;
    bySource: IncomeSourceSummary[];
    incomeList: IncomeEntry[];
    shopWeekLog: ShopSaleEntry[];
    projectRates: ProjectRate[];
  };
  schedule: ScheduleItem[];
  journal: JournalEntry[];
  coaching: CoachingData;
}

// ========================
// Projects (GET /api/projects)
// ========================

export interface Project {
  id: number;
  client_id: number | null;
  name: string;
  description: string | null;
  category: "client" | "product" | "shop" | "internal";
  status: string;
  budget: number | null;
  currency: string;
  deadline: string | null;
  estimated_hours: number | null;
  actual_hours: number;
  created_at: string;
}

export interface ProjectsResponse {
  projects: Project[];
  upcomingDeadlines: Array<{
    id: number;
    name: string;
    deadline: string;
  }>;
}

// ========================
// Goals (GET /api/goals)
// ========================

export type GoalMetric = "income" | "quran_pages" | "work_hours" | "tasks" | "habits" | "custom";
export type GoalPeriod = "weekly" | "monthly" | "yearly";

export interface Goal {
  id: number;
  title: string;
  metric: GoalMetric;
  target_value: number;
  current_value: number;
  period: GoalPeriod;
  currentValue: number;
  progress: number;
}

// ========================
// Weekly Trends (GET /api/weekly-trends)
// ========================

export interface WeeklyTrendEntry {
  weekStart: string;
  weekEnd: string;
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

// ========================
// WhatsApp
// ========================

export interface WhatsAppStatus {
  status: "connected" | "disconnected" | "qr" | "pairing" | "connecting" | "blocked";
  qrDataUrl?: string;
  pairingCode?: string;
}

export interface WhatsAppChat {
  jid: string;
  name: string;
  lastMessage: string;
  lastTimestamp: number;
  unreadCount: number;
}

export interface WhatsAppMessage {
  id: string;
  content: string;
  fromMe: boolean;
  senderName: string | null;
  timestamp: number;
}

// ========================
// Chat / Conversations
// ========================

export interface ConversationMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

// ========================
// Server
// ========================

export interface ServerResponse {
  status: string;
}

// ========================
// Calendar
// ========================

export interface DaySummary {
  date: string;
  tasksCompleted: number;
  tasksCreated: number;
  workMinutes: number;
  habitsCompleted: number;
  habitsTotal: number;
  quranPages: number;
  journalCount: number;
  income: number;
  waMessages?: number;
  conversations?: number;
}

export interface CalendarRangeResponse {
  start: string;
  end: string;
  days: DaySummary[];
}

export interface DailyActivity {
  date: string;
  tasksCompleted: { id: number; title: string; category: string; completed_at: string }[];
  tasksCreated: { id: number; title: string; status: string; category: string }[];
  activeTasks: { id: number; title: string; category: string; priority: string; status: string; due_date: string | null }[];
  habits: { id: number; name: string; done: boolean }[];
  work: {
    totalMinutes: number;
    breakMinutes: number;
    byType: Record<string, number>;
  };
  journals: { id: number; entry: string; mood: string | null; logged_at: string }[];
  quranPages: number;
  adhkar: { morning: boolean; evening: boolean; postPrayer: boolean };
  schedule: { id: number; title: string; time: string; recurring: boolean }[];
  income: { amount: number; source: string; description: string | null }[];
  shopSales: { total_revenue: number; items_sold: number | null }[];
  whatsapp: {
    messages: { id: number; jid: string; sender_name: string; content: string; from_me: boolean; timestamp: number; contact_category?: string; contact_display_name?: string; message_type?: string; media_path?: string; transcription?: string }[];
    received: number;
    sent: number;
    chats: number;
  };
  conversations: { role: string; content: string; created_at: string }[];
}

// ========================
// Generic API response
// ========================

export interface ApiOkResponse {
  ok: true;
  id?: number;
}

export interface ApiErrorResponse {
  error: string;
}

export interface BreakToggleResponse {
  ok: true;
  onBreak: boolean;
}

export interface HabitToggleResponse {
  ok: true;
  done: boolean;
}
