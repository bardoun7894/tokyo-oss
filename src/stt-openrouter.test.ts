import "./test-db-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { transcribe, hasTranscriptionBackend } from "./stt";

// OpenRouter is the primary STT path as of 2026-09-18 — the only backend that keeps
// Arabic dialects intelligible. These tests pin the request shape and the failure modes;
// they never touch the network.

type FetchArgs = { url: string; init: any };

function withFetch(
  handler: (args: FetchArgs) => any,
  env: Record<string, string | undefined>,
  run: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    const realFetch = globalThis.fetch;
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      prev[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    globalThis.fetch = (async (url: any, init: any) =>
      handler({ url: String(url), init })) as any;
    try {
      await run();
    } finally {
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
}

const okResponse = (text: string) => ({
  ok: true,
  status: 200,
  headers: new Headers({ "content-type": "application/json" }),
  json: async () => ({ choices: [{ message: { content: text } }] }),
});

const KEYED = {
  TRANSCRIBE_ENABLED: "1",
  OPENROUTER_API_KEY: "test-key",
  TRANSCRIBE_TOKEN: undefined,
};

test(
  "transcribe() never calls OpenRouter, even with OPENROUTER_API_KEY set",
  withFetch(
    ({ url, init }) => {
      assert.notEqual(url, "https://openrouter.ai/api/v1/chat/completions");
      return okResponse("should not be reached");
    },
    { ...KEYED, AGY_STT_TOKEN: undefined },
    async () => {
      const r = await transcribe(Buffer.from("AUDIO"), "ogg");
      assert.equal(r, null);
    },
  ),
);

test(
  "ogg is sent as ogg, never transcoded — mp3 conversion measurably degraded accuracy",
  withFetch(
    ({ init }) => {
      const body = JSON.parse(init.body);
      assert.equal(body.messages[0].content[1].input_audio.format, "ogg");
      return okResponse("ok");
    },
    KEYED,
    async () => {
      await transcribe(Buffer.from("AUDIO"), "ogg");
    },
  ),
);

test(
  "no key and no laptop token means no network call at all",
  withFetch(
    () => {
      throw new Error("fetch must not be called");
    },
    { TRANSCRIBE_ENABLED: "1", OPENROUTER_API_KEY: undefined, TRANSCRIBE_TOKEN: undefined },
    async () => {
      assert.equal(await transcribe(Buffer.from("AUDIO"), "ogg"), null);
    },
  ),
);

test(
  "an unsupported extension is rejected before any request",
  withFetch(
    () => {
      throw new Error("fetch must not be called");
    },
    KEYED,
    async () => {
      assert.equal(await transcribe(Buffer.from("AUDIO"), "amr"), null);
    },
  ),
);

test(
  "an HTTP error returns null rather than throwing into the message handler",
  withFetch(
    () => ({ ok: false, status: 429, statusText: "Too Many Requests", text: async () => "rate limited" }),
    KEYED,
    async () => {
      assert.equal(await transcribe(Buffer.from("AUDIO"), "ogg"), null);
    },
  ),
);

test(
  "a 200 carrying an error body is treated as failure, not as a transcript",
  withFetch(
    () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ error: { message: "upstream model unavailable" } }),
    }),
    KEYED,
    async () => {
      assert.equal(await transcribe(Buffer.from("AUDIO"), "ogg"), null);
    },
  ),
);

test(
  "an empty transcript is null, not an empty-string row",
  withFetch(() => okResponse("   "), KEYED, async () => {
    assert.equal(await transcribe(Buffer.from("AUDIO"), "ogg"), null);
  }),
);

test(
  "OPENROUTER_STT_MODEL overrides the default model",
  withFetch(
    ({ init }) => {
      assert.equal(JSON.parse(init.body).model, "openai/gpt-audio");
      return okResponse("ok");
    },
    { ...KEYED, OPENROUTER_STT_MODEL: "openai/gpt-audio" },
    async () => {
      await transcribe(Buffer.from("AUDIO"), "ogg");
    },
  ),
);

test("hasTranscriptionBackend tracks the providers stt.ts actually implements", () => {
  const prevO = process.env.OPENROUTER_API_KEY;
  const prevT = process.env.TRANSCRIBE_TOKEN;
  const prevA = process.env.AGY_STT_TOKEN;
  try {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.TRANSCRIBE_TOKEN;
    delete process.env.AGY_STT_TOKEN;
    assert.equal(hasTranscriptionBackend(), false);
    process.env.OPENROUTER_API_KEY = "k";
    assert.equal(hasTranscriptionBackend(), false, "OpenRouter alone is not a backend");
    delete process.env.OPENROUTER_API_KEY;
    process.env.TRANSCRIBE_TOKEN = "t";
    assert.equal(hasTranscriptionBackend(), true);
    delete process.env.TRANSCRIBE_TOKEN;
    process.env.AGY_STT_TOKEN = "a";
    assert.equal(hasTranscriptionBackend(), true);
  } finally {
    if (prevA === undefined) delete process.env.AGY_STT_TOKEN; else process.env.AGY_STT_TOKEN = prevA;
    if (prevO === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prevO;
    if (prevT === undefined) delete process.env.TRANSCRIBE_TOKEN; else process.env.TRANSCRIBE_TOKEN = prevT;
  }
});
