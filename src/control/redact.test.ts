import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "./redact";

test("KEY=value for secret-looking names", () => {
  assert.equal(redact("API_TOKEN=abc123 ok"), "API_TOKEN=[redacted] ok");
  assert.equal(redact("export DB_PASSWORD=hunter2"), "export DB_PASSWORD=[redacted]");
  assert.equal(redact("MY_SECRET: s3cr3t"), "MY_SECRET: [redacted]");
  assert.equal(redact("ANTHROPIC_AUTH_TOKEN=sk-ant-xyz"), "ANTHROPIC_AUTH_TOKEN=[redacted]");
  assert.equal(redact("OPENAI_API_KEY='abc def'"), "OPENAI_API_KEY=[redacted]");
});

test("Bearer, sk- keys, PEM blocks", () => {
  assert.equal(redact("Authorization: Bearer abcdef.123-xyz"), "Authorization: Bearer [redacted]");
  assert.equal(redact("key sk-abcdefghijklmnopqrstuvwx1234 end"), "key [redacted] end");
  const pem = "a\n-----BEGIN PRIVATE KEY-----\nMIIabc\ndef==\n-----END PRIVATE KEY-----\nb";
  assert.equal(redact(pem), "a\n[redacted pem]\nb");
});

test("agent home paths and long blobs", () => {
  assert.equal(redact("cat /home/tokyo-agent/.env"), "cat [path]");
  assert.equal(redact("cat /home/tokyo-agent/projects/x/y.ts"), "cat [path]");
  assert.equal(redact("hash " + "a".repeat(40) + " done"), "hash [redacted] done");
  assert.equal(redact("b64 " + "QUJD".repeat(12) + "== done"), "b64 [redacted] done");
});

test("normal prose and code are untouched", () => {
  for (const s of [
    "Fixed the login flow in src/auth.ts and added 3 tests.",
    "const token = getToken();",
    "git commit abc1234 -m 'fix'",
    "KEY_COUNT=3",
    "the password field is required",
    "https://example.com/a/b?c=1",
  ]) assert.equal(redact(s), s);
});

test("idempotent", () => {
  const s = "A_TOKEN=x Bearer abc sk-abcdefghijklmnopqrstuvwx /home/tokyo-agent/a " + "f".repeat(50);
  assert.equal(redact(redact(s)), redact(s));
});
