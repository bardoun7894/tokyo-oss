import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { controlApp } from "../test-app";
import { OpsStore } from "../ops-store";
import type { AllowEntry, Exec } from "../ops-restart";
import type { Cap } from "../store";
import { ServiceStates } from "./state";
import type { ServicesDeps } from "./routes";

const e = (id: string, kind: AllowEntry["kind"], name: string, cooldownSec = 300): AllowEntry => ({ id, kind, name, label: `L ${name}`, cooldownSec });
const LIST = [e("web", "docker", "web-1"), e("shop", "pm2", "tokyo-shop"), e("unit", "systemd", "x.service")];
const NOW = Date.parse("2026-10-17T12:00:00Z");

async function setup(opts: { list?: AllowEntry[]; caps?: Cap[] } = {}) {
  const db = new Database(":memory:");
  const ops = new OpsStore(db);
  const execCalls: string[][] = [];
  const exec: Exec = async (file, args) => { execCalls.push([file, ...args]); return { code: 0, stdout: "", stderr: "", timedOut: false }; };
  const services: ServicesDeps = { allowlist: () => opts.list ?? LIST, states: new ServiceStates(exec, () => NOW), ops, now: () => NOW };
  const t = await controlApp({ services, now: () => NOW }, db);
  t.store.setCaps(t.store.listDevices()[0]!.id, opts.caps ?? ["ops:read", "ops:service"]);
  const audits = () => (db.prepare("SELECT action, subject, params, result FROM control_ops_audit ORDER BY id").all() as any[]);
  return { ...t, db, ops, execCalls, audits, prepare: (id: string) => t.post(`/ops/services/${id}/restart`, {}) };
}

test("S2 needs ops:service (403 with only ops:read) and writes nothing", async () => {
  const t = await setup({ caps: ["ops:read", "ops:write"] });
  const r = await t.prepare("web");
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, "forbidden");
  assert.equal(t.audits().length, 0);
  assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM control_restart_tokens").get() as any).n, 0);
  await t.close();
});

test("S2 prepare: the 003 X15 shape, a 120 s single-use token of kind restart bound to the device and the allowlist id", async () => {
  const t = await setup();
  const r = await t.prepare("shop");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json, {
    fetchedAt: new Date(NOW).toISOString(), reachable: true, actionId: r.json.actionId, kind: "pm2", label: "L tokyo-shop", expiresAt: new Date(NOW + 120_000).toISOString(),
  });
  assert.match(r.json.actionId, /^act_[0-9a-f]{12}$/);
  const tok = t.ops.getActionToken(r.json.actionId)!;
  assert.deepEqual([tok.kind, tok.subject, tok.targetId, tok.deviceId, tok.usedAt, tok.payloadHash], ["restart", "shop", "shop", t.store.listDevices()[0]!.id, null, null]);
  assert.deepEqual(t.audits().map((a) => [a.action, a.subject, a.result, JSON.parse(a.params)]), [["service.restart.prepare", "shop", "ok", { target: "shop" }]]);
  assert.deepEqual(t.execCalls, [], "prepare runs nothing");
  await t.close();
});

test("S2: an id that is not on the allowlist, a bad id and an emptied allowlist spawn nothing", async () => {
  const t = await setup();
  for (const id of ["nope", "tokyo", "pm2-root.service", "all", "1"]) {
    const r = await t.prepare(id);
    assert.equal(r.status, 404, id);
    assert.equal(r.json.error.code, "not_found");
  }
  for (const id of ["a%20b", "x".repeat(41), "a;b", "%2e%2e"]) assert.equal((await t.prepare(id)).status, 400, id);
  assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM control_restart_tokens").get() as any).n, 0);
  assert.ok(t.audits().every((a) => a.action === "service.restart.prepare" && a.result === "not_found"));
  assert.deepEqual(t.execCalls, []);
  await t.close();
  const empty = await setup({ list: [] });
  assert.equal((await empty.prepare("web")).status, 404);
  await empty.close();
});

test("S2: 30 writes a minute per device, then 429", async () => {
  const t = await setup();
  let last = 0;
  for (let i = 0; i < 31; i++) last = (await t.prepare("web")).status;
  assert.equal(last, 429);
  await t.close();
});
