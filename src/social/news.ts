/**
 * Tokyo — AI news → LinkedIn.
 *
 * A daily cron pulls the same AI stories Tokyo already tracks for /digest,
 * asks Claude to turn the most relevant one into a LinkedIn post in the owner's
 * voice, and drops the draft into Telegram behind an approve button. Nothing
 * reaches LinkedIn without a tap unless autopost is switched on.
 *
 * A story is only ever offered once — the Hacker News item id is written to
 * social_news_posts the moment a draft is built, whatever happens to it after.
 */

import cron from "node-cron";
import type { Bot } from "grammy";
import db from "../db";
import { fetchAINews, fetchAITrending } from "../research";
import { linkedinPostText, linkedinTextReady } from "./adapters/linkedin";

/** Structural shape of the story objects research.ts hands back. */
interface Story {
  id?: number | string;
  title: string;
  url: string;
  score?: number;
  time?: number;
  fullName?: string;
  description?: string;
  stars?: number;
}

export type NewsStatus = "draft" | "posted" | "skipped" | "failed";

export interface NewsRow {
  id: number;
  story_key: string;
  story_title: string;
  story_url: string;
  draft: string;
  status: NewsStatus;
  post_url: string | null;
  error: string | null;
  chat_id: number | null;
  created_at: string;
  posted_at: string | null;
}

// --- Persistence ---

export function initNewsTables(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS social_news_posts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      story_key   TEXT NOT NULL UNIQUE,
      story_title TEXT NOT NULL,
      story_url   TEXT,
      draft       TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted','skipped','failed')),
      post_url    TEXT,
      error       TEXT,
      chat_id     INTEGER,
      created_at  TEXT DEFAULT (datetime('now')),
      posted_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS social_news_config (
      id       INTEGER PRIMARY KEY CHECK(id = 1),
      autopost INTEGER NOT NULL DEFAULT 0
    );

    INSERT OR IGNORE INTO social_news_config (id, autopost) VALUES (1, 0);
  `);
}

export function autopostOn(): boolean {
  const row = db.prepare(`SELECT autopost FROM social_news_config WHERE id = 1`).get() as
    | { autopost: number }
    | undefined;
  return Boolean(row?.autopost);
}

export function setAutopost(on: boolean): void {
  db.prepare(`UPDATE social_news_config SET autopost = ? WHERE id = 1`).run(on ? 1 : 0);
}

function seenKeys(): Set<string> {
  const rows = db.prepare(`SELECT story_key FROM social_news_posts`).all() as Array<{ story_key: string }>;
  return new Set(rows.map((r) => r.story_key));
}

export function getNews(id: number): NewsRow | undefined {
  return db.prepare(`SELECT * FROM social_news_posts WHERE id = ?`).get(id) as NewsRow | undefined;
}

export function recentNews(limit = 10): NewsRow[] {
  return db.prepare(`SELECT * FROM social_news_posts ORDER BY id DESC LIMIT ?`).all(limit) as NewsRow[];
}

export function deleteNews(id: number): void {
  db.prepare(`DELETE FROM social_news_posts WHERE id = ?`).run(id);
}

function insertDraft(story: Story, key: string, draft: string, chatId: number | null): number {
  const info = db
    .prepare(
      `INSERT INTO social_news_posts (story_key, story_title, story_url, draft, chat_id)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(key, story.title.slice(0, 300), story.url || "", draft, chatId);
  return Number(info.lastInsertRowid);
}

function setStatus(id: number, status: NewsStatus, patch: { post_url?: string; error?: string } = {}): void {
  db.prepare(
    `UPDATE social_news_posts
        SET status = ?,
            post_url = COALESCE(?, post_url),
            error = COALESCE(?, error),
            posted_at = CASE WHEN ? = 'posted' THEN datetime('now') ELSE posted_at END
      WHERE id = ?`
  ).run(status, patch.post_url ?? null, patch.error ?? null, status, id);
}

export function updateDraftText(id: number, draft: string): void {
  db.prepare(`UPDATE social_news_posts SET draft = ? WHERE id = ?`).run(draft, id);
}

// --- Picking a story ---

/** Stable key per item, so the same story is never drafted twice. */
function storyKey(s: Story): string {
  if (s.id !== undefined && s.id !== null && s.id !== "") return `hn:${s.id}`;
  if (s.fullName) return `gh:${s.fullName}`;
  return `url:${(s.url || s.title).slice(0, 200)}`;
}

/**
 * The highest-scoring AI story not offered before. Trending repos are the
 * fallback when Hacker News has nothing new — a quiet news day should not mean
 * a silent day.
 */
export async function pickStory(): Promise<Story | null> {
  const seen = seenKeys();

  const news = (await fetchAINews().catch(() => [])) as Story[];
  const fresh = news.filter((s) => s.title && !seen.has(storyKey(s)));
  if (fresh.length) return fresh.sort((a, b) => (b.score || 0) - (a.score || 0))[0];

  const repos = (await fetchAITrending(3).catch(() => [])) as Story[];
  const freshRepos = repos
    .map((r) => ({ ...r, title: r.title || r.fullName || "", url: r.url || "" }))
    .filter((r) => r.title && !seen.has(storyKey(r)));
  if (freshRepos.length) return freshRepos.sort((a, b) => (b.stars || 0) - (a.stars || 0))[0];

  return null;
}

// --- Writing the post ---

function langLine(): string {
  return (process.env.NEWS_POST_LANG || "en").toLowerCase() === "ar"
    ? "اكتب بالعربية الفصحى المبسطة مع المصطلحات التقنية بالإنجليزية."
    : "Write in plain English. Short sentences. No corporate filler.";
}

function prompt(story: Story): string {
  const when = story.time ? new Date(story.time * 1000).toISOString().slice(0, 10) : "today";
  const context = [
    `TITLE: ${story.title}`,
    story.description ? `DESCRIPTION: ${story.description}` : "",
    story.url ? `LINK: ${story.url}` : "",
    `DATE: ${when}`,
    story.score ? `HN SCORE: ${story.score}` : "",
    story.stars ? `GITHUB STARS: ${story.stars}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return `You write LinkedIn posts for the owner — a freelance full-stack developer
(Laravel, Next.js, React, Python, Flutter) who builds AI agents and automation, ships SaaS
products, and posts to attract technical clients.

Turn this piece of AI news into ONE LinkedIn post:

${context}

Rules:
- ${langLine()}
- 120-200 words. Hard ceiling 250.
- Open with a concrete hook, not "Exciting news!" and not a question to the reader.
- The middle is the owner's own read: what this actually changes for someone
  shipping real software this week. Be specific and opinionated.
- Close with one line inviting a reply. At most 3 hashtags.
- No emoji headers, no markdown, no bullet characters — LinkedIn renders plain text.
- Never invent benchmarks, funding numbers or quotes. If the source is thin,
  say less rather than padding.
- Put the link on its own last line, after the hashtags.

Return ONLY the post text.`;
}

export async function writeDraft(story: Story): Promise<string> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({
    apiKey: process.env.CLIPROXY_API_KEY || process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.CLIPROXY_API_KEY ? "http://localhost:8317" : undefined,
  });

  const res = await client.messages.create({
    model: process.env.NEWS_POST_MODEL || "claude-sonnet-5",
    max_tokens: 800,
    messages: [{ role: "user", content: prompt(story) }],
  });

  const text = (res.content[0] as any)?.text?.trim();
  if (!text) throw new Error("Claude returned an empty draft");
  return text;
}

/**
 * Pick a story, write the post, record it. Returns null when every AI story on
 * offer has already been drafted before.
 */
export async function buildDraft(
  chatId: number | null
): Promise<{ id: number; story: Story; draft: string } | null> {
  const story = await pickStory();
  if (!story) return null;
  const draft = await writeDraft(story);
  const id = insertDraft(story, storyKey(story), draft, chatId);
  return { id, story, draft };
}

/** Publish a stored draft to LinkedIn and record the outcome. */
export async function postDraft(id: number): Promise<{ url?: string }> {
  const row = getNews(id);
  if (!row) throw new Error(`news draft ${id} not found`);
  if (row.status === "posted") throw new Error(`draft ${id} is already posted`);
  try {
    const { url } = await linkedinPostText(row.draft, "public");
    setStatus(id, "posted", { post_url: url });
    return { url };
  } catch (err: any) {
    setStatus(id, "failed", { error: String(err?.message || err).slice(0, 500) });
    throw err;
  }
}

// --- Telegram ---

function notifyChat(): number {
  return Number(process.env.SOCIAL_NOTIFY_CHAT || process.env.TELEGRAM_USER_ID || 0);
}

function draftKeyboard(id: number) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Post to LinkedIn", callback_data: `np:go:${id}` },
        { text: "🔁 Rewrite", callback_data: `np:re:${id}` },
      ],
      [
        { text: "✏️ Edit text", callback_data: `np:ed:${id}` },
        { text: "✖ Skip", callback_data: `np:x:${id}` },
      ],
    ],
  };
}

/** Markdown is off on purpose — a draft is arbitrary prose and would break it. */
function draftMessage(row: NewsRow): string {
  const src = row.story_url ? `\n\nsource: ${row.story_url}` : "";
  const warn = linkedinTextReady()
    ? ""
    : "\n\n⚠️ LinkedIn is not connected — run /social connect linkedin. The draft is saved either way.";
  return `📰 AI news → LinkedIn · draft #${row.id}\n\n${row.draft}${src}${warn}`;
}

/** Which chat is waiting to type a replacement draft. */
const awaitingEdit = new Map<number, number>();

export function registerNewsCommands(bot: Bot): void {
  initNewsTables();

  bot.command("newspost", async (ctx) => {
    const arg = String(ctx.match || "").trim().toLowerCase();

    if (arg === "status") {
      const rows = recentNews(8);
      const head =
        `📰 News → LinkedIn\n` +
        `autopost: ${autopostOn() ? "ON" : "OFF"} · LinkedIn: ${linkedinTextReady() ? "connected" : "not connected"} · cron: ${process.env.NEWS_POST_CRON || "0 9 * * *"}`;
      if (!rows.length) return ctx.reply(`${head}\n\nNo drafts yet — run /newspost to build one.`);
      const icon: Record<NewsStatus, string> = { draft: "📝", posted: "✅", skipped: "⏭", failed: "❌" };
      const lines = rows.map(
        (r) =>
          `${icon[r.status]} #${r.id} ${r.story_title.slice(0, 60)}` +
          (r.post_url ? `\n   ${r.post_url}` : "") +
          (r.error ? `\n   ${r.error.slice(0, 90)}` : "")
      );
      return ctx.reply(`${head}\n\n${lines.join("\n")}`, { link_preview_options: { is_disabled: true } });
    }

    if (arg === "auto on") {
      setAutopost(true);
      return ctx.reply("Autopost ON — the daily draft goes straight to LinkedIn.");
    }
    if (arg === "auto off") {
      setAutopost(false);
      return ctx.reply("Autopost OFF — drafts wait for the button.");
    }
    if (arg === "auto") {
      return ctx.reply(`Autopost is ${autopostOn() ? "ON" : "OFF"}. Use /newspost auto on|off.`);
    }

    const dry = arg === "dry" || arg === "--dry-run";
    const note = await ctx.reply(dry ? "Building a draft (dry run)…" : "Building a draft…");
    try {
      const built = await buildDraft(dry ? null : ctx.chat.id);
      if (!built) {
        return ctx.api.editMessageText(
          ctx.chat.id,
          note.message_id,
          "No fresh AI story today — everything on offer has been drafted before."
        );
      }
      if (dry) {
        deleteNews(built.id);
        return ctx.api.editMessageText(
          ctx.chat.id,
          note.message_id,
          `📰 Dry run — not saved, not posted.\n\n${built.draft}\n\nsource: ${built.story.url || "—"}`,
          { link_preview_options: { is_disabled: true } }
        );
      }
      await ctx.api.deleteMessage(ctx.chat.id, note.message_id).catch(() => {});
      const row = getNews(built.id)!;
      await ctx.reply(draftMessage(row), {
        reply_markup: draftKeyboard(row.id),
        link_preview_options: { is_disabled: true },
      });
    } catch (err: any) {
      await ctx.api
        .editMessageText(ctx.chat.id, note.message_id, `Draft failed: ${String(err?.message || err).slice(0, 300)}`)
        .catch(() => {});
    }
  });

  bot.callbackQuery(/^np:go:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    await ctx.answerCallbackQuery({ text: "Posting…" });
    try {
      const { url } = await postDraft(id);
      await ctx
        .editMessageText(`✅ Posted to LinkedIn.\n${url || ""}`, { link_preview_options: { is_disabled: true } })
        .catch(() => {});
    } catch (err: any) {
      await ctx.reply(`❌ LinkedIn post failed: ${String(err?.message || err).slice(0, 300)}`);
    }
  });

  bot.callbackQuery(/^np:re:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const row = getNews(id);
    if (!row) return ctx.answerCallbackQuery({ text: "Gone." });
    await ctx.answerCallbackQuery({ text: "Rewriting…" });
    try {
      updateDraftText(id, await writeDraft({ title: row.story_title, url: row.story_url }));
      await ctx
        .editMessageText(draftMessage(getNews(id)!), {
          reply_markup: draftKeyboard(id),
          link_preview_options: { is_disabled: true },
        })
        .catch(() => {});
    } catch (err: any) {
      await ctx.reply(`Rewrite failed: ${String(err?.message || err).slice(0, 200)}`);
    }
  });

  bot.callbackQuery(/^np:ed:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    awaitingEdit.set(ctx.chat!.id, id);
    await ctx.answerCallbackQuery();
    await ctx.reply(`Send the replacement text for draft #${id}.`);
  });

  bot.callbackQuery(/^np:x:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    setStatus(id, "skipped");
    await ctx.answerCallbackQuery({ text: "Skipped" });
    await ctx.editMessageText(`⏭ Draft #${id} skipped. That story will not come round again.`).catch(() => {});
  });

  bot.on("message:text", async (ctx, next) => {
    const id = awaitingEdit.get(ctx.chat.id);
    if (!id) return next();
    if (ctx.message.text.startsWith("/")) return next();
    awaitingEdit.delete(ctx.chat.id);
    updateDraftText(id, ctx.message.text);
    await ctx.reply(draftMessage(getNews(id)!), {
      reply_markup: draftKeyboard(id),
      link_preview_options: { is_disabled: true },
    });
  });

  startNewsAutomation(bot);
  console.log(`📰 News → LinkedIn ready (/newspost) — autopost ${autopostOn() ? "ON" : "OFF"}`);
}

// --- Cron ---

let tickBusy = false;

async function newsTick(bot: Bot): Promise<void> {
  if (tickBusy) return;
  tickBusy = true;
  try {
    const chatId = notifyChat();
    const built = await buildDraft(chatId || null);
    if (!built) {
      console.log("[news] no fresh AI story today");
      return;
    }
    const row = getNews(built.id)!;

    if (autopostOn() && linkedinTextReady()) {
      try {
        const { url } = await postDraft(built.id);
        console.log(`[news] auto-posted draft #${built.id} → ${url || "posted"}`);
        if (chatId) {
          await bot.api
            .sendMessage(chatId, `📰 Auto-posted to LinkedIn.\n${url || ""}\n\n${row.draft}`, {
              link_preview_options: { is_disabled: true },
            })
            .catch(() => {});
        }
      } catch (err: any) {
        console.error("[news] autopost failed:", err);
        if (chatId) {
          await bot.api
            .sendMessage(
              chatId,
              `📰 Autopost failed — draft #${built.id} kept.\n${String(err?.message || err).slice(0, 300)}`,
              { reply_markup: draftKeyboard(built.id) }
            )
            .catch(() => {});
        }
      }
      return;
    }

    if (!chatId) {
      console.warn("[news] no SOCIAL_NOTIFY_CHAT / TELEGRAM_USER_ID — draft saved, nobody told");
      return;
    }
    await bot.api
      .sendMessage(chatId, draftMessage(row), {
        reply_markup: draftKeyboard(row.id),
        link_preview_options: { is_disabled: true },
      })
      .catch(() => {});
  } finally {
    tickBusy = false;
  }
}

export function startNewsAutomation(bot: Bot): void {
  const expr = process.env.NEWS_POST_CRON || "0 9 * * *";
  if (!cron.validate(expr)) {
    console.error(`[news] NEWS_POST_CRON is not a valid cron expression: ${expr} — automation off`);
    return;
  }
  cron.schedule(expr, () => {
    newsTick(bot).catch((err) => console.error("[news] tick:", err));
  });
  console.log(`⏱ News → LinkedIn cron on (${expr})`);
}
