import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { matchProject, getProject, type ProjectRef } from "./project-registry";
import { proposeClaudeRun, runClaudeNow } from "./claude-runner";
import { routeClientTask } from "./client-task-route";
import { classifyWAMessage, type Classification } from "./classifier";
import { sdkReply } from "./sdk-reply";
import { hasMissionConfig, proposeServerMission, autoStartServerMission } from "./mission-wiring";

let bot: Bot | null = null;
const CHAT_ID = parseInt(process.env.TELEGRAM_USER_ID || "0");

export function setAutoDispatchBot(b: Bot): void {
  bot = b;
}

export interface WAAutoInput {
  content: string;
  sender_name: string;
  jid: string;
  is_group: boolean;
  has_image?: boolean;
}

function resolveProject(msg: WAAutoInput): ProjectRef | null {
  const candidates = [msg.sender_name, msg.jid.split("@")[0]];
  for (const c of candidates) {
    const p = matchProject(c);
    if (p) return p;
  }
  return null;
}

export async function maybeAutoDispatch(msg: WAAutoInput): Promise<boolean> {
  if (!bot || !CHAT_ID) return false;

  if (!msg.content || msg.content.trim().length < 3) return false;
  if (msg.is_group) return false;

  const project = resolveProject(msg);
  if (!project) return false;

  let classification: Classification;
  try {
    classification = await classifyWAMessage({
      content: msg.content,
      sender_name: msg.sender_name,
      project_name: project.name,
      project_location: project.location,
      has_image: !!msg.has_image,
      char_count: msg.content.length,
    });
  } catch (err: any) {
    console.error("[wa-auto-dispatch] classifier error, skipping:", err?.message);
    return false;
  }

  if (classification.layer === "sdk-quick") {
    await sdkReply(bot, msg, classification, project);
    return true;
  }

  // Jev: coding or personal, website or mobile app → Claude in herdr on the server or the laptop.
  const route = await routeClientTask(msg, { name: project.name, note: project.note, location: project.location, hasMission: hasMissionConfig(project.name) });
  console.log(`[wa-auto-dispatch] ${project.name} from ${msg.sender_name}: ${route.action} (${route.reason})`);
  if (route.action === "skip") return false;
  if (route.action === "mission") return autoStartServerMission(project, msg, route.reason);
  if (route.action === "run") {
    const variant = classification.layer === "tech-company" ? "tech-company" : "kb-dev";
    runClaudeNow(bot, CHAT_ID, project, msg.content.trim(), `WA auto-run from ${msg.sender_name}: ${route.reason}`, {
      clientJid: msg.jid, senderName: msg.sender_name, originalMessage: msg.content, variant,
    });
    return true;
  }

  if (project.location !== "laptop") {
    // Server project with a mission config: approve → Claude in a server herdr pane → test → deploy.
    if (hasMissionConfig(project.name)) return proposeServerMission(project, msg);
    await notifyServerOnlyUnsupported(project, msg, classification);
    return false;
  }

  return proposeLaptopRun(project, msg, classification);
}

async function proposeLaptopRun(
  project: ProjectRef,
  msg: WAAutoInput,
  classification: Classification,
): Promise<boolean> {
  if (!bot) return false;

  const prompt = msg.content.trim();
  const variant: "kb-dev" | "tech-company" =
    classification.layer === "tech-company" ? "tech-company" : "kb-dev";
  const reason = `WA auto-dispatch from ${msg.sender_name} [${classification.layer}]`;

  const id = proposeClaudeRun(CHAT_ID, project, prompt, reason, {
    clientJid: msg.jid,
    senderName: msg.sender_name,
    originalMessage: msg.content,
    variant,
  });

  const keyboard = new InlineKeyboard()
    .text("✅ Run", `claude_yes:${id}`)
    .text("✅ Run + reply", `claude_yes_reply:${id}`)
    .row()
    .text(
      variant === "tech-company" ? "🏢 Full team (again)" : "🏢 Full team",
      `claude_tc:${id}`,
    )
    .text("❌ Cancel", `claude_no:${id}`);

  const layerBadge = classification.layer === "tech-company" ? "🏢 tech-company" : "🔧 claude-code";
  const preview =
    msg.content.length > 400 ? msg.content.slice(0, 400) + "…" : msg.content;
  const text =
    `💬 *WA from* ${msg.sender_name}\n` +
    `"${preview}"\n\n` +
    `📁 Project: \`${project.name}\` (${project.location})\n` +
    `🤖 Layer: ${layerBadge}\n` +
    `_${classification.reasoning || ""}_\n\n` +
    `_(expires in 5 min)_`;

  await bot.api
    .sendMessage(CHAT_ID, text, { parse_mode: "Markdown", reply_markup: keyboard })
    .catch(async () => {
      await bot!.api.sendMessage(CHAT_ID, text.replace(/[*_`]/g, ""), {
        reply_markup: keyboard,
      });
    });
  return true;
}

async function notifyServerOnlyUnsupported(
  project: ProjectRef,
  msg: WAAutoInput,
  classification: Classification,
): Promise<void> {
  if (!bot) return;
  const text =
    `⚠️ WA dev task from *${msg.sender_name}* matched server-only project \`${project.name}\`.\n` +
    `Layer: \`${classification.layer}\`\n` +
    `"${msg.content.slice(0, 300)}"\n` +
    `_Server-side dispatch not wired yet — handle manually._`;
  await bot.api.sendMessage(CHAT_ID, text, { parse_mode: "Markdown" }).catch(() => {
    bot!.api.sendMessage(CHAT_ID, text.replace(/[*_`]/g, ""));
  });
}

// Surface the registry helpers to callers that want them
export { matchProject, getProject };
