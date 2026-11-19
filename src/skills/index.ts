import type { Skill, SkillContext, SkillResult, SkillCategory } from "./types";
import type { Bot } from "grammy";
import Anthropic from "@anthropic-ai/sdk";
import * as db from "../db";
import { runCommand } from "../shell";
import * as fs from "fs";
import * as path from "path";
import { prayerOn } from "../profile";

const skills = new Map<string, Skill>();

export function loadSkills(): void {
  const dir = __dirname;
  const files = fs.readdirSync(dir).filter(
    (f) =>
      (f.endsWith(".ts") || f.endsWith(".js")) &&
      !["index.ts", "index.js", "types.ts", "types.js"].includes(f)
  );

  for (const file of files) {
    try {
      const mod = require(path.join(dir, file));
      const skill = (mod.default || mod) as Skill;
      if (skill && typeof skill.name === "string" && typeof skill.execute === "function") {
        skills.set(skill.name, skill);
        console.log(`  ✅ Skill: ${skill.name}`);
      }
    } catch (err) {
      console.error(`  ❌ Failed to load skill ${file}:`, err);
    }
  }

  console.log(`⚡ ${skills.size} skills loaded.`);
}

export function getSkill(name: string): Skill | undefined {
  return skills.get(name);
}

export function listSkills(): Skill[] {
  return Array.from(skills.values());
}

function createContext(bot: Bot, chatId: number): SkillContext {
  const ai = new Anthropic({
    apiKey: process.env.CLIPROXY_API_KEY || process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.CLIPROXY_API_KEY ? "http://localhost:8317" : undefined,
  });

  return {
    db,
    runCommand,
    ai,
    bot,
    chatId,
    sendUpdate: async (text: string) => {
      try {
        await bot.api.sendMessage(chatId, text, { parse_mode: "Markdown" });
      } catch {
        await bot.api.sendMessage(chatId, text.replace(/[*_`\[\]]/g, ""));
      }
    },
  };
}

export async function executeSkill(
  name: string,
  args: Record<string, any>,
  bot: Bot,
  chatId: number
): Promise<SkillResult> {
  const skill = skills.get(name);
  if (!skill) {
    return { success: false, output: `Unknown skill: "${name}". Use /skills to see available skills.` };
  }

  for (const argDef of skill.args) {
    if (argDef.required && (args[argDef.name] === undefined || args[argDef.name] === null)) {
      return { success: false, output: `Missing required argument: ${argDef.name} (${argDef.description})` };
    }
    if (args[argDef.name] === undefined && argDef.default !== undefined) {
      args[argDef.name] = argDef.default;
    }
  }

  const ctx = createContext(bot, chatId);

  try {
    return await skill.execute(ctx, args);
  } catch (err: any) {
    console.error(`Skill "${name}" error:`, err);
    return { success: false, output: `Skill "${name}" failed: ${err.message}` };
  }
}

export function getSkillsPromptSection(): string {
  if (skills.size === 0) return "";

  const byCategory = new Map<SkillCategory, Skill[]>();
  for (const skill of skills.values()) {
    if (skill.category === "deen" && !prayerOn()) continue;
    const list = byCategory.get(skill.category) || [];
    list.push(skill);
    byCategory.set(skill.category, list);
  }

  const categoryLabels: Record<SkillCategory, string> = {
    devops: "DevOps & Server",
    analytics: "Analytics & Reports",
    planning: "Planning & AI",
    deen: "Deen & Islamic",
    system: "System & Maintenance",
  };

  let prompt = `\n## Skills (Multi-Step Workflows)\nInvoke skills via: <action>{"type":"skill","name":"SKILL_NAME","args":{...}}</action>\nUse skills for complex operations instead of multiple run_command actions.\n\n`;

  for (const [cat, items] of byCategory) {
    prompt += `### ${categoryLabels[cat]}\n`;
    for (const s of items) {
      const argsDesc = s.args.length > 0
        ? s.args.map((a) => `${a.name}${a.required ? "" : "?"}: ${a.type} — ${a.description}`).join(", ")
        : "no args";
      prompt += `- **${s.name}**: ${s.description} (${argsDesc})\n`;
    }
    prompt += "\n";
  }

  return prompt;
}
