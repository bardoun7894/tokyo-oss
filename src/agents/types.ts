import type { Bot, Context } from "grammy";
import type { EventBus, AgentEvent } from "./event-bus";
import type { PrayerTimes, NextPrayer, TimeSlot } from "../types";
import type { UserState, StateInfo } from "../state";

export type AgentDomain =
  | "productivity"
  | "deen"
  | "finance"
  | "whatsapp"
  | "devops"
  | "coaching"
  | "research";

/** Shared context available to all agents — prayer, state, date */
export interface SharedContext {
  prayerTimes: PrayerTimes | null;
  nextPrayer: NextPrayer | null;
  workWindows: TimeSlot[];
  userState: StateInfo;
  today: string;
}

/** Context provided to every agent call */
export interface AgentContext {
  db: typeof import("../db");
  bot: Bot;
  chatId: number;
  eventBus: EventBus;
  /** Send a message to the owner on Telegram */
  sendMessage: (text: string, options?: any) => Promise<void>;
  /** AI call with automatic agent-scoped system prompt. Pass model to override default. */
  aiCall: (
    messages: { role: "user" | "assistant"; content: string }[],
    maxTokens?: number,
    model?: "pi" | "kieai",
  ) => Promise<string>;
  /** Get shared cross-agent context (prayer, state, date) */
  getSharedContext: () => Promise<SharedContext>;
  /** Grammy context for the current message (only available in command/message handlers) */
  grammy?: Context;
}

export interface AgentResult {
  success: boolean;
  output: string;
  data?: Record<string, any>;
  /** If true, don't send output to user */
  silent?: boolean;
}

export interface Agent {
  name: string;
  domain: AgentDomain;
  description: string;

  /** Event types this agent subscribes to via EventBus */
  handles: string[];

  /** Keywords for the classifier to route natural language to this agent */
  keywords: string[];

  /** Telegram commands this agent owns (without slash, e.g. "tasks") */
  commands: string[];

  /** AI action types this agent handles (from <action> blocks) */
  actions: string[];

  /** Domain-specific system prompt section for AI calls */
  getSystemPromptSection(): string;

  /** Domain-specific context section for AI calls */
  getContextSection(): Promise<string>;

  /** Handle a routed event */
  handleEvent(event: AgentEvent, ctx: AgentContext): Promise<AgentResult>;

  /** Handle a direct Telegram command */
  handleCommand(command: string, args: string, ctx: AgentContext): Promise<AgentResult>;

  /** Handle an AI action (from <action> blocks). Returns result string or void. */
  handleAction(action: Record<string, any>, ctx: AgentContext): Promise<string | void>;

  /** Called once at startup to initialize the agent */
  init?(ctx: AgentContext): Promise<void>;

  /** Called once at startup to register cron/scheduled jobs */
  registerSchedule?(ctx: AgentContext): void;
}
