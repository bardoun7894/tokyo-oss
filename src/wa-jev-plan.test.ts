import "./test-db-env";
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { planWAActions, type WAPlanInput } from './wa-jev-plan';

const realFetch = globalThis.fetch;
let sent: any = null;

function mockJev(answers: Record<string, any>, status = 200) {
  globalThis.fetch = (async (_url: any, init: any) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ model: 'typesafe/jev-1.13', answers }), { status });
  }) as typeof fetch;
}

const input: WAPlanInput = { sender: 'Client A', category: 'client', chatType: 'direct message', message: 'the login page shows error 500 since this morning', history: '' };
const noul = (p: number) => ({ type: 'noul', noul: p });
const choice = (c: string, confidence = 0.9) => ({ type: 'choice', choice: c, confidence });

beforeEach(() => { process.env.OPENROUTER_API_KEY = 'sk-or-test'; sent = null; });
afterEach(() => { globalThis.fetch = realFetch; delete process.env.OPENROUTER_API_KEY; });

test('asks all four decisions in one request', async () => {
  mockJev({ forward: noul(0.05), needs_task: noul(0.05), task_category: choice('client'), priority: choice('low') });
  await planWAActions(input);
  assert.deepEqual(Object.keys(sent.questions).sort(), ['forward', 'needs_task', 'priority', 'task_category']);
});

test('clearly nothing to do: empty plan, no LLM needed', async () => {
  mockJev({ forward: noul(0.05), needs_task: noul(0.1), task_category: choice('client'), priority: choice('low') });
  assert.deepEqual(await planWAActions(input), { forward: false, task: null });
});

test('confident forward + task: returns category and priority, title left to the caller', async () => {
  mockJev({ forward: noul(0.92), needs_task: noul(0.95), task_category: choice('client', 0.9), priority: choice('high', 0.85) });
  assert.deepEqual(await planWAActions(input), { forward: true, task: { category: 'client', priority: 'high' } });
});

test('an unsure yes/no returns null so the full LLM path decides', async () => {
  mockJev({ forward: noul(0.5), needs_task: noul(0.95), task_category: choice('client'), priority: choice('high') });
  assert.equal(await planWAActions(input), null);
});

test('a task with an unsure category or priority returns null', async () => {
  mockJev({ forward: noul(0.05), needs_task: noul(0.95), task_category: choice('client', 0.5), priority: choice('high') });
  assert.equal(await planWAActions(input), null);
});

test('no key or HTTP error returns null and never throws', async () => {
  delete process.env.OPENROUTER_API_KEY;
  assert.equal(await planWAActions(input), null);
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  mockJev({}, 500);
  assert.equal(await planWAActions(input), null);
});
