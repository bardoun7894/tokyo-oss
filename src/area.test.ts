import "./test-db-env";
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { decideArea, areaFromCategory } from './area';

const realFetch = globalThis.fetch;
let sent: any = null;

function mockJev(choice: string, confidence: number, status = 200) {
  globalThis.fetch = (async (url: any, init: any) => {
    sent = { url: String(url), body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ answers: { q: { type: 'choice', choice, confidence } } }), { status });
  }) as typeof fetch;
}

beforeEach(() => { process.env.OPENROUTER_API_KEY = 'sk-or-test'; sent = null; });
afterEach(() => { globalThis.fetch = realFetch; delete process.env.OPENROUTER_API_KEY; });

test('asks Jev one choice over work / personal / learn', async () => {
  mockJev('learn', 0.9);
  assert.equal(await decideArea({ kind: 'task', text: 'finish the Rust ownership chapter', category: 'personal' }), 'learn');
  assert.match(sent.url, /\/api\/alpha\/decisions$/);
  assert.deepEqual(Object.keys(sent.body.questions.q.criteria).sort(), ['learn', 'personal', 'work']);
  assert.equal(sent.body.state.item_kind, 'task');
  assert.equal(sent.body.state.category, undefined, 'the loose upstream category is not shown to Jev');
});

test('a pasted " — personal — medium" title tag is not sent to Jev', async () => {
  mockJev('work', 0.9);
  await decideArea({ kind: 'task', text: 'Fix coach profile not opening — personal — medium', category: 'personal' });
  assert.equal(sent.body.state.text, 'Fix coach profile not opening');
});

test('a task on a project is work without asking Jev', async () => {
  mockJev('personal', 0.99);
  assert.equal(await decideArea({ kind: 'task', text: 'rename the app', category: 'personal', projectId: 7 }), 'work');
  assert.equal(sent, null);
});

test('unsure Jev falls back to the category', async () => {
  mockJev('learn', 0.4);
  assert.equal(await decideArea({ kind: 'task', text: 'fix login bug', category: 'client' }), 'work');
});

test('Jev error falls back to the category', async () => {
  mockJev('work', 0.99, 500);
  assert.equal(await decideArea({ kind: 'journal', text: 'good day with family', category: 'family' }), 'personal');
});

test('no key: category decides without calling Jev', async () => {
  delete process.env.OPENROUTER_API_KEY;
  mockJev('work', 0.99);
  assert.equal(await decideArea({ kind: 'task', text: 'x', category: 'shop' }), 'work');
  assert.equal(sent, null);
});

test('unknown category and no confident answer stays unsorted', async () => {
  mockJev('work', 0.3);
  assert.equal(await decideArea({ kind: 'journal', text: 'hmm', category: 'general' }), null);
});

test('areaFromCategory is case-insensitive and null-safe', () => {
  assert.equal(areaFromCategory(' Client '), 'work');
  assert.equal(areaFromCategory('Learning'), 'learn');
  assert.equal(areaFromCategory(null), null);
  assert.equal(areaFromCategory('general'), null);
});
