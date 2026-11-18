import { test } from "node:test";
import assert from "node:assert/strict";
import { GhClient, GhInputError, GH_READS, GH_WRITES, type GhReadKey, type GhWriteKey } from "./client";

interface Call { url: string; init: any }

function client(over: { fetch?: any; token?: string | null; timeoutMs?: number } = {}) {
  const calls: Call[] = [];
  const fetch = over.fetch ?? (async (url: string, init: any) => { calls.push({ url, init }); return { status: 200, json: async () => ({ ok: true }) }; });
  const wrapped = async (url: string, init: any) => { if (!over.fetch) return fetch(url, init); calls.push({ url, init }); return fetch(url, init); };
  const c = new GhClient({ url: "http://127.0.0.1:8000/api/godhome", token: () => (over.token === undefined ? "tok-SECRET-9" : over.token), fetch: wrapped as any, timeoutMs: over.timeoutMs });
  return { c, calls };
}

test("postAgentPrompt: one POST to /herdr/agents/<name>/prompt with the bearer and {text}", async () => {
  const { c, calls } = client();
  assert.deepEqual(await c.postAgentPrompt("Sample", "please continue"), { status: "ok" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://127.0.0.1:8000/api/godhome/herdr/agents/Sample/prompt");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.init.headers.authorization, "Bearer tok-SECRET-9");
  assert.equal(calls[0]!.init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0]!.init.body), { text: "please continue" });
});

test("the name is one path segment: slashes, spaces and dots cannot change the route", async () => {
  const { c, calls } = client();
  await c.postAgentPrompt("w1/../2 x?y#z", "hi");
  assert.equal(calls[0]!.url, "http://127.0.0.1:8000/api/godhome/herdr/agents/w1%2F..%2F2%20x%3Fy%23z/prompt");
  assert.equal((await c.postAgentPrompt("..", "hi")).status, "not_found");
  assert.equal((await c.postAgentPrompt("", "hi")).status, "not_found");
  assert.equal((await c.postAgentPrompt("a\nb", "hi")).status, "not_found");
  assert.equal((await c.postAgentPrompt("n".repeat(201), "hi")).status, "not_found");
  assert.equal(calls.length, 1, "the refused names never reach GodHome");
});

test("text must be 1 to 2000 characters or the call throws before any request", async () => {
  const { c, calls } = client();
  await assert.rejects(() => c.postAgentPrompt("a", ""), GhInputError);
  await assert.rejects(() => c.postAgentPrompt("a", "x".repeat(2001)), GhInputError);
  assert.equal(calls.length, 0);
  assert.deepEqual(await c.postAgentPrompt("a", "x".repeat(2000)), { status: "ok" });
});

test("404 is not_found; any other non-200 is unreachable", async () => {
  for (const [status, want] of [[404, "not_found"], [502, "unreachable"], [500, "unreachable"], [401, "unreachable"]] as const) {
    const { c } = client({ fetch: async () => ({ status, json: async () => ({}) }) });
    assert.equal((await c.postAgentPrompt("a", "hi")).status, want, String(status));
  }
});

test("no token: unreachable and nothing is sent", async () => {
  const { c, calls } = client({ token: null });
  assert.equal((await c.postAgentPrompt("a", "hi")).status, "unreachable");
  assert.equal(calls.length, 0);
});

test("a throwing or hanging GodHome is unreachable; neither the token nor the text reaches a log line", async () => {
  const logs: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    const boom = client({ fetch: async () => { throw new Error("connect ECONNREFUSED Bearer tok-SECRET-9 text=please continue"); } });
    assert.equal((await boom.c.postAgentPrompt("a", "please continue")).status, "unreachable");
    const hang = client({ timeoutMs: 20, fetch: (_url: string, init: any) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))) });
    assert.equal((await hang.c.postAgentPrompt("a", "please continue")).status, "unreachable");
  } finally {
    console.warn = orig;
  }
  assert.ok(logs.length >= 2);
  for (const l of logs) assert.ok(!/tok-SECRET|please continue/.test(l), l);
});

// --- T5.1: the fixed GET table, the cache, and the fixed write table ---

function reader(over: { t?: { v: number }; status?: number; body?: any; token?: string | null; fail?: boolean } = {}) {
  const calls: Call[] = [];
  const clock = over.t ?? { v: 1_000_000 };
  const state = { status: over.status ?? 200, body: over.body ?? { n: 1 }, fail: over.fail ?? false, delay: 0 };
  const fetch = async (url: string, init: any) => {
    calls.push({ url, init });
    if (state.delay) await new Promise((r) => setTimeout(r, state.delay));
    if (state.fail) throw new Error("connect ECONNREFUSED Bearer tok-SECRET-9");
    return { status: state.status, json: async () => state.body };
  };
  const c = new GhClient({ url: "http://127.0.0.1:8000/api/godhome", token: () => (over.token === undefined ? "tok-SECRET-9" : over.token), fetch: fetch as any, now: () => clock.v });
  return { c, calls, clock, state };
}

test("T5.1 the read table is closed: keys outside it, even inherited ones, are refused before any request", async () => {
  const { c, calls } = reader();
  for (const k of ["constructor", "toString", "__proto__", "hasOwnProperty", "tmux/output", "quota?fresh=1", ""]) {
    await assert.rejects(() => c.read(k as any), GhInputError, k);
  }
  assert.equal(calls.length, 0);
  assert.ok(Object.keys(GH_READS).length >= 28, String(Object.keys(GH_READS).length));
});

test("T5.1 every table path is a fixed GodHome GET; quota never carries fresh, tmux has the list only", async () => {
  const { c, calls } = reader();
  for (const k of Object.keys(GH_READS) as GhReadKey[]) {
    calls.length = 0;
    c.invalidate();
    await c.read(k, { name: "build", repo: "demo-site", since: "2026-10-17T00:00:00.000Z", limit: 50 });
    assert.equal(calls.length, 1, k);
    assert.equal(calls[0]!.init.method ?? "GET", "GET", k);
    assert.ok(calls[0]!.url.startsWith("http://127.0.0.1:8000/api/godhome/"), k);
    assert.ok(!/[?&]fresh=/.test(calls[0]!.url), k);
    assert.ok(!/tmux\/(send|key|output|resize|interrupt)|hygiene\/fix$|models\/probe/.test(calls[0]!.url), k);
  }
  calls.length = 0;
  c.invalidate();
  await c.read("quota", { fresh: "1" } as any);
  assert.equal(calls[0]!.url, "http://127.0.0.1:8000/api/godhome/quota");
});

test("T5.1 name and id parameters are one plain segment: dots, slashes and long names throw before any request", async () => {
  const { c, calls } = reader();
  for (const bad of ["..", ".", "a/b", "a b", "", "x".repeat(65), "a\nb", "a?b", "%2e%2e"]) {
    await assert.rejects(() => c.read("graph", { name: bad }), GhInputError, JSON.stringify(bad));
    await assert.rejects(() => c.read("factoryRun", { name: bad }), GhInputError, JSON.stringify(bad));
  }
  await assert.rejects(() => c.read("graph", {}), GhInputError);
  assert.equal(calls.length, 0);
  await c.read("graph", { name: "build-x.1" });
  assert.equal(calls[0]!.url, "http://127.0.0.1:8000/api/godhome/graphs/build-x.1");
  await c.read("factoryRoster", { repo: "demo-site" });
  assert.equal(calls[1]!.url, "http://127.0.0.1:8000/api/godhome/factory/roster?repo=demo-site");
});

test("T5.1 world events: since must be ISO-8601 and limit an integer 1..500, both encoded", async () => {
  const { c, calls } = reader();
  for (const p of [{ since: "yesterday" }, { since: "2026-10-17T00:00:00Z&x=1" }, { limit: 0 }, { limit: 501 }, { limit: 1.5 }, { limit: "5" as any }]) {
    await assert.rejects(() => c.read("worldEvents", p), GhInputError, JSON.stringify(p));
  }
  assert.equal(calls.length, 0);
  await c.read("worldEvents", { since: "2026-10-17T00:00:00.000Z", limit: 50 });
  assert.equal(calls[0]!.url, "http://127.0.0.1:8000/api/godhome/world/events?since=2026-10-17T00%3A00%3A00.000Z&limit=50");
  await c.read("worldEvents", {});
  assert.equal(calls[1]!.url, "http://127.0.0.1:8000/api/godhome/world/events");
});

test("T5.1 10 s cache, single-flight, fresh bypass, and a bounded cache for distinct since values", async () => {
  const { c, calls, clock, state } = reader();
  await c.read("fleetServices");
  await c.read("fleetServices");
  assert.equal(calls.length, 1);
  clock.v += 9_999;
  await c.read("fleetServices");
  assert.equal(calls.length, 1);
  clock.v += 2;
  await c.read("fleetServices");
  assert.equal(calls.length, 2);
  await c.read("fleetServices", {}, { fresh: true });
  assert.equal(calls.length, 3);
  state.delay = 20;
  c.invalidate();
  calls.length = 0;
  const [a, b] = await Promise.all([c.read("monitor"), c.read("monitor")]);
  assert.equal(calls.length, 1);
  assert.deepEqual(a, b);
  state.delay = 0;
  for (let i = 0; i < 300; i++) await c.read("worldEvents", { since: new Date(2_026_000_000_000 + i * 1000).toISOString() });
  assert.ok(c.cacheSize() <= 200, String(c.cacheSize()));
});

test("T5.1 stale-while-error: the last good reply is served and stays reachable for 6 ttl; 404 is notFound; no token is unreachable", async () => {
  const { c, clock, state } = reader();
  const first = await c.read("inbox");
  assert.deepEqual([first.reachable, first.data, first.fetchedAt], [true, { n: 1 }, 1_000_000]);
  state.fail = true;
  clock.v += 20_000;
  const stale = await c.read("inbox");
  assert.deepEqual([stale.reachable, stale.data, stale.fetchedAt], [true, { n: 1 }, 1_000_000]);
  clock.v += 60_000;
  const old = await c.read("inbox");
  assert.deepEqual([old.reachable, old.data], [false, { n: 1 }]);
  const none = await c.read("roles");
  assert.deepEqual([none.reachable, none.data, none.fetchedAt], [false, null, 0]);
  state.fail = false;
  state.status = 404;
  const nf = await c.read("skills");
  assert.deepEqual([nf.reachable, nf.data, nf.notFound], [true, null, true]);
  state.status = 500;
  assert.equal((await c.read("costs")).reachable, false);
  const t = reader({ token: null });
  assert.equal((await t.c.read("models")).reachable, false);
  assert.equal(t.calls.length, 0);
});

test("T5.1 the token and the request headers reach no log line and no error message", async () => {
  const logs: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    const { c } = reader({ fail: true });
    assert.equal((await c.read("network")).reachable, false);
    const r2 = reader({ status: 502 });
    assert.equal((await r2.c.read("network")).reachable, false);
    for (const bad of [() => c.read("graph", { name: "../tok-SECRET-9" }), () => c.write("nope" as any, {})]) {
      await assert.rejects(bad, (e: Error) => { assert.ok(!/tok-SECRET/.test(e.message), e.message); return true; });
    }
  } finally {
    console.warn = orig;
  }
  assert.ok(logs.length >= 2);
  for (const l of logs) assert.ok(!/tok-SECRET|Bearer|ECONNREFUSED/.test(l), l);
});

test("T5.1 projects?refresh=1 has its own key and a 60 s floor; before the floor the plain cached list is served", async () => {
  const { c, calls, clock } = reader();
  await c.read("projectsRefresh");
  assert.equal(calls[0]!.url, "http://127.0.0.1:8000/api/godhome/projects?refresh=1");
  clock.v += 30_000;
  await c.read("projectsRefresh");
  assert.equal(calls[1]!.url, "http://127.0.0.1:8000/api/godhome/projects", "inside the floor: no refresh");
  clock.v += 31_000;
  await c.read("projectsRefresh");
  assert.equal(calls[2]!.url, "http://127.0.0.1:8000/api/godhome/projects?refresh=1");
  for (const k of Object.keys(GH_READS) as GhReadKey[]) if (k !== "projectsRefresh") assert.ok(!/refresh/.test(GH_READS[k]({ name: "a", repo: "a" })), k);
});

test("T5.1 the write table lists exactly the 004 GodHome writes: no tmux send/key/output, probe, hygiene fix, mission or graph edit", () => {
  assert.deepEqual(Object.keys(GH_WRITES).sort(), [
    "cardDelete", "cardMove", "factoryRun", "graphRun", "inboxDismiss", "launchStop", "lessonApprove", "lessonReject", "modelEnabled",
    "networkRefresh", "servicesRefresh", "sitesRefresh", "terminalKill", "triggerDelete", "triggerFire", "triggerReset",
  ]);
  for (const k of Object.keys(GH_WRITES) as GhWriteKey[]) {
    const path = GH_WRITES[k].path(["a", "b"]);
    assert.ok(!/tmux\/(send|key|output|resize|interrupt)|hygiene|probe|missions|\/graphs$/.test(path), path);
  }
});

test("T5.1 write: fixed method and path, segments encoded, bodies built from allowlists; merge:true is ignored", async () => {
  const { c, calls } = reader({ body: { ok: true } });
  assert.deepEqual(await c.write("cardMove", { seg: ["col a", "f/x.md"], body: { to: "done", evil: 1 } as any }), { status: "ok", json: { ok: true } });
  assert.equal(calls[0]!.url, "http://127.0.0.1:8000/api/godhome/factory/kanban/col%20a/f%2Fx.md/move");
  assert.equal(calls[0]!.init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0]!.init.body), { to: "done" });
  assert.equal(calls[0]!.init.headers.authorization, "Bearer tok-SECRET-9");
  await c.write("factoryRun", { body: { ticket: "t", repo: "r", stages: "plan,build", adw: "auto", merge: true, architect: "x" } as any });
  assert.deepEqual(JSON.parse(calls[1]!.init.body), { ticket: "t", repo: "r", stages: "plan,build", adw: "auto", merge: false });
  await c.write("factoryRun", { body: { ticket: "t", repo: "r" } });
  assert.deepEqual(JSON.parse(calls[2]!.init.body), { ticket: "t", repo: "r", merge: false });
  await c.write("lessonReject", { seg: ["l1"] });
  assert.equal(calls[3]!.init.method, "DELETE");
  assert.equal(calls[3]!.url, "http://127.0.0.1:8000/api/godhome/playbook/l1");
  await c.write("modelEnabled", { body: { id: "prov/model-x", enabled: false } });
  assert.deepEqual(JSON.parse(calls[4]!.init.body), { id: "prov/model-x", enabled: false });
  await c.write("inboxDismiss", { body: { kind: "failed-run", title: "nightly", at: "2026-10-17T12:00:00.000Z", detail: "x" } as any });
  assert.deepEqual(JSON.parse(calls[5]!.init.body), { kind: "failed-run", title: "nightly", at: "2026-10-17T12:00:00.000Z" });
  await c.write("networkRefresh", {});
  assert.equal(calls[6]!.url, "http://127.0.0.1:8000/api/godhome/network/refresh");
  assert.equal(calls[6]!.init.body, undefined);
});

test("T5.1 write: bad segments throw, statuses map to ok / not_found / rejected / unreachable", async () => {
  const { c, calls, state } = reader({ body: { ok: true } });
  for (const seg of [[".."], [""], ["a\nb"], ["x".repeat(201)], []]) await assert.rejects(() => c.write("triggerFire", { seg }), GhInputError, JSON.stringify(seg));
  await assert.rejects(() => c.write("cardMove", { seg: ["a", "b"], body: { to: 5 as any } }), GhInputError);
  await assert.rejects(() => c.write("factoryRun", { body: { ticket: "", repo: "r" } }), GhInputError);
  assert.equal(calls.length, 0);
  for (const [status, want] of [[404, "not_found"], [400, "rejected"], [502, "unreachable"], [401, "unreachable"]] as const) {
    state.status = status;
    assert.equal((await c.write("triggerFire", { seg: ["t1"] })).status, want, String(status));
  }
  state.fail = true;
  assert.equal((await c.write("triggerFire", { seg: ["t1"] })).status, "unreachable");
  assert.equal((await reader({ token: null }).c.write("triggerFire", { seg: ["t1"] })).status, "unreachable");
  await assert.rejects(() => c.write("constructor" as any, {}), GhInputError);
});

test("T5.1 a successful write drops the cached reads", async () => {
  const { c, calls } = reader({ body: { ok: true } });
  await c.read("triggers");
  await c.read("triggers");
  assert.equal(calls.length, 1);
  await c.write("triggerReset", { seg: ["t1"] });
  await c.read("triggers");
  assert.equal(calls.length, 3);
});
