import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { controlApp } from "../test-app";
import { OpsStore } from "../ops-store";
import type { Cap } from "../store";
import { GhIds } from "./ids";
import { ghRoutes, type GhDeps } from "./index";
import { assertWithinExample, fakeGh } from "./test-support";

const NOW = Date.parse("2026-10-17T13:00:00Z");

async function setup(caps: Cap[] = ["ops:read", "ops:write"]) {
  const db = new Database(":memory:");
  const ops = new OpsStore(db);
  const gh = fakeGh(() => NOW);
  const deps: GhDeps = { client: gh, ids: new GhIds(db), ops, allowlist: () => [], now: () => NOW };
  const t = await controlApp({ gh: deps }, db);
  t.store.setCaps(t.store.listDevices()[0]!.id, caps);
  const audits = () => db.prepare("SELECT action, subject, result FROM control_ops_audit ORDER BY id").all() as { action: string; subject: string; result: string }[];
  return { ...t, gh, deps, audits };
}

const INBOX = { items: [
  { kind: "failed-run", title: "nightly-check", at: "2026-10-17T12:00:00.000Z", runId: "run-0123", detail: "Error: ENOENT /root/app/data.json sk-live-abcdefghijklmnop" },
  { kind: "unit-failed", title: "pi-dashboard | x", at: "2026-10-17T12:05:00.000Z", detail: "d" },
] };

test("T5.3 K9, K10, K12, K14 map to exactly the contract example's fields", async () => {
  const t = await setup(["ops:read"]);
  t.gh.bodies.inbox = INBOX;
  for (const [code, path] of [["K9", "/ops/gh/world"], ["K10", "/ops/gh/control"], ["K12", "/ops/gh/inbox"], ["K14", "/ops/gh/hygiene"]] as const) {
    const r = await t.get(path);
    assert.equal(r.status, 200, code);
    assert.equal(r.json.reachable, true, code);
    // The example maps the first two list items only; a field first seen in a later item is allowed by name.
    assertWithinExample(code, r.json, ["needsYou[].tab", "sites[].git.ahead", "sites[].git.behind", "workers[].source", "workers[].host"]);
  }
  await t.close();
});

test("T5.3 world: the life block, urls, by_host and refs never leave; events are paged by since and limit", async () => {
  const t = await setup(["ops:read"]);
  t.gh.bodies.worldState = {
    hosts: [{ id: "server", name: "server", up: true, addr: "100.64.0.1" }],
    projects: [{ slug: "app", host: "server", kind: "repo", status: "up", url: "https://x.example/", last_event_ts: "t", counts: { done: 1, failed: 2 }, xp: 3, kinds: { worker: 1 }, work_30d: 4, by_host: { mac: {} } }],
    needs_you: [{ project: "app", title: "Review /root/app/x/y", since: "t", detail: "d" }],
    workers: [{ id: "w1", label: "w", model: "m", project: "app", source: "herdr", started: "t", status: "running", host: "server", cwd: "/root/app" }],
    life: { income: { USD: 1234 }, shop: { total: 5 }, whatsapp: { unread: 3 }, habits: [{ name: "pray" }] },
  };
  t.gh.bodies.worldEvents = { events: [{ id: "e1", ts: "2026-10-17T12:00:00.000Z", kind: "worker", host: "server", project: "app", status: "up", title: "Did a thing at /root/app/x", ref: "r", url: "https://y.example/", actor: "a", model: "m", source: "s", cost: 1, dur_s: 2 }] };
  const w = (await t.get("/ops/gh/world?since=2026-10-17T11:00:00.000Z&limit=20")).json;
  const dump = JSON.stringify(w);
  assert.ok(!/life|income|1234|whatsapp|habits|pray|https?:|by_host|kinds|100\.64|\/root\/|addr|cwd|"ref"|"url"/.test(dump), dump);
  assert.deepEqual(w.projects[0], { slug: "app", status: "up", kind: "repo", host: "server", work_30d: 4, xp: 3, counts: { done: 1, failed: 2 }, lastEventAt: "t" });
  assert.match(w.events[0].id, /^g_[0-9a-f]{12}$/);
  assert.match(w.workers[0].id, /^g_[0-9a-f]{12}$/);
  assert.deepEqual(t.gh.reads.at(-1), { key: "worldEvents", params: { since: "2026-10-17T11:00:00.000Z", limit: 20 }, fresh: false });
  await t.get("/ops/gh/world");
  assert.deepEqual(t.gh.reads.at(-1)!.params, { limit: 50 });
  for (const q of ["since=yesterday", "limit=0", "limit=501", "limit=abc", "limit=1.5", "since=2026-10-17T00:00:00Z%26x%3D1"]) {
    const r = await t.get(`/ops/gh/world?${q}`);
    assert.equal(r.status, 400, q);
    assert.equal(r.json.error.code, "bad_request", q);
  }
  await t.close();
});

test("T5.3 control: sites keep status, latency and git facts; missions are {missionId, project, state} linking to /offers", async () => {
  const t = await setup(["ops:read"]);
  t.gh.bodies.control = {
    sites: { sites: [{ name: "shop", repo: "/root/shop", url: "https://shop.example/", notes: "n", deploy: "ok", health: { url: "https://shop.example/", state: "ok", detail: "d", ms: 40 }, git: { branch: "main", dirty: 1, commit: "abc", ago: "2h", subject: "fix /root/x/y", ahead: 1, behind: 0 } }] },
    missions: { missions: [
      { id: "m_01ab", project: "app", sender: "+971500000000", state: "pending", engine: "claude", prompt: "do the thing", answered_by: "x", branch: "b", tmux_session: "s", result: "r", created_at: 1, updated_at: 2, hold_reason: "h" },
      { id: "bad id/../x", project: "app", state: "pending" },
      { id: "m_02cd", project: "shop", state: "failed" },
    ] },
    needsYou: [{ severity: "critical", kind: "site-down", tab: "control", title: "Site shop is down", detail: "d /root/x/y" }],
    overview: { agents: { data: [{ pid: 1, detail: "/root/a/b" }] } },
  };
  const c = (await t.get("/ops/gh/control")).json;
  assert.deepEqual(c.missions, [{ missionId: "m_01ab", project: "app", state: "pending" }, { missionId: "m_02cd", project: "shop", state: "failed" }]);
  assert.deepEqual(c.sites[0], { name: "shop", deploy: "ok", health: { state: "ok", ms: 40 }, git: { branch: "main", commit: "abc", ahead: 1, behind: 0, dirty: 1, ago: "2h" } });
  assert.deepEqual(c.needsYou, [{ kind: "site-down", severity: "critical", tab: "control", title: "Site shop is down" }]);
  assert.ok(!/971500|do the thing|shop\.example|\/root\/|tmux|overview|pid/.test(JSON.stringify(c)), JSON.stringify(c));
  await t.close();
});

test("T5.3 there is no GodHome mission write: nothing under /ops/gh/control answers or sends a mission answer", async () => {
  const t = await setup();
  for (const p of ["/ops/gh/control/missions/m_01ab/approve", "/ops/gh/control/missions/m_01ab/skip", "/ops/gh/control/missions/m_01ab/answer"]) {
    const r = await t.post(p);
    assert.notEqual(r.status, 200, p);
  }
  assert.deepEqual(t.gh.writes, []);
  await t.close();
});

test("T5.3 K11: refresh the sites with ops:write, audited, 1 per 60 s", async () => {
  const ro = await setup(["ops:read"]);
  assert.equal((await ro.post("/ops/gh/control/sites/refresh")).status, 403);
  await ro.close();
  const t = await setup();
  assert.deepEqual([(await t.post("/ops/gh/control/sites/refresh")).status], [200]);
  assert.equal((await t.post("/ops/gh/control/sites/refresh")).status, 429);
  assert.deepEqual(t.gh.writes.map((w) => w.key), ["sitesRefresh"]);
  assert.deepEqual(t.audits().map((a) => [a.action, a.result]), [["gh.K11", "ok"]]);
  await t.close();
});

test("T5.3 inbox: opaque ids, no detail; dismiss resolves the id back to {kind,title,at} server-side", async () => {
  const t = await setup();
  t.gh.bodies.inbox = INBOX;
  const items = (await t.get("/ops/gh/inbox")).json.items as any[];
  assert.deepEqual(items.map((i) => Object.keys(i).sort()), [["at", "id", "kind", "runId", "title"], ["at", "id", "kind", "title"]]);
  assert.ok(!/ENOENT|sk-live|\/root\//.test(JSON.stringify(items)));
  assert.ok(items.every((i) => /^g_[0-9a-f]{12}$/.test(i.id)));
  assert.deepEqual((await t.get("/ops/gh/inbox")).json.items.map((i: any) => i.id), items.map((i) => i.id), "stable");
  const r = await t.post(`/ops/gh/inbox/${items[1].id}/dismiss`);
  assert.deepEqual([r.status, r.json], [200, { ok: true }]);
  assert.deepEqual(t.gh.writes, [{ key: "inboxDismiss", args: { body: { kind: "unit-failed", title: "pi-dashboard | x", at: "2026-10-17T12:05:00.000Z" } } }]);
  assert.deepEqual(t.audits().map((a) => [a.action, a.subject, a.result]), [["gh.K13", items[1].id, "ok"]]);
  await t.close();
});

test("T5.3 dismiss: a bad id is 400, an unknown id 404, GodHome down 503, a refusal 409; ops:write is needed", async () => {
  const t = await setup();
  t.gh.bodies.inbox = INBOX;
  const items = (await t.get("/ops/gh/inbox")).json.items as any[];
  assert.equal((await t.post("/ops/gh/inbox/not-an-id/dismiss")).status, 400);
  assert.equal((await t.post("/ops/gh/inbox/g_000000000000/dismiss")).status, 404);
  assert.equal(t.gh.writes.length, 0);
  t.gh.writeResult = () => ({ status: "rejected" });
  assert.equal((await t.post(`/ops/gh/inbox/${items[0].id}/dismiss`)).status, 409);
  t.gh.down = true;
  const down = await t.post(`/ops/gh/inbox/${items[0].id}/dismiss`);
  assert.deepEqual([down.status, down.json.error.code], [503, "unavailable"]);
  await t.close();
  const ro = await setup(["ops:read"]);
  assert.equal((await ro.post("/ops/gh/inbox/g_000000000000/dismiss")).status, 403);
  await ro.close();
});

test("T5.3 hygiene: findings and fix names only; detail, desc, inverse and confirm text are dropped; there is no fix route", async () => {
  const t = await setup(["ops:read", "ops:write", "ops:run", "ops:service"]);
  t.gh.bodies.hygieneFindings = { findings: [{ check: "env-tracked", severity: "P0", scope: "app", title: "Env file is tracked ".repeat(20), detail: "tracked /root/app/.env", fix: "untrack_env", cheap: true }], errors: 0 };
  t.gh.bodies.hygieneFixes = { untrack_env: { label: "Untrack .env", desc: "git rm --cached /root/app/.env", safety: "confirm", needs_target: true, inverse: "git add", confirm: "Really?" } };
  const h = (await t.get("/ops/gh/hygiene")).json;
  assert.deepEqual(h.findings[0], { id: h.findings[0].id, check: "env-tracked", severity: "P0", scope: "app", fix: "untrack_env", cheap: true, title: "Env file is tracked ".repeat(20).slice(0, 120) });
  assert.deepEqual(h.fixes, [{ id: "untrack_env", label: "Untrack .env", safety: "confirm", needsTarget: true }]);
  assert.ok(!/\/root\/|git rm|Really|inverse/.test(JSON.stringify(h)));
  for (const [m, p] of [["post", "/ops/gh/hygiene/fix"], ["post", "/ops/gh/hygiene"], ["post", "/ops/gh/hygiene/fixes/untrack_env/apply"]] as const) {
    const r = await t.post(p);
    assert.notEqual(r.status, 200, `${m} ${p}`);
  }
  assert.deepEqual(t.gh.writes, []);
  await t.close();
});

test("T5.3 GodHome down: every signals read is 200 with reachable:false and empty lists", async () => {
  const t = await setup();
  t.gh.down = true;
  for (const p of ["/ops/gh/world", "/ops/gh/control", "/ops/gh/inbox", "/ops/gh/hygiene"]) {
    const r = await t.get(p);
    assert.equal(r.status, 200, p);
    assert.equal(r.json.reachable, false, p);
  }
  assert.deepEqual((await t.get("/ops/gh/world")).json.events, []);
  assert.equal((await t.post("/ops/gh/control/sites/refresh")).status, 503);
  await t.close();
});

test("T5.3 reads need ops:read", async () => {
  const t = await setup([]);
  for (const p of ["/ops/gh/world", "/ops/gh/control", "/ops/gh/inbox", "/ops/gh/hygiene"]) assert.equal((await t.get(p)).status, 403, p);
  await t.close();
});
