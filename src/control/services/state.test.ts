import { test } from "node:test";
import assert from "node:assert/strict";
import type { AllowEntry, Exec, ExecResult } from "../ops-restart";
import { ServiceStates, STATE_TTL_MS, parseDocker, parsePm2, parseSystemd } from "./state";

const e = (id: string, kind: AllowEntry["kind"], name: string): AllowEntry => ({ id, kind, name, label: name, cooldownSec: 300 });
const ENTRIES: AllowEntry[] = [
  e("d1", "docker", "web"), e("d2", "docker", "db"), e("d3", "docker", "gone"),
  e("p1", "pm2", "shop"), e("p2", "pm2", "api"), e("p3", "pm2", "missing-app"),
  e("s1", "systemd", "a.service"), e("s2", "systemd", "b.service"), e("s3", "systemd", "c.service"),
];

const DOCKER = "web\trunning\ndb\texited\nother\trunning\nweird\trestarting\n";
const PM2 = `[PM2] notice line\n${JSON.stringify([
  { name: "shop", pm2_env: { status: "online", SECRET_TOKEN: "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" } },
  { name: "api", pm2_env: { status: "errored" } },
  { name: "x", pm2_env: { status: "stopped" } },
])}`;
const SYSTEMD = "Id=a.service\nActiveState=active\n\nId=b.service\nActiveState=failed\n\nId=c.service\nActiveState=activating\n";

function recorder(over: Partial<Record<string, ExecResult | Error>> = {}) {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    const key = file;
    const forced = over[key];
    if (forced instanceof Error) throw forced;
    if (forced) return forced;
    const stdout = file === "docker" ? DOCKER : file === "pm2" ? PM2 : SYSTEMD;
    return { code: 0, stdout, stderr: "", timedOut: false };
  };
  return { exec, calls };
}

test("parsers: docker, pm2 and systemd answers map to active, inactive, failed or unknown", () => {
  assert.deepEqual([...parseDocker(DOCKER)], [["web", "active"], ["db", "inactive"], ["other", "active"], ["weird", "unknown"]]);
  assert.deepEqual([...parsePm2(PM2)], [["shop", "active"], ["api", "failed"], ["x", "inactive"]]);
  assert.deepEqual([...parseSystemd(SYSTEMD)], [["a.service", "active"], ["b.service", "failed"], ["c.service", "unknown"]]);
  assert.deepEqual([...parseSystemd("Id=z.service\nActiveState=inactive\n")], [["z.service", "inactive"]]);
  assert.deepEqual([...parsePm2("not json")], []);
  assert.deepEqual([...parseDocker("")], []);
  assert.deepEqual([...parseDocker("created\n\tdead")], [], "malformed lines are skipped");
  assert.equal(parseDocker("a\tdead").get("a"), "failed");
  assert.equal(parseDocker("a\tpaused").get("a"), "inactive");
});

test("one batched read per kind with a fixed argv; a name that is not in the answer is unknown", async () => {
  const r = recorder();
  const s = new ServiceStates(r.exec, () => 1000);
  const got = await s.read(ENTRIES);
  assert.deepEqual(r.calls, [
    ["docker", "ps", "-a", "--format", "{{.Names}}\t{{.State}}"],
    ["pm2", "jlist"],
    ["systemctl", "show", "--no-pager", "-p", "Id,ActiveState", "a.service", "b.service", "c.service"],
  ]);
  assert.deepEqual(Object.fromEntries(got.states), { d1: "active", d2: "inactive", d3: "unknown", p1: "active", p2: "failed", p3: "unknown", s1: "active", s2: "failed", s3: "unknown" });
  assert.equal(got.at, 1000);
});

test("only the kinds that have entries are read", async () => {
  const r = recorder();
  await new ServiceStates(r.exec).read([e("p1", "pm2", "shop")]);
  assert.deepEqual(r.calls, [["pm2", "jlist"]]);
  const none = recorder();
  const got = await new ServiceStates(none.exec).read([]);
  assert.deepEqual(none.calls, []);
  assert.equal(got.states.size, 0);
});

test("cached for 15 s; read again after; a changed entry set is read at once", async () => {
  let t = 0;
  const r = recorder();
  const s = new ServiceStates(r.exec, () => t);
  await s.read(ENTRIES);
  t = STATE_TTL_MS - 1;
  await s.read(ENTRIES);
  assert.equal(r.calls.length, 3, "served from the cache");
  t = STATE_TTL_MS;
  await s.read(ENTRIES);
  assert.equal(r.calls.length, 6, "expired");
  await s.read(ENTRIES.slice(0, 2));
  assert.equal(r.calls.length, 7, "another set of entries is a different read");
  assert.equal(STATE_TTL_MS, 15_000);
});

test("single-flight: concurrent reads share one run of the commands", async () => {
  const r = recorder();
  const s = new ServiceStates(r.exec);
  const [a, b, c] = await Promise.all([s.read(ENTRIES), s.read(ENTRIES), s.read(ENTRIES)]);
  assert.equal(r.calls.length, 3);
  assert.deepEqual([...a.states], [...b.states]);
  assert.deepEqual([...b.states], [...c.states]);
});

test("a failing, throwing or timed-out read is unknown for that kind only, and neither stderr nor the pm2 environment reaches a log", async () => {
  const logs: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    const r = recorder({
      docker: { code: 1, stdout: "", stderr: "Cannot connect Bearer tk_leak", timedOut: false },
      pm2: new Error("spawn pm2 ENOENT SECRET_TOKEN=sk-abc"),
      systemctl: { code: null, stdout: "", stderr: "", timedOut: true },
    });
    const got = await new ServiceStates(r.exec).read(ENTRIES);
    assert.ok([...got.states.values()].every((v) => v === "unknown"));
    const part = recorder({ docker: { code: 1, stdout: "", stderr: "", timedOut: false } });
    const mixed = await new ServiceStates(part.exec).read(ENTRIES);
    assert.equal(mixed.states.get("d1"), "unknown");
    assert.equal(mixed.states.get("p1"), "active");
    assert.equal(mixed.states.get("s1"), "active");
  } finally {
    console.warn = orig;
  }
  assert.ok(logs.length >= 3);
  for (const l of logs) assert.ok(!/tk_leak|sk-|SECRET_TOKEN|Cannot connect/.test(l), l);
});
