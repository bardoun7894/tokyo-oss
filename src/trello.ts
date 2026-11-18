import type { Bot } from "grammy";

const API_BASE = "https://api.trello.com/1";
const KEY = process.env.TRELLO_API_KEY || "";
const TOKEN = process.env.TRELLO_TOKEN || "";

function authParams(): string {
  return `key=${KEY}&token=${TOKEN}`;
}

async function trelloGet(path: string, extra = ""): Promise<any> {
  const res = await fetch(`${API_BASE}${path}?${authParams()}${extra ? "&" + extra : ""}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Trello API error: ${res.status}`);
  return res.json();
}

async function trelloPost(path: string, body: Record<string, any> = {}): Promise<any> {
  const params = new URLSearchParams({ key: KEY, token: TOKEN, ...Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)])) });
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`Trello API error: ${res.status}`);
  return res.json();
}

async function trelloPut(path: string, body: Record<string, any> = {}): Promise<any> {
  const params = new URLSearchParams({ key: KEY, token: TOKEN, ...Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)])) });
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`Trello API error: ${res.status}`);
  return res.json();
}

// ========================
// Public API for AI actions
// ========================

export async function getBoards(): Promise<{ id: string; name: string; url: string }[]> {
  return trelloGet("/members/me/boards", "fields=name,url,dateLastActivity");
}

export async function getBoardLists(boardId: string): Promise<{ id: string; name: string; cards: any[] }[]> {
  const lists = await trelloGet(`/boards/${boardId}/lists`, "cards=open&card_fields=name,desc,due,labels,idMembers,dateLastActivity");
  return lists;
}

export async function getBoardCards(boardId: string): Promise<any[]> {
  return trelloGet(`/boards/${boardId}/cards`, "fields=name,desc,due,labels,idList,dateLastActivity,url");
}

export async function createCard(listId: string, name: string, desc?: string, due?: string): Promise<any> {
  const body: Record<string, any> = { idList: listId, name };
  if (desc) body.desc = desc;
  if (due) body.due = due;
  return trelloPost("/cards", body);
}

export async function moveCard(cardId: string, listId: string): Promise<any> {
  return trelloPut(`/cards/${cardId}`, { idList: listId });
}

export async function archiveCard(cardId: string): Promise<any> {
  return trelloPut(`/cards/${cardId}`, { closed: "true" });
}

export async function unarchiveCard(cardId: string): Promise<any> {
  return trelloPut(`/cards/${cardId}`, { closed: "false" });
}

export async function addComment(cardId: string, text: string): Promise<any> {
  return trelloPost(`/cards/${cardId}/actions/comments`, { text });
}

export async function getCard(cardId: string): Promise<any> {
  return trelloGet(`/cards/${cardId}`, "fields=name,desc,due,closed,idList,url,labels");
}

export async function searchCards(boardId: string, query: string): Promise<any[]> {
  const cards = await getBoardCards(boardId);
  const lower = query.toLowerCase();
  return cards.filter((c: any) => c.name.toLowerCase().includes(lower) || (c.desc || "").toLowerCase().includes(lower));
}

/** Move card to Done list */
export async function completeCard(boardId: string, cardId: string): Promise<any> {
  const list = await findList(boardId, "Done");
  if (!list) throw new Error("No 'Done' list found");
  return moveCard(cardId, list.id);
}

/** Move card back from Done to its project list or In Progress */
export async function reopenCard(boardId: string, cardId: string, targetList?: string): Promise<any> {
  const list = await findList(boardId, targetList || "In Progress");
  if (!list) throw new Error("No target list found");
  // Unarchive if archived
  await unarchiveCard(cardId).catch(() => {});
  return moveCard(cardId, list.id);
}

// ========================
// Formatted output
// ========================

export async function formatBoards(): Promise<string> {
  const boards = await getBoards();
  if (boards.length === 0) return "📋 No Trello boards found.";
  const lines = boards.map((b, i) => `${i + 1}. *${b.name}*\n   ${b.url}`);
  return `📋 *Trello Boards (${boards.length})*\n\n${lines.join("\n\n")}`;
}

export async function formatBoard(boardId: string): Promise<string> {
  const lists = await getBoardLists(boardId);
  if (lists.length === 0) return "📋 No lists in this board.";

  const lines: string[] = [];
  for (const list of lists) {
    const cards = list.cards || [];
    lines.push(`📌 *${list.name}* (${cards.length} cards)`);
    for (const card of cards.slice(0, 10)) {
      const due = card.due ? ` ⏰${card.due.split("T")[0]}` : "";
      const labels = card.labels?.length > 0 ? ` [${card.labels.map((l: any) => l.name || l.color).join(",")}]` : "";
      lines.push(`  • ${card.name}${due}${labels}`);
    }
    if (cards.length > 10) lines.push(`  _...+${cards.length - 10} more_`);
    lines.push("");
  }
  return lines.join("\n");
}

// ========================
// Board name → ID resolver
// ========================

const boardCache = new Map<string, { id: string; name: string }>();

export async function findBoard(query: string): Promise<{ id: string; name: string } | null> {
  if (boardCache.size === 0) {
    const boards = await getBoards();
    for (const b of boards) boardCache.set(b.name.toLowerCase(), { id: b.id, name: b.name });
  }
  const lower = query.toLowerCase();
  // Exact match
  if (boardCache.has(lower)) return boardCache.get(lower)!;
  // Partial match
  for (const [name, data] of boardCache) {
    if (name.includes(lower) || lower.includes(name)) return data;
  }
  return null;
}

export async function findList(boardId: string, query: string): Promise<{ id: string; name: string } | null> {
  const lists = await getBoardLists(boardId);
  const lower = query.toLowerCase();
  for (const l of lists) {
    if (l.name.toLowerCase().includes(lower) || lower.includes(l.name.toLowerCase())) {
      return { id: l.id, name: l.name };
    }
  }
  return lists.length > 0 ? { id: lists[0].id, name: lists[0].name } : null;
}

// ========================
// Telegram Commands
// ========================

export function registerTrelloCommands(bot: Bot): void {
  bot.command("trello", async (ctx) => {
    const arg = ctx.match?.trim().toLowerCase() || "";

    if (!KEY || !TOKEN) {
      await ctx.reply("Trello not configured. Add TRELLO_API_KEY and TRELLO_TOKEN to .env");
      return;
    }

    try {
      if (!arg || arg === "boards") {
        const text = await formatBoards();
        await sendSplit(ctx, text);
      } else {
        // Show specific board
        const board = await findBoard(arg);
        if (!board) {
          await ctx.reply(`Board "${arg}" not found. Use /trello to see all boards.`);
          return;
        }
        const text = await formatBoard(board.id);
        await sendSplit(ctx, `📋 *${board.name}*\n\n${text}`);
      }
    } catch (err: any) {
      console.error("Trello error:", err);
      await ctx.reply(`Trello error: ${err.message}`);
    }
  });
}

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
