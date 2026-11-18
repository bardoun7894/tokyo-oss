import type { Agent, AgentContext, AgentResult, AgentDomain } from "../types";
import type { AgentEvent } from "../event-bus";
import { localToday } from "../../utils";
import { InlineKeyboard } from "grammy";

// ─── Command Handlers ──────────────────────────────────────

async function handleQuran(args: string, ctx: AgentContext): Promise<AgentResult> {
  const parts = args.trim().split(/\s+/);
  const pages = parseFloat(parts[0]);
  if (!pages || isNaN(pages)) {
    return { success: false, output: "Usage: /quran [pages]\n\nExample: /quran 5\nOr chat naturally: \"قرأت 3 صفحات من القرآن\"" };
  }
  const juz = parts[1] ? parseInt(parts[1], 10) : undefined;
  ctx.db.logQuranReading(pages, juz);
  const progress = ctx.db.getQuranProgress();
  const output =
    `📖 Logged ${pages} pages. بارك الله فيك!\n\n` +
    `Total: ${progress.totalPages} pages across ${progress.daysRead} days` +
    (progress.totalPages >= 604
      ? "\n🎉 You've completed a full Quran!"
      : `\n📊 ${((progress.totalPages / 604) * 100).toFixed(1)}% of the Quran`);
  return { success: true, output };
}

async function handleQuranStats(ctx: AgentContext): Promise<AgentResult> {
  const progress = ctx.db.getQuranProgress();
  const khatmas = Math.floor((progress.totalPages || 0) / 604);
  const remaining = 604 - ((progress.totalPages || 0) % 604);
  const avgPages = progress.daysRead > 0 ? ((progress.totalPages || 0) / progress.daysRead).toFixed(1) : "0";

  let msg = `📖 *Quran Progress*\n\n`;
  msg += `Total pages read: *${progress.totalPages || 0}*\n`;
  msg += `Days reading: *${progress.daysRead || 0}*\n`;
  msg += `Daily average: *${avgPages} pages*\n`;
  msg += `Khatmas completed: *${khatmas}*\n`;
  msg += `Pages to next khatma: *${remaining}*\n`;

  if (progress.latest) {
    msg += `\nLast reading: ${progress.latest.pages_read} pages${progress.latest.juz ? ` (Juz ${progress.latest.juz})` : ""} — ${progress.latest.date}`;
  }

  return { success: true, output: msg };
}

async function handleAdhkar(args: string, ctx: AgentContext): Promise<AgentResult> {
  const type = args.trim().toLowerCase();
  if (!["morning", "evening"].includes(type)) {
    const today = localToday();
    const status = ctx.db.getAdhkarStatus(today);
    return {
      success: true,
      output:
        `🤲 *Today's Adhkar:*\n\n` +
        `${status.morning ? "✅" : "⬜"} Morning adhkar\n` +
        `${status.evening ? "✅" : "⬜"} Evening adhkar\n\n` +
        `Mark done: /adhkar morning or /adhkar evening`,
    };
  }
  ctx.db.logAdhkar(type);
  const emoji = type === "morning" ? "🌅" : "🌙";
  return { success: true, output: `${emoji} ${type.charAt(0).toUpperCase() + type.slice(1)} adhkar logged. جزاك الله خيرا!` };
}

// ─── Action Handlers ───────────────────────────────────────

async function handleAction(action: Record<string, any>, ctx: AgentContext): Promise<string | void> {
  switch (action.type) {
    case "log_quran":
      ctx.db.logQuranReading(action.pages, action.juz, undefined, action.notes);
      break;

    case "log_adhkar":
      ctx.db.logAdhkar(action.adhkar_type);
      break;

    default:
      return;
  }
}

// ─── Context Builder ───────────────────────────────────────

function buildDeenContext(db: typeof import("../../db")): string {
  const today = localToday();
  const adhkar = db.getAdhkarStatus(today);
  const progress = db.getQuranProgress();

  let ctx = `### Deen Today\n`;
  ctx += `Adhkar: ${adhkar.morning ? "✅" : "⬜"} Morning ${adhkar.evening ? "✅" : "⬜"} Evening\n`;
  ctx += `Quran: ${progress.totalPages || 0} total pages, ${progress.daysRead || 0} days`;
  if (progress.latest) {
    ctx += `, last: ${progress.latest.pages_read}p on ${progress.latest.date}`;
  }
  return ctx;
}

// ─── System Prompt Section ─────────────────────────────────

function getDeenPromptSection(): string {
  return `## Deen Actions
- {"type": "log_quran", "pages": number, "juz": number, "notes": "..."}
- {"type": "log_adhkar", "adhkar_type": "morning|evening"}

## RELIGION — TOP PRIORITY (NON-NEGOTIABLE)
The owner practises Islam and asked Tokyo to put prayer and worship first. You MUST:
- ALWAYS schedule around the 5 daily prayers. NEVER schedule work during prayer times or within 20 minutes after prayer.
- Check the Work Windows in context — these are the available blocks between prayers.
- Include prayer time awareness in all scheduling advice.
- Friday (Jumu'ah) is sacred — minimal work, encourage early masjid.
- Encourage Quran reading, dhikr, and Islamic knowledge.
- Track Ramadan, Eid, Islamic occasions.`;
}

// ─── Prayer Schedule Logic ─────────────────────────────────

function registerPrayerSchedule(ctx: AgentContext): void {
  // Dynamic imports to avoid circular dependencies at module load time
  const setupPrayerTimers = async () => {
    const { getTodayPrayerTimes, msUntilTime, prefetchTomorrow } = await import("../../prayer");
    const cron = (await import("node-cron")).default;

    let prayerTimers: NodeJS.Timeout[] = [];

    const schedulePrayerReminders = async () => {
      // Clear old timers
      for (const t of prayerTimers) clearTimeout(t);
      prayerTimers = [];

      const times = await getTodayPrayerTimes();

      const prayers = [
        { name: "Fajr", time: times.fajr, emoji: "🌅", msg: "وقت صلاة الفجر. قم وصلِّ! The best way to start your day." },
        { name: "Dhuhr", time: times.dhuhr, emoji: "☀️", msg: "وقت صلاة الظهر. Take a break and pray." },
        { name: "Asr", time: times.asr, emoji: "🌤", msg: "وقت صلاة العصر. Don't let work make you miss it!" },
        { name: "Maghrib", time: times.maghrib, emoji: "🌅", msg: "وقت صلاة المغرب. Pray on time." },
        { name: "Isha", time: times.isha, emoji: "🌙", msg: "وقت صلاة العشاء. End your day right." },
      ];

      for (const prayer of prayers) {
        const ms = msUntilTime(prayer.time);
        if (ms > 0) {
          // Prayer time notification
          prayerTimers.push(setTimeout(() => {
            ctx.sendMessage(`${prayer.emoji} *${prayer.name} — ${prayer.time}*\n\n${prayer.msg}`);
            // Emit event for other agents (e.g. productivity to suggest wrapping up)
            ctx.eventBus.fire({
              type: "prayer:time",
              source: "deen",
              domain: "deen",
              data: { name: prayer.name, time: prayer.time },
              timestamp: Date.now(),
            });
          }, ms));

          // 10-min warning — emit approaching event
          const warningMs = ms - 10 * 60000;
          if (warningMs > 0) {
            prayerTimers.push(setTimeout(() => {
              ctx.eventBus.fire({
                type: "prayer:approaching",
                source: "deen",
                domain: "deen",
                data: { name: prayer.name, time: prayer.time, minutesUntil: 10 },
                timestamp: Date.now(),
              });
            }, warningMs));
          }
        }
      }

      // Morning adhkar — 30 min after Fajr
      const fajrMs = msUntilTime(times.fajr);
      const morningAdhkarMs = fajrMs + 30 * 60000;
      if (morningAdhkarMs > 0) {
        prayerTimers.push(setTimeout(() => {
          const kb = new InlineKeyboard()
            .text("✅ Done Morning Adhkar", "adhkar:morning")
            .text("✅ Done Quran", "habit:4");
          ctx.sendMessage("🤲 *Morning Adhkar Reminder*\n\nTime for morning adhkar and Quran!", { reply_markup: kb });
        }, morningAdhkarMs));
      }

      // Evening adhkar — 30 min before Maghrib
      const maghribMs = msUntilTime(times.maghrib);
      const eveningAdhkarMs = maghribMs - 30 * 60000;
      if (eveningAdhkarMs > 0) {
        prayerTimers.push(setTimeout(() => {
          const kb = new InlineKeyboard()
            .text("✅ Done Evening Adhkar", "adhkar:evening");
          ctx.sendMessage("🤲 *Evening Adhkar Reminder*\n\nTime for evening adhkar before Maghrib.", { reply_markup: kb });
        }, eveningAdhkarMs));
      }

      // After each prayer — post-prayer adhkar button (15 min after adhan)
      for (const prayer of prayers) {
        const afterPrayerMs = msUntilTime(prayer.time) + 15 * 60000;
        if (afterPrayerMs > 0 && prayer.name !== "Fajr") {
          prayerTimers.push(setTimeout(() => {
            const kb = new InlineKeyboard()
              .text("✅ Post-Prayer Adhkar", "adhkar:post_prayer");
            ctx.sendMessage(`🤲 Did you pray *${prayer.name}*? Don't forget post-prayer adhkar.`, { reply_markup: kb });
          }, afterPrayerMs));
        }
      }

      // Friday Jumu'ah — 1 hour before Dhuhr
      if (new Date().getDay() === 5) {
        const jumuahMs = msUntilTime(times.dhuhr) - 60 * 60000;
        if (jumuahMs > 0) {
          prayerTimers.push(setTimeout(() => {
            ctx.sendMessage(
              "🕌 *Jumu'ah Reminder*\n\n" +
              "اللهم صل وسلم على نبينا محمد\n\n" +
              "Don't forget:\n• Ghusl\n• Surah Al-Kahf\n• Extra du'a\n• Go early to the masjid"
            );
          }, jumuahMs));
        }
      }

      console.log(`[deen] Prayer reminders set: ${Object.entries(times).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    };

    // Set up today's reminders immediately
    await schedulePrayerReminders();

    // Midnight: re-fetch prayer times + set next day's reminders
    cron.schedule("0 0 * * *", async () => {
      console.log("[deen] Midnight: refreshing prayer times...");
      await schedulePrayerReminders();
      await prefetchTomorrow();
    });
  };

  // Fire-and-forget setup (don't block registration)
  setupPrayerTimers().catch((err) => {
    console.error("[deen] Failed to set up prayer schedule:", err);
  });
}

// ─── Prayer Context for AI ─────────────────────────────────

async function buildPrayerContext(): Promise<string> {
  try {
    const { getTodayPrayerTimes, getNextPrayer, getWorkWindows, formatPrayerTimesCompact } = await import("../../prayer");
    const times = await getTodayPrayerTimes();
    const next = await getNextPrayer();
    const windows = await getWorkWindows();
    return `### Prayer Times Today
${formatPrayerTimesCompact(times)}
Next: ${next.name} in ${next.minutesUntil} min

### Work Windows (between prayers)
${windows.map((w) => `${w.start}-${w.end} (${Math.floor(w.durationMinutes / 60)}h${w.durationMinutes % 60}m) ${w.label}`).join("\n")}`;
  } catch {
    return "### Prayer Times\nUnavailable — using approximate times.";
  }
}

// ─── Agent Definition ──────────────────────────────────────

const deenAgent: Agent = {
  name: "deen",
  domain: "deen" as AgentDomain,
  description: "Spiritual companion — prayer times, Quran tracking, adhkar reminders, and Islamic scheduling.",

  handles: [],
  keywords: [
    "quran", "adhkar", "prayer", "صلاة", "قرآن", "أذكار", "صفحات",
    "juz", "deen", "دين",
  ],
  commands: ["adhkar", "quran", "quranstats"],
  actions: ["log_quran", "log_adhkar"],

  getSystemPromptSection(): string {
    return getDeenPromptSection();
  },

  async getContextSection(): Promise<string> {
    const db = await import("../../db");
    const deenCtx = buildDeenContext(db);
    const prayerCtx = await buildPrayerContext();
    return `${prayerCtx}\n\n${deenCtx}`;
  },

  async handleEvent(_event: AgentEvent, _ctx: AgentContext): Promise<AgentResult> {
    // Deen agent doesn't subscribe to events — it publishes them
    return { success: true, output: "", silent: true };
  },

  async handleCommand(command: string, args: string, ctx: AgentContext): Promise<AgentResult> {
    switch (command) {
      case "quran": return handleQuran(args, ctx);
      case "quranstats": return handleQuranStats(ctx);
      case "adhkar": return handleAdhkar(args, ctx);
      default:
        return { success: false, output: `Unknown deen command: /${command}` };
    }
  },

  async handleAction(action: Record<string, any>, ctx: AgentContext): Promise<string | void> {
    return handleAction(action, ctx);
  },

  registerSchedule(ctx: AgentContext): void {
    registerPrayerSchedule(ctx);
  },
};

export default deenAgent;
