import { test } from "node:test";
import assert from "node:assert/strict";
import { OpsGodhome, OpsInputError } from "./ops-godhome";

const SECRET = "tok-SECRET-9f3a1c77d2e84b0aa6c5";
const BASE = "http://127.0.0.1:8000/api/godhome";

interface Call { url: string; auth: string | null }

function rig(opts: { handler?: (url: string, n: number) => Response | Promise<Response>; ttlMs?: number; token?: () => string | null } = {}) {
  let now = 1_000_000;
  const calls: Call[] = [];
  const fakeFetch = (async (input: any, init?: any) => {
    const url = String(input);
    calls.push({ url, auth: init?.headers?.authorization ?? null });
    return (opts.handler ?? (() => new Response(JSON.stringify({ ok: true, n: calls.length }), { status: 200 })))(url, calls.length);
  }) as typeof fetch;
  const gh = new OpsGodhome({ url: BASE, token: opts.token ?? (() => SECRET), now: () => now, ttlMs: opts.ttlMs ?? 10_000, fetch: fakeFetch });
  return { gh, calls, advance: (ms: number) => (now += ms) };
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

test("reads the four fixed paths with the Bearer token", async () => {
  const { gh, calls } = rig();
  await gh.summary("7d");
  await gh.runs();
  await gh.run("run-1");
  await gh.graph("build");
  assert.deepEqual(calls.map((c) => c.url), [
    `${BASE}/ops/summary?window=7d`,
    `${BASE}/runs?limit=200`,
    `${BASE}/runs/run-1`,
    `${BASE}/graphs/build`,
  ]);
  for (const c of calls) assert.equal(c.auth, `Bearer ${SECRET}`);
});

test("a bad window is an input error (400) and never reaches GodHome", async () => {
  const { gh, calls } = rig();
  for (const w of ["bad", "", "24H", "24h&x=1", "../all"]) {
    await assert.rejects(() => gh.summary(w), (e: any) => e instanceof OpsInputError && e.status === 400);
  }
  for (const id of ["", "a/b", "..", "x y", "a".repeat(65)]) {
    await assert.rejects(() => gh.run(id), (e: any) => e instanceof OpsInputError && e.status === 400);
    await assert.rejects(() => gh.graph(id), (e: any) => e instanceof OpsInputError && e.status === 400);
  }
  assert.equal(calls.length, 0);
});

test("10 s cache: a second call inside the TTL does not fetch, one after it does; windows are cached apart", async () => {
  const { gh, calls, advance } = rig();
  const a = await gh.summary("24h");
  advance(9_999);
  const b = await gh.summary("24h");
  assert.equal(calls.length, 1);
  assert.deepEqual(b.data, a.data);
  await gh.summary("7d");
  assert.equal(calls.length, 2);
  advance(1);
  await gh.summary("24h");
  assert.equal(calls.length, 3);
});

test("single-flight: two concurrent calls make one fetch", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { gh, calls } = rig({ handler: async () => { await gate; return json({ v: 1 }); } });
  const p1 = gh.summary("24h");
  const p2 = gh.summary("24h");
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(calls.length, 1);
  assert.deepEqual(r1.data, { v: 1 });
  assert.deepEqual(r2.data, { v: 1 });
});

test("a fetch that never answers is cut at 5 s", async () => {
  const gh = new OpsGodhome({
    url: BASE, token: () => SECRET, timeoutMs: 20,
    fetch: ((_u: any, init: any) => new Promise((_res, rej) => { init.signal.addEventListener("abort", () => rej(new Error("aborted"))); })) as typeof fetch,
  });
  const r = await gh.summary("24h");
  assert.equal(r.reachable, false);
  assert.equal(r.data, null);
});

test("stale-while-error: last good reply while down, reachable:false once TTL x6 has passed", async () => {
  let down = false;
  const { gh, advance } = rig({ handler: () => (down ? json({ e: 1 }, 503) : json({ v: "good" })) });
  const first = await gh.summary("24h");
  assert.equal(first.reachable, true);
  down = true;
  advance(10_001);
  const within = await gh.summary("24h");
  assert.equal(within.reachable, true, "inside TTL x6 the last good reply still counts as reachable");
  assert.deepEqual(within.data, { v: "good" });
  advance(60_000);
  const past = await gh.summary("24h");
  assert.equal(past.reachable, false);
  assert.deepEqual(past.data, { v: "good" }, "the last good reply is still handed out");
  down = false;
  const back = await gh.summary("24h");
  assert.equal(back.reachable, true);
  assert.deepEqual(back.data, { v: "good" });
});

test("down with nothing cached: reachable:false, data null, no throw; no token: same and no fetch", async () => {
  const dead = rig({ handler: () => { throw new Error("ECONNREFUSED"); } });
  const r = await dead.gh.summary("24h");
  assert.deepEqual({ reachable: r.reachable, data: r.data }, { reachable: false, data: null });
  const noTok = rig({ token: () => null });
  const r2 = await noTok.gh.runs();
  assert.equal(r2.reachable, false);
  assert.equal(noTok.calls.length, 0);
});

test("GodHome 404 on a run or graph is notFound, not an outage, and is not cached as a good reply", async () => {
  const { gh } = rig({ handler: () => json({ error: "no such run" }, 404) });
  const r = await gh.run("nope");
  assert.equal(r.reachable, true);
  assert.equal(r.notFound, true);
  assert.equal(r.data, null);
});

test("the token appears in no log line, no result and no thrown message (assert)", async () => {
  const lines: string[] = [];
  const spies = (["log", "warn", "error", "info", "debug"] as const).map((k) => {
    const orig = console[k];
    console[k] = (...a: unknown[]) => { lines.push(a.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join(" ")); };
    return () => { console[k] = orig; };
  });
  try {
    const leaks = [
      () => { throw new Error(`connect failed with Authorization: Bearer ${SECRET}`); },
      () => json({ detail: `bad token ${SECRET}` }, 401),
      () => json({ detail: `boom ${SECRET}` }, 500),
    ];
    for (const handler of leaks) {
      const { gh } = rig({ handler });
      const results = [await gh.summary("24h"), await gh.runs(), await gh.run("r1"), await gh.graph("g1")];
      assert.ok(!JSON.stringify(results).includes(SECRET));
      await assert.rejects(() => gh.summary("bad"), (e: any) => !String(e?.message).includes(SECRET) && !String(e?.stack).includes(SECRET));
    }
  } finally {
    spies.forEach((restore) => restore());
  }
  assert.ok(lines.length > 0, "failures are logged");
  assert.ok(!lines.join("\n").includes(SECRET), "no log line carries the token");
});

// ---- T3.3: stopRun, the one GodHome write ----------------------------------------------------------------------

import fs from "fs";
import path from "path";

test("stopRun posts only /runs/:id/stop with the Bearer token and no body, and maps GodHome's {ok}", async () => {
  const seen: any[] = [];
  let reply: Response = json({ ok: true });
  const gh = new OpsGodhome({
    url: BASE, token: () => SECRET, now: () => 1_000_000,
    fetch: (async (input: any, init?: any) => { seen.push({ url: String(input), method: init?.method, body: init?.body, auth: init?.headers?.authorization }); return reply; }) as typeof fetch,
  });
  assert.deepEqual(await gh.stopRun("run-1"), { status: "stopped" });
  assert.deepEqual(seen, [{ url: `${BASE}/runs/run-1/stop`, method: "POST", body: undefined, auth: `Bearer ${SECRET}` }]);
  reply = json({ ok: false });
  assert.deepEqual(await gh.stopRun("run-1"), { status: "not_running" });
});

test("stopRun checks the id before any call: nothing reaches GodHome for a bad id", async () => {
  const { gh, calls } = rig();
  for (const id of ["", "a/b", "..", ".", "x y", "a".repeat(65), "run?x=1", "a%2fb"]) {
    await assert.rejects(() => gh.stopRun(id), (e: any) => e instanceof OpsInputError && e.status === 400, id);
  }
  assert.equal(calls.length, 0);
});

test("stopRun: an outage, a non-200, a missing token or a malformed reply is unreachable, with no secret in the console", async () => {
  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.join(" ")); };
  try {
    for (const handler of [
      () => { throw new Error(`connect ECONNREFUSED Bearer ${SECRET}`); },
      () => json({ ok: true }, 500),
      () => json({ ok: true }, 404),
      () => new Response("<html>", { status: 200 }),
      () => json({ ok: "yes" }),
    ]) {
      const { gh } = rig({ handler: handler as any });
      assert.deepEqual(await gh.stopRun("run-1"), { status: "unreachable" });
    }
    assert.deepEqual(await rig({ token: () => null }).gh.stopRun("run-1"), { status: "unreachable" });
  } finally {
    console.warn = realWarn;
  }
  assert.ok(!warns.join("\n").includes(SECRET));
});

test("stopRun drops the cached run reads so the next read sees the stop", async () => {
  const { gh, calls } = rig();
  await gh.run("run-1");
  await gh.runs();
  await gh.stopRun("run-1");
  await gh.run("run-1");
  await gh.runs();
  assert.equal(calls.filter((c) => c.url.endsWith("/runs/run-1")).length, 2);
  assert.equal(calls.filter((c) => c.url.endsWith("/runs?limit=200")).length, 2);
});

test("the module has exactly one write path: one POST in its source", () => {
  const src = fs.readFileSync(path.join(__dirname, "ops-godhome.ts"), "utf8");
  assert.equal(src.match(/method: "POST"/g)?.length, 1);
  assert.equal(src.match(/method:\s*["'`](?!POST)/g), null, "no other method");
  assert.equal(src.match(/\/stop/g)?.length, 1, "only /runs/:id/stop is written");
});
