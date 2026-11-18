// Workflow code: deterministic. Imports only from @temporalio/workflow and
// pure type-only imports from ./activities (B1 — no I/O, no wall clock other
// than the SDK-patched Date.now()/Math.random(), no non-deterministic control
// flow).
import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  continueAsNew,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activities from './activities';

const acts = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: {
    initialInterval: '10s',
    backoffCoefficient: 2,
    maximumInterval: '5m',
    maximumAttempts: 6,
  },
});

export interface InboundSignal {
  msgId: number;
  ts: number;
}

export interface WaChatCarry {
  burstCount: number;
  queue: InboundSignal[];
}

export interface PendingResult {
  pending: number[];
  lastRunAt: number | null;
}

export const inbound = defineSignal<[InboundSignal]>('inbound');
export const pendingQuery = defineQuery<PendingResult>('pending');

// Debounce window: after each inbound signal, wait this long for a quiet gap
// before running the burst. Matches the 15s in-memory cooldown this workflow
// replaces (src/whatsapp-ai.ts COOLDOWN_MS) — same effective cadence, but
// durable instead of an in-memory Map that a crash silently wipes.
const QUIET_WINDOW_MS = 15_000;
// No message for this long: let the workflow complete. The next inbound
// message restarts it via signalWithStart (src/whatsapp.ts dispatch path).
const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
// continueAsNew budget — keeps workflow history bounded for long-lived chats.
const MAX_BURSTS_BEFORE_CONTINUE = 200;

/**
 * Durable per-chat message queue. One workflow execution per WhatsApp jid
 * (workflow id `wa-chat-<jid>`, see src/temporal/client.ts / src/whatsapp.ts).
 * Debounces bursts of inbound messages into a single processChatBurst
 * activity call, serialized — only one burst is ever in flight per chat.
 */
export async function waChatWorkflow(jid: string, carry?: WaChatCarry): Promise<void> {
  let queue: InboundSignal[] = carry ? [...carry.queue] : [];
  let burstCount = carry?.burstCount ?? 0;
  let lastRunAt: number | null = null;

  setHandler(inbound, (sig) => {
    queue.push(sig);
  });
  setHandler(pendingQuery, () => ({
    pending: queue.map((s) => s.msgId),
    lastRunAt,
  }));

  for (;;) {
    if (queue.length === 0) {
      const gotSignal = await condition(() => queue.length > 0, IDLE_TIMEOUT_MS);
      if (!gotSignal) {
        // Idle 24h with nothing pending — complete. A future message restarts
        // this workflow id fresh via signalWithStart.
        return;
      }
    }

    // Debounce: each new signal that lands while we wait resets the quiet
    // window. Settles once QUIET_WINDOW_MS passes with no new arrival.
    for (;;) {
      const sizeBefore = queue.length;
      const quiet = await condition(() => queue.length !== sizeBefore, QUIET_WINDOW_MS);
      if (!quiet) break;
    }

    const burst = queue;
    queue = [];
    const msgIds = burst.map((s) => s.msgId);

    await acts.processChatBurst(jid, msgIds);
    lastRunAt = Date.now();
    burstCount++;

    // Any signals that arrived *during* the activity call are already sitting
    // in `queue` (the signal handler above keeps appending) — continueAsNew
    // carries them forward so they are never dropped.
    if (burstCount >= MAX_BURSTS_BEFORE_CONTINUE || workflowInfo().continueAsNewSuggested) {
      await continueAsNew<typeof waChatWorkflow>(jid, { burstCount: 0, queue });
      return;
    }
  }
}
