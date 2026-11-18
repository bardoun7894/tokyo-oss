import type { Bot, Context } from "grammy";
import { EventBus } from "./agents/event-bus";
import { AgentRegistry } from "./agents/registry";
import { SharedContextProvider } from "./agents/shared-context";
import type { Agent, AgentContext } from "./agents/types";
import { aiCall } from "./ai";
import * as db from "./db";

const USER_ID = process.env.TELEGRAM_USER_ID;

/**
 * Tokyo Orchestrator — the brain that routes events to specialized agents.
 *
 * Owns: Telegram bot, WhatsApp connection, EventBus, AgentRegistry.
 * Does NOT own: domain logic (that belongs to agents).
 */
export class Orchestrator {
  readonly eventBus = new EventBus();
  readonly registry = new AgentRegistry();
  readonly shared = new SharedContextProvider();
  private bot: Bot;
  private chatId: number;

  constructor(bot: Bot) {
    this.bot = bot;
    this.chatId = parseInt(USER_ID || "0");
  }

  /** Register an agent */
  registerAgent(agent: Agent): void {
    this.registry.register(agent);
  }

  /** Create an AgentContext for a specific agent */
  createContext(agent: Agent, grammy?: Context): AgentContext {
    const self = this;
    return {
      db,
      bot: this.bot,
      chatId: this.chatId,
      eventBus: this.eventBus,
      grammy,

      async sendMessage(text: string, options?: any) {
        if (!self.chatId) return;
        const opts = { parse_mode: "Markdown" as const, ...options };
        await self.bot.api.sendMessage(self.chatId, text, opts).catch(() =>
          self.bot.api.sendMessage(self.chatId, text),
        );
      },

      async aiCall(messages, maxTokens = 1024, model?: "pi" | "kieai") {
        const systemPrompt = agent.getSystemPromptSection();
        return aiCall(systemPrompt, messages, maxTokens, model);
      },

      async getSharedContext() {
        return self.shared.getContext();
      },
    };
  }

  /** Wire all registered agents to the event bus */
  wireAll(): void {
    this.registry.wireEvents(this.eventBus, (agent) => this.createContext(agent));
  }

  /** Initialize all agents */
  async initAll(): Promise<void> {
    await this.registry.initAll((agent) => this.createContext(agent));
  }

  /** Register all agent schedules */
  registerAllSchedules(): void {
    this.registry.registerAllSchedules((agent) => this.createContext(agent));
  }

  /** Register Telegram command handlers for all agents */
  registerCommands(): void {
    for (const agent of this.registry.getAll()) {
      for (const cmd of agent.commands) {
        const cmdName = cmd.replace(/^\//, "");
        this.bot.command(cmdName, async (ctx) => {
          const agentCtx = this.createContext(agent, ctx);
          try {
            const result = await agent.handleCommand(cmdName, ctx.match || "", agentCtx);
            if (!result.silent && result.output) {
              await sendSplit(ctx, result.output);
            }
          } catch (err) {
            console.error(`[${agent.name}] Command /${cmdName} error:`, err);
            await ctx.reply(`${agent.name} agent error. Try again.`).catch(() => {});
          }
        });
      }
    }
  }

  /** Route an AI action to the appropriate agent */
  async routeAction(action: Record<string, any>, grammy?: Context): Promise<string | void> {
    const agent = this.registry.getByAction(action.type);
    if (!agent) return;
    const ctx = this.createContext(agent, grammy);
    return this.registry.routeAction(action, ctx);
  }

  /** Build composite context from all agents */
  async buildCompositeContext(): Promise<string> {
    return this.registry.buildCompositeContext();
  }

  /** Build composite system prompt from all agents */
  buildCompositePrompt(): string {
    return this.registry.buildCompositePrompt();
  }

  /** Classify natural language to find matching agents */
  classify(text: string): Agent[] {
    return this.registry.classify(text);
  }

  /** Refresh shared prayer data */
  async refreshPrayer(): Promise<void> {
    await this.shared.refreshPrayer();
  }
}

/** Split long messages for Telegram (4000 char limit) */
async function sendSplit(ctx: Context, text: string) {
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

/** Singleton orchestrator instance — set up in main() */
let instance: Orchestrator | null = null;

export function createOrchestrator(bot: Bot): Orchestrator {
  instance = new Orchestrator(bot);
  return instance;
}

