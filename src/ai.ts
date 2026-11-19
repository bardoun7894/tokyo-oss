import { ownerName, ownerProfile, languageRule, currency, prayerOn, shopOn } from "./profile";
import { exec } from 'child_process';
import { runModelCli } from './model-cli';
import { promisify } from 'util';
import type { Bot } from 'grammy';
import * as db from './db';
import { getTodayPrayerTimes, getNextPrayer, getWorkWindows, formatPrayerTimesCompact } from './prayer';
import { getFinancialContext } from './finance';
import { getDeenContext } from './quran';
import { runCommand, getActiveClaudeSessions } from './shell';
import { localToday } from './utils';
import { getSkillsPromptSection, executeSkill } from './skills';
import { kieChat } from './kie-ai';

type AIModel = 'pi' | 'kieai';
let currentModel: AIModel = (process.env.AI_MODEL === 'kieai' ? 'kieai' : 'pi') as AIModel;
const PI_CMD = process.env.PI_CLI || 'pi';
// Async on purpose: execSync froze the whole event loop for up to 120s per call,
// stalling Baileys, Telegram and the embedded Temporal worker's polling.
const execAsync = promisify(exec);

export function setModel(model: AIModel) {
  currentModel = model;
  process.env.AI_MODEL = model;
  try {
    const fs = require('fs');
    const p = require('path');
    const envPath = p.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
      let content = fs.readFileSync(envPath, 'utf-8');
      if (content.includes('AI_MODEL=')) {
        content = content.replace(/AI_MODEL=.*/g, 'AI_MODEL=' + model);
      } else {
        content += '\nAI_MODEL=' + model + '\n';
      }
      fs.writeFileSync(envPath, content);
    }
  } catch (err) {
    console.error('Failed to save AI_MODEL to .env:', err);
  }
}
export function getModel(): AIModel { return currentModel; }
export function getModelLabel(): string {
  return currentModel === 'kieai' ? 'GPT-5.4 (kie.ai)' : 'Pi Agent (DeepSeek V4 Pro)';
}

async function piCall(systemPrompt: string, userMessage: string, maxTokens = 2048): Promise<string> {
  const fullPrompt = systemPrompt
    ? '[System]\n' + systemPrompt + '\n\n[User]\n' + userMessage + '\n\n[Assistant]'
    : userMessage;
  try {
    const stdout = await runModelCli(PI_CMD, ['-p', '--mode', 'text', '--no-tools', '--no-session'], fullPrompt, {
      timeout: maxTokens > 4096 ? 120_000 : 60_000,
      env: { ...process.env, PI_OFFLINE: '1' },
    });
    return stdout.trim();
  } catch (err: any) {
    if (err.stderr) console.error('[pi] stderr:', err.stderr);
    if (err.stdout) return err.stdout.trim();
    console.error('[pi] Error:', err.message);
    throw err;
  }
}

export async function aiCall(
  systemPrompt: string,
  messages: { role: 'user' | 'assistant'; content: string }[],
  maxTokens = 2048,
  model?: AIModel,
): Promise<string> {
  const useModel = model || currentModel;
  if (useModel === 'kieai') {
    try {
      return await kieChat(systemPrompt, messages, maxTokens);
    } catch (err: any) {
      console.error('kie.ai failed, falling back to Pi:', err.message);
    }
  }
  const conversationLines = messages.map(m => m.role === 'user' ? '[User]\n' + m.content : '[Assistant]\n' + m.content);
  const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || '';
  const userPrompt = conversationLines.length > 1
    ? conversationLines.slice(0, -1).join('\n\n') + '\n\n[User]\n' + lastUserMsg + '\n\n[Assistant]'
    : lastUserMsg;
  return piCall(systemPrompt, userPrompt, maxTokens);
}

// Free tier (OpenRouter :free model, plain HTTP, no tools). Free endpoints may log prompts,
// so only send public or non-sensitive input here — never client messages or finances.
// Falls back to aiCall when the free route fails or is rate limited.
const FREE_MODEL = process.env.FREE_MODEL || 'deepseek/deepseek-v4-flash-0731:free';

export async function freeCall(systemPrompt: string, userMessage: string, maxTokens = 1500): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (key) {
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'tokyo' },
        body: JSON.stringify({
          model: FREE_MODEL,
          max_tokens: maxTokens,
          messages: [
            ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
            { role: 'user', content: userMessage },
          ],
        }),
        signal: AbortSignal.timeout(90_000),
      });
      const data: any = await resp.json().catch(() => null);
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (resp.ok && text) return text;
      console.warn(`[free] ${FREE_MODEL} failed (${resp.status}): ${JSON.stringify(data?.error || data).slice(0, 200)}`);
    } catch (err: any) {
      console.warn('[free] error:', err?.message || err);
    }
  }
  return aiCall(systemPrompt, [{ role: 'user', content: userMessage }], maxTokens);
}

function getTodayStr(): string {
  return localToday();
}

/** Read per call so a /setup change applies to the next message. */
export function systemPrompt(): string {
  return `You are Tokyo — a personal life & work management assistant for ${ownerName()}.
${ownerProfile()}
Keep messages short and actionable. ${languageRule()}`;
}

export async function buildContext(): Promise<string> {
  const today = getTodayStr();
  const tasks = db.getAllActiveTasks() as any[];
  const habits = db.getHabitLogsForDate(today) as any[];
  const schedule = db.getScheduleForDate(today) as any[];
  const workStats = db.getWorkStats(today);
  const journals = db.getRecentJournals(3) as any[];
  const projects = db.getActiveProjects() as any[];
  const clients = db.getActiveClients() as any[];

  let prayerCtx = "";
  if (prayerOn()) try {
    const times = await getTodayPrayerTimes();
    const next = await getNextPrayer();
    const windows = await getWorkWindows();
    prayerCtx = `### Prayer Times Today
${formatPrayerTimesCompact(times)}
Next: ${next.name} in ${next.minutesUntil} min

### Work Windows (between prayers)
${windows.map((w) => `${w.start}-${w.end} (${Math.floor(w.durationMinutes / 60)}h${w.durationMinutes % 60}m) ${w.label}`).join("\n")}`;
  } catch {
    prayerCtx = "### Prayer Times\nUnavailable — using approximate times.";
  }

  const workByType = Object.entries(workStats.byType)
    .map(([type, mins]) => `${type}: ${Math.round(mins / 60)}h${mins % 60}m`)
    .join(", ") || "nothing tracked";

  const financialCtx = getFinancialContext();
  const deenCtx = prayerOn() ? getDeenContext() : "";

  return `## Current Context (${today})

${prayerCtx}${prayerCtx ? "\n\n" : ""}### Active Tasks (${tasks.length})
${tasks.length > 0
    ? tasks.map((t) => {
        const subs = db.getSubtasks(t.id) as any[];
        let line = `- [${t.priority}][${t.category}] #${t.id} ${t.title}${t.due_date ? ` (due: ${t.due_date})` : ""} — ${t.status}`;
        if (subs.length > 0) line += `\n  Subtasks: ${subs.map((s) => `#${s.id} ${s.title} (${s.status})`).join(", ")}`;
        return line;
      }).join("\n")
    : "No active tasks."}

### Active Projects (${projects.length})
${projects.length > 0
    ? projects.map((p) => {
        const deadline = p.deadline ? ` (due: ${p.deadline})` : "";
        const budget = p.budget ? ` — ${p.budget} ${p.currency}` : "";
        const hours = p.estimated_hours ? ` [${p.actual_hours || 0}/${p.estimated_hours}h]` : "";
        const cl = p.client_name ? `[${p.client_name}]` : `[${p.category}]`;
        return `- #${p.id} ${cl} ${p.name}${deadline}${budget}${hours} — ${p.status}`;
      }).join("\n")
    : "No active projects."}

### Clients (${clients.length})
${clients.length > 0
    ? clients.map((c) => `- #${c.id} ${c.name} (${c.platform})`).join(", ")
    : "No clients."}

### Today's Schedule
${schedule.length > 0 ? schedule.map((s) => `- ${s.time}: ${s.title}${s.recurring ? " 🔁" : ""}`).join("\n") : "Nothing scheduled."}

### Habits Today
${habits.length > 0 ? habits.map((h) => `- ${h.done ? "✅" : "⬜"} ${h.name}`).join("\n") : "No habits tracked."}

${deenCtx ? `### Deen Today\n${deenCtx}\n\n` : ""}### Work Today
Total: ${workStats.totalWorkMinutes} min work, ${workStats.totalBreakMinutes} min breaks
By type: ${workByType}

### Financial (This Month)
${financialCtx}

### Expenses (This Month)
${(() => {
    try {
      const now = new Date();
      const mStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
      const total = db.getExpenseTotal(mStart, today);
      const summary = db.getExpenseSummary(mStart, today);
      if (total === 0) return "No expenses logged this month.";
      return `Total: ${total} ${currency()}\n${summary.map((s: any) => `- ${s.category}: ${s.total} ${currency()}`).join("\n")}`;
    } catch { return "No expense data."; }
  })()}

### Recent Journal
${journals.length > 0 ? journals.map((j) => `- ${j.mood ? `[${j.mood}] ` : ""}${j.entry.substring(0, 100)}`).join("\n") : "No recent entries."}

### Goals
${(() => {
  try {
    const goals = db.getGoals();
    if (goals.length === 0) return "No goals set.";
    return goals.map((g: any) => {
      const progress = g.target_value > 0 ? Math.round((g.current_value / g.target_value) * 100) : 0;
      const bar = "█".repeat(Math.floor(progress / 10)) + "░".repeat(10 - Math.floor(progress / 10));
      return `- ${g.title} [${g.metric}]: ${bar} ${progress}% (${g.current_value}/${g.target_value}, ${g.period})`;
    }).join("\n");
  } catch { return "No goals data."; }
})()}

### WhatsApp Messages
${(() => {
    try {
      const byCategory = db.getUnrepliedByCategory();
      const catLabels: Record<string, string> = { client: "👤 Client", shop: "🏪 Shop", family: "👨‍👩‍👧 Family", personal: "🏠 Personal", other: "📱 Other" };
      const catOrder = ["client", ...(shopOn() ? ["shop"] : []), "family", "personal", "other"];
      const lines: string[] = [];
      let totalUnreplied = 0;
      for (const cat of catOrder) {
        const msgs = byCategory[cat];
        if (!msgs || msgs.length === 0) continue;
        totalUnreplied += msgs.length;
        lines.push(`**${catLabels[cat] || cat} (${msgs.length} unreplied):**`);
        for (const m of msgs.slice(0, 3)) {
          const time = new Date(m.timestamp * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
          lines.push(`- ${m.display_name || m.sender_name}: "${m.content.slice(0, 80)}" (${time})`);
        }
        if (msgs.length > 3) lines.push(`  ...and ${msgs.length - 3} more`);
      }
      if (totalUnreplied === 0) lines.push("No unreplied messages.");
      return lines.join("\n");
    } catch { return "WhatsApp data unavailable."; }
  })()}`.trim();
}

export async function chat(userMessage: string, bot?: Bot, chatId?: number): Promise<string> {
  const context = await buildContext();
  const recentConvos = db.getRecentConversations(10) as { role: string; content: string }[];

  const messages: { role: "user" | "assistant"; content: string }[] = [];
  for (const conv of recentConvos.reverse()) {
    const safeContent = conv.content.replace(/<action>[\s\S]*?<\/action>/g, "[Action Executed]");
    messages.push({ role: conv.role as "user" | "assistant", content: safeContent });
  }
  messages.push({ role: "user", content: userMessage });

  db.saveConversation("user", userMessage);

  const assistantMessage = await aiCall(
    `${systemPrompt()}\n\n${getSkillsPromptSection()}\n\n${context}`,
    messages,
    2048
  );

  db.saveConversation("assistant", assistantMessage);
  return assistantMessage;
}

export async function generateBriefing(type: "morning" | "evening" = "morning"): Promise<string> {
  const context = await buildContext();
  const prompt =
    type === "morning"
      ? `Generate a morning briefing. Include ${prayerOn() ? "prayer times, " : ""}today's priorities for the owner's work, pending deadlines, habits to do, ${prayerOn() ? "a Quran/adhkar reminder, " : ""}and goals progress. Check the Goals section for current goal status and mention any that need attention. Check the WhatsApp Messages section — highlight any unreplied messages that need attention.${prayerOn() ? " Start with بسم الله." : ""}`
      : `Generate an evening review. Summarize what was accomplished, habits done, work time split by type, ${prayerOn() ? "deen status (prayers/Quran/adhkar), " : ""}balance score (1-10), and suggestions for tomorrow.`;

  return await aiCall(
    `${systemPrompt()}\n\n${context}`,
    [{ role: "user", content: prompt }],
    1500
  );
}

export async function generateCoaching(focusedPrompt: string): Promise<string> {
  const context = await buildContext();

  return await aiCall(
    `${systemPrompt()}\n\n${context}\n\nYou are sending a proactive coaching message. Be direct, concise (2-3 sentences max), and actionable. No greetings or fluff.`,
    [{ role: "user", content: focusedPrompt }],
    500
  );
}
