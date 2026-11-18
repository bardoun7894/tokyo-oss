import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { waChatWorkflow, inbound } from './workflows';

const TASK_QUEUE = 'test-wa-chat';

async function withTestEnv(
  fn: (env: TestWorkflowEnvironment, worker: Worker) => Promise<void>,
  activities: Record<string, (...args: any[]) => any>,
) {
  const testEnv = await TestWorkflowEnvironment.createTimeSkipping();
  try {
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: require.resolve('./workflows'),
      activities,
    });
    await worker.runUntil(async () => {
      await fn(testEnv, worker);
    });
  } finally {
    await testEnv.teardown();
  }
}

test('debounces 3 messages within 15s into one activity call with all 3 ids', async () => {
  const calls: number[][] = [];
  await withTestEnv(
    async (testEnv) => {
      const wfId = `wa-chat-${randomUUID()}`;
      const handle = await testEnv.client.workflow.signalWithStart(waChatWorkflow, {
        workflowId: wfId,
        taskQueue: TASK_QUEUE,
        args: ['jid-burst'],
        signal: inbound,
        signalArgs: [{ msgId: 1, ts: 1 }],
      });
      await testEnv.sleep('5s');
      await handle.signal(inbound, { msgId: 2, ts: 2 });
      await testEnv.sleep('5s');
      await handle.signal(inbound, { msgId: 3, ts: 3 });

      // Settle the 15s quiet window, then let it idle out (24h) to complete cleanly.
      await testEnv.sleep('16s');
      await testEnv.sleep('25h');
      await handle.result();
    },
    {
      processChatBurst: async (jid: string, msgIds: number[]) => {
        calls.push(msgIds);
        return { processed: msgIds.length, latestId: msgIds[msgIds.length - 1] ?? null };
      },
    },
  );
  assert.deepEqual(calls, [[1, 2, 3]]);
});

test('messages 20s apart produce two separate activity calls in order', async () => {
  const calls: number[][] = [];
  await withTestEnv(
    async (testEnv) => {
      const wfId = `wa-chat-${randomUUID()}`;
      const handle = await testEnv.client.workflow.signalWithStart(waChatWorkflow, {
        workflowId: wfId,
        taskQueue: TASK_QUEUE,
        args: ['jid-gap'],
        signal: inbound,
        signalArgs: [{ msgId: 10, ts: 1 }],
      });
      // Let the quiet window settle burst 1.
      await testEnv.sleep('16s');
      // Second message arrives well after the first burst was processed.
      await handle.signal(inbound, { msgId: 11, ts: 2 });
      await testEnv.sleep('16s');
      await testEnv.sleep('25h');
      await handle.result();
    },
    {
      processChatBurst: async (jid: string, msgIds: number[]) => {
        calls.push(msgIds);
        return { processed: msgIds.length, latestId: msgIds[msgIds.length - 1] ?? null };
      },
    },
  );
  assert.deepEqual(calls, [[10], [11]]);
});

test('activity failing twice then succeeding is retried and completes', async () => {
  let attempts = 0;
  await withTestEnv(
    async (testEnv) => {
      const wfId = `wa-chat-${randomUUID()}`;
      const handle = await testEnv.client.workflow.signalWithStart(waChatWorkflow, {
        workflowId: wfId,
        taskQueue: TASK_QUEUE,
        args: ['jid-retry'],
        signal: inbound,
        signalArgs: [{ msgId: 20, ts: 1 }],
      });
      await testEnv.sleep('16s');
      // Let the retry backoff (10s, x2, ...) play out via time-skipping.
      await testEnv.sleep('5m');
      await testEnv.sleep('25h');
      await handle.result();
    },
    {
      processChatBurst: async (_jid: string, msgIds: number[]) => {
        attempts++;
        if (attempts < 3) throw new Error('transient failure');
        return { processed: msgIds.length, latestId: msgIds[msgIds.length - 1] ?? null };
      },
    },
  );
  assert.equal(attempts, 3);
});

test('idle 24h with no messages completes the workflow', async () => {
  await withTestEnv(
    async (testEnv) => {
      const wfId = `wa-chat-${randomUUID()}`;
      const handle = await testEnv.client.workflow.start(waChatWorkflow, {
        workflowId: wfId,
        taskQueue: TASK_QUEUE,
        args: ['jid-idle'],
      });
      await testEnv.sleep('25h');
      // Must resolve (workflow returned) rather than hang or throw.
      await handle.result();
    },
    {
      processChatBurst: async () => {
        throw new Error('should never be called — no messages were sent');
      },
    },
  );
});

test('continueAsNew preserves pending ids queued during the last burst', async () => {
  const calls: number[][] = [];
  await withTestEnv(
    async (testEnv) => {
      const wfId = `wa-chat-${randomUUID()}`;
      // Start directly with carry state as if this were the continuation of a
      // prior run that had just reached the burst budget while message 99 was
      // still sitting in queue, unprocessed, at the moment continueAsNew fired.
      const handle = await testEnv.client.workflow.start(waChatWorkflow, {
        workflowId: wfId,
        taskQueue: TASK_QUEUE,
        args: ['jid-continue', { burstCount: 199, queue: [{ msgId: 99, ts: 1 }] }],
      });

      // The carried id is already queued — no extra signal needed. It should
      // be processed after one debounce window, and (burstCount becomes 200,
      // >= the 200 budget) trigger another continueAsNew immediately after.
      await testEnv.sleep('16s');

      // The handle transparently follows continue-as-new under the same
      // workflow id. Send a fresh message to the (new) run to prove it came
      // back up with a clean queue rather than stuck or duplicating id 99.
      await handle.signal(inbound, { msgId: 100, ts: 2 });
      await testEnv.sleep('16s');
      await testEnv.sleep('25h');
      await handle.result();
    },
    {
      processChatBurst: async (_jid: string, msgIds: number[]) => {
        calls.push(msgIds);
        return { processed: msgIds.length, latestId: msgIds[msgIds.length - 1] ?? null };
      },
    },
  );
  assert.deepEqual(calls, [[99], [100]]);
});
