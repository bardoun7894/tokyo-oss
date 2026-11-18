import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { controlApp } from "../test-app";
import { OpsStore } from "../ops-store";
import { prepareToken } from "../actions/tokens";
import type { AllowEntry, Exec } from "../ops-restart";
import type { Cap } from "../store";
import { ServiceStates } from "./state";
import type { ServicesDeps } from "./routes";

const e = (id: string, kind: AllowEntry["kind"], name: string, cooldownSec = 300): AllowEntry => ({ id, kind, name, label: `L ${name}`, cooldownSec });
const LIST = [e("web", "docker", "web-1"), e("shop", "pm2", "tokyo-shop"), e("unit", "systemd", "x.service", 600)];
const NOW = Date.parse("2026-10-17T12:00:00Z");

async function setup(opts: { list?: AllowEntry[]; caps?: Cap[]; exec?: Exec } = {}) {
  const db = new Database(":memory:");
  const ops = new OpsStore(db);
  const calls: string[][] = [];
  const exec: Exec = opts.exec ?? (async (file, args) => {
    calls.push([file, ...args]);
    const stdout = file === "docker" ? "web-1\trunning\n" : file === "pm2" ? JSON.stringify([{ name: "tokyo-shop", pm2_env: { status: "stopped" } }]) : "Id=x.service\nActiveState=failed\n";
    return { code: 0, stdout, stderr: "", timedOut: false };
  });
  const services: ServicesDeps = { allowlist: () => opts.list ?? LIST, states: new ServiceStates(exec, () => NOW), ops, now: () => NOW };
  const t = await controlApp({ services }, db);
  t.store.setCaps(t.store.listDevices()[0]!.id, opts.caps ?? ["ops:read"]);
  return { ...t, db, ops, calls };
}

test("S1 needs ops:read; actions only for a device with ops:service", async () => {
  const none = await setup({ caps: ["ops:write"] });
  assert.equal((await none.get("/ops/services")).status, 403);
  await none.close();
  const ro = await setup();
  const r = await ro.get("/ops/services");
  assert.equal(r.status, 200);
  assert.ok(r.json.services.every((s: any) => !("actions" in s)));
  await ro.close();
  const svc = await setup({ caps: ["ops:read", "ops:service"] });
  const x = await svc.get("/ops/services");
  assert.ok(x.json.services.every((s: any) => JSON.stringify(s.actions) === '["restart"]'));
  await svc.close();
});

test("S1 lists every loaded entry with its state; fetchedAt is the state read; no name leaves", async () => {
  const t = await setup();
  const r = await t.get("/ops/services");
  assert.deepEqual(r.json, {
    fetchedAt: new Date(NOW).toISOString(),
    services: [
      { id: "web", kind: "docker", label: "L web-1", state: "active", cooldownLeftS: 0 },
      { id: "shop", kind: "pm2", label: "L tokyo-shop", state: "inactive", cooldownLeftS: 0 },
      { id: "unit", kind: "systemd", label: "L x.service", state: "failed", cooldownLeftS: 0 },
    ],
  });
  await t.close();
});

test("S1 filters by kind and state; a bad or repeated value is 400", async () => {
  const t = await setup();
  assert.deepEqual((await t.get("/ops/services?kind=docker")).json.services.map((s: any) => s.id), ["web"]);
  assert.deepEqual((await t.get("/ops/services?state=failed")).json.services.map((s: any) => s.id), ["unit"]);
  assert.deepEqual((await t.get("/ops/services?kind=pm2&state=failed")).json.services, []);
  for (const q of ["kind=shell", "state=up", "kind=", "kind=docker&kind=pm2", "state=active&state=failed", "kind=Docker"]) {
    const r = await t.get(`/ops/services?${q}`);
    assert.equal(r.status, 400, q);
    assert.equal(r.json.error.code, "bad_request");
  }
  await t.close();
});

test("S1: a missing allowlist file is an empty list and nothing is read from the host", async () => {
  const t = await setup({ list: [] });
  const r = await t.get("/ops/services");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.services, []);
  assert.equal(t.calls.length, 0);
  await t.close();
});

test("S1: cooldownLeftS is the 003 cooldown of the target, in whole seconds rounded up", async () => {
  const t = await setup();
  const dev = t.store.listDevices()[0]!.id;
  const tok = prepareToken(t.ops, { kind: "restart", deviceId: dev, subject: "i_1", targetId: "web", incidentId: "i_1", now: NOW - 150_000 });
  t.ops.consumeRestartToken(tok.actionId, NOW - 100_500); // restarted 100.5 s ago, cooldown 300 s
  const other = prepareToken(t.ops, { kind: "agent_run", deviceId: dev, subject: "p", targetId: "shop", now: NOW - 60_000 });
  t.ops.consumeRestartToken(other.actionId, NOW - 1000); // another kind of action: no cooldown
  const r = await t.get("/ops/services");
  assert.deepEqual(r.json.services.map((s: any) => s.cooldownLeftS), [200, 0, 0]);
  await t.close();
});

test("S1: a second request within 15 s is served from the cache (one run of each command)", async () => {
  const t = await setup();
  await t.get("/ops/services");
  await t.get("/ops/services?kind=docker");
  assert.equal(t.calls.length, 3);
  await t.close();
});

test("S1: a failing host read still answers 200 with unknown states", async () => {
  const t = await setup({ exec: async () => { throw new Error("boom Bearer tk_leak"); } });
  const r = await t.get("/ops/services");
  assert.equal(r.status, 200);
  assert.ok(r.json.services.every((s: any) => s.state === "unknown"));
  assert.ok(!JSON.stringify(r.json).includes("tk_leak"));
  await t.close();
});
