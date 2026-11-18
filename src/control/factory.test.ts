import { test } from "node:test";
import assert from "node:assert/strict";
import { Factory } from "./factory";
import { controlApp } from "./test-app";
import { NO_FIX, NO_HOLDOUT, fake, ok, status, ticket } from "./factory-test-util";

test("status maps field by field and drops unknown fields", async () => {
  const f = fake(() => ok(status({ secretField: "x", tickets: [ticket({ extra: "no", columnNote: "no" })] })));
  const s = await new Factory({ exec: f.exec }).status();
  assert.deepEqual(f.calls, [["status", "--json"]]);
  assert.equal(s.reachable, true);
  assert.equal(s.target, "main");
  assert.deepEqual(s.counts, { backlog: 1, blocked: 2, inProgress: 3, done: 4, failed: 5 });
  assert.deepEqual(s.tickets, [{ ...ticket(), steps: [], fix: NO_FIX }]);
  assert.deepEqual(s.merges, status().merges);
  assert.deepEqual(s.alerts, status().alerts);
  assert.ok(!("secretField" in s));
});

test("status redacts every string and caps lengths and list sizes", async () => {
  const long = "x".repeat(500);
  const tickets = Array.from({ length: 150 }, (_, i) => ticket({ id: `t${i}` }));
  tickets[0] = ticket({ id: "t0", title: long, error: "API_TOKEN=abc123 " + long, epic: long });
  const merges = Array.from({ length: 30 }, () => status().merges[0]);
  const alerts = Array.from({ length: 30 }, () => ({ ...status().alerts[0], message: "Bearer abcdef0123456789abcdef " + long }));
  const s = await new Factory({ exec: fake(() => ok(status({ tickets, merges, alerts }))).exec }).status();
  assert.equal(s.tickets.length, 100);
  assert.equal(s.merges.length, 20);
  assert.equal(s.alerts.length, 20);
  assert.equal(s.tickets[0].title.length, 120);
  assert.equal(s.tickets[0].epic!.length, 64);
  assert.ok(s.tickets[0].error!.length <= 300);
  assert.ok(s.tickets[0].error!.startsWith("API_TOKEN=[redacted]"));
  assert.ok(s.alerts[0].message.length <= 300);
  assert.ok(s.alerts[0].message.startsWith("Bearer [redacted]"));
});

test("status drops malformed rows and coerces bad enums", async () => {
  const s = await new Factory({
    exec: fake(() => ok(status({
      tickets: [ticket({ id: "../etc" }), ticket({ id: "a b" }), ticket({ id: "ok", column: "weird" }),
        ticket({ id: "good", column: "in-progress", rounds: -3, mergeOutcome: "nope", dependsOn: ["x", "bad id", 7] })],
      merges: [{ at: "t", ticket: "good", branch: "b", outcome: "exploded", commit: null }, ...status().merges],
      alerts: [{ at: "t", level: "fatal", ticket: "no spaces", message: "m" }],
    }))).exec,
  }).status();
  assert.deepEqual(s.tickets.map((t) => t.id), ["good"]);
  assert.equal(s.tickets[0].rounds, 0);
  assert.equal(s.tickets[0].mergeOutcome, "error");
  assert.deepEqual(s.tickets[0].dependsOn, ["x"]);
  assert.deepEqual(s.merges.map((m) => m.outcome), ["error", "merged"]);
  assert.equal(s.alerts[0].level, "warn");
  assert.equal(s.alerts[0].ticket, null);
});

test("merge outcome accepts error and maps unknown strings to error", async () => {
  const s = await new Factory({
    exec: fake(() => ok(status({
      tickets: ["merged", "conflict", "gate", "protected", "error", "weird", null].map((o, i) =>
        ticket({ id: `t${i}`, column: "done", mergeOutcome: o })),
      merges: ["merged", "conflict", "gate", "protected", "error", "weird"].map((o, i) =>
        ({ at: "t", ticket: `t${i}`, branch: "b", outcome: o, commit: null })),
    }))).exec,
  }).status();
  assert.deepEqual(s.tickets.map((t) => t.mergeOutcome), ["merged", "conflict", "gate", "protected", "error", "error", null]);
  assert.deepEqual(s.merges.map((m) => m.outcome), ["merged", "conflict", "gate", "protected", "error", "error"]);
});

test("ticket validation maps pass/fail/skipped, anything else or missing to null", async () => {
  const missing: any = ticket({ id: "none" });
  delete missing.validation;
  const s = await new Factory({
    exec: fake(() => ok(status({
      tickets: [...["pass", "fail", "skipped", "PASS", "ok", 1, true, "", null].map((v, i) => ticket({ id: `t${i}`, validation: v })), missing],
    }))).exec,
  }).status();
  assert.deepEqual(s.tickets.map((t) => t.validation), ["pass", "fail", "skipped", null, null, null, null, null, null, null]);
});

test("holdout maps epic, counts and time; missing or invalid gives all null", async () => {
  const hold = async (holdout: unknown) =>
    (await new Factory({ exec: fake(() => ok(status({ holdout }))).exec }).status()).holdout;
  assert.deepEqual(await hold({ epic: "auth-v1", passed: 7, failed: 0, at: "2026-10-16T12:00:00Z", extra: "no" }),
    { epic: "auth-v1", passed: 7, failed: 0, at: "2026-10-16T12:00:00Z" });
  assert.deepEqual(await hold(undefined), NO_HOLDOUT);
  for (const bad of [null, "x", 5, [1, 2], {}]) assert.deepEqual(await hold(bad), NO_HOLDOUT, JSON.stringify(bad));
  assert.deepEqual(await hold({ epic: 3, passed: -1, failed: 1.5, at: 7 }), NO_HOLDOUT);
  assert.deepEqual(await hold({ epic: "", passed: "4", failed: null, at: "" }), NO_HOLDOUT);
  const long = await hold({ epic: "API_TOKEN=abc123 " + "x".repeat(200), passed: 1, failed: 2, at: "t" });
  assert.ok(long.epic!.length <= 64);
  assert.ok(long.epic!.startsWith("API_TOKEN=[redacted]"));
  assert.deepEqual([long.passed, long.failed, long.at], [1, 2, "t"]);
});

test("unreachable (exec throws, non-zero exit) gives reachable:false with zeros", async () => {
  const down = { reachable: false, generatedAt: null, target: null, paused: false, holdout: NO_HOLDOUT,
    counts: { backlog: 0, blocked: 0, inProgress: 0, done: 0, failed: 0 }, tickets: [], merges: [], alerts: [] };
  assert.deepEqual(await new Factory({ exec: fake(() => new Error("ssh: timeout")).exec }).status(), down);
  assert.deepEqual(await new Factory({ exec: fake(() => ({ code: 255, stdout: "" })).exec }).status(), down);
});

test("bad JSON or a non-object gives reachable:false", async () => {
  for (const stdout of ["not json", "", "[1,2]", "null"]) {
    const s = await new Factory({ exec: fake(() => ({ code: 0, stdout })).exec }).status();
    assert.equal(s.reachable, false, stdout);
    assert.deepEqual(s.tickets, []);
  }
});

test("a second status within the TTL is served from cache; after it, exec runs again", async () => {
  let t = 1_000;
  const f = fake(() => ok(status()));
  const fac = new Factory({ exec: f.exec, now: () => t });
  await fac.status();
  t += 14_000;
  await fac.status();
  assert.equal(f.calls.length, 1);
  t += 2_000;
  await fac.status();
  assert.equal(f.calls.length, 2);
});

test("concurrent status calls share one exec", async () => {
  const f = fake(() => ok(status()));
  const fac = new Factory({ exec: f.exec });
  await Promise.all([fac.status(), fac.status(), fac.status()]);
  assert.equal(f.calls.length, 1);
});

test("failedCount reads counts.failed, 0 when unreachable", async () => {
  assert.equal(await new Factory({ exec: fake(() => ok(status())).exec }).failedCount(), 5);
  assert.equal(await new Factory({ exec: fake(() => ({ code: 255, stdout: "" })).exec }).failedCount(), 0);
});

test("retry: 200, 404 unknown, 409 not failed, 503 unreachable", async () => {
  const msg = (ok: boolean, message: string) => JSON.stringify({ ok, message }) + "\n";
  const f = new Factory({ exec: fake(() => ({ code: 0, stdout: msg(true, "moved") })).exec });
  assert.deepEqual(await f.retry("007-login-form"), { status: 200, body: { ok: true } });
  assert.equal((await new Factory({ exec: fake(() => ({ code: 2, stdout: msg(false, "unknown ticket 009") })).exec }).retry("009")).status, 404);
  assert.equal((await new Factory({ exec: fake(() => ({ code: 2, stdout: msg(false, "ticket 007 is not failed") })).exec }).retry("007")).status, 409);
  assert.equal((await new Factory({ exec: fake(() => ({ code: 255, stdout: "" })).exec }).retry("007")).status, 503);
  assert.equal((await new Factory({ exec: fake(() => new Error("timeout")).exec }).retry("007")).status, 503);
});

test("retry drops the cache so the next status is fresh", async () => {
  const f = fake((a) => (a[0] === "retry" ? { code: 0, stdout: '{"ok":true,"message":"m"}\n' } : ok(status())));
  const fac = new Factory({ exec: f.exec });
  await fac.status();
  await fac.retry("007-login-form");
  await fac.status();
  assert.deepEqual(f.calls.map((c) => c[0]), ["status", "retry", "status"]);
  assert.deepEqual(f.calls[1], ["retry", "007-login-form"]);
});

test("pause and resume: 200 {paused}, 503 when unreachable", async () => {
  const f = fake(() => ({ code: 0, stdout: '{"ok":true,"message":"m"}\n' }));
  const fac = new Factory({ exec: f.exec });
  assert.deepEqual(await fac.setPaused(true), { status: 200, body: { paused: true } });
  assert.deepEqual(await fac.setPaused(false), { status: 200, body: { paused: false } });
  assert.deepEqual(f.calls, [["pause"], ["resume"]]);
  assert.equal((await new Factory({ exec: fake(() => ({ code: 255, stdout: "" })).exec }).setPaused(true)).status, 503);
});

test("an invalid ticket id never reaches exec", async () => {
  const f = fake(() => ok(status()));
  const fac = new Factory({ exec: f.exec });
  for (const id of ["", "a b", "a;rm -rf", "$(x)", "a/b", "../x", "-rf", "--help", ".", "x".repeat(65), "a\nb"]) {
    assert.equal((await fac.retry(id)).status, 404, JSON.stringify(id));
  }
  assert.deepEqual(f.calls, []);
});

test("routes: GET /factory, retry, pause, resume, and /counts factoryFailed", async () => {
  const f = fake((a) => (a[0] === "status" ? ok(status()) : { code: 0, stdout: '{"ok":true,"message":"m"}\n' }));
  const s = await controlApp({ factory: new Factory({ exec: f.exec }) });
  const g = await s.get("/factory");
  assert.equal(g.status, 200);
  assert.equal(g.json.reachable, true);
  assert.equal(g.json.tickets[0].id, "007-login-form");
  assert.equal((await s.get("/counts")).json.factoryFailed, 5);
  assert.deepEqual((await s.post("/factory/tickets/007-login-form/retry")).json, { ok: true });
  assert.deepEqual((await s.post("/factory/pause")).json, { paused: true });
  assert.deepEqual((await s.post("/factory/resume")).json, { paused: false });
  const bad = await s.post("/factory/tickets/a%20b/retry");
  assert.equal(bad.status, 404);
  assert.equal(bad.json.error.code, "not_found");
  await s.close();
});

test("routes: 409 and 503 use the error body; routes need a device token", async () => {
  const f = fake((a) => (a[0] === "retry" ? { code: 2, stdout: '{"ok":false,"message":"not failed"}\n' } : { code: 255, stdout: "" }));
  const s = await controlApp({ factory: new Factory({ exec: f.exec }) });
  const conflict = await s.post("/factory/tickets/x/retry");
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, "conflict");
  const down = await s.post("/factory/pause");
  assert.equal(down.status, 503);
  assert.equal(down.json.error.code, "unavailable");
  const g = await s.get("/factory");
  assert.equal(g.status, 200);
  assert.equal(g.json.reachable, false);
  assert.equal((await s.srv.call("GET", "/control-api/v1/factory")).status, 401);
  assert.equal((await s.srv.call("POST", "/control-api/v1/factory/pause", {})).status, 401);
  await s.close();
});

test("without a Factory the routes are absent and /counts has factoryFailed 0", async () => {
  const s = await controlApp({});
  assert.equal((await s.get("/factory")).status, 404);
  assert.equal((await s.get("/counts")).json.factoryFailed, 0);
  await s.close();
});
