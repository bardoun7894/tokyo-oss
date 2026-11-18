import { GateCounter, serialize, type PushEvent } from "./format";
import type { Publisher } from "./publisher";
import type { PushSource, SourceEvent } from "./sources";
import type { NotifyPrefs, PushStore } from "./store";

export const DISPATCH_INTERVAL_MS = 20_000;
const DRAIN_LIMIT = 50;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const realTimers: Timers = {
  set: (fn, ms) => { const h = setInterval(fn, ms); h.unref(); return h; },
  clear: (h) => clearInterval(h as NodeJS.Timeout),
};

/** Whether a device's switches let this event through. */
export function wanted(p: NotifyPrefs, e: PushEvent): boolean {
  switch (e.type) {
    case "approval.new": return p.approvals;
    case "deploy.result": return p.deploys;
    case "run.finished": case "run.failed": return p.runs;
    case "reminder": return p.reminders;
    case "incident.new": return p.incidents === "warning" || (p.incidents === "critical" && e.level === "critical");
    case "test": return true;
  }
}

/**
 * Every tick: read each source, diff it against the keys already seen, put one outbox row per eligible device, then send
 * what is pending. A source seeds silently the first time it is ever read (the sentinel survives restarts and pruning), so
 * a restart sends nothing twice and still sends what appeared while Tokyo was down. Without a push config nothing runs.
 */
export class Dispatcher {
  readonly stats = { gateRejected: 0, enqueued: 0, sent: 0, failed: 0 };
  private readonly gate = new GateCounter();
  private readonly timers: Timers;
  private handle: unknown = null;
  private busy: Promise<void> | null = null;
  private failing = new Set<string>();
  private lastPrune = 0;

  constructor(private readonly o: {
    store: PushStore; publisher: Publisher; sources: PushSource[]; now: () => number; format: () => "up" | "ntfy";
    log?: (m: string) => void; timers?: Timers;
  }) {
    this.timers = o.timers ?? realTimers;
  }

  start(intervalMs = DISPATCH_INTERVAL_MS): void {
    if (this.handle !== null) return;
    this.handle = this.timers.set(() => { void this.tick(); }, intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.timers.clear(this.handle);
    this.handle = null;
  }

  tick(): Promise<void> {
    if (!this.busy) this.busy = this.run().catch((e) => this.log(`[push] tick failed (${String(e?.name ?? "Error")})`)).finally(() => { this.busy = null; });
    return this.busy;
  }

  private log(m: string): void { (this.o.log ?? ((x: string) => console.warn(x)))(m); }

  private async run(): Promise<void> {
    if (!this.o.publisher.enabled) return;
    const now = this.o.now();
    for (const src of this.o.sources) {
      let events: SourceEvent[];
      try {
        events = await src.read();
        this.failing.delete(src.name);
      } catch (e: any) {
        // One line per outage, and never the error text: it may carry a path or a token.
        if (!this.failing.has(src.name)) { this.failing.add(src.name); this.log(`[push] source ${src.name} failed (${String(e?.name ?? "Error")})`); }
        continue;
      }
      if (!this.o.store.sourceSeeded(src.name)) {
        for (const ev of events) this.o.store.markSeen(src.name, ev.key, now);
        this.o.store.markSeeded(src.name, now);
        continue;
      }
      for (const ev of events) if (this.o.store.markSeen(src.name, ev.key, now)) this.fanOut(ev, now);
    }
    await this.drain();
    if (now - this.lastPrune >= PRUNE_EVERY_MS) { this.lastPrune = now; this.o.store.prune(now); }
    this.stats.gateRejected = this.gate.rejected;
  }

  private fanOut(ev: SourceEvent, now: number): void {
    let body: string | null | undefined;
    for (const ep of this.o.store.list()) {
      if (ep.deviceId === ev.except || !wanted(this.o.store.getPrefs(ep.deviceId), ev.event)) continue;
      if (body === undefined) {
        const built = serialize(ev.event, this.o.format(), this.gate);
        body = built.ok ? built.payload : null;
      }
      if (body === null) return;
      if (this.o.store.enqueue(ep.deviceId, ev.key, ev.event.type, body, now)) this.stats.enqueued += 1;
    }
  }

  private async drain(): Promise<void> {
    for (const row of this.o.store.pending(DRAIN_LIMIT)) {
      const r = await this.o.publisher.send(row);
      if (r === "off") return;
      if (r === "sent") this.stats.sent += 1; else this.stats.failed += 1;
    }
  }
}
