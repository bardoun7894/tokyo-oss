import "./test-db-env";
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { askJev } from './jev';

const realFetch = globalThis.fetch;
const answers = { ok: { type: 'noul', noul: 0.9 } };

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
});

function mockRoutes(statusFor: (url: string) => number) {
  const calls: { url: string; model: string; auth: string }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), model: JSON.parse(init.body).model, auth: init.headers.Authorization });
    const status = statusFor(String(url));
    return new Response(JSON.stringify(status === 200 ? { answers } : { detail: { error_type: 'billing_error' } }), { status });
  }) as typeof fetch;
  return calls;
}

test('prefers OpenRouter when both keys are set', async () => {
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  process.env.TYPESAFE_API_KEY = 'ts-test';
  const calls = mockRoutes(() => 200);
  assert.deepEqual(await askJev({}, { ok: { type: 'noul', instructions: 'x' } }), answers);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /openrouter\.ai\/api\/alpha\/decisions$/);
  assert.equal(calls[0].model, 'typesafe/jev-1.13');
  assert.equal(calls[0].auth, 'Bearer sk-or-test');
});

test('falls through to TypeSafe direct when OpenRouter fails', async () => {
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  process.env.TYPESAFE_API_KEY = 'ts-test';
  const calls = mockRoutes((url) => (url.includes('openrouter') ? 402 : 200));
  assert.deepEqual(await askJev({}, { ok: { type: 'noul', instructions: 'x' } }), answers);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /api\.typesafe\.ai\/v1\/systemone$/);
  assert.equal(calls[1].model, 'jev-latest');
});

test('throws the last error when every route fails', async () => {
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  process.env.TYPESAFE_API_KEY = 'ts-test';
  mockRoutes(() => 402);
  await assert.rejects(askJev({}, { ok: { type: 'noul', instructions: 'x' } }), /jev_402/);
});

test('uses TypeSafe alone when only its key is set', async () => {
  process.env.TYPESAFE_API_KEY = 'ts-test';
  const calls = mockRoutes(() => 200);
  await askJev({}, { ok: { type: 'noul', instructions: 'x' } });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.typesafe\.ai/);
});
