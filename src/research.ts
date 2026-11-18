import type { Bot } from "grammy";

// ========================
// AI-Focused Research — tailored for the owner
// Topics: AI tools, AI agents, SaaS, dev productivity, freelancing, e-commerce
// ========================

const AI_TOPICS = ["artificial-intelligence", "llm", "machine-learning", "generative-ai", "langchain", "rag", "agent", "chatbot", "ai-tools"];
const AI_KEYWORDS = [
  "ai", "gpt", "llm", "claude", "openai", "anthropic", "gemini", "mistral",
  "machine learning", "deep learning", "agent", "rag", "embedding", "vector",
  "copilot", "automation", "saas", "no-code", "low-code", "ai tool",
  "fine-tun", "inference", "hugging", "langchain", "crewai", "autogen",
];

interface TrendingRepo {
  name: string;
  fullName: string;
  description: string;
  stars: number;
  language: string;
  url: string;
  topics: string[];
  createdAt: string;
}

interface HNStory {
  title: string;
  url: string;
  score: number;
  time: number;
}

interface YouTubeResult {
  title: string;
  videoId: string;
  author: string;
  lengthSeconds: number;
  viewCount: number;
}

// ========================
// GitHub: AI/Tools trending
// ========================

async function fetchAITrending(since = 3): Promise<TrendingRepo[]> {
  const date = new Date();
  date.setDate(date.getDate() - since);
  const dateStr = date.toISOString().split("T")[0];

  const topicFilter = AI_TOPICS.map(t => `topic:${t}`).join("+OR+");
  const query = `created:>${dateStr}+stars:>5+(${topicFilter})`;

  const res = await fetch(`https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=15`, {
    headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "Tokyo-LifeOS" },
  });
  if (!res.ok) return [];
  const data = await res.json() as any;

  return (data.items || []).map((r: any) => ({
    name: r.name,
    fullName: r.full_name,
    description: (r.description || "").slice(0, 150),
    stars: r.stargazers_count,
    language: r.language || "",
    url: r.html_url,
    topics: r.topics || [],
    createdAt: r.created_at ? r.created_at.split("T")[0] : "",
  }));
}

async function fetchAITools(since = 7): Promise<TrendingRepo[]> {
  const date = new Date();
  date.setDate(date.getDate() - since);
  const dateStr = date.toISOString().split("T")[0];

  const toolKeywords = ["tool", "cli", "framework", "sdk", "platform", "app", "kit", "studio", "playground"];
  const topicFilter = [...AI_TOPICS, ...toolKeywords.map(t => `topic:${t}`)].join("+OR+");
  const query = `created:>${dateStr}+stars:>10+(${topicFilter})+ai+in:name,description`;

  const res = await fetch(`https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=15`, {
    headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "Tokyo-LifeOS" },
  });
  if (!res.ok) return [];
  const data = await res.json() as any;

  return (data.items || []).map((r: any) => ({
    name: r.name,
    fullName: r.full_name,
    description: (r.description || "").slice(0, 150),
    stars: r.stargazers_count,
    language: r.language || "",
    url: r.html_url,
    topics: r.topics || [],
    createdAt: r.created_at ? r.created_at.split("T")[0] : "",
  }));
}

// ========================
// Hacker News: AI news
// ========================

async function fetchHNTopStories(filter?: string, limit = 15): Promise<HNStory[]> {
  const res = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json");
  if (!res.ok) return [];
  const ids = ((await res.json()) as any[]).slice(0, 80);

  const stories: HNStory[] = [];
  const batchSize = 15;

  for (let i = 0; i < ids.length && stories.length < limit; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map((id: number) =>
        fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)
          .then(r => r.json() as Promise<any>)
          .catch(() => null)
      )
    );
    for (const s of results) {
      if (!s || !s.title) continue;
      if (filter) {
        const lower = (s.title + " " + (s.url || "")).toLowerCase();
        if (!lower.includes(filter.toLowerCase())) continue;
      }
      stories.push({
        title: s.title,
        url: s.url || `https://news.ycombinator.com/item?id=${s.id}`,
        score: s.score || 0,
        time: s.time || 0,
      });
      if (stories.length >= limit) break;
    }
  }
  return stories;
}

async function fetchAINews(): Promise<HNStory[]> {
  const res = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json");
  if (!res.ok) return [];
  const ids = ((await res.json()) as any[]).slice(0, 100);

  const stories: HNStory[] = [];
  const batchSize = 15;

  for (let i = 0; i < ids.length && stories.length < 10; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map((id: number) =>
        fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)
          .then(r => r.json() as Promise<any>)
          .catch(() => null)
      )
    );
    for (const s of results) {
      if (!s || !s.title) continue;
      const lower = (s.title + " " + (s.url || "")).toLowerCase();
      if (AI_KEYWORDS.some(kw => lower.includes(kw))) {
        stories.push({
          title: s.title,
          url: s.url || `https://news.ycombinator.com/item?id=${s.id}`,
          score: s.score || 0,
          time: s.time || 0,
        });
      }
      if (stories.length >= 10) break;
    }
  }
  return stories;
}

// ========================
// YouTube Search (Invidious — no API key)
// ========================

async function searchYouTube(query: string, limit = 8): Promise<YouTubeResult[]> {
  const instances = [
    "https://vid.puffyan.us",
    "https://invidious.fdn.fr",
    "https://y.com.sb",
  ];

  for (const instance of instances) {
    try {
      const res = await fetch(`${instance}/api/v1/search?q=${encodeURIComponent(query)}&type=video&sort_by=relevance`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const data = await res.json() as any;
      return (data || []).slice(0, limit).map((v: any) => ({
        title: v.title || "",
        videoId: v.videoId || "",
        author: v.author || "",
        lengthSeconds: v.lengthSeconds || 0,
        viewCount: v.viewCount || 0,
      }));
    } catch { continue; }
  }
  return [];
}

// ========================
// Daily AI Digest — auto-sent
// ========================

export async function generateAIDigest(): Promise<string> {
  const [repos, tools, news] = await Promise.all([
    fetchAITrending(3).catch(() => [] as TrendingRepo[]),
    fetchAITools(7).catch(() => [] as TrendingRepo[]),
    fetchAINews().catch(() => [] as HNStory[]),
  ]);

  // Collect raw data
  const today = new Date().toISOString().split("T")[0];
  const rawRepos = repos.slice(0, 5).map(r => `${r.fullName} (⭐${r.stars}, created: ${r.createdAt}) — ${r.description} — ${r.url}`).join("\n");
  const uniqueTools = tools.filter(t => !repos.some(r => r.fullName === t.fullName)).slice(0, 5);
  const rawTools = uniqueTools.map(t => `${t.fullName} (⭐${t.stars}, created: ${t.createdAt}) — ${t.description} — ${t.url}`).join("\n");
  const rawNews = news.slice(0, 5).map(n => {
    const date = n.time > 0 ? new Date(n.time * 1000).toISOString().split("T")[0] : today;
    return `${n.title} (${n.score}pts, ${date}) — ${n.url}`;
  }).join("\n");

  if (!rawRepos && !rawTools && !rawNews) {
    return "🤖 *Daily AI Digest*\n\n_ما فيه جديد مهم اليوم في عالم AI._";
  }

  // Public news only, so the free model writes it (falls back to the main route).
  try {
    const { freeCall } = await import("./ai");

    const prompt = `أنت مساعد محمد — مطور full-stack فريلانسر (Laravel, Next.js, React, Python, Flutter) ويبيع ملابس في محل مع أبوه. يبني منتجات SaaS ويتعلم AI والتسويق.

تاريخ اليوم: ${today}
هذه آخر المستجدات في عالم AI. اشرح لمحمد بالعربية (دارجة مغربية/عربية مفهومة) كيف كل أداة أو خبر ممكن يساعده. اذكر تاريخ كل عنصر:

${rawRepos ? `## ريبوهات AI جديدة:\n${rawRepos}\n` : ""}
${rawTools ? `## أدوات AI جديدة:\n${rawTools}\n` : ""}
${rawNews ? `## أخبار AI:\n${rawNews}\n` : ""}

القواعد:
- اكتب بالعربية مع كلمات تقنية بالإنجليزية
- لكل عنصر اذكر:
  1. اسمه + شرح قصير
  2. 🎯 *الصلة بعمل محمد*: كيف يفيده كمطور فريلانسر أو صاحب محل أو باني SaaS
  3. 📊 *مستوى الصعوبة*: سهل ⬜ / متوسط 🟡 / متقدم 🔴
  4. الرابط
- ركز على الأدوات اللي ممكن يستعملها فعلاً في مشاريعه (shopdemo, erpdemo, studio, clinic, lab)
- إذا أداة مش مرتبطة بعمله أصلاً — تجاهلها ولا تذكرها
- أعطي أولوية للأدوات اللي تساعد في: بناء SaaS، أتمتة العمل، تحسين الإنتاجية، AI agents، e-commerce
- كن مختصر — كل عنصر 2-3 سطور
- استعمل format Telegram Markdown
- ابدأ بـ 🤖 *ملخص AI اليومي*`;

    const text = await freeCall("", prompt, 1500);
    return text?.trim() || "🤖 *Daily AI Digest*\n\n_فشل إنشاء الملخص._";
  } catch (err) {
    // Fallback: raw list without AI explanation
    console.error("AI digest generation failed:", err);
    const lines: string[] = ["🤖 *Daily AI Digest*\n"];
    if (rawRepos) { lines.push("🔥 *ريبوهات جديدة*"); lines.push(rawRepos); lines.push(""); }
    if (rawTools) { lines.push("🛠 *أدوات جديدة*"); lines.push(rawTools); lines.push(""); }
    if (rawNews) { lines.push("📰 *أخبار*"); lines.push(rawNews); }
    return lines.join("\n");
  }
}

// ========================
// Format helpers
// ========================

function formatRepos(repos: TrendingRepo[], title: string): string {
  if (repos.length === 0) return `${title}\n\n_No results found._`;
  const lines = repos.map((r, i) =>
    `${i + 1}. *${r.fullName}* ⭐${r.stars} (${r.createdAt})\n   ${r.description}\n   _${r.language}_ — ${r.url}`
  );
  return `${title}\n\n${lines.join("\n\n")}`;
}

function formatNews(stories: HNStory[], title: string): string {
  if (stories.length === 0) return `${title}\n\n_No AI news found._`;
  const lines = stories.map((s, i) => {
    const date = s.time > 0 ? new Date(s.time * 1000).toISOString().split("T")[0] : "";
    return `${i + 1}. *${s.title}* (${s.score} pts${date ? ", " + date : ""})\n   ${s.url}`;
  });
  return `${title}\n\n${lines.join("\n\n")}`;
}

function formatYouTube(videos: YouTubeResult[], title: string): string {
  if (videos.length === 0) return `${title}\n\n_No videos found._`;
  const lines = videos.map((v, i) => {
    const mins = Math.floor(v.lengthSeconds / 60);
    const views = v.viewCount > 1000 ? `${Math.round(v.viewCount / 1000)}K` : v.viewCount;
    return `${i + 1}. *${v.title}*\n   ${v.author} · ${mins}min · ${views} views\n   https://youtube.com/watch?v=${v.videoId}`;
  });
  return `${title}\n\n${lines.join("\n\n")}`;
}

// ========================
// Telegram Commands
// ========================

export function registerResearchCommands(bot: Bot): void {
  // /trending — AI trending repos
  bot.command("trending", async (ctx) => {
    await ctx.reply("🔍 Searching trending AI repos...");
    try {
      const repos = await fetchAITrending();
      await sendSplit(ctx, formatRepos(repos, "🔥 *Trending AI Repos (last 3 days)*"));
    } catch (err) {
      console.error("Trending error:", err);
      await ctx.reply("Failed to fetch trending repos.");
    }
  });

  // /tools — AI tools
  bot.command("tools", async (ctx) => {
    await ctx.reply("🔍 Searching new AI tools...");
    try {
      const tools = await fetchAITools();
      await sendSplit(ctx, formatRepos(tools, "🛠 *New AI Tools & Frameworks (this week)*"));
    } catch (err) {
      console.error("Tools error:", err);
      await ctx.reply("Failed to fetch tools.");
    }
  });

  // /news — AI news
  bot.command("news", async (ctx) => {
    await ctx.reply("🔍 Fetching AI news...");
    try {
      const stories = await fetchAINews();
      await sendSplit(ctx, formatNews(stories, "📰 *AI News (Hacker News)*"));
    } catch (err) {
      console.error("News error:", err);
      await ctx.reply("Failed to fetch news.");
    }
  });

  // /youtube — YouTube search
  bot.command("youtube", async (ctx) => {
    const query = ctx.match?.trim() || "AI tools 2026";
    await ctx.reply("🔍 Searching YouTube...");
    try {
      const videos = await searchYouTube(query);
      await sendSplit(ctx, formatYouTube(videos, `🎬 *YouTube — "${query}"*`));
    } catch (err) {
      console.error("YouTube error:", err);
      await ctx.reply("Failed to search YouTube.");
    }
  });

  // /digest — Manual AI digest
  bot.command("digest", async (ctx) => {
    await ctx.reply("🔍 Generating AI digest...");
    try {
      const digest = await generateAIDigest();
      await sendSplit(ctx, digest);
    } catch (err) {
      console.error("Digest error:", err);
      await ctx.reply("Failed to generate digest.");
    }
  });
}

export { fetchAITrending, fetchAINews, fetchAITools, fetchHNTopStories, searchYouTube, formatRepos, formatNews, formatYouTube };

async function sendSplit(ctx: any, text: string) {
  if (text.length <= 4000) {
    await ctx.reply(text, { parse_mode: "Markdown" }).catch(() => ctx.reply(text));
    return;
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= 4000) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf("\n", 4000);
    if (splitAt === -1) splitAt = 4000;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  for (const chunk of chunks) {
    await ctx.reply(chunk, { parse_mode: "Markdown" }).catch(() => ctx.reply(chunk));
  }
}
