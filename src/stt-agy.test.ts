import "./test-db-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { transcribe, hasTranscriptionBackend } from "./stt";

// agy-stt (Gemini 3.8 Flash through the sandboxed bridge on this host) is the primary STT
// path as of 2026-10-17; OpenRouter is out of credit. Network is never touched here.

type FetchArgs = { url: string; init: any };

function withFetch(
  handler: (args: FetchArgs) => any,
  env: Record<string, string | undefined>,
  run: (calls: string[]) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const realFetch = globalThis.fetch;
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      prev[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const calls: string[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push(String(url));
      return handler({ url: String(url), init });
    }) as any;
    try {
      await run(calls);
    } finally {
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
}

const json = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  headers: new Headers({ "content-type": "application/json" }),
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const BRIDGE = "http://172.17.0.1:8318/stt";
const ENV = {
  TRANSCRIBE_ENABLED: "1",
  AGY_STT_TOKEN: "agy-token",
  AGY_STT_URL: undefined,
  OPENROUTER_API_KEY: "or-key",
  TRANSCRIBE_TOKEN: undefined,
};

test(
  "sends the raw audio to the agy bridge with the token and a long budget",
  withFetch(
    ({ url, init }) => {
      assert.equal(url, BRIDGE);
      assert.equal(init.method, "POST");
      assert.equal(init.headers.Authorization, "Bearer agy-token");
      assert.equal(init.headers["X-Budget"], "120");
      assert.equal(init.headers["X-Language"], undefined);
      assert.deepEqual(Buffer.from(init.body), Buffer.from("AUDIO"));
      return json(200, { text: " بغيت نعرف الثمن " });
    },
    ENV,
    async (calls) => {
      const r = await transcribe(Buffer.from("AUDIO"), "ogg");
      assert.deepEqual(r, { text: "بغيت نعرف الثمن", durationSeconds: null });
      assert.deepEqual(calls, [BRIDGE]);
    },
  ),
);

test(
  "the WhatsApp 'ar' hint reaches the bridge as Moroccan Darija",
  withFetch(
    ({ init }) => {
      assert.equal(init.headers["X-Language"], "Moroccan Darija (Arabic)");
      return json(200, { text: "واخا" });
    },
    ENV,
    async () => {
      const r = await transcribe(Buffer.from("AUDIO"), "ogg", "ar");
      assert.equal(r?.text, "واخا");
    },
  ),
);

test(
  "a failing bridge falls through to the laptop, never OpenRouter",
  withFetch(
    ({ url }) => url === BRIDGE
      ? json(502, { error: "transcription failed" })
      : json(200, { text: "من اللابتوب" }),
    { ...ENV, TRANSCRIBE_TOKEN: "laptop-token" },
    async (calls) => {
      await transcribe(Buffer.from("AUDIO"), "ogg");
      assert.equal(calls[0], BRIDGE);
      assert.ok(calls.length >= 2, "laptop is tried after the bridge fails");
      assert.ok(!calls.some((u) => u.includes("openrouter.ai")), "OpenRouter is never called");
    },
  ),
);

test(
  "no speech from the bridge is not a transcript",
  withFetch(
    ({ url }) => url === BRIDGE ? json(200, { text: null }) : json(402, { error: { message: "no credit" } }),
    { ...ENV },
    async () => {
      assert.equal(await transcribe(Buffer.from("AUDIO"), "ogg"), null);
    },
  ),
);

test(
  "without AGY_STT_TOKEN the bridge is never called",
  withFetch(
    () => json(200, { choices: [{ message: { content: "ok" } }] }),
    { ...ENV, AGY_STT_TOKEN: undefined },
    async (calls) => {
      await transcribe(Buffer.from("AUDIO"), "ogg");
      assert.ok(!calls.includes(BRIDGE));
    },
  ),
);

test(
  "the bridge token alone counts as a transcription backend",
  withFetch(
    () => json(500, {}),
    { AGY_STT_TOKEN: "agy-token", OPENROUTER_API_KEY: undefined, TRANSCRIBE_TOKEN: undefined },
    async () => {
      assert.equal(hasTranscriptionBackend(), true);
    },
  ),
);
