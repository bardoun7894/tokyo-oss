import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { controlApp } from "../test-app";
import { OpsStore } from "../ops-store";
import { prepareToken } from "../actions/tokens";
import type { AllowEntry, Exec } from "../ops-restart";
import type { Cap } from "../store";
import { ServiceStates } from "./state";

const e = (id: string, kind: AllowEntry["kind"], name: string, cooldownSec = 300): AllowEntry => ({ id, kind, name, label: `L ${name}`, cooldownSec });
const LIST = [e("web", "docker", "web-1"), e("shop", "pm2", "tokyo-shop"), e("unit", "systemd", "tokyo-jobs-web.service"), e("db", "docker", "db-1")];
const T0 = Date.parse("2026-10-17T12:00:00Z");
const godhome = { summary: async () => ({ reachable: true, data: {}, fetchedAt: 0 }), runs: async () => ({ reachable: true, data: [], fetchedAt: 0 }), run: async () => ({ reachable: true, data: {}, fetchedAt: 0 }), graph: async () => ({ reachable: true, data: {}, fetchedAt: 0 }) };

async function setup(opts: { restartCode?: number; list?: () => AllowEntry[] } = {}) {
  const clock = { t: T0 };
  const db = new Database(":memory:");
  const ops = new OpsStore(db);
  const calls: string[][] = [];
  const feed: string[] = [];
  const list = opts.list ?? (() => LIST);
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    const isRestart = args[0] === "restart";
    if (isRestart) return { code: opts.restartCode ?? 0, stdout: "", stderr: "boom: Bearer tk_leak", timedOut: false };
    if (file === "docker" && args[0] === "inspect") return { code: 0, stdout: "running\n", stderr: "", timedOut: false };
    if (file === "systemctl" && args[0] === "is-active") return { code: 0, stdout: "active\n", stderr: "", timedOut: false };
    if (file === "pm2") return { code: 0, stdout: JSON.stringify([{ name: "tokyo-shop", pm2_env: { status: "online" } }]), stderr: "", timedOut: false };
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  const t = await controlApp({
    now: () => clock.t,
    ops: { godhome, store: ops, now: () => clock.t, restart: { allowlist: list, exec, sleep: async (ms: number) => { clock.t += ms; }, feed: { add: (x: { text: string }) => { feed.push(x.text); return 1; } } } } as any,
    services: { allowlist: list, states: new ServiceStates(exec, () => clock.t), ops, now: () => clock.t },
  }, db);
  const dev = t.store.listDevices()[0]!;
  t.store.setCaps(dev.id, ["ops:read", "ops:service"]);
  const prepare = (id: string) => t.post(`/ops/services/${id}/restart`, {});
  const confirm = (actionId: string, key: string) => t.srv.call("POST", `/control-api/v1/ops/actions/${actionId}/confirm`, {}, { ...t.auth, "idempotency-key": key });
  const restartCalls = () => calls.filter((c) => c[1] === "restart");
  const audits = () => (db.prepare("SELECT action, result FROM control_ops_audit ORDER BY id").all() as any[]).map((r) => `${r.action}:${r.result}`);
  return { ...t, db, ops, dev, clock, calls, feed, prepare, confirm, restartCalls, audits };
}

test("prepare then confirm runs exactly 003's argv for each kind, reads the state back, audits both steps and writes one feed line", async () => {
  const t = await setup();
  const cases: [string, string[], string[], string][] = [
    ["web", ["docker", "restart", "web-1"], ["docker", "inspect", "-f", "{{.State.Status}}", "web-1"], "Restarted docker web-1 from device t, ok"],
    ["shop", ["pm2", "restart", "tokyo-shop"], ["pm2", "jlist"], "Restarted pm2 tokyo-shop from device t, ok"],
    ["unit", ["systemctl", "restart", "tokyo-jobs-web.service"], ["systemctl", "is-active", "tokyo-jobs-web.service"], "Restarted systemd tokyo-jobs-web.service from device t, ok"],
  ];
  for (const [i, [id, restart, state, line]] of cases.entries()) {
    const before = t.calls.length;
    const p = await t.prepare(id);
    assert.equal(p.status, 200);
    assert.equal(t.calls.length, before, "prepare runs nothing");
    const c = await t.confirm(p.json.actionId, `k${i}`);
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.deepEqual(c.json, { fetchedAt: new Date(t.clock.t).toISOString(), reachable: true, ok: true, state: "active", label: `L ${LIST[i]!.name}` });
    assert.deepEqual(t.calls.slice(before), [restart, state]);
    assert.equal(t.feed.at(-1), line);
  }
  assert.equal(t.feed.length, 3);
  assert.deepEqual(t.audits(), ["service.restart.prepare:ok", "restart.confirm:ok", "service.restart.prepare:ok", "restart.confirm:ok", "service.restart.prepare:ok", "restart.confirm:ok"]);
  await t.close();
});

test("a replayed Idempotency-Key returns the stored body and restarts once; the same action under a new key is 409", async () => {
  const t = await setup();
  const p = await t.prepare("web");
  const first = await t.confirm(p.json.actionId, "same");
  const again = await t.confirm(p.json.actionId, "same");
  assert.deepEqual(again.json, first.json);
  assert.equal(t.restartCalls().length, 1);
  assert.equal((await t.confirm(p.json.actionId, "new-key")).status, 409);
  await t.close();
});

test("the per-target cooldown applies: a second restart of the same service inside 300 s is 429 with Retry-After, another service is not", async () => {
  const t = await setup();
  assert.equal((await t.confirm((await t.prepare("web")).json.actionId, "a")).status, 200);
  const again = await t.confirm((await t.prepare("web")).json.actionId, "b");
  assert.equal(again.status, 429);
  assert.equal(again.json.error.code, "rate_limited");
  assert.ok(Number(again.headers["retry-after"]) >= 1);
  assert.equal(t.restartCalls().length, 1);
  assert.equal((await t.confirm((await t.prepare("shop")).json.actionId, "c")).status, 200);
  const s1 = await t.get("/ops/services");
  const web = s1.json.services.find((s: any) => s.id === "web");
  assert.ok(web.cooldownLeftS > 0 && web.cooldownLeftS <= 300);
  assert.equal(s1.json.services.find((s: any) => s.id === "db").cooldownLeftS, 0);
  t.clock.t += 301_000;
  assert.equal((await t.confirm((await t.prepare("web")).json.actionId, "d")).status, 200, "after the cooldown");
  await t.close();
});

test("the global limit of 3 restarts per 10 minutes is shared with restarts that began at an incident", async () => {
  const t = await setup();
  // X15 stores exactly this token for an incident; X16 is the same confirm route. Two incident restarts, then S2.
  const incident = (target: string, n: number) => prepareToken(t.ops, { kind: "restart", deviceId: t.dev.id, subject: `i_00000000000${n}`, targetId: target, incidentId: `i_00000000000${n}`, now: t.clock.t });
  assert.equal((await t.confirm(incident("web", 1).actionId, "i1")).status, 200);
  assert.equal((await t.confirm(incident("shop", 2).actionId, "i2")).status, 200);
  assert.equal((await t.confirm((await t.prepare("unit")).json.actionId, "s1")).status, 200);
  const fourth = await t.confirm((await t.prepare("db")).json.actionId, "s2");
  assert.equal(fourth.status, 429);
  assert.equal(t.restartCalls().length, 3);
  // and the other way round: a service restart counts against an incident restart
  const fifth = await t.confirm(incident("db", 3).actionId, "i3");
  assert.equal(fifth.status, 429);
  t.clock.t += 10 * 60 * 1000 + 1000;
  assert.equal((await t.confirm((await t.prepare("db")).json.actionId, "s3")).status, 200, "after the window");
  await t.close();
});

test("a service taken off the allowlist after prepare is 404 at confirm and nothing runs; losing ops:service is 403", async () => {
  let list = LIST;
  const t = await setup({ list: () => list });
  const p = await t.prepare("web");
  list = LIST.filter((x) => x.id !== "web");
  const gone = await t.confirm(p.json.actionId, "k1");
  assert.equal(gone.status, 404);
  assert.deepEqual(t.calls, []);
  list = LIST;
  const q = await t.prepare("shop");
  t.store.setCaps(t.dev.id, ["ops:read"]);
  assert.equal((await t.confirm(q.json.actionId, "k2")).status, 403);
  assert.equal(t.restartCalls().length, 0);
  await t.close();
});

test("a restart that fails is audited as failed with ok:false, and neither stderr nor the token reaches the reply", async () => {
  const t = await setup({ restartCode: 1 });
  const p = await t.prepare("web");
  const c = await t.confirm(p.json.actionId, "k");
  assert.equal(c.status, 200);
  assert.equal(c.json.ok, false);
  assert.ok(!JSON.stringify(c.json).includes("tk_leak"));
  assert.deepEqual(t.audits(), ["service.restart.prepare:ok", "restart.confirm:failed"]);
  assert.equal(t.feed.at(-1), "Restarted docker web-1 from device t, failed");
  await t.close();
});

test("tokyo, pm2-root.service, pm2 all and 1 are not ids: nothing is spawned for them", async () => {
  const t = await setup();
  for (const id of ["tokyo", "pm2-root.service", "all", "1", "default"]) assert.equal((await t.prepare(id)).status, 404, id);
  assert.deepEqual(t.calls, []);
  await t.close();
});
