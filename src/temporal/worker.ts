import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities';
import { TEMPORAL_NAMESPACE, TEMPORAL_TASK_QUEUE, isTemporalEnabled } from './client';

function temporalAddress(): string {
  return process.env.TEMPORAL_ADDRESS || '100.64.0.1:7233';
}

let starting = false;
let started = false;

/**
 * Starts the embedded Temporal worker for the wa-chat workflow, once, only
 * when WA_TEMPORAL=1. Connection/start failure is logged and swallowed —
 * never throws, never crashes the bot. Callers on the WA_TEMPORAL path
 * (src/whatsapp.ts) already fall back to the direct dispatch when
 * signalWithStart itself fails, so a worker that never came up just means
 * every burst activity call times out and falls back the same way; still no
 * message is lost, it's just slower until the worker/server issue is fixed.
 */
export async function startTemporalWorkerIfEnabled(): Promise<void> {
  if (!isTemporalEnabled() || started || starting) return;
  starting = true;
  try {
    const connection = await NativeConnection.connect({ address: temporalAddress() });
    const worker = await Worker.create({
      connection,
      namespace: TEMPORAL_NAMESPACE,
      taskQueue: TEMPORAL_TASK_QUEUE,
      workflowsPath: require.resolve('./workflows'),
      activities,
    });
    started = true;
    worker.run().catch((err) => {
      console.error('⏱️  Temporal worker crashed:', err);
      started = false;
    });
    console.log(`⏱️  Temporal worker started (namespace=${TEMPORAL_NAMESPACE} taskQueue=${TEMPORAL_TASK_QUEUE})`);
  } catch (err) {
    console.error('⏱️  Temporal worker failed to start — WA_TEMPORAL falls back to direct dispatch:', err);
  } finally {
    starting = false;
  }
}
