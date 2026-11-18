import "./test-db-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { isTranscriptionEnabled, transcribe } from "./stt";

// Owner turned transcription off on 2026-09-17 ("not good, stop it"). Default is OFF;
// only TRANSCRIBE_ENABLED=1 turns WhatsApp voice notes and Telegram audio back on.

test("transcription is off unless TRANSCRIBE_ENABLED=1", () => {
  const prev = process.env.TRANSCRIBE_ENABLED;
  delete process.env.TRANSCRIBE_ENABLED;
  assert.equal(isTranscriptionEnabled(), false);
  process.env.TRANSCRIBE_ENABLED = "0";
  assert.equal(isTranscriptionEnabled(), false);
  process.env.TRANSCRIBE_ENABLED = "true";
  assert.equal(isTranscriptionEnabled(), false, "only the exact value 1 enables it");
  process.env.TRANSCRIBE_ENABLED = "1";
  assert.equal(isTranscriptionEnabled(), true);
  if (prev === undefined) delete process.env.TRANSCRIBE_ENABLED; else process.env.TRANSCRIBE_ENABLED = prev;
});

test("transcribe() does no network work and returns null while off", async () => {
  const prev = process.env.TRANSCRIBE_ENABLED;
  delete process.env.TRANSCRIBE_ENABLED;
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => { called = true; throw new Error("must not be called"); }) as any;
  try {
    assert.equal(await transcribe(Buffer.from("x"), "ogg", "ar"), null);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = realFetch;
    if (prev !== undefined) process.env.TRANSCRIBE_ENABLED = prev;
  }
});
