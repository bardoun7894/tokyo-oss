import type { Client } from '@temporalio/client';
import type { SignalRequest } from '../action-offer-flow';
import { getTemporalClientFor } from './client';

export const SIGNAL_TIMEOUT_MS = 10_000;

/** Sends one signal to a running workflow. `getClient` and the deadline are injectable for tests.
 *  A stalled Temporal rejects after `timeoutMs` so the caller's retry and fallback still run. */
export async function signalWorkflow(
  s: SignalRequest,
  getClient: (namespace: string) => Promise<Pick<Client, 'workflow'>> = getTemporalClientFor,
  timeoutMs: number = SIGNAL_TIMEOUT_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`signal ${s.signalName} to ${s.workflowId} timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    await Promise.race([
      (async () => {
        const client = await getClient(s.namespace);
        await client.workflow.getHandle(s.workflowId).signal(s.signalName);
      })(),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
