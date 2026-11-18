import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recordTelegramError,
  recordTelegramOk,
  telegramHealth,
  __resetChannelHealth,
} from "./channel-health";

const BLOCKED = { description: "Forbidden: bot was blocked by the user", error_code: 403 };

test("records ok and error events with timestamps", () => {
  __resetChannelHealth();
  recordTelegramOk("sendMessage", 1000);
  recordTelegramError("sendMessage", new Error("upstream down"), 2000);

  const h = telegramHealth(3000);
  assert.equal(h.lastOkAt, 1000);
  assert.equal(h.lastErrorAt, 2000);
  assert.equal(h.lastError, "upstream down");
  assert.equal(h.lastErrorMethod, "sendMessage");
  assert.equal(h.errorsLastHour, 1);
});

test("extracts the message out of a grammy-like blocked error", () => {
  __resetChannelHealth();
  recordTelegramError("sendMessage", BLOCKED, 1000);
  const h = telegramHealth(2000);
  assert.equal(h.lastError, "Forbidden: bot was blocked by the user");
  assert.equal(h.lastErrorMethod, "sendMessage");
});

test("blocked is true after a failed sendMessage and false after a later success", () => {
  __resetChannelHealth();
  recordTelegramError("sendMessage", BLOCKED, 1000);
  assert.equal(telegramHealth(1500).blocked, true);

  recordTelegramOk("sendMessage", 2000);
  assert.equal(telegramHealth(2500).blocked, false);
});

test("non-send methods never trip the blocked flag", () => {
  __resetChannelHealth();
  recordTelegramError("getMe", BLOCKED, 1000);
  recordTelegramError("getUpdates", BLOCKED, 1100);
  assert.equal(telegramHealth(2000).blocked, false);

  // A send blocked, then a non-send failure afterwards — still blocked, because
  // only send* matters and no send* succeeded.
  recordTelegramError("sendMessage", BLOCKED, 3000);
  recordTelegramError("getUpdates", BLOCKED, 3100);
  const h = telegramHealth(4000);
  assert.equal(h.blocked, true);
  assert.equal(h.errorsLastHour, 4);
});

test("errorsLastHour only counts the last 3600s", () => {
  __resetChannelHealth();
  // Timestamps are epoch milliseconds, like Date.now() in production.
  const now = 10_000_000;
  recordTelegramError("sendMessage", new Error("now"), now);
  recordTelegramError("sendMessage", new Error("old"), now - 4_000_000); // 4000s ago
  recordTelegramError("sendMessage", new Error("boundary"), now - 3_600_000);
  // cutoff = now - 3600s; a record exactly at the cutoff counts.
  const h = telegramHealth(now);
  assert.equal(h.errorsLastHour, 2);
});

test("errorsLastHour is capped at the last 200 stored timestamps", () => {
  __resetChannelHealth();
  for (let i = 0; i < 205; i++) {
    recordTelegramError("sendMessage", new Error(`e${i}`), 1000 + i);
  }
  const h = telegramHealth(1000 + 205);
  // 205 recorded inside the window, but we keep at most the 200 most recent.
  assert.equal(h.errorsLastHour, 200);
});

test("the stored error message is truncated to 200 characters", () => {
  __resetChannelHealth();
  const long = "x".repeat(500);
  recordTelegramError("sendMessage", new Error(long), 1000);
  const h = telegramHealth(2000);
  assert.equal(h.lastError!.length, 200);
  assert.equal(h.lastError, long.slice(0, 200));
});