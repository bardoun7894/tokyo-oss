import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { controlApp } from "./test-app";
import { OpsStore } from "./ops-store";
import type { OpsResult } from "./ops-godhome";

const FIX = path.join(__dirname, "..", "..", "test-fixtures");
const summary = (w: string) => JSON.parse(fs.readFileSync(path.join(FIX, `ops-summary-${w}.json`), "utf8"));
const NOW = Date.parse("2026-10-16T09:00:00Z");
const up = (w: string): OpsResult => ({ reachable: true, data: summary(w), fetchedAt: NOW - 3000 });
const down = async (): Promise<OpsResult> => ({ reachable: false, data: null, fetchedAt: 0 });

/** controlApp with the ops routes mounted over a fake GodHome that answers from the fixtures (or is down). */
async function opsApp(godhomeUp: boolean, extra: Record<string, unknown> = {}) {
  const db = new Database(":memory:");
  const godhome = {
    summary: async (w: string) => (godhomeUp ? up(w) : down()),
    runs: async () => (godhomeUp ? { reachable: true, data: { runs: [] }, fetchedAt: NOW } : down()),
    run: async () => down(),
    graph: async () => down(),
  };
  const app = await controlApp({ now: () => NOW, ops: { godhome, store: new OpsStore(db) }, ...extra } as any, db);
  return app;
}

test("ops routes are not mounted without deps.ops", async () => {
  const app = await controlApp();
  assert.equal((await app.get("/ops/overview")).status, 404);
  await app.close();
});

test("end to end: login then X1, X2, X5 answer from a fake GodHome; /counts carries the incident counts", async () => {
  const app = await opsApp(true);
  const x1 = await app.get("/ops/overview");
  assert.equal(x1.status, 200);
  assert.equal(x1.json.reachable, true);
  assert.equal(x1.json.window.id, "24h");
  const x2 = await app.get("/ops/map");
  assert.equal(x2.status, 200);
  assert.equal(x2.json.reachable, true);
  const x5 = await app.get("/ops/incidents");
  assert.equal(x5.status, 200);
  assert.ok(Array.isArray(x5.json.items));
  assert.match(x5.json.items[0].id, /^i_[0-9a-f]{12}$/);
  const counts = await app.get("/counts");
  assert.equal(counts.status, 200);
  assert.equal(counts.json.incidentsOpen, x5.json.counts.open);
  assert.equal(counts.json.incidentsCritical, x5.json.counts.critical);
  assert.deepEqual(Object.keys(counts.json).sort(), ["factoryFailed", "failedRuns24h", "incidentsCritical", "incidentsOpen", "pendingOffers", "runningRuns"]);
  await app.close();
});

test("no bearer is 401 on every mounted ops read", async () => {
  const app = await opsApp(true);
  for (const p of ["/ops/overview", "/ops/map", "/ops/traces", "/ops/incidents", "/ops/incidents/i_000000000000"]) {
    const r = await app.srv.call("GET", "/control-api/v1" + p);
    assert.equal(r.status, 401, p);
  }
  await app.close();
});

test("GodHome unreachable is 200 reachable:false for X1, X2, X3, X5; counts omit the incident fields", async () => {
  const app = await opsApp(false);
  for (const p of ["/ops/overview", "/ops/map", "/ops/traces", "/ops/incidents"]) {
    const r = await app.get(p);
    assert.equal(r.status, 200, p);
    assert.equal(r.json.reachable, false, p);
  }
  const counts = await app.get("/counts");
  assert.deepEqual(Object.keys(counts.json).sort(), ["factoryFailed", "failedRuns24h", "pendingOffers", "runningRuns"]);
  await app.close();
});

test("end to end: login, ack, mute, resolve and reopen change the incident list and the /counts badge; a replayed key does not act twice", async () => {
  const app = await opsApp(true);
  const list = async (q = "") => (await app.get(`/ops/incidents?limit=100${q}`)).json;
  const first = await list();
  const inc = first.items.find((i: any) => i.severity !== "critical");
  const badge = async () => (await app.get("/counts")).json.incidentsOpen;
  assert.equal(await badge(), first.counts.open);
  assert.equal((await app.post(`/ops/incidents/${inc.id}/ack`)).json.incident.acked, true);
  assert.equal(await badge(), first.counts.open, "ack keeps the count");
  const key = { "idempotency-key": "e2e-1" };
  const m1 = await app.srv.call("POST", `/control-api/v1/ops/incidents/${inc.id}/mute`, { minutes: 60 }, { ...app.auth, ...key });
  assert.equal(m1.status, 200);
  assert.equal(await badge(), first.counts.open - 1, "mute leaves the badge");
  const m2 = await app.srv.call("POST", `/control-api/v1/ops/incidents/${inc.id}/mute`, { minutes: 60 }, { ...app.auth, ...key });
  assert.deepEqual(m2.json, m1.json);
  assert.equal(((await list("&state=muted")).items as any[]).length, 1);
  assert.equal((await app.post(`/ops/incidents/${inc.id}/resolve`)).json.incident.state, "resolved");
  assert.equal((await app.post(`/ops/incidents/${inc.id}/reopen`)).json.incident.state, "open");
  assert.equal(await badge(), first.counts.open, "reopen restores the badge");
  assert.equal((await app.srv.call("POST", `/control-api/v1/ops/incidents/${inc.id}/ack`, {})).status, 401);
  await app.close();
});

// --- T4.3: service restart through the routes (exec is a recorder; nothing is ever spawned) ---

import type { AllowEntry, Exec, ExecResult } from "./ops-restart";

const isoAt = (ms: number) => new Date(ms).toISOString();
const checkItem = (n: number, title: string, over: Record<string, unknown> = {}) => ({
  id: `check:${title.split(":")[0]}:${n}`, kind: "check", title, subtitle: "", severity: "warning", state: "open", project: "server", check: title.split(":")[0],
  firstAt: isoAt(NOW - 3_600_000), lastAt: isoAt(NOW - 60_000 * n), durationMs: 3_600_000, flaps: 1, flapping: false, count: 1, url: "", ...over,
});
const RESTART_ITEMS = [
  checkItem(1, "docker: ops-smoke exited (restart=unless-stopped):"),
  checkItem(2, "docker: web-1 exited"), checkItem(3, "docker: web-2 exited"), checkItem(4, "docker: web-3 exited"), checkItem(5, "docker: web-4 exited"),
  checkItem(6, "unit: x.service loaded failed failed Some unit"),
  checkItem(7, "pm2: app restarts=3"),
  checkItem(8, "docker: notlisted exited"),
  checkItem(9, "docker: tokyo exited"),
  checkItem(10, "docker: macbox exited", { host: "mac" }),
  checkItem(11, "site: www.shopdemo.com 000"),
];
const entry = (id: string, kind: AllowEntry["kind"], name: string, cooldownSec = 300): AllowEntry => ({ id, kind, name, label: id === "smoke" ? "Smoke" : name, cooldownSec });
const baseEntries = (): AllowEntry[] => [
  entry("smoke", "docker", "ops-smoke"), entry("w1", "docker", "web-1", 0), entry("w2", "docker", "web-2", 0), entry("w3", "docker", "web-3", 0), entry("w4", "docker", "web-4", 0),
  entry("x", "systemd", "x.service"), entry("app", "pm2", "app"),
  // not reachable through the real loader (tokyo is refused there); injected here to prove the routes refuse it on their own
  entry("self", "docker", "tokyo"), entry("mac", "docker", "macbox"),
];
const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const defaultAnswer = (file: string, args: string[]): ExecResult => {
  if (file === "docker" && args[0] === "inspect") return ok("running\n");
  if (file === "systemctl" && args[0] === "is-active") return ok("active\n");
  if (file === "pm2" && args[0] === "jlist") return ok(JSON.stringify([{ name: "app", pm2_env: { status: "online" } }]));
  return ok();
};

async function restartApp(withRestart = true) {
  const db = new Database(":memory:");
  const clock = { t: NOW };
  const calls: string[][] = [];
  const feed: string[] = [];
  const entries = baseEntries();
  const script = { fn: defaultAnswer };
  const exec: Exec = async (file, args) => { calls.push([file, ...args]); return script.fn(file, [...args]); };
  const godhome = {
    summary: async () => ({ reachable: true, data: { incidents: { counts: { open: RESTART_ITEMS.length, critical: 0, warning: RESTART_ITEMS.length, notice: 0, resolved: 0 }, items: RESTART_ITEMS } }, fetchedAt: NOW }),
    runs: async () => down(), run: async () => down(), graph: async () => down(),
  };
  const restart = { allowlist: () => entries, exec, sleep: async (ms: number) => { clock.t += ms; }, feed: { add: (e: { text: string }) => { feed.push(e.text); return 1; } } };
  const app = await controlApp({ now: () => clock.t, ops: { godhome, store: new OpsStore(db), ...(withRestart ? { restart } : {}) } } as any, db);
  const grant = (caps: string, deviceId?: string) => (deviceId ? db.prepare("UPDATE control_devices SET caps = ? WHERE id = ?").run(caps, deviceId) : db.prepare("UPDATE control_devices SET caps = ?").run(caps));
  grant("ops:read,ops:write,ops:service");
  const l2 = await app.srv.call("POST", "/control-api/v1/auth/login", { username: "admin", password: "pw", deviceName: "d2" });
  const auth2 = { authorization: `Bearer ${l2.json.deviceToken}` };
  const incidents = async () => (await app.get("/ops/incidents?limit=100")).json.items as any[];
  const idOf = async (title: string) => (await incidents()).find((i) => i.title.startsWith(title)).id as string;
  const prep = (id: string, auth: Record<string, string> = app.auth) => app.srv.call("POST", `/control-api/v1/ops/incidents/${id}/restart`, {}, auth);
  const conf = (actionId: string, key = "k1", auth: Record<string, string> = app.auth) => app.srv.call("POST", `/control-api/v1/ops/actions/${actionId}/confirm`, {}, { ...auth, "idempotency-key": key });
  const actions = async () => (await app.get("/ops/audit?limit=100")).json.entries.map((e: any) => `${e.action}:${e.result}`) as string[];
  return { ...app, db, clock, calls, feed, entries, script, grant, auth2, d2: l2.json.deviceId as string, incidents, idOf, prep, conf, actions };
}

test("restart routes are not mounted without deps.ops.restart", async () => {
  const t = await restartApp(false);
  const id = await t.idOf("docker: ops-smoke");
  assert.equal((await t.prep(id)).status, 404);
  assert.ok(!(await t.incidents()).some((i) => i.actions.includes("restart")));
  await t.close();
});

test("actions[] has restart only for an allowlisted server target and a device holding ops:service", async () => {
  const t = await restartApp();
  const has = (items: any[], title: string) => items.find((i) => i.title.startsWith(title)).actions.includes("restart");
  const items = await t.incidents();
  for (const title of ["docker: ops-smoke", "docker: web-1", "unit: x.service", "pm2: app"]) assert.equal(has(items, title), true, title);
  for (const title of ["docker: notlisted", "docker: tokyo", "docker: macbox", "site: www"]) assert.equal(has(items, title), false, title);
  const detail = (await t.get(`/ops/incidents/${items.find((i) => i.title.startsWith("docker: ops-smoke")).id}`)).json;
  assert.ok(detail.actions.includes("restart"));
  t.grant("ops:read,ops:write", t.d2);
  const noService = (await t.srv.call("GET", "/control-api/v1/ops/incidents?limit=100", undefined, t.auth2)).json.items;
  assert.ok(noService.every((i: any) => !i.actions.includes("restart")));
  t.grant("ops:read,ops:service", t.d2);
  const serviceOnly = (await t.srv.call("GET", "/control-api/v1/ops/incidents?limit=100", undefined, t.auth2)).json.items;
  assert.deepEqual(serviceOnly.find((i: any) => i.title.startsWith("docker: ops-smoke")).actions, ["restart"]);
  await t.close();
});

test("prepare and confirm spawn nothing for a missing cap, a non-allowlisted target, tokyo, a Mac-host incident, a bad id, a bad or unknown action id", async () => {
  const t = await restartApp();
  const smoke = await t.idOf("docker: ops-smoke");
  const denied = await t.prep(smoke, t.auth2);
  assert.deepEqual([denied.status, denied.json.error.code], [403, "forbidden"]);
  for (const title of ["docker: notlisted", "docker: tokyo", "docker: macbox", "site: www"]) {
    const r = await t.prep(await t.idOf(title));
    assert.deepEqual([r.status, r.json.error.code], [404, "not_found"], title);
  }
  assert.equal((await t.prep("i_0123456789ab")).status, 404, "an id this store never issued");
  assert.equal((await t.prep("not-an-id")).status, 400);
  assert.equal((await t.conf("nope")).status, 400);
  assert.equal((await t.conf("act_000000000000")).status, 404);
  assert.equal((await t.srv.call("POST", "/control-api/v1/ops/actions/act_000000000000/confirm", {}, t.auth)).status, 400, "no Idempotency-Key");
  assert.deepEqual(t.calls, []);
  assert.deepEqual(t.feed, []);
  await t.close();
});

test("prepare then confirm restarts exactly the allowlisted docker target: argv, body, one feed line, two audit rows", async () => {
  const t = await restartApp();
  const p = await t.prep(await t.idOf("docker: ops-smoke"));
  assert.equal(p.status, 200);
  assert.match(p.json.actionId, /^act_[0-9a-f]{12}$/);
  assert.deepEqual([p.json.kind, p.json.label, p.json.expiresAt], ["docker", "Smoke", isoAt(NOW + 120_000)]);
  assert.deepEqual(t.calls, [], "prepare runs nothing");
  const c = await t.conf(p.json.actionId);
  assert.equal(c.status, 200);
  assert.deepEqual([c.json.ok, c.json.state, c.json.label, c.json.reachable], [true, "active", "Smoke", true]);
  assert.deepEqual(t.calls, [["docker", "restart", "ops-smoke"], ["docker", "inspect", "-f", "{{.State.Status}}", "ops-smoke"]]);
  assert.deepEqual(t.feed, ["Restarted docker ops-smoke from device t, ok"]);
  const a = await t.actions();
  assert.ok(a.includes("restart.prepare:ok") && a.includes("restart.confirm:ok"), a.join());
  await t.close();
});

test("a systemd unit and a pm2 app use their own fixed argv", async () => {
  const t = await restartApp();
  const u = await t.prep(await t.idOf("unit: x.service"));
  assert.equal(u.json.kind, "systemd");
  assert.equal((await t.conf(u.json.actionId, "ku")).json.state, "active");
  const a = await t.prep(await t.idOf("pm2: app"));
  assert.equal((await t.conf(a.json.actionId, "kp")).json.state, "active");
  assert.deepEqual(t.calls, [["systemctl", "restart", "x.service"], ["systemctl", "is-active", "x.service"], ["pm2", "restart", "app"], ["pm2", "jlist"]]);
  for (const [file, ...args] of t.calls) assert.ok(["systemctl", "docker", "pm2"].includes(file!) && args.every((x) => typeof x === "string" && !/[;&|`$ ]/.test(x.replace("{{.State.Status}}", ""))), `${file} ${args}`);
  await t.close();
});

test("single use: a replayed key returns the stored result and execs once; the same action with a new key, or the key on another action, is 409", async () => {
  const t = await restartApp();
  const p = await t.prep(await t.idOf("docker: ops-smoke"));
  const first = await t.conf(p.json.actionId, "k1");
  const replay = await t.conf(p.json.actionId, "k1");
  assert.deepEqual([replay.status, replay.json], [200, first.json]);
  assert.equal((await t.conf(p.json.actionId, "k2")).status, 409, "token already used");
  const other = await t.prep(await t.idOf("docker: web-1"));
  assert.equal((await t.conf(other.json.actionId, "k1")).status, 409, "key already used for another action");
  assert.equal(t.calls.filter((c) => c[1] === "restart").length, 1);
  assert.equal(t.feed.length, 1);
  assert.equal((await t.actions()).filter((x) => x === "restart.confirm:ok").length, 1);
  await t.close();
});

test("an expired action id is 409 and spawns nothing; a missing or malformed Idempotency-Key is 400 and keeps the token", async () => {
  const t = await restartApp();
  const id = await t.idOf("docker: ops-smoke");
  const late = await t.prep(id);
  t.clock.t += 121_000;
  assert.deepEqual([(await t.conf(late.json.actionId)).status, t.calls.length], [409, 0]);
  t.clock.t = NOW;
  const p = await t.prep(id);
  const url = `/control-api/v1/ops/actions/${p.json.actionId}/confirm`;
  assert.equal((await t.srv.call("POST", url, {}, t.auth)).status, 400);
  assert.equal((await t.srv.call("POST", url, {}, { ...t.auth, "idempotency-key": "bad key!" })).status, 400);
  assert.equal(t.calls.length, 0);
  assert.equal((await t.conf(p.json.actionId, "good-key")).status, 200, "the token survived both 400s");
  await t.close();
});

test("the token is bound to its device and needs ops:service at confirm time", async () => {
  const t = await restartApp();
  t.grant("ops:read,ops:write,ops:service", t.d2);
  const p = await t.prep(await t.idOf("docker: ops-smoke"));
  assert.equal((await t.conf(p.json.actionId, "k1", t.auth2)).status, 404, "another device's id");
  t.grant("ops:read,ops:write");
  assert.equal((await t.conf(p.json.actionId)).status, 403, "cap revoked after prepare");
  assert.deepEqual(t.calls, []);
  t.grant("ops:read,ops:write,ops:service");
  assert.equal((await t.conf(p.json.actionId)).status, 200, "neither refusal consumed it");
  await t.close();
});

test("an allowlist entry removed after prepare is 404 at confirm; a resolved incident cannot be prepared", async () => {
  const t = await restartApp();
  const id = await t.idOf("docker: ops-smoke");
  const p = await t.prep(id);
  t.entries.splice(0, 1);
  assert.equal((await t.conf(p.json.actionId)).status, 404);
  assert.deepEqual(t.calls, []);
  t.entries.unshift(entry("smoke", "docker", "ops-smoke"));
  assert.equal((await t.post(`/ops/incidents/${id}/resolve`)).status, 200);
  assert.deepEqual([(await t.prep(id)).status, (await t.prep(id)).json.error.code], [409, "conflict"]);
  await t.close();
});

test("the 4th restart inside 10 minutes is 429 with Retry-After, spawns nothing and keeps its token", async () => {
  const t = await restartApp();
  const done: number[] = [];
  for (const n of [1, 2, 3, 4]) {
    const p = await t.prep(await t.idOf(`docker: web-${n}`));
    const c = await t.conf(p.json.actionId, `rk-${n}`);
    done.push(c.status);
    if (n === 4) {
      assert.deepEqual(c.json.error.code, "rate_limited");
      assert.equal(c.headers["retry-after"], "600");
      assert.equal((t.db.prepare("SELECT used_at FROM control_restart_tokens WHERE action_id = ?").get(p.json.actionId) as any).used_at, null);
    }
  }
  assert.deepEqual(done, [200, 200, 200, 429]);
  assert.deepEqual(t.calls.filter((c) => c[1] === "restart").map((c) => c[2]), ["web-1", "web-2", "web-3"]);
  assert.ok((await t.actions()).includes("restart.confirm:rate_limited"));
  await t.close();
});

test("one restart per target per cooldownSec: a second inside 300 s is 429 with Retry-After 300, allowed after", async () => {
  const t = await restartApp();
  const id = await t.idOf("docker: ops-smoke");
  assert.equal((await t.conf((await t.prep(id)).json.actionId, "c1")).status, 200);
  const again = await t.conf((await t.prep(id)).json.actionId, "c2");
  assert.deepEqual([again.status, again.headers["retry-after"]], [429, "300"]);
  t.clock.t += 301_000;
  assert.equal((await t.conf((await t.prep(id)).json.actionId, "c3")).status, 200);
  assert.equal(t.calls.filter((c) => c[1] === "restart").length, 2);
  await t.close();
});

test("a timeout is state failed with one exec; a non-zero exit reads the state; the failed result is stored for the key and fed to the owner", async () => {
  const t = await restartApp();
  t.script.fn = (file, args) => (args[0] === "restart" ? { code: null, stdout: "", stderr: "", timedOut: true } : defaultAnswer(file, args));
  const p = await t.prep(await t.idOf("docker: web-1"));
  const c = await t.conf(p.json.actionId, "f1");
  assert.deepEqual([c.status, c.json.ok, c.json.state], [200, false, "failed"]);
  assert.equal(t.calls.length, 1, "no state read after a timeout");
  assert.equal(t.feed[0], "Restarted docker web-1 from device t, failed");
  assert.deepEqual((await t.conf(p.json.actionId, "f1")).json, c.json, "replay");
  assert.ok((await t.actions()).includes("restart.confirm:failed"));
  t.script.fn = (file, args) => (args[0] === "restart" ? { code: 1, stdout: "", stderr: "boom", timedOut: false } : args[0] === "inspect" ? ok("exited\n") : defaultAnswer(file, args));
  const q = await t.prep(await t.idOf("docker: web-2"));
  const d = await t.conf(q.json.actionId, "f2");
  assert.deepEqual([d.json.ok, d.json.state], [false, "inactive"]);
  assert.ok(!JSON.stringify(d.json).includes("boom"), "stderr never leaves Tokyo");
  await t.close();
});

test("two concurrent confirms of one action exec once", async () => {
  const t = await restartApp();
  const p = await t.prep(await t.idOf("docker: ops-smoke"));
  const both = await Promise.all([t.conf(p.json.actionId, "r1"), t.conf(p.json.actionId, "r2")]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
  assert.equal(t.calls.filter((c) => c[1] === "restart").length, 1);
  await t.close();
});
