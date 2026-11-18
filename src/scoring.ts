import { localToday } from "./utils";

export interface ScoredTask {
  task: any;
  score: number;
  breakdown: {
    urgency: number;
    income: number;
    trust: number;
    windowFit: number;
    stateFit: number;
    ease: number;
    blocked: number;
  };
}

export interface ScoringContext {
  windowMinutes: number;
  state: string;
  today: string;
  promises?: any[];
}

export function urgency(task: any): number {
  const due = task.due_date;
  if (!due) return 2;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dueDate = new Date(due + "T00:00:00");
  const diff = (dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24);
  if (diff < 0) return 10;
  if (diff < 1) return 8;
  if (diff <= 3) return 6;
  if (diff <= 7) return 4;
  return 2;
}

export function incomeImpact(task: any): number {
  const cat = (task.category || "").toLowerCase();
  if (cat === "client") {
    if (task.project_budget) return 9;
    return 6;
  }
  if (cat === "product") return 7;
  if (cat === "shop") return 5;
  if (cat === "learning") return 3;
  if (cat === "deen") return 2;
  if (cat === "admin") return 4;
  if (cat === "health") return 2;
  if (cat === "personal") return 1;
  return 3;
}

export function trustImpact(task: any): number {
  if (task.promise_id) return 9;
  const cat = (task.category || "").toLowerCase();
  if (cat === "client" && task.status === "in_progress") return 7;
  if (cat === "client") return 5;
  return 2;
}

export function windowFit(task: any, windowMinutes: number): number {
  const est = task.estimated_hours;
  if (windowMinutes < 20) {
    if (est != null && est <= 0.25) return 10;
    if (est != null && est <= 0.5) return 6;
    if (est == null) return 8; // unknown duration — assume quick
    return 1;
  }
  if (est == null) return 5;
  const estMin = est * 60;
  if (estMin <= windowMinutes && estMin >= windowMinutes * 0.8) return 10;
  if (estMin <= windowMinutes) return 8;
  return 2;
}

export function stateFit(task: any, state: string): number {
  const cat = (task.category || "").toLowerCase();
  if (state === "deep_work" && (cat === "client" || cat === "product")) return 9;
  if (state === "shop_mode" && cat === "shop") return 9;
  if (state === "admin_mode" && cat === "admin") return 9;
  if (state === "low_energy" && task.estimated_hours != null && task.estimated_hours < 0.5) return 8;
  if (state === "low_energy" && ease(task) >= 6) return 8;
  if (state === "post_prayer" && (cat === "deen" || cat === "personal")) return 8;
  if (state === "idle") return 5;
  return 2;
}

export function ease(task: any): number {
  const est = task.estimated_hours;
  if (est == null) return 5;
  if (est < 0.5) return 8;
  if (est <= 1.5) return 6;
  if (est <= 3) return 4;
  return 2;
}

export function blocked(task: any): boolean {
  const notes = (task.notes || "").toLowerCase();
  if (notes.includes("blocked") || notes.includes("waiting")) return true;
  if (task.status === "in_progress") {
    const updated = task.updated_at;
    if (updated) {
      const lastUpdate = new Date(updated);
      const now = new Date();
      const daysSince = (now.getTime() - lastUpdate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince > 3) return true;
    }
  }
  return false;
}

export function scoreTask(task: any, context: ScoringContext): ScoredTask {
  const u = urgency(task);
  const i = incomeImpact(task);
  const t = trustImpact(task);
  const w = windowFit(task, context.windowMinutes);
  const s = stateFit(task, context.state);
  const e = ease(task);
  const b = blocked(task) ? 1 : 0;

  const score = 3.0 * u + 2.5 * i + 2.5 * t + 2.0 * w + 1.5 * s + 1.0 * e - 3.0 * b;

  return {
    task,
    score: Math.round(score * 100) / 100,
    breakdown: {
      urgency: u,
      income: i,
      trust: t,
      windowFit: w,
      stateFit: s,
      ease: e,
      blocked: b,
    },
  };
}

export function scoreTasks(tasks: any[], context: ScoringContext): ScoredTask[] {
  return tasks
    .map((task) => scoreTask(task, context))
    .sort((a, b) => b.score - a.score);
}
