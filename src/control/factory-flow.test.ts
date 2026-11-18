import { test } from "node:test";
import assert from "node:assert/strict";
import { Factory } from "./factory";
import { controlApp } from "./test-app";
import { NO_FIX, fake, fixOf, ok, status, step, ticket } from "./factory-test-util";

test("ticket steps and fix keep the contract fields and drop unknown ones", async () => {
  const s = await new Factory({
    exec: fake(() => ok(status({ tickets: [ticket({ steps: [step({ extra: "no" }), step({ name: "fix", kind: "fix", round: null, state: "running", ms: null, endedAt: null })],
      fix: { ...fixOf(), pid: 4242, secret: "no" } })] }))).exec,
  }).status();
  assert.deepEqual(s.tickets[0].steps, [step(), step({ name: "fix", kind: "fix", round: null, state: "running", ms: null, endedAt: null })]);
  assert.deepEqual(s.tickets[0].fix, fixOf());
});

test("steps with an unknown kind or state are dropped, never the ticket", async () => {
  const s = await new Factory({
    exec: fake(() => ok(status({ tickets: [ticket({ steps: [step({ kind: "evil" }), step({ state: "weird" }), step({ name: 5 }), "x", null,
      step({ name: "gate-1", kind: "gate" })] })] }))).exec,
  }).status();
  assert.equal(s.tickets.length, 1);
  assert.deepEqual(s.tickets[0].steps.map((x) => x.name), ["gate-1"]);
});

test("steps are redacted, cut to 200, capped at 60; bad numbers become null", async () => {
  const many = Array.from({ length: 70 }, (_, i) => step({ name: `s${i}` }));
  many[0] = step({ summary: "API_TOKEN=abc123 " + "x".repeat(400), round: 0, ms: -1 });
  many[1] = step({ round: 1.5, ms: "5", startedAt: 7 });
  const s = await new Factory({ exec: fake(() => ok(status({ tickets: [ticket({ steps: many })] }))).exec }).status();
  const st = s.tickets[0].steps;
  assert.equal(st.length, 60);
  assert.ok(st[0].summary.length <= 200);
  assert.ok(st[0].summary.startsWith("API_TOKEN=[redacted]"));
  assert.deepEqual([st[0].round, st[0].ms], [null, null]);
  assert.deepEqual([st[1].round, st[1].ms, st[1].startedAt], [null, null, null]);
});

test("fix coerces bad enums and non-objects to the default fix object", async () => {
  const fix = async (v: unknown) =>
    (await new Factory({ exec: fake(() => ok(status({ tickets: [ticket({ fix: v })] }))).exec }).status()).tickets[0].fix;
  for (const bad of [undefined, null, "x", 5, [1], {}]) assert.deepEqual(await fix(bad), NO_FIX, JSON.stringify(bad));
  assert.deepEqual(await fix(fixOf({ runtime: "gpt", state: "weird", attempts: -2, auto: "yes", runId: 3 })),
    { ...NO_FIX, runtime: null, state: "none", attempts: 0, auto: false, startedAt: "2026-10-16T12:02:00Z" });
});

const flowJson = (over: Record<string, unknown> = {}) => ({
  id: "007-login-form", column: "failed", steps: [step()], fix: fixOf(), logs: { gate: "g", merge: "m", fix: "f" }, ...over,
});

test("flow maps strictly, redacts and cuts the log tails to 4000", async () => {
  const f = fake(() => ok(flowJson({ extra: "no", logs: { gate: "API_TOKEN=abc123 " + "x".repeat(5000), merge: 3, fix: "ok", other: "no" },
    steps: [step({ kind: "evil" }), step()] })));
  const out = await new Factory({ exec: f.exec }).flow("007-login-form");
  assert.deepEqual(f.calls, [["flow", "007-login-form", "--json"]]);
  assert.equal(out.status, 200);
  const b: any = out.body;
  assert.deepEqual(Object.keys(b).sort(), ["column", "fix", "id", "logs", "steps"]);
  assert.deepEqual(b.steps, [step()]);
  assert.deepEqual(b.fix, fixOf());
  assert.deepEqual(Object.keys(b.logs), ["gate", "merge", "fix"]);
  assert.equal(b.logs.gate.length, 4000);
  assert.ok(b.logs.gate.startsWith("API_TOKEN=[redacted]"));
  assert.deepEqual([b.logs.merge, b.logs.fix], ["", "ok"]);
});

test("flow: 404 on exit 2, 503 on ssh failure or unusable output", async () => {
  assert.equal((await new Factory({ exec: fake(() => ({ code: 2, stdout: "" })).exec }).flow("nope")).status, 404);
  assert.equal((await new Factory({ exec: fake(() => ({ code: 255, stdout: "" })).exec }).flow("x")).status, 503);
  assert.equal((await new Factory({ exec: fake(() => new Error("timeout")).exec }).flow("x")).status, 503);
  assert.equal((await new Factory({ exec: fake(() => ({ code: 0, stdout: "not json" })).exec }).flow("x")).status, 503);
  assert.equal((await new Factory({ exec: fake(() => ok(flowJson({ column: "weird" }))).exec }).flow("x")).status, 503);
});

test("fix passes argv exactly and returns the started object", async () => {
  const started = (runtime: string) => ({ started: true, ticket: "007-login-form", runtime, fixRunId: "fix-9", extra: "no" });
  const f = fake((a) => ok(started(a[3])));
  const fac = new Factory({ exec: f.exec });
  assert.deepEqual(await fac.fix("007-login-form", "claude"), { status: 200, body: { started: true, ticket: "007-login-form", runtime: "claude", fixRunId: "fix-9" } });
  assert.equal((await fac.fix("007-login-form", "agent")).status, 200);
  assert.deepEqual(f.calls, [["fix", "007-login-form", "--runtime", "claude", "--json"], ["fix", "007-login-form", "--runtime", "agent", "--json"]]);
});

test("fix: 404 unknown, 409 bad state, 409 fix_running on exit 3, 503 unreachable", async () => {
  const msg = (m: string) => JSON.stringify({ ok: false, message: m }) + "\n";
  const run = (r: { code: number; stdout: string } | Error) => new Factory({ exec: fake(() => r).exec }).fix("007", "claude");
  assert.equal((await run({ code: 2, stdout: msg("unknown ticket 007") })).status, 404);
  assert.equal((await run({ code: 2, stdout: msg("ticket 007 is not failed") })).status, 409);
  assert.deepEqual(await run({ code: 3, stdout: msg("fix already running") }), { status: 409, body: { error: "fix_running" } });
  assert.equal((await run({ code: 255, stdout: "" })).status, 503);
  assert.equal((await run(new Error("timeout"))).status, 503);
  assert.equal((await run({ code: 0, stdout: "not json" })).status, 503);
});

test("fix drops the status cache; a bad id never reaches exec", async () => {
  const f = fake((a) => (a[0] === "fix" ? ok({ started: true, ticket: "x", runtime: "claude", fixRunId: "r" }) : ok(status())));
  const fac = new Factory({ exec: f.exec });
  await fac.status();
  await fac.fix("x", "claude");
  await fac.status();
  assert.deepEqual(f.calls.map((c) => c[0]), ["status", "fix", "status"]);
  const g = fake(() => ok(status()));
  const bad = new Factory({ exec: g.exec });
  for (const id of ["", "a b", "a;rm -rf", "$(x)", "a/b", "../x", "-rf", "--help", ".", "x".repeat(65), "a\nb"]) {
    assert.equal((await bad.fix(id, "claude")).status, 404, JSON.stringify(id));
    assert.equal((await bad.flow(id)).status, 404, JSON.stringify(id));
  }
  assert.deepEqual(g.calls, []);
});

test("routes: GET flow and POST fix map statuses and validate the runtime", async () => {
  const f = fake((a) => {
    if (a[0] === "flow") return a[1] === "gone" ? { code: 2, stdout: "" } : ok(flowJson());
    if (a[0] === "fix") return a[1] === "busy" ? { code: 3, stdout: "" } : ok({ started: true, ticket: a[1], runtime: a[3], fixRunId: "fix-2" });
    return ok(status());
  });
  const s = await controlApp({ factory: new Factory({ exec: f.exec }) });
  const g = await s.get("/factory/tickets/007-login-form/flow");
  assert.equal(g.status, 200);
  assert.equal(g.json.logs.gate, "g");
  const nf = await s.get("/factory/tickets/gone/flow");
  assert.equal(nf.status, 404);
  assert.equal(nf.json.error.code, "not_found");
  assert.equal((await s.get("/factory/tickets/a%20b/flow")).status, 404);
  assert.deepEqual((await s.post("/factory/tickets/007-login-form/fix")).json,
    { started: true, ticket: "007-login-form", runtime: "claude", fixRunId: "fix-2" });
  assert.equal((await s.post("/factory/tickets/007-login-form/fix", { runtime: "agent" })).json.runtime, "agent");
  for (const runtime of ["gpt", "", 5, null, ["claude"]]) assert.equal((await s.post("/factory/tickets/007-login-form/fix", { runtime })).status, 400, JSON.stringify(runtime));
  const busy = await s.post("/factory/tickets/busy/fix");
  assert.equal(busy.status, 409);
  assert.deepEqual(busy.json, { error: "fix_running" });
  assert.equal((await s.post("/factory/tickets/a%20b/fix")).status, 404);
  assert.deepEqual(f.calls.filter((c) => c[0] === "fix").map((c) => c.slice(0, 4)),
    [["fix", "007-login-form", "--runtime", "claude"], ["fix", "007-login-form", "--runtime", "agent"], ["fix", "busy", "--runtime", "claude"]]);
  assert.equal((await s.srv.call("GET", "/control-api/v1/factory/tickets/x/flow")).status, 401);
  assert.equal((await s.srv.call("POST", "/control-api/v1/factory/tickets/x/fix", {})).status, 401);
  await s.close();
});

test("routes: flow and fix answer 503 when the Mac is off", async () => {
  const s = await controlApp({ factory: new Factory({ exec: fake(() => ({ code: 255, stdout: "" })).exec }) });
  assert.equal((await s.get("/factory/tickets/x/flow")).status, 503);
  const d = await s.post("/factory/tickets/x/fix");
  assert.equal(d.status, 503);
  assert.equal(d.json.error.code, "unavailable");
  await s.close();
});
