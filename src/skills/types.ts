import type { Bot } from "grammy";
import type Anthropic from "@anthropic-ai/sdk";

export interface SkillContext {
  db: typeof import("../db");
  runCommand: (cmd: string) => Promise<{ stdout: string; stderr: string; code: number | null }>;
  ai: Anthropic;
  bot: Bot;
  chatId: number;
  sendUpdate: (text: string) => Promise<void>;
}

export interface SkillResult {
  success: boolean;
  output: string;
  data?: Record<string, any>;
}

export interface SkillArg {
  name: string;
  type: "string" | "number" | "boolean";
  description: string;
  required: boolean;
  default?: any;
}

export type SkillCategory = "devops" | "analytics" | "planning" | "deen" | "system";

export interface Skill {
  name: string;
  description: string;
  category: SkillCategory;
  args: SkillArg[];
  execute: (ctx: SkillContext, args: Record<string, any>) => Promise<SkillResult>;
}
