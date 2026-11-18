import type { Agent, AgentContext, AgentResult } from "../types";
import type { AgentEvent } from "../event-bus";
import * as db from "../../db";
import { processIncomingMessage } from "../../whatsapp-ai";

const whatsappAgent: Agent = {
  name: "whatsapp",
  domain: "whatsapp",
  description: "The owner's WhatsApp communication manager — smart replies, intent detection, contact management.",

  handles: ["wa:message"],

  keywords: [
    "whatsapp", "contacts", "واتساب", "واتس", "messages", "رسائل",
    "reply", "categorize", "rename", "wa",
    "said", "قال", "قالت", "sent", "ارسل",
    "farah", "فرح", "wife", "زوج",
    "جهات", "label", "list contacts",
  ],

  commands: ["contacts", "contact", "wa"],

  actions: [
    "show_wa_messages", "search_wa", "list_wa_contacts",
    "categorize_wa_contact", "wa_reply", "wa_rule",
  ],

  getSystemPromptSection(): string {
    return `## WhatsApp Actions
- {"type": "show_wa_messages", "jid": "optional_jid@s.whatsapp.net", "unreplied_only": true|false} — Show WhatsApp messages. Use when user asks "check whatsapp", "whatsapp messages", "unreplied messages", "رسائل الواتساب". If no jid, shows all recent. Set unreplied_only=true to show only unreplied messages. Shows messages grouped by category (client/shop/family/personal).
- {"type": "search_wa", "query": "name or text"} — Search WhatsApp messages by contact name or content. Use when user asks "what did X say", "check messages from Y", "شنو قال فلان", "messages from farah". ALWAYS use this instead of run_command/sqlite3 for WhatsApp searches.
- {"type": "list_wa_contacts"} — Show all WhatsApp contacts with their categories. Use when user asks "show my contacts", "who messaged me", "list contacts", "جهات الاتصال". Shows both categorized and uncategorized contacts.
- {"type": "categorize_wa_contact", "jid": "number@s.whatsapp.net", "name": "search name if no jid", "category": "client|shop|family|personal|other", "display_name": "Label Name", "notes": "optional context"} — Categorize AND rename a WhatsApp contact. Use jid OR name to find the contact. The display_name is the label shown everywhere (e.g., "Ahmed - ShopDemo Dev", "Farah (Wife)", "Shop Supplier Frank"). Use when user says "rename X to Y", "this is a client", "tag X as family", "سمي فلان". You can set multiple contacts in one response with multiple actions.
- {"type": "wa_reply", "jid": "number@s.whatsapp.net", "text": "..."} — Send a reply to a WhatsApp chat. Use when the owner asks you to reply to someone on WhatsApp.
- {"type": "wa_rule", "jid": "number@s.whatsapp.net"|null, "rule_type": "auto_reply|ignore|notify", "condition": "keyword|all", "response": "..."} — Add a WhatsApp auto-reply rule. jid=null means applies to all chats.

## WhatsApp as part of Life OS
WhatsApp messages are stored in the database. You have FULL access to search and read them. When the owner asks about messages:
- "check what X said" / "شنو قال فلان" → use search_wa action (NOT run_command/sqlite3)
- "check whatsapp" / "رسائل الواتساب" → use show_wa_messages
- "reply to X" → use wa_reply

**Connect messages to life management:**
- If a client sends a dev task/request → suggest creating a task with category "client"
- If a shop contact mentions inventory/orders → suggest creating a task with category "shop"
- If family mentions plans/appointments → suggest adding to schedule
- When showing unreplied messages, prioritize client messages (they affect income)
- In morning briefings, mention important unreplied messages

**Contact categorization:**
- When you see a new contact that isn't categorized, and you can infer from context (shop group = "shop", dev discussion = "client", etc.), proactively categorize them
- When the owner says "my wife", "my father", "my friend X" — categorize and remember the relationship`;
  },

  async getContextSection(): Promise<string> {
    try {
      const byCategory = db.getUnrepliedByCategory();
      const catLabels: Record<string, string> = {
        client: "👤 Client", shop: "🏪 Shop", family: "👨‍👩‍👧 Family",
        personal: "🏠 Personal", other: "📱 Other",
      };
      const catOrder = ["client", "shop", "family", "personal", "other"];
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
      // Count uncategorized contacts
      const contacts = db.getAllWAContacts();
      const allJids = db.getRecentWAMessages(100).map((m: any) => m.jid);
      const uniqueJids = [...new Set(allJids)];
      const categorized = contacts.length;
      const uncategorized = uniqueJids.filter((j: string) => !contacts.some((c: any) => c.jid === j)).length;
      if (uncategorized > 0) lines.push(`\n⚠️ ${uncategorized} contacts not categorized. Ask the owner to categorize them.`);
      return `### WhatsApp Messages\n${lines.join("\n")}`;
    } catch {
      return "### WhatsApp Messages\nWhatsApp data unavailable.";
    }
  },

  async handleEvent(event: AgentEvent, ctx: AgentContext): Promise<AgentResult> {
    if (event.type === "wa:message") {
      try {
        await processIncomingMessage(event.data as any);
        return { success: true, output: "Message processed", silent: true };
      } catch (err: any) {
        return { success: false, output: `WA message processing failed: ${err.message}`, silent: true };
      }
    }
    return { success: false, output: `Unknown event: ${event.type}` };
  },

  async handleCommand(command: string, args: string, ctx: AgentContext): Promise<AgentResult> {
    switch (command) {
      case "contacts":
      case "contact":
        return handleContactsCommand(ctx);
      case "wa":
        return handleWaCommand(args, ctx);
      default:
        return { success: false, output: `Unknown command: ${command}` };
    }
  },

  async handleAction(action: Record<string, any>, ctx: AgentContext): Promise<string | void> {
    switch (action.type) {
      case "show_wa_messages":
        return handleShowWaMessages(action);
      case "search_wa":
        return handleSearchWa(action);
      case "list_wa_contacts":
        return handleListWaContacts();
      case "categorize_wa_contact":
        return handleCategorizeWaContact(action);
      case "wa_reply":
        return handleWaReply(action);
      case "wa_rule":
        return handleWaRule(action);
    }
  },
};

// ==================
// Command Handlers
// ==================

async function handleContactsCommand(ctx: AgentContext): Promise<AgentResult> {
  const categorized = db.getAllWAContacts() as any[];
  const recent = db.getRecentWAMessages(200) as any[];
  const contactMap = new Map<string, { name: string; count: number }>();
  for (const m of recent) {
    const e = contactMap.get(m.jid);
    if (e) e.count++;
    else contactMap.set(m.jid, { name: m.sender_name, count: 1 });
  }
  const catMap = new Map(categorized.map((c: any) => [c.jid, c]));
  const catEmoji: Record<string, string> = { client: "👤", shop: "🏪", family: "👨‍👩‍👧", personal: "🏠", other: "📱" };

  const tagged: string[] = [];
  const untagged: string[] = [];
  for (const [jid, info] of contactMap) {
    const cat = catMap.get(jid) as any;
    if (cat) {
      tagged.push(`${catEmoji[cat.category] || "📱"} *${cat.display_name || info.name}* [${cat.category}]`);
    } else {
      untagged.push(`⚪ ${info.name} (${info.count} msgs)`);
    }
  }

  const lines = ["📱 *WhatsApp Contacts*\n"];
  if (tagged.length) { lines.push("*Labeled:*"); lines.push(...tagged); lines.push(""); }
  if (untagged.length) { lines.push(`*Not labeled (${untagged.length}):*`); lines.push(...untagged); }
  if (!tagged.length && !untagged.length) lines.push("No WhatsApp contacts yet.");
  lines.push("\n_Tell me naturally: \"حفوصة is my wife Farah\", \"Androtetouan is a client\"_");

  return { success: true, output: lines.join("\n") };
}

async function handleWaCommand(args: string, ctx: AgentContext): Promise<AgentResult> {
  const input = args.trim();

  if (!input || input === "help") {
    return {
      success: true,
      output:
        `*WhatsApp AI Commands:*\n\n` +
        `/wa rules — List active rules\n` +
        `/wa ignore <jid> — Ignore a chat\n` +
        `/wa notify <jid> — Forward messages to Telegram\n` +
        `/wa auto <jid|all> <keyword> <response> — Auto-reply rule\n` +
        `/wa del <rule_id> — Delete a rule\n` +
        `/wa recent — Recent messages`,
    };
  }

  const parts = input.split(/\s+/);
  const cmd = parts[0];

  if (cmd === "rules") {
    const rules = db.getWARules();
    if (rules.length === 0) {
      return { success: true, output: "No active WhatsApp rules." };
    }
    const lines = rules.map((r: any) => {
      const target = r.jid ? r.jid.split("@")[0] : "ALL";
      return `#${r.id} [${r.rule_type}] ${target} — ${r.condition || "*"} → ${(r.response || "").slice(0, 50)}`;
    });
    return { success: true, output: `*WhatsApp Rules:*\n\n${lines.join("\n")}` };
  }

  if (cmd === "ignore") {
    const jid = parts[1];
    if (!jid) return { success: false, output: "Usage: /wa ignore <jid or phone@s.whatsapp.net>" };
    const fullJid = jid.includes("@") ? jid : `${jid}@s.whatsapp.net`;
    db.addWARule(fullJid, "ignore");
    return { success: true, output: `Ignoring ${fullJid.split("@")[0]}` };
  }

  if (cmd === "notify") {
    const jid = parts[1];
    if (!jid) return { success: false, output: "Usage: /wa notify <jid>" };
    const fullJid = jid.includes("@") ? jid : `${jid}@s.whatsapp.net`;
    db.addWARule(fullJid, "notify");
    return { success: true, output: `Forwarding messages from ${fullJid.split("@")[0]} to Telegram` };
  }

  if (cmd === "auto") {
    const jid = parts[1];
    const keyword = parts[2];
    const response = parts.slice(3).join(" ");
    if (!jid || !keyword || !response) {
      return { success: false, output: "Usage: /wa auto <jid|all> <keyword> <response>" };
    }
    const fullJid = jid === "all" ? null : (jid.includes("@") ? jid : `${jid}@s.whatsapp.net`);
    db.addWARule(fullJid, "auto_reply", keyword, response);
    return { success: true, output: `Auto-reply rule added: "${keyword}" → "${response}"` };
  }

  if (cmd === "del") {
    const id = parseInt(parts[1]);
    if (!id) return { success: false, output: "Usage: /wa del <rule_id>" };
    db.deleteWARule(id);
    return { success: true, output: `Rule #${id} deleted.` };
  }

  if (cmd === "recent") {
    const messages = db.getRecentWAMessages(15);
    if (messages.length === 0) {
      return { success: true, output: "No recent WhatsApp messages." };
    }
    const lines = messages.map((m: any) => {
      const name = m.sender_name || m.sender?.split("@")[0] || "?";
      const time = new Date(m.timestamp * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      const replied = m.replied ? " ✓" : "";
      return `${time} *${name}*: ${m.content.slice(0, 80)}${replied}`;
    });
    return { success: true, output: `*Recent WhatsApp:*\n\n${lines.join("\n")}` };
  }

  return { success: false, output: "Unknown /wa command. Try /wa help" };
}

// ==================
// Action Handlers
// ==================

function handleShowWaMessages(action: Record<string, any>): string {
  const jid = action.jid;
  const unrepliedOnly = action.unreplied_only !== false;
  if (unrepliedOnly && !jid) {
    // Show by category
    const byCategory = db.getUnrepliedByCategory();
    const catEmoji: Record<string, string> = { client: "👤", shop: "🏪", family: "👨‍👩‍👧", personal: "🏠", other: "📱" };
    const catOrder = ["client", "shop", "family", "personal", "other"];
    const lines: string[] = ["\n📱 *Unreplied WhatsApp Messages*\n"];
    let total = 0;
    for (const cat of catOrder) {
      const msgs = byCategory[cat];
      if (!msgs || msgs.length === 0) continue;
      total += msgs.length;
      lines.push(`${catEmoji[cat] || "📱"} *${cat.toUpperCase()}* (${msgs.length})`);
      for (const m of msgs.slice(0, 5)) {
        const time = new Date(m.timestamp * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
        lines.push(`  ← ${time} *${m.display_name || m.sender_name}* (\`${m.jid}\`): ${m.content.slice(0, 100)}`);
      }
      if (msgs.length > 5) lines.push(`  _...+${msgs.length - 5} more_`);
      lines.push("");
    }
    if (total === 0) lines.push("_No unreplied messages._");
    return lines.join("\n");
  }
  // Single chat or all recent
  let messages: any[];
  if (unrepliedOnly) {
    messages = db.getUnrepliedWAMessages(jid, 15);
  } else {
    messages = jid ? db.getWAMessages(jid, 20) : db.getRecentWAMessages(20);
  }
  if (messages.length === 0) return `\n📱 No ${unrepliedOnly ? "unreplied" : "recent"} messages.`;
  const lines: string[] = [`\n📱 *WhatsApp Messages*\n`];
  const grouped: Record<string, any[]> = {};
  for (const m of messages) {
    const key = m.sender_name || m.jid?.split("@")[0] || "Unknown";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(m);
  }
  for (const [name, msgs] of Object.entries(grouped)) {
    const contact = db.getWAContactCategory(msgs[0].jid);
    const catTag = contact ? ` [${contact.category}]` : "";
    lines.push(`*${name}*${catTag} — JID: \`${msgs[0].jid}\` (${msgs.length})`);
    for (const m of msgs.slice(-3)) {
      const time = new Date(m.timestamp * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      const dir = m.from_me ? "→" : "←";
      lines.push(`  ${dir} ${time}: ${m.content.slice(0, 100)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function handleSearchWa(action: Record<string, any>): string {
  const results = db.searchWAMessages(action.query, 15);
  if (results.length === 0) return `\n📱 No WhatsApp messages found for "${action.query}".`;
  const lines: string[] = [`\n📱 *WhatsApp — "${action.query}"* (${results.length} messages)\n`];
  for (const m of results) {
    const time = new Date(m.timestamp * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const dir = m.from_me ? "→" : "←";
    const cat = m.contact_category !== "other" ? ` [${m.contact_category}]` : "";
    lines.push(`${dir} *${m.display_name || m.sender_name}*${cat} (${time}) — JID: \`${m.jid}\``);
    lines.push(`  ${m.content.slice(0, 150)}`);
  }
  return lines.join("\n");
}

function handleListWaContacts(): string {
  const allMessages = db.getRecentWAMessages(200);
  const contactMap = new Map<string, { jid: string; name: string; count: number; lastMsg: string; lastTs: number }>();
  for (const m of allMessages) {
    const existing = contactMap.get(m.jid);
    if (existing) {
      existing.count++;
      if (m.timestamp > existing.lastTs) {
        existing.lastMsg = m.content;
        existing.lastTs = m.timestamp;
      }
    } else {
      contactMap.set(m.jid, { jid: m.jid, name: m.sender_name, count: 1, lastMsg: m.content, lastTs: m.timestamp });
    }
  }
  const categorized = db.getAllWAContacts();
  const catMap = new Map(categorized.map((c: any) => [c.jid, c]));
  const catEmoji: Record<string, string> = { client: "👤", shop: "🏪", family: "👨‍👩‍👧", personal: "🏠", other: "📱" };
  const lines: string[] = ["\n📱 *WhatsApp Contacts*\n"];

  const tagged: string[] = [];
  const untagged: string[] = [];
  for (const [jid, info] of contactMap) {
    const cat = catMap.get(jid) as any;
    if (cat) {
      const emoji = catEmoji[cat.category] || "📱";
      tagged.push(`${emoji} *${cat.display_name || info.name}* [${cat.category}] — ${info.count} msgs, JID: \`${jid}\``);
    } else {
      untagged.push(`⚪ *${info.name}* — ${info.count} msgs, last: "${info.lastMsg.slice(0, 40)}" — JID: \`${jid}\``);
    }
  }
  if (tagged.length > 0) {
    lines.push("*Categorized:*");
    lines.push(...tagged);
    lines.push("");
  }
  if (untagged.length > 0) {
    lines.push(`*Not categorized (${untagged.length}):*`);
    lines.push(...untagged);
    lines.push("");
    lines.push("_Tell me how to label them: \"X is a client\", \"rename Y to Z\"_");
  }
  return lines.join("\n");
}

function handleCategorizeWaContact(action: Record<string, any>): string {
  let jid = action.jid;
  // If no JID but a name is given, try to find the contact
  if (!jid && action.name) {
    const results = db.searchWAMessages(action.name, 1);
    if (results.length > 0) jid = results[0].jid;
  }
  if (!jid) return `📱 Could not find contact. Use list_wa_contacts to see JIDs.`;
  db.setWAContactCategory(jid, action.category, action.display_name, action.notes);
  const label = action.display_name || jid.split("@")[0];
  return `📱 *${label}* → ${action.category}${action.notes ? ` (${action.notes})` : ""}`;
}

async function handleWaReply(action: Record<string, any>): Promise<string> {
  try {
    const { sendWhatsAppMessage } = await import("../../whatsapp");
    await sendWhatsAppMessage(action.jid, action.text);
    return `📱 Sent to ${action.jid.split("@")[0]}: "${action.text.slice(0, 100)}"`;
  } catch (err: any) {
    return `❌ WhatsApp send failed: ${err.message}`;
  }
}

function handleWaRule(action: Record<string, any>): string {
  db.addWARule(action.jid || null, action.rule_type, action.condition, action.response);
  return `📱 WhatsApp rule added: ${action.rule_type} ${action.jid ? "for " + action.jid.split("@")[0] : "for all"}`;
}

export default whatsappAgent;
