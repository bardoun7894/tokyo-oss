import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { mapEngine, mapNetwork, mapOverview, mapTrace, mapTraceDetail, mapTraces, scrub } from "./ops-map";
import { graphBody, listView, MIN, phaseRec, runRec, T0 } from "./ops-fixtures";

const FIX = path.join(__dirname, "..", "..", "test-fixtures");
const WINDOWS = ["24h", "7d", "all"] as const;
const summary = (w: string) => JSON.parse(fs.readFileSync(path.join(FIX, `ops-summary-${w}.json`), "utf8"));
const golden = (w: string) => JSON.parse(fs.readFileSync(path.join(FIX, `ops-overview-${w}.golden.json`), "utf8"));
const contract = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "specs", "010-ops-control", "contract-examples.json"), "utf8"));

const HOST_BITS = /\/home\/|\/root\/|\/var\/|\/usr\/|\/etc\/|sk-|Bearer [A-Za-z0-9]|"cwd"|"input"|"output"/;

/** Key sets of an object tree, arrays by their first element: `a.b[].c`. */
function keyPaths(v: unknown, prefix = ""): string[] {
  if (Array.isArray(v)) return v.length ? keyPaths(v[0], prefix + "[]") : [];
  if (typeof v !== "object" || v === null) return [];
  return Object.entries(v).flatMap(([k, x]) => [`${prefix}.${k}`, ...keyPaths(x, `${prefix}.${k}`)]);
}

test("scrub: absolute paths of two or more segments become ..., secrets are redacted", () => {
  assert.equal(scrub("kernel: /usr/lib/modules/6.8.0-142/kernel/fs/x.ko changed"), "kernel: ... changed");
  assert.equal(scrub("open (/var/log/nginx/error.log) failed"), "open (...) failed");
  assert.equal(scrub("a /root/x and /home/tokyo/y"), "a ... and ...");
  assert.equal(scrub("API_TOKEN=abc123def456 at /srv/app/.env"), "API_TOKEN=[redacted] at ...");
  assert.equal(scrub("Authorization: Bearer abcDEF123456"), "Authorization: Bearer [redacted]");
});

test("scrub: URLs, words with a slash, a bare mount point and relative paths stay", () => {
  assert.equal(scrub("see https://github.com/example-org/repo/pull/12"), "see https://github.com/example-org/repo/pull/12");
  assert.equal(scrub("yes and/or no"), "yes and/or no");
  assert.equal(scrub("disk: / at 91%"), "disk: / at 91%");
  assert.equal(scrub("site: host.example.test/health down"), "site: host.example.test/health down");
  assert.equal(scrub("src/control/ops.ts failed"), "src/control/ops.ts failed");
});

for (const w of WINDOWS) {
  test(`mapOverview ${w}: equals the golden mapping of the fixture`, () => {
    assert.deepEqual(mapOverview(summary(w), w), golden(w));
  });

  test(`mapOverview ${w}: values equal the fixture's own numbers (independent of the golden)`, () => {
    const s = summary(w);
    const o = mapOverview(s, w);
    assert.equal(o.window.id, w);
    assert.equal(o.window.from, s.window.from);
    assert.equal(o.window.to, s.window.to);
    assert.equal(o.freshness.stale, s.freshness.stale);
    assert.equal(o.health.score, s.health.score);
    assert.equal(o.health.checks.length, s.health.checks.length);
    assert.deepEqual(o.kpi, {
      active: s.agents.active, stale: s.agents.stale, done: s.agents.done, failed: s.agents.failed,
      successRate: s.agents.successRate, projects: s.agents.projects, avgDurS: Math.round(s.agents.durS / s.agents.withDur),
    });
    assert.deepEqual(o.series, { success: s.series.success, failed: s.series.failed, started: s.series.started, durS: s.series.durS });
    assert.deepEqual(o.previous, s.previous);
    const c = s.incidents.counts;
    assert.deepEqual(o.incidents.counts, { open: c.open, critical: c.critical, warning: c.warning, notice: c.notice, resolved: c.resolved, acked: 0, muted: 0 });
    assert.equal(o.incidents.mttrMs, s.incidents.mttr.meanMs);
    assert.equal(o.recent.length, 20);
    assert.deepEqual(o.recent.map((x) => x.at), s.recent.map((x: any) => x.at));
  });

  test(`mapOverview ${w}: key set equals the contract example (deep) and no host detail leaks`, () => {
    const s = summary(w);
    s.needsYou = [{ title: "Approve deploy", project: "tokyo", url: "", since: "2026-10-16T08:30:00.000Z" }]; // the fixtures have none
    const o = mapOverview(s, w);
    const { fetchedAt: _f, reachable: _r, ...example } = contract.routes.X1.response;
    assert.deepEqual(keyPaths(o).sort(), keyPaths(example).sort());
    assert.ok(!HOST_BITS.test(JSON.stringify(o)), "no path, key, cwd, input or output in the mapped body");
  });
}

test("mapOverview: fields outside the contract are dropped at every level", () => {
  const s = summary("24h");
  const noisy = JSON.parse(JSON.stringify(s));
  noisy.cwd = "/root/secret-project";
  noisy.env = { OPENAI_API_KEY: "sk-leak-leak-leak-leak-leak" };
  noisy.window.cwd = "/root/x/y";
  noisy.freshness.skipped = 9;
  noisy.health.series = [1, 2];
  noisy.health.checks[0].cwd = "/root/a/b";
  noisy.agents.costUsd = 12.5;
  noisy.previous.extra = "x";
  noisy.incidents.counts.byKind = { check: 1 };
  noisy.incidents.mttr.medianMs = 5;
  noisy.recent[0].url = "https://github.com/example-org/r";
  noisy.recent[0].output = "full output";
  noisy.needsYou = [{ title: "Approve", project: "tokyo", url: "https://github.com/o/r/pull/1", since: "2026-10-16T08:30:00.000Z", input: "prompt" }];
  const o = mapOverview(noisy, "24h");
  assert.deepEqual(o, { ...mapOverview(s, "24h"), needsYou: [{ title: "Approve", project: "tokyo", since: "2026-10-16T08:30:00.000Z" }] });
  assert.ok(!/secret-project|sk-leak|full output|prompt|github\.com/.test(JSON.stringify(o)));
});

test("mapOverview: a title with /usr/lib/modules/... comes out scrubbed (needsYou, recent, health label)", () => {
  const s = summary("24h");
  s.needsYou = [{ title: "unit: modprobe failed for /usr/lib/modules/6.8.0-142/kernel/x.ko", project: "server", url: "", since: "2026-10-16T08:30:00.000Z" }];
  s.recent[0].title = "check: /usr/lib/modules/6.8.0-142/kernel/y.ko missing";
  s.health.checks[0].label = "files in /var/lib/docker/overlay2";
  const o = mapOverview(s, "24h");
  assert.equal(o.needsYou[0].title, "unit: modprobe failed for ...");
  assert.equal(o.recent[0].title, "check: ... missing");
  assert.equal(o.health.checks[0].label, "files in ...");
});

test("mapOverview: lengths are clamped, lists capped, nulls stay null", () => {
  const s = summary("24h");
  s.needsYou = Array.from({ length: 30 }, (_, i) => ({ title: "t".repeat(400), project: "p".repeat(200), since: "2026-10-16T08:30:00.000Z" }));
  s.agents.successRate = null;
  s.agents.withDur = 0;
  s.incidents.mttr = { meanMs: null, medianMs: null, resolved: 0 };
  s.previous.successRate = null;
  s.series.durS = [null, 5, null];
  const o = mapOverview(s, "24h");
  assert.equal(o.needsYou.length, 20);
  assert.equal(o.needsYou[0].title.length, 160);
  assert.equal(o.needsYou[0].project.length, 64);
  assert.equal(o.kpi.successRate, null);
  assert.equal(o.kpi.avgDurS, null);
  assert.equal(o.incidents.mttrMs, null);
  assert.equal(o.previous.successRate, null);
  assert.deepEqual(o.series.durS, [null, 5, null]);
});

test("mapOverview: stale freshness carries a scrubbed staleReason; a non-object summary throws", () => {
  const s = summary("24h");
  s.freshness.stale = true;
  s.freshness.staleReason = "events file /var/lib/world/events.jsonl not updated for 12 min";
  const o = mapOverview(s, "24h");
  assert.equal(o.freshness.stale, true);
  assert.equal(o.freshness.staleReason, "events file ... not updated for 12 min");
  assert.throws(() => mapOverview(null, "24h"));
  assert.throws(() => mapOverview([], "24h"));
});

// ---- T1.4: X2 live map ------------------------------------------------------------------------------------

const STATUS4 = ["healthy", "degraded", "failing", "idle"];
/** Every key name in a tree, to prove a key is nowhere in it. */
const allKeys = (v: unknown): string[] =>
  Array.isArray(v) ? v.flatMap(allKeys) : typeof v === "object" && v !== null ? Object.entries(v).flatMap(([k, x]) => [k, ...allKeys(x)]) : [];

for (const w of WINDOWS) {
  test(`mapNetwork ${w}: every agent sits once, under the project of its busiest edge; groups busiest first`, () => {
    const s = summary(w);
    const m = mapNetwork(s, {});
    const placed = m.groups.flatMap((g) => g.agents.map((a) => [g.project, a.key] as const));
    assert.equal(placed.length, s.network.agents.length);
    assert.equal(new Set(placed.map(([, k]) => k)).size, new Set(s.network.agents.map((a: any) => a.key)).size, "no agent twice (the all fixture holds one key twice)");
    for (const [project, key] of placed) {
      const edges = s.network.edges.filter((e: any) => e.agent === key);
      const top = [...edges].sort((a: any, b: any) => b.runs - a.runs || (a.project < b.project ? -1 : 1))[0];
      assert.equal(project, top ? top.project : "other", key);
    }
    const order = m.groups.map((g) => [g.runs, g.project] as const);
    assert.deepEqual([...order].sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : 1)), order, "busiest first, ties by project id");
    assert.deepEqual(m.projects, s.network.projects);
    for (const g of m.groups) {
      const runs = s.network.projects.find((p: any) => p.id === g.project)?.runs;
      if (runs !== undefined) assert.equal(g.runs, runs);
    }
  });

  test(`mapNetwork ${w}: agent rows carry Status4 as is, rounded avgDurS (null stays null), lastAt from agents.items, no actions`, () => {
    const s = summary(w);
    const m = mapNetwork(s, {});
    const dupKeys = new Set(s.network.agents.map((a: any) => a.key).filter((k: string, i: number, all: string[]) => all.indexOf(k) !== i));
    const rows = m.groups.flatMap((g) => g.agents).filter((a) => !dupKeys.has(a.key));
    for (const a of rows) {
      const src = s.network.agents.find((x: any) => x.key === a.key);
      assert.ok(STATUS4.includes(a.status), a.status);
      assert.equal(a.status, src.status);
      assert.equal(a.avgDurS, src.avgDurS === null ? null : Math.round(src.avgDurS));
      assert.equal(a.active, src.active);
      assert.equal(a.runs, src.runs);
      assert.equal(a.failed, src.failed);
      const newest = s.agents.items.filter((i: any) => i.key === a.key).map((i: any) => Date.parse(i.lastAt)).sort((x: number, y: number) => y - x)[0];
      assert.equal(a.lastAt, newest === undefined ? null : new Date(newest).toISOString(), a.key);
    }
    assert.ok(rows.some((a) => a.avgDurS === null), "the fixtures have agents without a duration");
    assert.ok(!allKeys(m).includes("actions"), "S8: no actions on agent rows");
    assert.ok(!allKeys(m).includes("slow"));
    assert.ok(!HOST_BITS.test(JSON.stringify(m)));
  });

  test(`mapNetwork ${w}: key set equals the contract example`, () => {
    const { fetchedAt: _f, reachable: _r, ...example } = contract.routes.X2.response;
    assert.deepEqual(keyPaths(mapNetwork(summary(w), {})).sort(), keyPaths(example).sort());
  });
}

test("mapNetwork: the all fixture shows degraded and failing agents through unchanged", () => {
  const seen = new Set(mapNetwork(summary("all"), {}).groups.flatMap((g) => g.agents.map((a) => a.status)));
  assert.ok(seen.has("degraded") && seen.has("failing"), [...seen].join());
});

test("mapNetwork: project filter keeps one group; an unknown project gives none; projects stay whole", () => {
  const s = summary("7d");
  const all = mapNetwork(s, {});
  const first = all.groups[0].project;
  const one = mapNetwork(s, { project: first });
  assert.deepEqual(one.groups, [all.groups[0]]);
  assert.deepEqual(one.projects, all.projects);
  assert.deepEqual(mapNetwork(s, { project: "no-such-project" }).groups, []);
});

test("mapNetwork: ties between edges go to the lower project id; an agent without an edge goes to other; unknown status becomes idle", () => {
  const s = {
    agents: { items: [{ key: "a:one", lastAt: "2026-10-16T08:00:00.000Z" }, { key: "a:one", lastAt: "2026-10-16T09:00:00.000Z" }] },
    network: {
      agents: [
        { key: "a:one", label: "one", source: "a", runs: 6, failed: 1, avgDurS: 10.6, active: true, status: "weird", slow: true },
        { key: "a:two", label: "two", source: "a", runs: 2, failed: 0, avgDurS: null, active: false, status: "idle", slow: false },
        { key: "a:three", label: "three", source: "a", runs: 1, failed: 0, avgDurS: null, active: true, status: "healthy", slow: false },
      ],
      projects: [{ id: "zeta", runs: 3 }, { id: "alpha", runs: 3 }, { id: "beta", runs: 9 }],
      edges: [
        { agent: "a:one", project: "zeta", runs: 3, failed: 0, avgDurS: null, status: "healthy" },
        { agent: "a:one", project: "alpha", runs: 3, failed: 1, avgDurS: null, status: "healthy" },
        { agent: "a:two", project: "beta", runs: 2, failed: 0, avgDurS: null, status: "idle" },
      ],
    },
  };
  const m = mapNetwork(s, {});
  assert.deepEqual(m.groups.map((g) => [g.project, g.runs, g.agents.map((a) => a.key)]), [
    ["beta", 9, ["a:two"]], ["alpha", 3, ["a:one"]], ["other", 1, ["a:three"]],
  ]);
  const one = m.groups[1].agents[0];
  assert.equal(one.status, "idle");
  assert.equal(one.avgDurS, 11);
  assert.equal(one.lastAt, "2026-10-16T09:00:00.000Z");
  assert.equal(m.groups[0].agents[0].lastAt, null);
});

test("mapNetwork: lengths are clamped, host detail is scrubbed, a non-object summary throws, no network is an empty map", () => {
  const long = "x".repeat(300);
  const m = mapNetwork({
    network: {
      agents: [{ key: long, label: "run /usr/lib/modules/6.8.0/x.ko " + long, source: "s", runs: 1, failed: 0, avgDurS: 1, active: false, status: "healthy" }],
      projects: [{ id: "p".repeat(100), runs: 1 }],
      edges: [{ agent: long, project: "p".repeat(100), runs: 1 }],
    },
  }, {});
  assert.equal(m.groups[0].agents[0].label.length, 80);
  assert.ok(m.groups[0].agents[0].label.startsWith("run ... "));
  assert.equal(m.groups[0].project.length, 64);
  assert.deepEqual(mapNetwork({}, {}), { groups: [], projects: [] });
  assert.throws(() => mapNetwork(null, {}));
});

// ---- T1.4: engine mode ------------------------------------------------------------------------------------

const ok4 = { ok: true, ms: 1000 };
const build = graphBody("build", ["plan", "code", "review", "ship"], [["plan", "code"], ["code", "review"], ["review", "code"], ["review", "ship"]]);

test("mapEngine: phases come in graph order with the newest run's states; a back edge marks a loop; never-run is idle", () => {
  const older = runRec("r-old", "build", T0, { ended: T0 + 5 * MIN, ok: false, phases: [phaseRec("plan", "done", ok4), phaseRec("code", "failed", { ok: false, ms: 5 })] });
  const newest = runRec("r-new", "build", T0 + 60 * MIN, {
    ended: T0 + 70 * MIN, ok: false,
    phases: [phaseRec("plan", "done", ok4), phaseRec("code", "done", ok4), phaseRec("review", "failed", { ok: false, ms: 3 }), phaseRec("code", "done", ok4)],
  });
  const other = runRec("r-other", "deploy", T0 + 80 * MIN, { ended: T0 + 81 * MIN, ok: true, phases: [phaseRec("ship", "done", ok4)] });
  const e = mapEngine({ runs: [older, newest, other].map(listView) }, build, "build");
  assert.deepEqual(e.phases, [
    { id: "plan", status: "healthy", calls: 1, loop: false },
    { id: "code", status: "healthy", calls: 2, loop: true },
    { id: "review", status: "failing", calls: 1, loop: false },
    { id: "ship", status: "idle", calls: 0, loop: false },
  ]);
  assert.ok(e.phases.every((p) => STATUS4.includes(p.status)));
});

test("mapEngine: workflows list the newest run per graph, newest first; ok is true only for ok runs; no input, cwd or prompt", () => {
  const runs = [
    runRec("a1", "build", T0, { ended: T0 + MIN, ok: true }),
    runRec("a2", "build", T0 + 10 * MIN, { ended: T0 + 12 * MIN, ok: false }),
    runRec("b1", "deploy", T0 + 20 * MIN, { done: false }),
    runRec("c1", "audit", T0 + 5 * MIN, { ended: T0 + 6 * MIN, ok: true }),
  ];
  const e = mapEngine({ runs: runs.map(listView) }, build, "build");
  assert.deepEqual(e.workflows, [
    { graph: "deploy", lastRunAt: new Date(T0 + 20 * MIN).toISOString(), ok: false },
    { graph: "build", lastRunAt: new Date(T0 + 12 * MIN).toISOString(), ok: false },
    { graph: "audit", lastRunAt: new Date(T0 + 6 * MIN).toISOString(), ok: true },
  ]);
  assert.ok(!/secret|PRIVATE|SECRET/i.test(JSON.stringify(e)));
  assert.ok(!allKeys(e).some((k) => ["input", "cwd", "prompt", "output", "actions"].includes(k)));
});

test("mapEngine: no graph asked gives workflows only; a graph with no run is all idle; a running phase counts as healthy", () => {
  assert.deepEqual(mapEngine({ runs: [] }, null, undefined), { workflows: [], phases: [] });
  assert.deepEqual(mapEngine({ runs: [] }, build, "build").phases.map((p) => p.status), ["idle", "idle", "idle", "idle"]);
  const live = runRec("l", "build", T0, { done: false, phases: [phaseRec("plan", "running")] });
  assert.equal(mapEngine({ runs: [listView(live)] }, build, "build").phases[0].status, "healthy");
});

test("mapEngine: key set equals the contract example; malformed input throws", () => {
  const { fetchedAt: _f, reachable: _r, ...example } = contract.routes.X2.responseEngine;
  const run = runRec("r", "build", T0, { ended: T0 + MIN, ok: true, phases: [phaseRec("plan", "done", ok4)] });
  assert.deepEqual(keyPaths(mapEngine({ runs: [listView(run)] }, build, "build")).sort(), keyPaths(example).sort());
  assert.throws(() => mapEngine("oops", null, undefined));
  assert.throws(() => mapEngine({ runs: [] }, "oops", "build"));
});

// ---- T1.5: X3 and X4 traces --------------------------------------------------------------------------------

const NOWMS = T0 + 3 * 60 * MIN;
const iso8 = (ms: number) => new Date(ms).toISOString();
const FORBIDDEN_KEYS = ["input", "output", "cwd", "prompt", "child", "parents", "tokensTotal", "cost", "scope", "model", "elapsedMs", "transitions", "maxCalls", "depth"];

const detailRun = () => runRec("tr_01", "build", T0, {
  ended: T0 + 2 * MIN, ok: true, calls: 7, subCalls: 2,
  phases: [
    phaseRec("plan", "done", { ok: true, ms: 30000, output: "SECRET OUTPUT /root/secret-project/plan", to: "code", tokens: 1200 }),
    phaseRec("code", "done", { ok: true, ms: 900, output: "abcdef", to: "review", tokens: 300 }),
    phaseRec("review", "failed", { ok: false, ms: 40, output: "", tokens: null, error: "failed in /root/secret-project/src/x.ts with token=abc123def456" }),
  ],
});

test("mapTrace: a finished run keeps ids, ISO times, calls plus subCalls, the phase count; nothing else", () => {
  const t = mapTrace(listView(detailRun()), NOWMS);
  assert.deepEqual(t, {
    id: "tr_01", graph: "build", ok: true, done: true, startedAt: iso8(T0), endedAt: iso8(T0 + 2 * MIN), durMs: 2 * MIN, calls: 9, phases: 3,
  });
  const { fetchedAt: _f, reachable: _r, ...example } = contract.routes.X3.response;
  assert.deepEqual(keyPaths({ traces: [t] }).sort(), keyPaths({ traces: example.traces }).sort());
});

test("mapTrace: a running run has durMs so far and endedAt null; ok is only true for an ok run", () => {
  const live = mapTrace(listView(runRec("live", "build", T0, { done: false })), T0 + 5 * MIN);
  assert.equal(live.done, false);
  assert.equal(live.ok, false);
  assert.equal(live.endedAt, null);
  assert.equal(live.durMs, 5 * MIN);
  assert.equal(mapTrace(listView(runRec("bad", "build", T0, { ended: T0 + MIN, ok: false })), NOWMS).ok, false);
  assert.equal(mapTrace(listView(runRec("clock", "build", T0 + 10 * MIN, { ended: T0, ok: true })), NOWMS).durMs, 0, "never negative");
});

const many = () => [1, 2, 3, 4, 5].map((n) => listView(runRec(`r${n}`, "build", T0 + n * 10 * MIN, { ended: T0 + n * 10 * MIN + MIN, ok: true })));

test("mapTraces: newest first, paged on started; next is the started of the last item and null at the end", () => {
  const body = { runs: many() };
  const p1 = mapTraces(body, { limit: 2 }, NOWMS);
  assert.deepEqual(p1.traces.map((t) => t.id), ["r5", "r4"]);
  assert.equal(p1.next, iso8(T0 + 40 * 10 * 0 + 4 * 10 * MIN));
  const p2 = mapTraces(body, { limit: 2, before: Date.parse(p1.next!) }, NOWMS);
  assert.deepEqual(p2.traces.map((t) => t.id), ["r3", "r2"]);
  const p3 = mapTraces(body, { limit: 2, before: Date.parse(p2.next!) }, NOWMS);
  assert.deepEqual(p3.traces.map((t) => t.id), ["r1"]);
  assert.equal(p3.next, null);
  assert.equal(mapTraces(body, { limit: 5 }, NOWMS).next, null);
});

test("mapTraces: lastRunAt is the newest end of all runs, also when the page is empty or past it; null with no runs", () => {
  const body = { runs: many() };
  const all = Date.parse(mapTraces(body, { limit: 1 }, NOWMS).traces[0].endedAt!);
  const lastAt = iso8(all);
  assert.equal(mapTraces(body, { limit: 1 }, NOWMS).lastRunAt, lastAt);
  const old = mapTraces(body, { limit: 20, before: T0 }, NOWMS);
  assert.deepEqual(old.traces, []);
  assert.equal(old.next, null);
  assert.equal(old.lastRunAt, lastAt);
  assert.deepEqual(mapTraces({ runs: [] }, { limit: 20 }, NOWMS), { traces: [], next: null, lastRunAt: null });
  assert.equal(mapTraces({ runs: [listView(runRec("live", "build", T0, { done: false }))] }, { limit: 20 }, NOWMS).lastRunAt, iso8(T0));
  assert.throws(() => mapTraces("oops", { limit: 1 }, NOWMS));
});

test("mapTraces: input, cwd, parents and every other GodHome field stay out of the list", () => {
  const out = mapTraces({ runs: many() }, { limit: 5 }, NOWMS);
  const keys = allKeys(out);
  for (const k of FORBIDDEN_KEYS) assert.ok(!keys.includes(k), k);
  assert.ok(!/PRIVATE|secret-project/.test(JSON.stringify(out)));
});

test("mapTraceDetail: phases with outputBytes and token totals, handoffs from the edges taken, never output or input", () => {
  const d = mapTraceDetail(detailRun(), NOWMS);
  assert.deepEqual(d, {
    id: "tr_01", graph: "build", ok: true, done: true, startedAt: iso8(T0), endedAt: iso8(T0 + 2 * MIN), durMs: 2 * MIN, calls: 9,
    phases: [
      { id: "plan", kind: "agent", state: "done", ok: true, ms: 30000, tokens: 1200, outputBytes: "SECRET OUTPUT /root/secret-project/plan".length },
      { id: "code", kind: "agent", state: "done", ok: true, ms: 900, tokens: 300, outputBytes: 6 },
      { id: "review", kind: "agent", state: "failed", ok: false, ms: 40, outputBytes: 0 },
    ],
    handoffs: [
      { from: "plan", to: "code", chars: "SECRET OUTPUT /root/secret-project/plan".length, latencyMs: null, tokens: 1200 },
      { from: "code", to: "review", chars: 6, latencyMs: null, tokens: 300 },
    ],
  });
  const keys = allKeys(d);
  for (const k of FORBIDDEN_KEYS) assert.ok(!keys.includes(k), k);
  assert.ok(!/SECRET OUTPUT|PRIVATE|secret-project/.test(JSON.stringify(d)));
});

test("mapTraceDetail: key set equals the contract example", () => {
  const { fetchedAt: _f, reachable: _r, ...example } = contract.routes.X4.response;
  assert.deepEqual(keyPaths(mapTraceDetail(detailRun(), NOWMS)).sort(), keyPaths(example).sort());
});

test("mapTraceDetail: error is scrubbed and clamped; a list-shaped phase (outputBytes, no output) still counts", () => {
  const withError = runRec("e", "build", T0, { ended: T0 + MIN, ok: false, error: "crash in /root/secret-project/src/x.ts API_TOKEN=abc123def456 " + "z".repeat(400), phases: [phaseRec("plan", "done", { ok: true, outputBytes: 77 })] });
  const d = mapTraceDetail(withError, NOWMS);
  assert.ok(d.error!.startsWith("crash in ... API_TOKEN=[redacted]"), d.error);
  assert.ok(d.error!.length <= 200);
  assert.equal(d.phases[0].outputBytes, 77);
  assert.equal("error" in mapTraceDetail(runRec("n", "build", T0, { ended: T0 + MIN, ok: true }), NOWMS), false);
});

test("mapTraceDetail: a handoff to a node that did not run, a missing token total and 100+ phases are handled", () => {
  const run = runRec("x", "build", T0, { ended: T0 + MIN, ok: true, phases: [phaseRec("plan", "done", { ok: true, output: "ab", to: "ghost", tokens: null })] });
  const d = mapTraceDetail(run, NOWMS);
  assert.deepEqual(d.handoffs, [{ from: "plan", to: "ghost", chars: 2, latencyMs: null }]);
  assert.ok(!("tokens" in d.phases[0]));
  const big = runRec("big", "build", T0, { ended: T0 + MIN, ok: true, phases: Array.from({ length: 300 }, (_, i) => phaseRec(`p${i}`, "done", { ok: true, to: `p${i + 1}` })) });
  const dd = mapTraceDetail(big, NOWMS);
  assert.equal(dd.phases.length, 100);
  assert.ok(dd.handoffs.length <= 100);
  assert.throws(() => mapTraceDetail(null, NOWMS));
});
