import * as db from "./db";
import { localToday } from "./utils";

export interface ExtractedPromise {
  content: string;
  dueDate?: string;
  dueContext?: string;
  madeTo?: string;
}

function addDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("en-CA", { timeZone: process.env.TIMEZONE || "Africa/Casablanca" });
}

function parseContextDate(ctx: string): string | undefined {
  const today = localToday();
  const lower = ctx.toLowerCase().trim();
  if (/بكرا/.test(lower) || lower === "tomorrow") return addDays(1);
  if (/هذه الليلة/.test(lower) || lower === "tonight" || lower === "today") return today;
  if (/بعد صلاة/.test(lower)) return today;
  if (/بعدين/.test(lower) || lower === "later") return addDays(2);
  if (lower === "next week") return addDays(7);
  const dateMatch = lower.match(/(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) return dateMatch[1];
  const shortDate = lower.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})/i);
  if (shortDate) {
    const months: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const month = months[shortDate[1].toLowerCase()];
    const day = parseInt(shortDate[2]);
    const d = new Date(new Date().getFullYear(), month, day);
    return d.toLocaleDateString("en-CA", { timeZone: process.env.TIMEZONE || "Africa/Casablanca" });
  }
  return undefined;
}

export function extractPromises(text: string): ExtractedPromise[] {
  const results: ExtractedPromise[] = [];
  const lines = text.split(/[\n.!?]+/).map(l => l.trim()).filter(l => l.length > 3);

  for (const line of lines) {
    let match: RegExpMatchArray | null;

    match = line.match(/أوعدك\s+(.{3,}?)(?:\s+(بكرا|هذه الليلة|بعدين|بعد صلاة (?:الفجر|الظهر|العصر|المغرب|العشاء)))?\s*$/);
    if (match) {
      const dueContext = match[2] || undefined;
      results.push({ content: match[1].trim(), dueDate: dueContext ? parseContextDate(dueContext) : undefined, dueContext });
      continue;
    }

    match = line.match(/حن\s+(.{3,}?)(?:\s+(بكرا|هذه الليلة|بعدين|بعد صلاة (?:الفجر|الظهر|العصر|المغرب|العشاء)))?\s*$/);
    if (match) {
      const dueContext = match[2] || undefined;
      results.push({ content: match[1].trim(), dueDate: dueContext ? parseContextDate(dueContext) : undefined, dueContext });
      continue;
    }

    match = line.match(/بكرا\s+(.{3,})/);
    if (match) {
      results.push({ content: match[1].trim(), dueDate: addDays(1), dueContext: "بكرا" });
      continue;
    }

    match = line.match(/هذه الليلة\s+(.{3,})/);
    if (match) {
      results.push({ content: match[1].trim(), dueDate: localToday(), dueContext: "هذه الليلة" });
      continue;
    }

    match = line.match(/بعدين\s+(.{3,})/);
    if (match) {
      results.push({ content: match[1].trim(), dueDate: addDays(2), dueContext: "بعدين" });
      continue;
    }

    match = line.match(/بعد صلاة (الفجر|الظهر|العصر|المغرب|العشاء)\s+(.{3,})/);
    if (match) {
      results.push({ content: match[2].trim(), dueDate: localToday(), dueContext: `بعد صلاة ${match[1]}` });
      continue;
    }

    match = line.match(/I'll\s+(.{3,}?)(?:\s+(?:by|before|until)\s+(.+?))?\s*$/i);
    if (match) {
      const dueContext = match[2]?.trim();
      results.push({ content: match[1].trim(), dueDate: dueContext ? parseContextDate(dueContext) : undefined, dueContext });
      continue;
    }

    match = line.match(/I will\s+(.{3,}?)(?:\s+(?:by|before|until)\s+(.+?))?\s*$/i);
    if (match) {
      const dueContext = match[2]?.trim();
      results.push({ content: match[1].trim(), dueDate: dueContext ? parseContextDate(dueContext) : undefined, dueContext });
      continue;
    }

    match = line.match(/I promise\s+(?:to\s+)?(.{3,}?)(?:\s+(?:by|before|until)\s+(.+?))?\s*$/i);
    if (match) {
      const dueContext = match[2]?.trim();
      results.push({ content: match[1].trim(), dueDate: dueContext ? parseContextDate(dueContext) : undefined, dueContext });
      continue;
    }

    match = line.match(/(?:I'll|I will)\s+.+?\s+next week/i);
    if (match) {
      results.push({ content: match[0].replace(/^I(?:'ll| will)\s+/i, "").replace(/\s+next week$/i, "").trim(), dueDate: addDays(7), dueContext: "next week" });
      continue;
    }

    match = line.match(/(?:after|قبل)\s+(Fajr|Dhuhr|Asr|Maghrib|Isha|الفجر|الظهر|العصر|المغرب|العشاء)\s+(.{3,})/i);
    if (match) {
      results.push({ content: match[2].trim(), dueDate: localToday(), dueContext: `after ${match[1]}` });
      continue;
    }

    // Additional Arabic patterns
    match = line.match(/سأ(?:فعل|قوم|نجز|رسل|كتب|عمل)\s+(.{3,}?)(?:\s+(بكرا|هذه الليلة|بعدين))?\s*$/);
    if (match) {
      const dueContext = match[2] || undefined;
      results.push({ content: match[1].trim(), dueDate: dueContext ? parseContextDate(dueContext) : undefined, dueContext });
      continue;
    }

    match = line.match(/عندي\s+(.{3,}?)(?:\s+(?:لازم|بكرا|هذه الليلة))?\s*$/);
    if (match) {
      results.push({ content: match[1].trim(), dueDate: undefined });
      continue;
    }

    // Additional English patterns
    match = line.match(/I (?:should|need to|have to|must)\s+(.{3,}?)(?:\s+(?:by|before|until)\s+(.+?))?\s*$/i);
    if (match) {
      const dueContext = match[2]?.trim();
      results.push({ content: match[1].trim(), dueDate: dueContext ? parseContextDate(dueContext) : undefined, dueContext });
      continue;
    }
  }

  return results;
}

function formatShortDate(dateStr: string): string {
  try {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return dateStr;
  }
}

export function formatPromisesOutput(): string {
  const today = localToday();
  const allPromises = db.getPromises() as any[];
  const active = allPromises.filter((p: any) => !["fulfilled", "broken"].includes(p.status));

  if (active.length === 0) return "📋 No active promises. Keep your word — make one!";

  const overdue: any[] = [];
  const dueToday: any[] = [];
  const pending: any[] = [];

  for (const p of active) {
    if (p.status === "overdue" || (p.due_date && p.due_date < today && ["pending", "due_soon"].includes(p.status))) {
      overdue.push(p);
    } else if (p.due_date === today || (p.status === "due_soon" && p.due_date && p.due_date <= today)) {
      dueToday.push(p);
    } else {
      pending.push(p);
    }
  }

  const sections: string[] = ["📋 *Promises*"];

  if (overdue.length > 0) {
    sections.push("");
    sections.push("🔴 *OVERDUE:*");
    for (const p of overdue) {
      const due = p.due_date ? ` (was due ${formatShortDate(p.due_date)})` : "";
      const madeTo = p.made_to ? ` [${p.made_to}]` : "";
      sections.push(`  #${p.id} — ${p.content}${due}${madeTo}`);
    }
  }

  if (dueToday.length > 0) {
    sections.push("");
    sections.push("🟡 *DUE TODAY:*");
    for (const p of dueToday) {
      const ctx = p.due_context ? ` (${p.due_context})` : p.due_date ? ` (by ${formatShortDate(p.due_date)})` : "";
      const madeTo = p.made_to ? ` [${p.made_to}]` : "";
      sections.push(`  #${p.id} — ${p.content}${ctx}${madeTo}`);
    }
  }

  if (pending.length > 0) {
    sections.push("");
    sections.push("🟢 *PENDING:*");
    for (const p of pending) {
      const due = p.due_date ? ` (by ${formatShortDate(p.due_date)})` : "";
      const madeTo = p.made_to ? ` [${p.made_to}]` : "";
      sections.push(`  #${p.id} — ${p.content}${due}${madeTo}`);
    }
  }

  return sections.join("\n");
}

export function formatPromiseSummary(): string {
  const today = localToday();
  const overdue = db.getOverduePromises() as any[];
  const dueToday = (db.getDueTodayPromises() as any[]).filter((p: any) => p.due_date && p.due_date <= today);

  const todayCount = dueToday.length;
  const overdueCount = overdue.length;

  if (todayCount === 0 && overdueCount === 0) return "";

  const lines: string[] = [`📋 ${todayCount} promise${todayCount !== 1 ? "s" : ""} due today, ${overdueCount} overdue`];

  if (overdueCount > 0) {
    lines.push(`🔴 Overdue: ${overdue.slice(0, 3).map((p: any) => p.content).join(", ")}`);
  }
  if (todayCount > 0) {
    lines.push(`🟡 Today: ${dueToday.slice(0, 3).map((p: any) => p.content).join(", ")}`);
  }

  return lines.join("\n");
}
