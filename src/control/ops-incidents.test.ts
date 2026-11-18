import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { OpsStore } from "./ops-store";
import { adjustedCounts, findIncident, fixPrompt, INCIDENT_ID, listIncidents, mapIncident, muteKey } from "./ops-incidents";

const FIX = path.join(__dirname, "..", "..", "test-fixtures");
const summary = (w: string) => JSON.parse(fs.readFileSync(path.join(FIX, `ops-summary-${w}.json`), "utf8"));
const contract = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "specs", "010-ops-control", "contract-examples.json"), "utf8"));
const WINDOWS = ["24h", "7d", "all"] as const;
const RW = ["ops:read", "ops:write"];
const RO = ["ops:read"];
const store = () => new OpsStore(new Database(":memory:"));

const item = (over: Record<string, unknown> = {}) => ({
  id: "check:docker:1792170025000", kind: "check", title: "docker: crmdemo-backend-1 exited (1) 3 minutes ago", subtitle: "check docker, 0 flaps",
  severity: "critical", state: "open", project: "server", check: "docker", firstAt: "2026-10-16T08:10:00.000Z", lastAt: "2026-10-16T08:40:00.000Z",
  durationMs: 1_800_000, flaps: 0, flapping: false, count: 3, durS: null, url: "", ...over,
});
/** A summary around some incidents, counts left as given. */
const wrap = (items: any[], counts: Record<string, unknown> = {}, mttr: unknown = { meanMs: 900_000, medianMs: 1, resolved: 2 }) => ({
  incidents: { items, counts: { open: 0, critical: 0, warning: 0, notice: 0, resolved: 0, flapping: 0, agentFailures: 0, byKind: {}, ...counts }, mttr },
});
const q = (over: Record<string, unknown> = {}) => ({ state: "open" as const, limit: 500, ...over });

test("INCIDENT_ID accepts exactly i_ and 12 lower-case hex", () => {
  for (const ok of ["i_3f2a9c1b7d40", "i_000000000000"]) assert.match(ok, INCIDENT_ID);
  for (const bad of ["i_3f2a9c1b7d4", "i_3f2a9c1b7d400", "I_3f2a9c1b7d40", "i_3F2A9C1B7D40", "check:site:1", "i_3f2a9c1b7d4g", " i_3f2a9c1b7d40", "i_3f2a9c1b7d40\n"]) {
    assert.doesNotMatch(bad, INCIDENT_ID, bad);
  }
});

// ---- mapping ------------------------------------------------------------------------------------------------

test("mapIncident: named fields only, ISO strings, opaque id, no raw id, no durS, nothing outside the contract", () => {
  const v = mapIncident(item({ cwd: "/root/secret/x", env: { A: 1 }, input: "p" }), "i_3f2a9c1b7d40", RW);
  assert.deepEqual(v, {
    id: "i_3f2a9c1b7d40", kind: "check", title: "docker: crmdemo-backend-1 exited (1) 3 minutes ago", subtitle: "check docker, 0 flaps", severity: "critical",
    state: "open", project: "server", check: "docker", firstAt: "2026-10-16T08:10:00.000Z", lastAt: "2026-10-16T08:40:00.000Z", durationMs: 1_800_000,
    flaps: 0, flapping: false, count: 3, acked: false, reopened: false, actions: ["ack", "mute", "resolve"],
  });
  const example = contract.routes.X5.response.items[0];
  for (const k of Object.keys(example)) assert.ok(k in v, `contract key ${k}`);
});

test("mapIncident: resolvedAt only when GodHome has one; url only for https github.com; titles are scrubbed and clamped", () => {
  const r = mapIncident(item({ state: "resolved", resolvedAt: "2026-10-16T08:50:00.000Z" }), "i_000000000001", RW);
  assert.equal(r.resolvedAt, "2026-10-16T08:50:00.000Z");
  assert.ok(!("resolvedAt" in mapIncident(item(), "i_000000000001", RW)));
  const good = "https://github.com/example-org/repo/pull/12";
  assert.equal(mapIncident(item({ url: good }), "i_000000000001", RW).url, good);
  for (const bad of [
    "", "http://github.com/o/r/pull/1", "javascript:alert(1)", "https://github.com.evil.test/o/r", "https://evil.test/https://github.com/o/r",
    "https://user:pw@github.com/o/r", "https://github.com@evil.test/o/r", "ftp://github.com/o/r", "//github.com/o/r", "https://github.com:8443/o/r", 42, null,
  ]) {
    assert.ok(!("url" in mapIncident(item({ url: bad }), "i_000000000001", RW)), String(bad));
  }
  const t = mapIncident(item({ title: "unit: failed at /usr/lib/modules/6.8.0/x.ko " + "t".repeat(400), subtitle: "s".repeat(300), project: "p".repeat(200) }), "i_000000000001", RW);
  assert.ok(t.title.startsWith("unit: failed at ... "));
  assert.equal(t.title.length, 160);
  assert.equal(t.subtitle.length, 120);
  assert.equal(t.project.length, 64);
});

test("mapIncident: recovering is an additive state, deploy an additive kind, both pass through", () => {
  const rec = mapIncident(item({ state: "recovering", severity: "notice" }), "i_000000000002", RW);
  assert.equal(rec.state, "recovering");
  assert.deepEqual(rec.actions, ["ack", "mute", "resolve"]);
  const dep = mapIncident(item({ id: "deploy:lab|tokyo-69b8e370", kind: "deploy", title: "deploy lab (nothing deployed)", project: "lab", check: undefined }), "i_000000000003", RW);
  assert.equal(dep.kind, "deploy");
  assert.ok(!("check" in dep));
});

test("mapIncident: actions follow caps and state; a read-only device and a resolved incident get none", () => {
  assert.deepEqual(mapIncident(item(), "i_000000000004", RO).actions, []);
  assert.deepEqual(mapIncident(item({ state: "resolved" }), "i_000000000004", RW).actions, []);
  assert.deepEqual(mapIncident(item(), "i_000000000004", ["ops:write"]).actions, ["ack", "mute", "resolve"]);
});

test("mapIncident: bad severity or state read as notice and open; numbers are never negative or NaN", () => {
  const v = mapIncident(item({ severity: "loud", state: "weird", durationMs: -5, flaps: "x", count: NaN }), "i_000000000005", RW);
  assert.equal(v.severity, "notice");
  assert.equal(v.state, "open");
  assert.equal(v.durationMs, 0);
  assert.equal(v.flaps, 0);
  assert.equal(v.count, 0);
});

// ---- mute key -----------------------------------------------------------------------------------------------

test("muteKey: a check keys on ref and target, not on the episode; review, agent and deploy key on the GodHome id", () => {
  const k = (title: string, check: string, id = "check:x:1") => muteKey(item({ id, title, check }));
  assert.equal(k("docker: crmdemo-backend-1 exited (1) 3 minutes ago", "docker"), "check:docker:crmdemo-backend-1");
  assert.equal(k("docker: crmdemo-backend-1 exited (1) 3 minutes ago", "docker", "check:docker:999"), "check:docker:crmdemo-backend-1", "new flap episode, same key");
  assert.equal(k("unit: user@111.service loaded failed failed User Manager for UID 111", "unit"), "check:unit:user@111.service");
  assert.equal(k("pm2: portfolio-next restarts=65358 (was 64236)", "pm2"), "check:pm2:portfolio-next");
  assert.equal(k("site: site-2.example.test 000", "site"), "check:site:site-2.example.test");
  assert.equal(k("disk: /var 86% (df -P)", "disk"), "check:disk:/var");
  assert.equal(k("backup: shopdemo-mysql-volume-pre-restore missing (newest file 102h old)", "backup"), "check:backup:shopdemo-mysql-volume-pre-restore");
  assert.equal(k("cronlog: /var/log/x last line: boom", "cronlog"), "check:cronlog:");
  assert.equal(k("chkrootkit: <path>", "chkrootkit"), "check:chkrootkit:");
  assert.equal(k("docker:", "docker"), "check:docker:");
  assert.equal(muteKey(item({ id: "review:invoices|2", kind: "review", check: undefined })), "review:invoices|2");
  assert.equal(muteKey(item({ id: "agent:live:final-perf", kind: "agent", check: undefined })), "agent:live:final-perf");
  assert.equal(muteKey(item({ id: "deploy:lab|tokyo-69b8e370", kind: "deploy", check: undefined })), "deploy:lab|tokyo-69b8e370");
});

// ---- counts: GodHome's, never recounted ---------------------------------------------------------------------

for (const w of WINDOWS) {
  test(`adjustedCounts ${w}: equals GodHome's counts with acked and muted at 0 (empty overlay)`, () => {
    const s = summary(w);
    const c = s.incidents.counts;
    assert.deepEqual(adjustedCounts(s), { open: c.open, critical: c.critical, warning: c.warning, notice: c.notice, resolved: c.resolved, acked: 0, muted: 0 });
  });
}

test("adjustedCounts: a summary without counts is all zero; a non-object throws", () => {
  assert.deepEqual(adjustedCounts({}), { open: 0, critical: 0, warning: 0, notice: 0, resolved: 0, acked: 0, muted: 0 });
  assert.throws(() => adjustedCounts(null));
});

// ---- list ---------------------------------------------------------------------------------------------------

for (const w of WINDOWS) {
  test(`listIncidents ${w}: state=open returns exactly the items GodHome's counts.open counts (recovering in, agent out)`, () => {
    const s = summary(w);
    const out = listIncidents(s, q(), store(), RW);
    const expected = s.incidents.items.filter((i: any) => i.kind !== "agent" && (i.state === "open" || i.state === "recovering"));
    assert.equal(out.items.length, expected.length);
    assert.equal(out.items.length, s.incidents.counts.open, "list size equals counts.open");
    assert.equal(out.counts.open, s.incidents.counts.open);
    assert.equal(out.items.filter((i) => i.severity === "critical").length, s.incidents.counts.critical);
    assert.equal(out.items.filter((i) => i.severity === "warning").length, s.incidents.counts.warning);
    assert.equal(out.items.filter((i) => i.severity === "notice").length, s.incidents.counts.notice);
    assert.deepEqual(out.counts, adjustedCounts(s));
    assert.equal(out.mttrMs, s.incidents.mttr.meanMs);
    assert.equal(out.next, null);
    assert.ok(out.items.every((i) => INCIDENT_ID.test(i.id)));
    assert.ok(out.items.every((i) => i.kind !== "agent"));
  });

  test(`listIncidents ${w}: ids are stable across two fetches and map back to the GodHome ids; none contains ':' or '|'`, () => {
    const s = summary(w);
    const ids = store();
    const a = listIncidents(s, q({ state: "all" }), ids, RW);
    const b = listIncidents(s, q({ state: "all" }), ids, RW);
    assert.deepEqual(a.items.map((i) => i.id), b.items.map((i) => i.id));
    const sources = new Set(s.incidents.items.map((i: any) => i.id));
    for (const i of a.items) {
      assert.ok(!/[:|]/.test(i.id));
      assert.ok(sources.has(ids.sourceId(i.id)), i.id);
    }
    assert.equal(new Set(a.items.map((i) => i.id)).size, a.items.length);
  });
}

test("listIncidents: sorted by lastAt, newest first; ids break ties", () => {
  const items = [item({ id: "check:a:1", lastAt: "2026-10-16T08:00:00.000Z" }), item({ id: "check:b:1", lastAt: "2026-10-16T08:30:00.000Z" }), item({ id: "check:c:1", lastAt: "2026-10-16T08:00:00.000Z" })];
  const ids = store();
  const out = listIncidents(wrap(items), q(), ids, RW);
  assert.deepEqual(out.items.map((i) => ids.sourceId(i.id)), ["check:b:1", "check:a:1", "check:c:1"]);
});

test("listIncidents: state, kind, project filters; kind=agent is the only way to see agent incidents; muted is empty until the overlay lands", () => {
  const s = summary("all");
  const ids = store();
  const resolved = listIncidents(s, q({ state: "resolved" }), ids, RW);
  assert.ok(resolved.items.length > 0 && resolved.items.every((i) => i.state === "resolved" && i.kind !== "agent"));
  const all = listIncidents(s, q({ state: "all" }), ids, RW);
  assert.equal(all.items.length, s.incidents.items.filter((i: any) => i.kind !== "agent").length);
  const agents = listIncidents(s, q({ state: "all", kind: "agent" }), ids, RW);
  assert.equal(agents.items.length, s.incidents.items.filter((i: any) => i.kind === "agent").length);
  assert.ok(agents.items.every((i) => i.kind === "agent"));
  assert.equal(listIncidents(s, q({ state: "open", kind: "agent" }), ids, RW).items.length, s.incidents.items.filter((i: any) => i.kind === "agent" && i.state === "open").length);
  const reviews = listIncidents(s, q({ kind: "review" }), ids, RW);
  assert.ok(reviews.items.length > 0 && reviews.items.every((i) => i.kind === "review"));
  const proj = reviews.items[0].project;
  const byProject = listIncidents(s, q({ project: proj }), ids, RW);
  assert.ok(byProject.items.length > 0 && byProject.items.every((i) => i.project === proj));
  assert.deepEqual(listIncidents(s, q({ project: "no-such-project" }), ids, RW).items, []);
  assert.deepEqual(listIncidents(s, q({ state: "muted" }), ids, RW).items, []);
  assert.deepEqual(listIncidents(s, q({ kind: "deploy" }), ids, RW).items.map((i) => i.kind), Array(14).fill("deploy"));
});

test("listIncidents: since keeps incidents whose newest of lastAt and resolvedAt is later", () => {
  const items = [
    item({ id: "check:a:1", lastAt: "2026-10-16T08:00:00.000Z" }),
    item({ id: "check:b:1", lastAt: "2026-10-16T07:00:00.000Z", state: "resolved", resolvedAt: "2026-10-16T08:30:00.000Z" }),
    item({ id: "check:c:1", lastAt: "2026-10-16T06:00:00.000Z" }),
  ];
  const ids = store();
  const since = Date.parse("2026-10-16T07:30:00.000Z");
  const out = listIncidents(wrap(items), q({ state: "all", since }), ids, RW);
  assert.deepEqual(out.items.map((i) => ids.sourceId(i.id)).sort(), ["check:a:1", "check:b:1"]);
  assert.deepEqual(listIncidents(wrap(items), q({ state: "all", since: Date.parse("2026-10-16T09:00:00.000Z") }), ids, RW).items, []);
});

test("listIncidents: pages with before and next cover every item once; a tie on lastAt is never split across pages", () => {
  const items = Array.from({ length: 9 }, (_, i) => item({ id: `check:p${i}:1`, lastAt: new Date(Date.parse("2026-10-16T08:00:00Z") + Math.floor(i / 2) * 60_000).toISOString() }));
  const ids = store();
  const seen: string[] = [];
  let before: number | undefined;
  let pages = 0;
  for (;;) {
    const p = listIncidents(wrap(items), q({ limit: 3, before }), ids, RW);
    seen.push(...p.items.map((i) => ids.sourceId(i.id)!));
    pages++;
    if (p.next === null) break;
    before = Date.parse(p.next);
    assert.ok(pages < 10, "terminates");
  }
  assert.equal(seen.length, 9);
  assert.equal(new Set(seen).size, 9);
  assert.ok(pages >= 3);
});

test("listIncidents: duplicate GodHome ids keep the first, unknown kinds and id-less items are skipped, no throw", () => {
  const items = [item({ id: "check:a:1", title: "first" }), item({ id: "check:a:1", title: "second" }), item({ id: "mystery:1", kind: "mystery" }), { title: "no id" }, null, "x"];
  const out = listIncidents(wrap(items as any[]), q({ state: "all" }), store(), RW);
  assert.deepEqual(out.items.map((i) => i.title), ["first"]);
});

test("listIncidents: no incidents block is an empty list with zero counts; a non-object summary throws", () => {
  const out = listIncidents({}, q(), store(), RW);
  assert.deepEqual(out, { items: [], counts: { open: 0, critical: 0, warning: 0, notice: 0, resolved: 0, acked: 0, muted: 0 }, mttrMs: null, next: null });
  assert.throws(() => listIncidents("oops", q(), store(), RW));
});

test("listIncidents: null mttr stays null, a missing mttr object stays null", () => {
  assert.equal(listIncidents(wrap([], {}, { meanMs: null, medianMs: null, resolved: 0 }), q(), store(), RW).mttrMs, null);
  assert.equal(listIncidents(wrap([], {}, null), q(), store(), RW).mttrMs, null);
});

test("listIncidents: no host detail, key or token leaves in any window", () => {
  const BITS = /\/home\/|\/root\/|\/var\/|\/usr\/|\/etc\/|sk-|Bearer [A-Za-z0-9]|"cwd"|"input"|"output"|"durS"/;
  for (const w of WINDOWS) {
    const out = listIncidents(summary(w), q({ state: "all", kind: undefined }), store(), RW);
    assert.ok(!BITS.test(JSON.stringify(out)), w);
  }
});

// ---- find ---------------------------------------------------------------------------------------------------

test("findIncident: resolves an opaque id issued by a list; unknown ids and ids that left GodHome give null", () => {
  const s = summary("all");
  const ids = store();
  const list = listIncidents(s, q({ state: "all" }), ids, RW);
  const pick = list.items[3];
  assert.deepEqual(findIncident(s, pick.id, ids, RW), pick);
  assert.equal(findIncident(s, "i_000000000000", ids, RW), null, "never issued");
  const src = ids.sourceId(pick.id)!;
  const gone = { incidents: { ...s.incidents, items: s.incidents.items.filter((i: any) => i.id !== src) } };
  assert.equal(findIncident(gone, pick.id, ids, RW), null, "aged out of GodHome");
  assert.equal(findIncident(s, "not-an-id", ids, RW), null);
});

test("findIncident: finds an agent incident too, and shows the caps of the caller", () => {
  const s = summary("all");
  const ids = store();
  const agent = listIncidents(s, q({ state: "all", kind: "agent" }), ids, RW).items[0];
  assert.equal(findIncident(s, agent.id, ids, RO)!.kind, "agent");
  assert.deepEqual(findIncident(s, agent.id, ids, RO)!.actions, []);
});

test("the example in the contract has the keys the mapper produces for a check", () => {
  const example = contract.routes.X5.response.items[0];
  const v = mapIncident(item(), example.id, RW);
  assert.deepEqual(Object.keys(v).sort(), Object.keys(example).sort());
  assert.deepEqual(v.actions, example.actions.filter((a: string) => a !== "fixTask" && a !== "restart"));
});

// ---- T2.1: overlay application (A5) -------------------------------------------------------------------------

const NOW = Date.parse("2026-10-16T09:00:00Z");
const HOUR = 3_600_000;
const D1 = "d_aaaaaaaa";
const trio = () => {
  const items = [
    item({ id: "check:docker:1792170025000", severity: "critical", lastAt: "2026-10-16T08:40:00.000Z" }),
    item({ id: "check:site:1792170026000", title: "site: https://example.test down", check: "site", severity: "warning", lastAt: "2026-10-16T08:30:00.000Z" }),
    item({ id: "review:dev-stack|2", kind: "review", title: "review: dev-stack PR 2", check: undefined, severity: "notice", project: "dev-stack", lastAt: "2026-10-16T08:20:00.000Z" }),
  ];
  return { items, s: wrap(items, { open: 3, critical: 1, warning: 1, notice: 1, resolved: 4 }) };
};
const row = (out: ReturnType<typeof listIncidents>, id: string) => out.items.find((i) => i.id === id)!;

test("overlay: ack keeps the open counts, sets acked and counts.acked, and offers unack in place of ack", () => {
  const { items, s } = trio();
  const ids = store();
  const a = ids.opaqueId(items[0].id, NOW);
  ids.ack(a, items[0].id, "check", D1, NOW);
  const out = listIncidents(s, q(), ids, RW, NOW);
  assert.deepEqual(out.counts, { open: 3, critical: 1, warning: 1, notice: 1, resolved: 4, acked: 1, muted: 0 });
  assert.equal(out.items.length, 3);
  assert.equal(row(out, a).acked, true);
  assert.equal(row(out, a).state, "open");
  assert.deepEqual(row(out, a).actions, ["unack", "mute", "resolve"]);
  assert.equal(out.items.filter((i) => i.acked).length, 1);
});

test("overlay: mute subtracts the incident from its severity and from open, leaves the open list, shows in state=muted with mutedUntil and unmute", () => {
  const { items, s } = trio();
  const ids = store();
  const until = NOW + HOUR;
  ids.mute(muteKey(items[1]), until, D1, NOW);
  const open = listIncidents(s, q(), ids, RW, NOW);
  assert.deepEqual(open.counts, { open: 2, critical: 1, warning: 0, notice: 1, resolved: 4, acked: 0, muted: 1 });
  assert.equal(open.items.length, 2);
  const muted = listIncidents(s, q({ state: "muted" }), ids, RW, NOW);
  assert.equal(muted.items.length, 1);
  assert.equal(muted.items[0].mutedUntil, new Date(until).toISOString());
  assert.equal(muted.items[0].state, "open");
  assert.deepEqual(muted.items[0].actions, ["unmute", "resolve"]);
  assert.equal(listIncidents(s, q({ state: "all" }), ids, RW, NOW).items.length, 3, "all keeps it");
});

test("overlay: manual resolve subtracts, moves the incident to state=resolved with resolvedAt and a reopen action, and counts.resolved grows", () => {
  const { items, s } = trio();
  const ids = store();
  const a = ids.opaqueId(items[0].id, NOW);
  ids.resolve(a, items[0].id, "check", Date.parse(items[0].lastAt), D1, NOW);
  const open = listIncidents(s, q(), ids, RW, NOW + 1000);
  assert.deepEqual(open.counts, { open: 2, critical: 0, warning: 1, notice: 1, resolved: 5, acked: 0, muted: 0 });
  assert.equal(open.items.some((i) => i.id === a), false);
  const resolved = listIncidents(s, q({ state: "resolved" }), ids, RW, NOW + 1000);
  const mine = row(resolved, a);
  assert.equal(mine.state, "resolved");
  assert.equal(mine.resolvedAt, new Date(NOW).toISOString());
  assert.equal(mine.reopened, false);
  assert.deepEqual(mine.actions, ["reopen"]);
});

test("overlay: a lastAt later than resolved_last_at reopens the incident with reopened:true and counts it again", () => {
  const { items, s } = trio();
  const ids = store();
  const a = ids.opaqueId(items[0].id, NOW);
  ids.resolve(a, items[0].id, "check", Date.parse(items[0].lastAt) - 1, D1, NOW);
  const out = listIncidents(s, q(), ids, RW, NOW + 1000);
  assert.deepEqual(out.counts, { open: 3, critical: 1, warning: 1, notice: 1, resolved: 4, acked: 0, muted: 0 });
  const mine = row(out, a);
  assert.equal(mine.reopened, true);
  assert.equal(mine.state, "open");
  assert.deepEqual(mine.actions, ["ack", "mute", "resolve"]);
});

test("overlay: a new flap episode of a muted check (new GodHome id, same key) stays muted", () => {
  const first = item({ id: "check:docker:1792170025000" });
  const ids = store();
  ids.mute(muteKey(first), NOW + HOUR, D1, NOW);
  const next = item({ id: "check:docker:1792170999000", lastAt: "2026-10-16T08:55:00.000Z" });
  const s = wrap([next], { open: 1, critical: 1 });
  const out = listIncidents(s, q(), ids, RW, NOW);
  assert.equal(out.items.length, 0);
  assert.deepEqual([out.counts.open, out.counts.critical, out.counts.muted], [0, 0, 1]);
  assert.equal(listIncidents(s, q({ state: "muted" }), ids, RW, NOW).items.length, 1);
  const other = item({ id: "check:docker:1792171000000", title: "docker: other-container exited (1) 1 minute ago" });
  assert.equal(listIncidents(wrap([other], { open: 1, critical: 1 }), q(), ids, RW, NOW).items.length, 1, "another target is not muted");
});

test("overlay: mute expiry restores the incident and the counts", () => {
  const { items, s } = trio();
  const ids = store();
  ids.mute(muteKey(items[0]), NOW + HOUR, D1, NOW);
  assert.equal(listIncidents(s, q(), ids, RW, NOW + HOUR - 1).counts.open, 2);
  const back = listIncidents(s, q(), ids, RW, NOW + HOUR);
  assert.equal(back.counts.open, 3);
  assert.equal(back.items.length, 3);
  assert.ok(back.items.every((i) => i.mutedUntil === undefined));
});

test("overlay: subtraction floors at 0 and works on GodHome's counts, not on the 200 listed items", () => {
  const items = Array.from({ length: 200 }, (_, n) => item({ id: `check:docker:${1792170000000 + n}`, title: `docker: c${n} exited (1) 1 minute ago`, lastAt: new Date(NOW - n * 1000).toISOString() }));
  const s = wrap(items, { open: 250, critical: 250 });
  const ids = store();
  ids.mute(muteKey(items[0]), NOW + HOUR, D1, NOW);
  ids.mute(muteKey(items[1]), NOW + HOUR, D1, NOW);
  const out = listIncidents(s, q({ limit: 500 }), ids, RW, NOW);
  assert.deepEqual([out.counts.open, out.counts.critical, out.counts.muted], [248, 248, 2]);
  assert.equal(out.items.length, 198);
  const small = listIncidents(wrap(items.slice(0, 2), { open: 1, critical: 1 }), q(), ids, RW, NOW);
  assert.deepEqual([small.counts.open, small.counts.critical], [0, 0], "floored, never negative");
});

test("overlay: agent incidents are not in counts.open, so hiding one changes no count; an ack on a GodHome-resolved incident shows nothing", () => {
  const agent = item({ id: "agent:live:final-perf", kind: "agent", check: undefined, title: "agent: final-perf failed" });
  const gone = item({ id: "check:site:1792170026000", state: "resolved", resolvedAt: "2026-10-16T08:50:00.000Z", title: "site: https://example.test down", check: "site" });
  const s = wrap([agent, gone], { open: 0, resolved: 1 });
  const ids = store();
  ids.mute(agent.id, NOW + HOUR, D1, NOW);
  ids.ack(ids.opaqueId(gone.id, NOW), gone.id, "check", D1, NOW);
  const out = listIncidents(s, q({ state: "all", kind: "agent" }), ids, RW, NOW);
  assert.deepEqual(out.counts, { open: 0, critical: 0, warning: 0, notice: 0, resolved: 1, acked: 0, muted: 0 });
  assert.equal(out.items[0].mutedUntil, new Date(NOW + HOUR).toISOString());
  const all = listIncidents(s, q({ state: "all" }), ids, RW, NOW);
  const goneView = all.items.find((i) => i.title.startsWith("site:"))!;
  assert.equal(goneView.acked, false);
  assert.deepEqual(goneView.actions, []);
});

test("overlay: reopen (clearState and unmute) restores ack, mute and resolve; findIncident shows the overlay too", () => {
  const { items, s } = trio();
  const ids = store();
  const a = ids.opaqueId(items[0].id, NOW);
  ids.mute(muteKey(items[0]), NOW + HOUR, D1, NOW);
  ids.ack(a, items[0].id, "check", D1, NOW);
  const hidden = findIncident(s, a, ids, RW, NOW)!;
  assert.equal(hidden.mutedUntil, new Date(NOW + HOUR).toISOString());
  assert.equal(hidden.acked, true);
  ids.clearState(a);
  ids.unmute(muteKey(items[0]));
  const back = findIncident(s, a, ids, RW, NOW)!;
  assert.deepEqual([back.acked, back.mutedUntil, back.reopened, back.actions], [false, undefined, false, ["ack", "mute", "resolve"]]);
  assert.deepEqual(listIncidents(s, q(), ids, RW, NOW).counts.open, 3);
});

test("adjustedCounts takes the overlay directly: no overlay is GodHome's numbers with acked and muted 0", () => {
  const { s } = trio();
  assert.deepEqual(adjustedCounts(s), { open: 3, critical: 1, warning: 1, notice: 1, resolved: 4, acked: 0, muted: 0 });
  const ids = store();
  ids.mute("check:docker:crmdemo-backend-1", NOW + HOUR, D1, NOW);
  assert.deepEqual(adjustedCounts(s, ids.overlay(NOW)), { open: 2, critical: 0, warning: 1, notice: 1, resolved: 4, acked: 0, muted: 1 });
});

// ---- T2.3: fixPrompt ----------------------------------------------------------------------------------------

test("fixPrompt: title, project, kind and duration; no output, cwd, path or secret; the note is scrubbed", () => {
  const it = item({
    title: "unit: chkrootkit failed at /usr/lib/modules/6.8.0/.build-id/aa/bb.debug and /tmp or /root/x Bearer abcdef0123456789abcdef0123456789",
    project: "tokyo", output: "SECRET LOG LINE", cwd: "/root/secret", durationMs: 90 * 60_000,
  });
  const p = fixPrompt(it, "see /var/log/syslog please");
  for (const want of ["Project: tokyo", "Kind: check", "Open for: 1 h 30 min", "unit: chkrootkit failed at", "see ... please"]) assert.ok(p.includes(want), want);
  assert.ok(!/(^|[^\w:/.~-])\/[\w.~-]/.test(p), p);
  for (const bad of ["SECRET LOG LINE", "/root", "/usr", "/var", "abcdef0123456789"]) assert.ok(!p.includes(bad), bad);
  assert.ok(!fixPrompt(it).includes("Note"), "no note, no note line");
  assert.ok(fixPrompt(item({ durationMs: 30_000 })).includes("Open for: under a minute"));
  assert.ok(fixPrompt(item({ durationMs: 3 * 24 * 3_600_000 })).includes("Open for: 3 d"));
});
