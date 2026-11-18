import type { Agent, AgentContext, AgentResult, AgentDomain } from "./types";
import type { EventBus } from "./event-bus";

/**
 * AgentRegistry — loads agents, routes commands/actions/events to them.
 */
export class AgentRegistry {
  private agents = new Map<string, Agent>();
  private commandMap = new Map<string, Agent>();
  private actionMap = new Map<string, Agent>();
  private keywordIndex: { keywords: string[]; agent: Agent }[] = [];

  register(agent: Agent): void {
    if (this.agents.has(agent.name)) {
      console.warn(`[Registry] Agent "${agent.name}" already registered, replacing.`);
    }
    this.agents.set(agent.name, agent);

    // Index commands
    for (const cmd of agent.commands) {
      const key = cmd.replace(/^\//, "");
      if (this.commandMap.has(key)) {
        console.warn(`[Registry] Command "/${key}" already owned by "${this.commandMap.get(key)!.name}", reassigning to "${agent.name}".`);
      }
      this.commandMap.set(key, agent);
    }

    // Index actions
    for (const action of agent.actions) {
      if (this.actionMap.has(action)) {
        console.warn(`[Registry] Action "${action}" already owned by "${this.actionMap.get(action)!.name}", reassigning to "${agent.name}".`);
      }
      this.actionMap.set(action, agent);
    }

    // Index keywords
    if (agent.keywords.length > 0) {
      this.keywordIndex.push({ keywords: agent.keywords, agent });
    }
  }

  /** Get all registered agents */
  getAll(): Agent[] {
    return Array.from(this.agents.values());
  }

  /** Get agent by name */
  get(name: string): Agent | undefined {
    return this.agents.get(name);
  }

  /** Get agent that owns a Telegram command */
  getByCommand(command: string): Agent | undefined {
    return this.commandMap.get(command.replace(/^\//, ""));
  }

  /** Get agent that handles an AI action type */
  getByAction(actionType: string): Agent | undefined {
    return this.actionMap.get(actionType);
  }

  /** Find agents matching natural language input by keyword scoring */
  classify(text: string): Agent[] {
    const lower = text.toLowerCase();
    const scored: { agent: Agent; score: number }[] = [];

    for (const { keywords, agent } of this.keywordIndex) {
      let score = 0;
      for (const kw of keywords) {
        if (lower.includes(kw.toLowerCase())) score++;
      }
      if (score > 0) scored.push({ agent, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.agent);
  }

  /** Subscribe all agents to their declared event types on the bus */
  wireEvents(eventBus: EventBus, createContext: (agent: Agent) => AgentContext): void {
    for (const agent of this.agents.values()) {
      for (const eventType of agent.handles) {
        eventBus.on(eventType, async (event) => {
          try {
            const ctx = createContext(agent);
            await agent.handleEvent(event, ctx);
          } catch (err) {
            console.error(`[${agent.name}] Event handler error for "${eventType}":`, err);
          }
        });
      }
    }
  }

  /** Initialize all agents */
  async initAll(createContext: (agent: Agent) => AgentContext): Promise<void> {
    for (const agent of this.agents.values()) {
      if (agent.init) {
        try {
          const ctx = createContext(agent);
          await agent.init(ctx);
          console.log(`  [agent] ${agent.name} initialized`);
        } catch (err) {
          console.error(`[${agent.name}] Init error:`, err);
        }
      }
    }
  }

  /** Register all agent schedules */
  registerAllSchedules(createContext: (agent: Agent) => AgentContext): void {
    for (const agent of this.agents.values()) {
      if (agent.registerSchedule) {
        try {
          const ctx = createContext(agent);
          agent.registerSchedule(ctx);
          console.log(`  [agent] ${agent.name} schedule registered`);
        } catch (err) {
          console.error(`[${agent.name}] Schedule registration error:`, err);
        }
      }
    }
  }

  /** Build composite context from all agents for AI calls */
  async buildCompositeContext(): Promise<string> {
    const sections: string[] = [];
    for (const agent of this.agents.values()) {
      try {
        const section = await agent.getContextSection();
        if (section && section.trim()) {
          sections.push(section.trim());
        }
      } catch (err) {
        console.error(`[${agent.name}] Context section error:`, err);
      }
    }
    return sections.join("\n\n");
  }

  /** Build composite system prompt from all agents */
  buildCompositePrompt(): string {
    const sections: string[] = [];
    for (const agent of this.agents.values()) {
      try {
        const section = agent.getSystemPromptSection();
        if (section && section.trim()) {
          sections.push(section.trim());
        }
      } catch (err) {
        console.error(`[${agent.name}] Prompt section error:`, err);
      }
    }
    return sections.join("\n\n");
  }

  /** Route an AI action to the owning agent */
  async routeAction(action: Record<string, any>, ctx: AgentContext): Promise<string | void> {
    const actionType = action.type;
    if (!actionType) return;

    const agent = this.actionMap.get(actionType);
    if (!agent) {
      console.warn(`[Registry] No agent handles action type "${actionType}"`);
      return;
    }

    try {
      return await agent.handleAction(action, ctx);
    } catch (err) {
      console.error(`[${agent.name}] Action "${actionType}" error:`, err);
      return `Error in ${agent.name}: ${(err as Error).message}`;
    }
  }
}
