import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatus, isLoopback } from "./internal-status";

function baseDeps(overrides: Partial<Parameters<typeof buildStatus>[0]> = {}) {
  return {
    whatsapp: () => ({ status: "connected" }),
    lastIncomingWhatsAppAt: () => 1_000_000_000, // unix ms
    missionCounts: () => ({ proposed: 5, running: 3, held: 2, failed: 1 }),
    transcriptionEnabled: () => true,
    telegram: () => ({
      lastOkAt: 123,
      lastErrorAt: null,
      lastError: null,
      lastErrorMethod: null,
      blocked: false,
      errorsLastHour: 0,
    }),
    now: 1_000_000_000_000,
    uptimeS: 42,
    ...overrides,
  };
}

test("isLoopback accepts only loopback addresses", () => {
  for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopback(a), true, a);
  }
  for (const a of ["100.64.0.1", "203.0.113.10", undefined, "127.0.0.1.evil"]) {
    assert.equal(isLoopback(a), false, String(a));
  }
});

test("buildStatus sets the connected flag from the whatsapp status", () => {
  const out = buildStatus(baseDeps());
  assert.equal(out.whatsapp.status, "connected");
  assert.equal(out.whatsapp.connected, true);

  const out2 = buildStatus(baseDeps({ whatsapp: () => ({ status: "disconnected" }) }));
  assert.equal(out2.whatsapp.connected, false);
});

test("buildStatus computes minutesSinceIncoming from lastIncomingAt", () => {
  const now = 1_000_000_000_000;
  const out = buildStatus(
    baseDeps({ now, lastIncomingWhatsAppAt: () => now - 120_000 }), // 2 minutes ago
  );
  assert.equal(out.whatsapp.lastIncomingAt, now - 120_000);
  assert.equal(out.whatsapp.minutesSinceIncoming, 2);
});

test("buildStatus maps missions with missing states to zero", () => {
  const out = buildStatus(baseDeps({ missionCounts: () => ({ proposed: 4, running: 6 }) }));
  assert.deepEqual(out.missions, { proposed: 4, running: 6, held: 0, failed: 0 });
});

test("buildStatus nulls/zeros a throwing dep instead of throwing", () => {
  const out = buildStatus(
    baseDeps({
      whatsapp: () => {
        throw new Error("socket gone");
      },
      missionCounts: () => {
        throw new Error("no missions table");
      },
      telegram: () => {
        throw new Error("boom");
      },
      lastIncomingWhatsAppAt: () => null,
    }),
  );
  assert.equal(out.whatsapp.status, "disconnected");
  assert.equal(out.whatsapp.connected, false);
  assert.deepEqual(out.missions, { proposed: 0, running: 0, held: 0, failed: 0 });
  assert.deepEqual(out.telegram, {
    lastOkAt: null,
    lastErrorAt: null,
    lastError: null,
    lastErrorMethod: null,
    blocked: false,
    errorsLastHour: 0,
  });
});

test("buildStatus output JSON never leaks private keys", () => {
  const out = buildStatus(baseDeps());
  const json = JSON.stringify(out);
  for (const key of ["user", "qr", "qrDataUrl", "pairingCode", "jid", "token"]) {
    assert.ok(!json.includes(`"${key}"`), `output leaked key "${key}"`);
  }
});