import { test } from "node:test";
import assert from "node:assert/strict";
import type { AllowEntry } from "../ops-restart";
import { buildServices, cooldownLeft } from "./inventory";
import type { ServiceState } from "./state";

const e = (id: string, kind: AllowEntry["kind"], name: string, cooldownSec = 300): AllowEntry => ({ id, kind, name, label: `L ${name}`, cooldownSec });
const ENTRIES = [e("a", "docker", "web"), e("b", "pm2", "shop"), e("c", "systemd", "x.service"), e("d", "docker", "db")];
const STATES = new Map<string, ServiceState>([["a", "active"], ["b", "failed"], ["c", "inactive"]]);
const NOW = 1_000_000;
const opts = (over: Partial<Parameters<typeof buildServices>[2]> = {}) => ({ now: NOW, cooldownLeftS: () => 0, canRestart: false, ...over });

test("every entry is listed in allowlist order with id, kind, label and state; the name never leaves", () => {
  const out = buildServices(ENTRIES, STATES, opts());
  assert.deepEqual(out, [
    { id: "a", kind: "docker", label: "L web", state: "active", cooldownLeftS: 0 },
    { id: "b", kind: "pm2", label: "L shop", state: "failed", cooldownLeftS: 0 },
    { id: "c", kind: "systemd", label: "L x.service", state: "inactive", cooldownLeftS: 0 },
    { id: "d", kind: "docker", label: "L db", state: "unknown", cooldownLeftS: 0 },
  ]);
  assert.ok(out.every((s) => !("name" in s)), "no name field");
});

test("actions:[restart] only when the device may restart", () => {
  assert.ok(buildServices(ENTRIES, STATES, opts()).every((s) => !("actions" in s)));
  assert.ok(buildServices(ENTRIES, STATES, opts({ canRestart: true })).every((s) => JSON.stringify(s.actions) === '["restart"]'));
});

test("cooldownLeftS comes from the injected lookup per entry", () => {
  const left = (en: AllowEntry) => ({ a: 61, b: 0, c: 5 }[en.id as "a"] ?? 0);
  const out = buildServices(ENTRIES, STATES, opts({ cooldownLeftS: left }));
  assert.deepEqual(out.map((s) => s.cooldownLeftS), [61, 0, 5, 0]);
});

test("cooldownLeft: whole seconds rounded up, 0 when never restarted or past the cooldown", () => {
  assert.equal(cooldownLeft(null, 300, NOW), 0);
  assert.equal(cooldownLeft(NOW - 100_500, 300, NOW), 200);
  assert.equal(cooldownLeft(NOW - 299_999, 300, NOW), 1);
  assert.equal(cooldownLeft(NOW - 300_000, 300, NOW), 0);
  assert.equal(cooldownLeft(NOW - 900_000, 300, NOW), 0);
  assert.equal(cooldownLeft(NOW - 10, 0, NOW), 0);
});

test("filters: kind, state, both, and none matching", () => {
  assert.deepEqual(buildServices(ENTRIES, STATES, opts({ kind: "docker" })).map((s) => s.id), ["a", "d"]);
  assert.deepEqual(buildServices(ENTRIES, STATES, opts({ state: "unknown" })).map((s) => s.id), ["d"]);
  assert.deepEqual(buildServices(ENTRIES, STATES, opts({ kind: "docker", state: "active" })).map((s) => s.id), ["a"]);
  assert.deepEqual(buildServices(ENTRIES, STATES, opts({ kind: "pm2", state: "active" })), []);
});

test("an empty allowlist is an empty list", () => {
  assert.deepEqual(buildServices([], new Map(), opts()), []);
});
