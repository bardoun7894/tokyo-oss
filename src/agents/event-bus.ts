export interface AgentEvent {
  type: string;
  source: string;
  domain?: string;
  data: Record<string, any>;
  timestamp: number;
}

type EventHandler = (event: AgentEvent) => Promise<void>;

/**
 * In-process event bus for agent communication.
 * Each handler is wrapped in try/catch — one agent's error won't crash others.
 */
export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();
  private wildcardHandlers = new Set<EventHandler>();

  /** Subscribe to a specific event type */
  on(eventType: string, handler: EventHandler): void {
    if (eventType === "*") {
      this.wildcardHandlers.add(handler);
      return;
    }
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);
  }

  /** Unsubscribe */
  off(eventType: string, handler: EventHandler): void {
    if (eventType === "*") {
      this.wildcardHandlers.delete(handler);
      return;
    }
    this.handlers.get(eventType)?.delete(handler);
  }

  /** Emit an event to all subscribers. Each handler is isolated — errors are logged, not thrown. */
  async emit(event: AgentEvent): Promise<void> {
    const handlers = this.handlers.get(event.type);
    const allHandlers = [
      ...(handlers ? Array.from(handlers) : []),
      ...Array.from(this.wildcardHandlers),
    ];

    await Promise.allSettled(
      allHandlers.map(async (handler) => {
        try {
          await handler(event);
        } catch (err) {
          console.error(`[EventBus] Handler error for "${event.type}" from "${event.source}":`, err);
        }
      }),
    );
  }

  /** Emit without awaiting — fire and forget */
  fire(event: AgentEvent): void {
    this.emit(event).catch((err) =>
      console.error("[EventBus] Fire error:", err),
    );
  }

  /** Helper to create an event */
  static event(type: string, source: string, data: Record<string, any> = {}, domain?: string): AgentEvent {
    return { type, source, domain, data, timestamp: Date.now() };
  }
}
