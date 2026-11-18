/**
 * Tokyo social publisher — Telegram surface.
 *
 * Two ways in:
 *   1. Drop a video in the chat → a panel appears with the preset, the
 *      per-platform switches and a Publish button.
 *   2. /share <path-or-url> for anything bigger than Telegram's 20 MB bot
 *      download cap, or for a file already sitting on the server.
 *
 * Every switch state is persisted, so the panel always opens on the same
 * defaults you left it on.
 */

import fs from "fs";
import path from "path";
import type { Bot } from "grammy";
import {
  downloadTelegramFile,
  downloadRemote,
  probe,
  ensureDirs,
  sweep,
  humanSize,
  humanDuration,
  publicHostingReady,
  TELEGRAM_DOWNLOAD_LIMIT,
} from "./media";
import { ADAPTERS } from "./adapters";
import { runJob, resolvePlatforms, presetWarnings } from "./publish";
import {
  createJob,
  getJob,
  getTargets,
  setTargets,
  updateJob,
  setJobStatus,
  listSwitches,
  toggleSwitch,
  listRecentJobs,
  scheduleJob,
  unscheduleJob,
  pendingScheduled,
  getAccount,
  deleteAccount,
  initSocialTables,
} from "./store";
import {
  PLATFORMS,
  PLATFORM_EMOJI,
  PLATFORM_LABEL,
  PRESET_PLATFORMS,
  type Platform,
  type Preset,
} from "./types";
import { youtubeAuthUrl, youtubeExchangeCode } from "./adapters/youtube";
import { tiktokAuthUrl, tiktokExchangeCode } from "./adapters/tiktok";
import { linkedinAuthUrl, linkedinExchangeCode } from "./adapters/linkedin";

/**
 * OAuth redirect URI, per platform.
 *
 * These never have to serve anything — you copy the `code` out of the browser
 * bar by hand — but each one must be registered byte-identically in that
 * platform's app settings. They differ because the platforms disagree:
 * TikTok rejects localhost and demands https, while an app you already
 * registered against localhost is easier to reuse than to amend.
 */
function redirectFor(platform: Platform): string {
  const specific = process.env[`SOCIAL_OAUTH_REDIRECT_${platform.toUpperCase()}`];
  return specific || process.env.SOCIAL_OAUTH_REDIRECT || "https://example.com/oauth/callback";
}

/** Chats waiting for the next text message to become a job's caption. */
const awaitingCaption = new Map<number, number>();
/** Chats waiting for the next text message to become a job's post time. */
const awaitingSchedule = new Map<number, number>();
/** Throttle for the live progress edit. */
const lastEdit = new Map<number, number>();

function isPlatform(v: string): v is Platform {
  return (PLATFORMS as string[]).includes(v);
}

function firstLine(text: string, fallback: string): string {
  const line = (text || "").split("\n").find((l) => l.trim());
  return (line || fallback).trim().slice(0, 100);
}

function escapeMd(text: string): string {
  return text.replace(/([_*`\[\]])/g, "\\$1");
}

/**
 * Parse the handful of ways a person actually writes a post time.
 * The server runs on the same timezone as you, so plain Date maths is honest.
 * Returns epoch ms, or null when the text is not a time at all.
 */
export function parseWhen(text: string, now = new Date()): number | null {
  const s = text.trim().toLowerCase();

  const rel = s.match(/^\+\s*(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours|d|day|days)$/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2][0];
    const ms = unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * 86_400_000;
    return now.getTime() + ms;
  }

  const abs = s.match(/^(\d{4})-(\d{2})-(\d{2})[ t](\d{1,2}):(\d{2})$/);
  if (abs) {
    const d = new Date(Number(abs[1]), Number(abs[2]) - 1, Number(abs[3]), Number(abs[4]), Number(abs[5]), 0, 0);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }

  const named = s.match(/^(today|tomorrow)\s+(\d{1,2}):(\d{2})$/);
  const bare = s.match(/^(\d{1,2}):(\d{2})$/);
  if (named || bare) {
    const h = Number(named ? named[2] : bare![1]);
    const m = Number(named ? named[3] : bare![2]);
    if (h > 23 || m > 59) return null;
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (named?.[1] === "tomorrow") d.setDate(d.getDate() + 1);
    // A bare time that already passed today means the next one.
    else if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  return null;
}

export function formatWhen(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameDay ? `today ${time}` : `${d.toISOString().slice(0, 10)} ${time}`;
}

// --- Panel ---

function renderPanel(jobId: number): { text: string; keyboard: any } {
  const job = getJob(jobId);
  if (!job) return { text: "This job is gone.", keyboard: { inline_keyboard: [] } };

  const chosen = getTargets(jobId).map((t) => t.platform);
  const eligible = resolvePlatforms(job.preset, chosen);
  const warnings = presetWarnings(
    {
      path: job.media_path,
      mime: "video/mp4",
      sizeBytes: job.size_bytes || 0,
      durationSec: job.duration_sec || 0,
      width: job.width || 0,
      height: job.height || 0,
    },
    job.preset
  );

  const lines = [
    `*Share #${jobId}*`,
    `\`${escapeMd(path.basename(job.media_path))}\``,
    `${humanDuration(job.duration_sec || 0)} · ${job.width}×${job.height} · ${humanSize(job.size_bytes || 0)}`,
    "",
    `Place: *${job.preset === "short" ? "🎬 SHORT" : "📺 VIDEO"}*  ·  ${job.privacy === "private" ? "🔒 private" : "🌍 public"}${job.scheduled_at ? `  ·  🕐 ${formatWhen(job.scheduled_at)}` : ""}`,
    `Caption: ${job.caption ? escapeMd(job.caption.slice(0, 180)) : "_none — tap ✏️_"}`,
  ];

  if (eligible.selected.length) {
    lines.push("", `Will post to: ${eligible.selected.map((p) => PLATFORM_LABEL[p]).join(", ")}`);
  } else {
    lines.push("", "_Nothing selected yet._");
  }
  const blocked = eligible.skipped.filter((s) => chosen.includes(s.platform));
  for (const s of blocked) lines.push(`⚠️ ${PLATFORM_LABEL[s.platform]}: ${s.reason}`);
  for (const w of warnings) lines.push(`⚠️ ${w}`);

  const presetRow = [
    { text: `${job.preset === "short" ? "✅" : "▫️"} 🎬 SHORT`, callback_data: `sc:preset:${jobId}:short` },
    { text: `${job.preset === "video" ? "✅" : "▫️"} 📺 VIDEO`, callback_data: `sc:preset:${jobId}:video` },
  ];

  const toggles: any[][] = [];
  const order = PRESET_PLATFORMS[job.preset];
  for (let i = 0; i < order.length; i += 2) {
    toggles.push(
      order.slice(i, i + 2).map((p) => ({
        text: `${chosen.includes(p) ? "✅" : "⬜"} ${PLATFORM_EMOJI[p]} ${PLATFORM_LABEL[p]}`,
        callback_data: `sc:tg:${jobId}:${p}`,
      }))
    );
  }

  return {
    text: lines.join("\n"),
    keyboard: {
      inline_keyboard: [
        presetRow,
        ...toggles,
        [
          { text: "✏️ Caption", callback_data: `sc:cap:${jobId}` },
          { text: job.privacy === "private" ? "🔒 Private" : "🌍 Public", callback_data: `sc:priv:${jobId}` },
        ],
        [
          {
            text: job.scheduled_at ? `🕐 ${formatWhen(job.scheduled_at)}` : "🕐 Schedule",
            callback_data: `sc:sched:${jobId}`,
          },
        ],
        [
          { text: job.scheduled_at ? "🚀 Publish now" : "🚀 Publish", callback_data: `sc:go:${jobId}` },
          { text: "✖ Cancel", callback_data: `sc:x:${jobId}` },
        ],
      ],
    },
  };
}

async function showPanel(ctx: any, jobId: number, edit = false) {
  const { text, keyboard } = renderPanel(jobId);
  const opts = { parse_mode: "Markdown", reply_markup: keyboard };
  if (edit) {
    try {
      await ctx.editMessageText(text, opts);
      return;
    } catch {
      /* message unchanged or too old — fall through to a fresh one */
    }
  }
  await ctx.reply(text, opts);
}

// --- Job creation ---

async function createJobFromFile(
  filePath: string,
  opts: { preset: Preset; caption: string; source: string }
): Promise<number> {
  const asset = await probe(filePath);
  const jobId = createJob({
    preset: opts.preset,
    title: firstLine(opts.caption, `Tokyo clip ${new Date().toISOString().slice(0, 10)}`),
    caption: opts.caption,
    mediaPath: asset.path,
    durationSec: asset.durationSec,
    width: asset.width,
    height: asset.height,
    sizeBytes: asset.sizeBytes,
    privacy: "public",
    source: opts.source,
  });
  // Seed the selection from the saved switches for that preset.
  const defaults = PRESET_PLATFORMS[opts.preset].filter((p) => listSwitches(opts.preset)[p]);
  setTargets(jobId, defaults);
  return jobId;
}

/** Pick the preset from the clip itself: vertical and short → SHORT. */
function guessPreset(durationSec: number, width: number, height: number): Preset {
  return height > width && durationSec <= 180 ? "short" : "video";
}

// --- Publishing with a live-updating message ---

/**
 * Publish a job and keep one Telegram message updated as it goes.
 * Takes a bare `api` rather than a `ctx` so the queue watcher and the
 * scheduler can call it with no incoming update to answer.
 */
export async function publishJob(api: any, chatId: number, jobId: number) {
  const job = getJob(jobId)!;
  const chosen = getTargets(jobId).map((t) => t.platform);
  const eligible = resolvePlatforms(job.preset, chosen);

  if (!eligible.selected.length) {
    const why = eligible.skipped.map((s) => `• ${PLATFORM_LABEL[s.platform]} — ${s.reason}`).join("\n");
    await api.sendMessage(chatId, `Nothing to publish.\n${why || "Select at least one platform."}`);
    return;
  }
  setTargets(jobId, eligible.selected);

  const status = new Map<Platform, string>();
  for (const p of eligible.selected) status.set(p, "⏳ queued");
  for (const s of eligible.skipped) status.set(s.platform, `⏭ skipped — ${s.reason}`);

  const header = `*Publishing #${jobId}* — ${job.preset === "short" ? "🎬 SHORT" : "📺 VIDEO"}`;
  const render = () =>
    [header, "", ...[...status.entries()].map(([p, s]) => `${PLATFORM_EMOJI[p]} *${PLATFORM_LABEL[p]}* — ${s}`)].join("\n");

  const msg = await api.sendMessage(chatId, render(), { parse_mode: "Markdown" });
  const messageId = msg.message_id;

  const flush = async (force = false) => {
    const now = Date.now();
    if (!force && now - (lastEdit.get(jobId) || 0) < 3000) return;
    lastEdit.set(jobId, now);
    try {
      await api.editMessageText(chatId, messageId, render(), { parse_mode: "Markdown" });
    } catch {
      /* identical text or rate limited — the next flush covers it */
    }
  };

  const results = await runJob(jobId, (e) => {
    if (e.phase === "start") status.set(e.platform, "⬆️ uploading");
    else if (e.phase === "log") status.set(e.platform, `⬆️ ${e.message}`);
    else if (e.phase === "done") {
      const r = e.result!;
      status.set(e.platform, `✅ ${r.url || r.id || "posted"}${r.warning ? `\n   ⚠️ ${r.warning}` : ""}`);
    } else if (e.phase === "fail") status.set(e.platform, `❌ ${e.message}`);
    void flush(e.phase !== "log");
  });

  await flush(true);
  const ok = results.filter((r) => r.ok).length;
  await api
    .sendMessage(chatId, `Done — ${ok}/${results.length} platforms posted.`, { reply_to_message_id: messageId })
    .catch(() => {});
}

// --- Registration ---

export function registerSocialCommands(bot: Bot): void {
  initSocialTables();
  ensureDirs();
  sweep();

  const botToken = process.env.TELEGRAM_BOT_TOKEN!;

  // 1. A video dropped in the chat opens the panel.
  bot.on("message:video", async (ctx) => {
    const video = ctx.message.video;
    if ((video.file_size || 0) > TELEGRAM_DOWNLOAD_LIMIT) {
      await ctx.reply(
        `That clip is ${humanSize(video.file_size || 0)} — Telegram only lets bots download 20 MB.\n` +
          `Put it on the server and run \`/share /path/to/file.mp4\`, or \`/share https://…\`.`,
        { parse_mode: "Markdown" }
      );
      return;
    }
    const notice = await ctx.reply("⬇️ Fetching the clip…");
    try {
      const file = await ctx.getFile();
      const local = await downloadTelegramFile(file.file_path!, botToken, ".mp4");
      const caption = ctx.message.caption || "";
      const preset = guessPreset(video.duration || 0, video.width || 0, video.height || 0);
      const jobId = await createJobFromFile(local, { preset, caption, source: "telegram" });
      await ctx.api.deleteMessage(ctx.chat.id, notice.message_id).catch(() => {});
      await showPanel(ctx, jobId);
    } catch (err: any) {
      await ctx.api
        .editMessageText(ctx.chat.id, notice.message_id, `Could not read that video: ${err.message}`)
        .catch(() => {});
    }
  });

  // 2. Videos sent as a file. Anything else falls through untouched.
  bot.on("message:document", async (ctx, next) => {
    const doc = ctx.message.document;
    const isVideo = (doc.mime_type || "").startsWith("video/") || /\.(mp4|mov|m4v|webm)$/i.test(doc.file_name || "");
    if (!isVideo) return next();
    if ((doc.file_size || 0) > TELEGRAM_DOWNLOAD_LIMIT) {
      await ctx.reply(`That file is ${humanSize(doc.file_size || 0)} — over Telegram's 20 MB bot limit. Use /share instead.`);
      return;
    }
    const notice = await ctx.reply("⬇️ Fetching the clip…");
    try {
      const file = await ctx.getFile();
      const local = await downloadTelegramFile(file.file_path!, botToken, path.extname(doc.file_name || ".mp4"));
      const asset = await probe(local);
      const jobId = await createJobFromFile(local, {
        preset: guessPreset(asset.durationSec, asset.width, asset.height),
        caption: ctx.message.caption || "",
        source: "telegram",
      });
      await ctx.api.deleteMessage(ctx.chat.id, notice.message_id).catch(() => {});
      await showPanel(ctx, jobId);
    } catch (err: any) {
      await ctx.api
        .editMessageText(ctx.chat.id, notice.message_id, `Could not read that file: ${err.message}`)
        .catch(() => {});
    }
  });

  // 3. A text message while a caption edit is pending belongs to that job.
  bot.on("message:text", async (ctx, next) => {
    // A pending schedule prompt takes the next message before the caption one.
    const schedJob = awaitingSchedule.get(ctx.chat.id);
    if (schedJob && !ctx.message.text.startsWith("/")) {
      const when = parseWhen(ctx.message.text);
      if (when === null) {
        await ctx.reply("Didn't understand that time. Try `18:30`, `tomorrow 09:00`, `+2h`, or `2026-08-22 14:00`.", {
          parse_mode: "Markdown",
        });
        return;
      }
      if (when <= Date.now()) {
        await ctx.reply("That time is already past.");
        return;
      }
      awaitingSchedule.delete(ctx.chat.id);
      scheduleJob(schedJob, when, ctx.chat.id);
      await ctx.reply(`Share #${schedJob} scheduled for *${formatWhen(when)}*.`, { parse_mode: "Markdown" });
      await showPanel(ctx, schedJob);
      return;
    }

    const jobId = awaitingCaption.get(ctx.chat.id);
    if (!jobId) return next();
    if (ctx.message.text.startsWith("/")) return next();
    awaitingCaption.delete(ctx.chat.id);
    updateJob(jobId, {
      caption: ctx.message.text,
      title: firstLine(ctx.message.text, `Tokyo clip ${new Date().toISOString().slice(0, 10)}`),
    });
    await showPanel(ctx, jobId);
  });

  // --- Panel callbacks ---

  bot.callbackQuery(/^sc:preset:(\d+):(short|video)$/, async (ctx) => {
    const jobId = Number(ctx.match[1]);
    const preset = ctx.match[2] as Preset;
    updateJob(jobId, { preset });
    // Re-seed the selection from the new preset's switches.
    setTargets(jobId, PRESET_PLATFORMS[preset].filter((p) => listSwitches(preset)[p]));
    await ctx.answerCallbackQuery({ text: preset === "short" ? "SHORT" : "VIDEO" });
    await showPanel(ctx, jobId, true);
  });

  bot.callbackQuery(/^sc:tg:(\d+):(\w+)$/, async (ctx) => {
    const jobId = Number(ctx.match[1]);
    const platform = ctx.match[2];
    if (!isPlatform(platform)) return ctx.answerCallbackQuery();
    const current = getTargets(jobId).map((t) => t.platform);
    const next = current.includes(platform)
      ? current.filter((p) => p !== platform)
      : [...current, platform];
    setTargets(jobId, next);
    await ctx.answerCallbackQuery({
      text: `${PLATFORM_LABEL[platform]} ${next.includes(platform) ? "on" : "off"}`,
    });
    await showPanel(ctx, jobId, true);
  });

  bot.callbackQuery(/^sc:cap:(\d+)$/, async (ctx) => {
    const jobId = Number(ctx.match[1]);
    awaitingCaption.set(ctx.chat!.id, jobId);
    await ctx.answerCallbackQuery();
    await ctx.reply(`Send the caption for share #${jobId} as your next message.`);
  });

  bot.callbackQuery(/^sc:sched:(\d+)$/, async (ctx) => {
    const jobId = Number(ctx.match[1]);
    const job = getJob(jobId);
    if (!job) return ctx.answerCallbackQuery({ text: "gone" });

    // Tapping the button on an already-scheduled job clears the schedule.
    if (job.scheduled_at) {
      unscheduleJob(jobId);
      await ctx.answerCallbackQuery({ text: "schedule cleared" });
      await showPanel(ctx, jobId, true);
      return;
    }
    awaitingSchedule.set(ctx.chat!.id, jobId);
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `When should share #${jobId} go out?\nReply with \`18:30\`, \`tomorrow 09:00\`, \`+2h\`, or \`2026-08-22 14:00\`.`,
      { parse_mode: "Markdown" }
    );
  });

  bot.callbackQuery(/^sc:priv:(\d+)$/, async (ctx) => {
    const jobId = Number(ctx.match[1]);
    const job = getJob(jobId);
    if (!job) return ctx.answerCallbackQuery({ text: "gone" });
    updateJob(jobId, { privacy: job.privacy === "private" ? "public" : "private" });
    await ctx.answerCallbackQuery();
    await showPanel(ctx, jobId, true);
  });

  bot.callbackQuery(/^sc:x:(\d+)$/, async (ctx) => {
    const jobId = Number(ctx.match[1]);
    const job = getJob(jobId);
    setJobStatus(jobId, "cancelled");
    if (job) {
      try {
        fs.unlinkSync(job.media_path);
      } catch {
        /* already gone */
      }
    }
    await ctx.answerCallbackQuery({ text: "cancelled" });
    await ctx.editMessageText(`Share #${jobId} cancelled.`).catch(() => {});
  });

  bot.callbackQuery(/^sc:go:(\d+)$/, async (ctx) => {
    const jobId = Number(ctx.match[1]);
    await ctx.answerCallbackQuery({ text: "publishing…" });
    unscheduleJob(jobId);
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
    publishJob(ctx.api, ctx.chat!.id, jobId).catch(async (err) => {
      console.error("[social] publish failed:", err);
      await ctx.reply(`Publish failed: ${err.message}`).catch(() => {});
    });
  });

  // --- /share ---

  bot.command("share", async (ctx) => {
    const raw = ctx.match?.toString().trim() || "";
    if (!raw || raw === "help") {
      await ctx.reply(
        "*Multi-platform share*\n\n" +
          "Send me a video and pick where it goes, or:\n" +
          "`/share /root/clips/reel.mp4`\n" +
          "`/share https://example.com/clip.mp4 --short`\n" +
          "`/share /root/clips/talk.mp4 --video --caption \"How we ship\"`\n\n" +
          "`/share status` — scheduled + recent shares\n" +
          "`/share cancel <id>` — drop a scheduled share\n" +
          "`/social` — switch platforms on and off\n\n" +
          "Or drop a file into `social-media/queue/` and it posts by itself — " +
          "put the caption in a `.txt` of the same name.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (raw === "status") {
      const upcoming = pendingScheduled();
      const jobs = listRecentJobs(8);
      if (!jobs.length && !upcoming.length) return void ctx.reply("No shares yet.");
      const lines: string[] = [];
      if (upcoming.length) {
        lines.push("*Scheduled*");
        for (const j of upcoming) {
          lines.push(
            `#${j.id} ${j.preset === "short" ? "🎬" : "📺"} 🕐 ${formatWhen(j.scheduled_at!)} — ${getTargets(j.id).length} platforms`
          );
        }
        lines.push("");
      }
      lines.push("*Recent*");
      for (const j of jobs) {
        const t = getTargets(j.id);
        const done = t.filter((x) => x.status === "done").length;
        lines.push(`#${j.id} ${j.preset === "short" ? "🎬" : "📺"} ${j.status} — ${done}/${t.length} · ${j.created_at}`);
      }
      return void ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    }

    const cancelMatch = raw.match(/^cancel\s+#?(\d+)$/);
    if (cancelMatch) {
      const id = Number(cancelMatch[1]);
      const job = getJob(id);
      if (!job) return void ctx.reply(`No share #${id}.`);
      if (job.status === "running") return void ctx.reply(`Share #${id} is uploading right now — too late to cancel.`);
      setJobStatus(id, "cancelled");
      return void ctx.reply(`Share #${id} cancelled.`);
    }

    const presetFlag: Preset | undefined = /--short\b/.test(raw) ? "short" : /--video\b/.test(raw) ? "video" : undefined;
    const captionMatch = raw.match(/--caption\s+"([^"]*)"|--caption\s+'([^']*)'/);
    const caption = captionMatch ? captionMatch[1] ?? captionMatch[2] ?? "" : "";
    const target = raw
      .replace(/--caption\s+"[^"]*"|--caption\s+'[^']*'/, "")
      .replace(/--(short|video)\b/g, "")
      .trim();

    if (!target) return void ctx.reply("Give me a file path or a URL.");

    const notice = await ctx.reply("⬇️ Preparing…");
    try {
      let local: string;
      if (/^https?:\/\//i.test(target)) {
        local = await downloadRemote(target);
      } else {
        if (!fs.existsSync(target)) throw new Error(`no file at ${target}`);
        local = target;
      }
      const asset = await probe(local);
      const jobId = await createJobFromFile(local, {
        preset: presetFlag || guessPreset(asset.durationSec, asset.width, asset.height),
        caption,
        source: "command",
      });
      await ctx.api.deleteMessage(ctx.chat.id, notice.message_id).catch(() => {});
      await showPanel(ctx, jobId);
    } catch (err: any) {
      await ctx.api.editMessageText(ctx.chat.id, notice.message_id, `Failed: ${err.message}`).catch(() => {});
    }
  });

  // --- /social — the switch panel and connection management ---

  function renderSwitches(preset: Preset): { text: string; keyboard: any } {
    const sw = listSwitches(preset);
    const rows: any[][] = [];
    const order = PRESET_PLATFORMS[preset];
    for (let i = 0; i < order.length; i += 2) {
      rows.push(
        order.slice(i, i + 2).map((p) => ({
          text: `${sw[p] ? "🟢" : "🔴"} ${PLATFORM_EMOJI[p]} ${PLATFORM_LABEL[p]}`,
          callback_data: `ss:tg:${preset}:${p}`,
        }))
      );
    }
    const lines = [
      `*Default platforms — ${preset === "short" ? "🎬 SHORT" : "📺 VIDEO"}*`,
      "",
      ...order.map((p) => {
        const a = ADAPTERS[p];
        const state = a.isConfigured() ? "connected" : `not set up — ${a.missing()}`;
        return `${sw[p] ? "🟢" : "🔴"} *${PLATFORM_LABEL[p]}* — ${state}`;
      }),
    ];
    if (!publicHostingReady()) {
      lines.push("", "⚠️ Public media hosting is off — Instagram and Facebook cannot pull the file.");
    }
    return {
      text: lines.join("\n"),
      keyboard: {
        inline_keyboard: [
          [
            { text: `${preset === "short" ? "✅" : "▫️"} 🎬 SHORT`, callback_data: `ss:preset:short` },
            { text: `${preset === "video" ? "✅" : "▫️"} 📺 VIDEO`, callback_data: `ss:preset:video` },
          ],
          ...rows,
        ],
      },
    };
  }

  bot.command("social", async (ctx) => {
    const args = (ctx.match?.toString() || "").trim().split(/\s+/).filter(Boolean);
    const sub = args[0];

    if (!sub) {
      const { text, keyboard } = renderSwitches("short");
      return void ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
    }

    if (sub === "status") {
      const lines = PLATFORMS.map((p) => {
        const a = ADAPTERS[p];
        const acct = getAccount(p);
        const expiry = acct?.expires_at ? ` · token until ${acct.expires_at.slice(0, 16).replace("T", " ")}` : "";
        return a.isConfigured()
          ? `✅ *${PLATFORM_LABEL[p]}* — ${acct?.label || "connected"}${expiry}`
          : `❌ *${PLATFORM_LABEL[p]}* — ${a.missing()}`;
      });
      lines.push(
        "",
        publicHostingReady()
          ? `🌍 Public media: ${process.env.SOCIAL_PUBLIC_BASE}`
          : "⚠️ Public media hosting off — set SOCIAL_PUBLIC_BASE and SOCIAL_PUBLIC_DIR"
      );
      return void ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    }

    if (sub === "connect") {
      const p = args[1];
      if (!p || !isPlatform(p)) return void ctx.reply(`Usage: /social connect ${PLATFORMS.join("|")}`);
      const state = String(Date.now());
      const redirect = redirectFor(p);
      let url: string | null = null;
      if (p === "youtube") url = youtubeAuthUrl(redirect);
      if (p === "tiktok") url = tiktokAuthUrl(redirect, state);
      if (p === "linkedin") url = linkedinAuthUrl(redirect, state);

      if (url) {
        return void ctx.reply(
          `*Connect ${PLATFORM_LABEL[p]}*\n\n1. Open this and approve:\n${url}\n\n` +
            `2. You land on \`${redirect}\`, which shows the code with a copy button.\n` +
            `3. Send \`/social code ${p} <code>\`\n\n` +
            `_That redirect URI must be registered on the app, character for character._`,
          { parse_mode: "Markdown", link_preview_options: { is_disabled: true } } as any
        );
      }
      // Meta platforms use a long-lived Page token rather than a code exchange.
      return void ctx.reply(
        `*Connect ${PLATFORM_LABEL[p]}*\n\n` +
          (p === "facebook"
            ? "Put a Page access token (pages_manage_posts, pages_read_engagement) in `.env` as `FACEBOOK_PAGE_TOKEN` and the Page id as `FACEBOOK_PAGE_ID`, then restart Tokyo.\nOr paste it here: `/social token facebook <page-id> <token>`"
            : "Instagram rides on the linked Facebook Page token. Set `INSTAGRAM_USER_ID` (the IG Business account id) in `.env`, or paste: `/social token instagram <ig-user-id> <token>`"),
        { parse_mode: "Markdown" }
      );
    }

    if (sub === "code") {
      const p = args[1];
      const code = args.slice(2).join(" ");
      if (!p || !isPlatform(p) || !code) return void ctx.reply("Usage: /social code <platform> <code>");
      try {
        if (p === "youtube") await youtubeExchangeCode(code, redirectFor(p));
        else if (p === "tiktok") await tiktokExchangeCode(code, redirectFor(p));
        else if (p === "linkedin") await linkedinExchangeCode(code, redirectFor(p));
        else return void ctx.reply(`${PLATFORM_LABEL[p]} does not use a code exchange — see /social connect ${p}`);
        await ctx.reply(`✅ ${PLATFORM_LABEL[p]} connected.`);
      } catch (err: any) {
        await ctx.reply(`Could not connect ${PLATFORM_LABEL[p]}: ${err.message}`);
      }
      return;
    }

    if (sub === "token") {
      const p = args[1];
      const accountId = args[2];
      const token = args.slice(3).join(" ");
      if (!p || !isPlatform(p) || !accountId || !token) {
        return void ctx.reply("Usage: /social token <platform> <account-id> <access-token>");
      }
      const { saveAccount } = await import("./store");
      saveAccount(p, { access_token: token, account_id: accountId, label: `${PLATFORM_LABEL[p]} (manual)` });
      // Delete the message so a live token does not sit in the chat history.
      await ctx.api.deleteMessage(ctx.chat.id, ctx.message!.message_id).catch(() => {});
      return void ctx.reply(`✅ ${PLATFORM_LABEL[p]} token saved (your message was deleted).`);
    }

    if (sub === "disconnect") {
      const p = args[1];
      if (!p || !isPlatform(p)) return void ctx.reply("Usage: /social disconnect <platform>");
      deleteAccount(p);
      return void ctx.reply(`${PLATFORM_LABEL[p]} disconnected.`);
    }

    if (sub === "sweep") {
      const n = sweep(0);
      return void ctx.reply(`Removed ${n} cached media files.`);
    }

    await ctx.reply(
      "`/social` — switches\n`/social status`\n`/social connect <platform>`\n`/social code <platform> <code>`\n`/social token <platform> <id> <token>`\n`/social disconnect <platform>`\n`/social sweep`",
      { parse_mode: "Markdown" }
    );
  });

  bot.callbackQuery(/^ss:preset:(short|video)$/, async (ctx) => {
    const { text, keyboard } = renderSwitches(ctx.match[1] as Preset);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard }).catch(() => {});
  });

  bot.callbackQuery(/^ss:tg:(short|video):(\w+)$/, async (ctx) => {
    const preset = ctx.match[1] as Preset;
    const platform = ctx.match[2];
    if (!isPlatform(platform)) return ctx.answerCallbackQuery();
    const now = toggleSwitch(platform, preset);
    await ctx.answerCallbackQuery({ text: `${PLATFORM_LABEL[platform]} ${now ? "ON" : "OFF"}` });
    const { text, keyboard } = renderSwitches(preset);
    await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard }).catch(() => {});
  });

  // AI news -> LinkedIn. Registered here so its text handler and panel
  // buttons land above the catch-all callback handler in index.ts.
  const { registerNewsCommands } = require("./news") as typeof import("./news");
  registerNewsCommands(bot);

  // Loaded lazily: automation.ts imports publishJob from this module, and a
  // top-level import here would close the cycle at load time.
  const { startSocialAutomation } = require("./automation") as typeof import("./automation");
  startSocialAutomation(bot);

  console.log("📣 Social publisher ready (/share, /social)");
}
