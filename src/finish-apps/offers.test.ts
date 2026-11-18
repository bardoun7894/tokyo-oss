import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOffers, MAX_CARDS, SKIP_COOLDOWN_MS, type OfferCtx } from "./offers";
import type { TriageEntry, Recommendation } from "./summary";

function entry(name: string, over: Partial<TriageEntry> = {}): TriageEntry {
  return {
    name, host: "server", commits: 3, specs_total: 2, specs_missing_plan: 0, specs_missing_tasks: 0, open_tasks: 4,
    completeness: 2, next_action: "fix-defects", ...over,
  };
}
const rec = (n: number): Recommendation => ({
  code: `R${n}`, title: `Title ${n}`, kind: "feature", why: `why ${n}`, evidence: [`ev${n}`], size: "S", impact: 3,
});
function ctx(over: Partial<OfferCtx> = {}): OfferCtx & { logs: string[] } {
  const logs: string[] = [];
  return {
    date: "2026-10-09",
    now: 1_000_000_000_000,
    getProject: (n: string) => ({ name: n, location: "server", path: `/srv/${n}` }),
    recentSkips: () => 0,
    readerFor: () => null,
    log: (m: string) => logs.push(m),
    logs,
    ...over,
  } as any;
}
const ids = (o: { buttons: { id: string }[] }) => o.buttons.map((b) => b.id).join(",");
const recsFor = (name: string, n: number) => [{ name, recommendations: [1, 2, 3].slice(0, n).map(rec) }];

test("skip only when verdict AND completeness 4", () => {
  const t = [
    entry("done", { next_action: "verdict", completeness: 4 }),
    entry("almost", { next_action: "verdict", completeness: 3 }),
    entry("odd", { next_action: "fix-defects", completeness: 4 }),
  ];
  const out = buildOffers(t, [], ctx());
  assert.deepEqual(out.map((o) => o.project).sort(), ["almost", "odd"]);
});

test("needs-llm gets report and skip only", () => {
  const [o] = buildOffers([entry("x", { next_action: "needs-llm", completeness: null })], recsFor("x", 3), ctx());
  assert.equal(ids(o), "report,skip");
});

test("customer: report and skip, --report-only, no recommendations, no implement card", () => {
  const [o] = buildOffers([entry("up", { customer: true, report_only: true })], recsFor("up", 3), ctx());
  assert.equal(ids(o), "report,skip");
  const report = o.buttons.find((b) => b.id === "report")!;
  assert.match(report.prompt!, /--report-only/);
  assert.doesNotMatch(report.prompt!, /Implement approved specs/);
  assert.doesNotMatch(o.body, /R1 /);
  assert.equal(o.buttons.find((b) => b.id === "skip")!.prompt, undefined);
});

test("next_action maps to its run prompt, every run prompt has the stop and the implement card", () => {
  const cases: [string, RegExp][] = [
    ["write-specs", /readiness-audit tokyo --defects/],
    ["fix-defects", /readiness-audit tokyo --defects/],
    ["verdict", /readiness-audit tokyo --defects/],
    ["research-features", /market-swot project \/srv\/tokyo[\s\S]*readiness-audit tokyo --defects/],
    ["implement-open-tasks", /open tasks[\s\S]*No code changes/],
  ];
  for (const [na, re] of cases) {
    const [o] = buildOffers([entry("tokyo", { next_action: na, completeness: 3 })], [], ctx());
    const p = o.buttons.find((b) => b.id === "run")!.prompt!;
    assert.match(p, re, na);
    assert.match(p, /Do not implement anything in this run/, na);
    assert.match(p, /FINISH-APPS-2026-10-09\.md/, na);
    assert.match(p, /tokyo-offer ask tokyo "Implement approved specs\?"/, na);
    assert.ok(p.length <= 8000);
  }
});

test("non-customer card: run, spec1..3, report, skip; fewer recs give fewer specN", () => {
  const t = [entry("tokyo")];
  assert.equal(ids(buildOffers(t, recsFor("tokyo", 3), ctx())[0]), "run,spec1,spec2,spec3,report,skip");
  assert.equal(ids(buildOffers(t, recsFor("tokyo", 1), ctx())[0]), "run,spec1,report,skip");
  assert.equal(ids(buildOffers(t, recsFor("tokyo", 0), ctx())[0]), "run,report,skip");
  assert.equal(ids(buildOffers(t, [{ name: "tokyo", skipped: "other-host", recommendations: [] }] as any, ctx())[0]), "run,report,skip");
});

test("Write spec Rn prompt", () => {
  const [o] = buildOffers([entry("tokyo")], recsFor("tokyo", 3), ctx());
  const b = o.buttons.find((x) => x.id === "spec2")!;
  assert.equal(b.label, "Write spec R2");
  assert.ok(b.label.length <= 32);
  assert.match(b.prompt!, /Title 2/);
  assert.doesNotMatch(b.prompt!, /Title 1|Title 3/);
  assert.match(b.prompt!, /kb-spec pre/);
  assert.match(b.prompt!, /speckit\.specify/);
  assert.match(b.prompt!, /no plan, no tasks, no code/i);
  assert.match(b.prompt!.trimEnd().split("\n").pop()!, /tokyo-offer ask tokyo "Plan and implement spec/);
});

test("card body has Done/Missing and R lines", () => {
  const [o] = buildOffers([entry("tokyo")], recsFor("tokyo", 3), ctx());
  assert.match(o.body, /^Done: /m);
  assert.match(o.body, /^Missing: /m);
  assert.match(o.body, /^R1 Title 1 \(S, impact 3\)$/m);
  assert.match(o.body, /^R3 Title 3/m);
  assert.equal(o.title, "tokyo is 2/4: fix-defects");
  assert.equal(o.from, "finish-apps-2026-10-09");
  assert.ok(o.body.length <= 1500);
});

test("cap of 5 lowest completeness first, plus one N more card with skip only", () => {
  const t = [4, 3, 1, 2, 0, 3, 2, 1].map((c, i) => entry(`p${i}`, { completeness: c, next_action: "fix-defects" }));
  const out = buildOffers(t, [], ctx());
  assert.equal(MAX_CARDS, 5);
  assert.equal(out.length, 6);
  assert.deepEqual(out.slice(0, 5).map((o) => o.project), ["p4", "p2", "p7", "p3", "p6"]);
  const more = out[5];
  assert.equal(ids(more), "skip");
  assert.match(more.title, /3 more/);
  assert.match(more.body, /p1/);
  assert.equal(more.from, "finish-apps-2026-10-09-more");
});

test("exactly 5 projects: no more card", () => {
  const t = [0, 1, 2, 3, 3].map((c, i) => entry(`p${i}`, { completeness: c }));
  assert.equal(buildOffers(t, [], ctx()).length, 5);
});

test("skip cooldown 3 days and unknown project", () => {
  assert.equal(SKIP_COOLDOWN_MS, 3 * 24 * 60 * 60 * 1000);
  const c = ctx({ recentSkips: (n: string) => (n === "b" ? 1 : 0), getProject: (n: string) => (n === "ghost" ? undefined : ({ name: n, location: "server", path: "/x" } as any)) });
  const out = buildOffers([entry("a"), entry("b"), entry("ghost")], [], c);
  assert.deepEqual(out.map((o) => o.project), ["a"]);
  assert.ok(c.logs.some((l) => /ghost/.test(l) && /registry/.test(l)));
  assert.ok(c.logs.some((l) => /b/.test(l) && /skip/i.test(l)));
});

// T118: resolve an active.sh project to a run directory (registry by path, ad-hoc server, Mac report-only)
const reg = [
  { name: "fashiondemo", location: "server" as const, path: "/var/local/fashiondemo" },
  { name: "tokyo", location: "server" as const, path: "/root/tokyo" },
  { name: "macapp", location: "laptop" as const, path: "/Users/m/projects/macapp" },
];
const pctx = (over: Partial<OfferCtx> = {}) =>
  ctx({ getProject: () => undefined, listProjects: () => reg, ...over } as any);

test("T118 rule 1: registry entry matching the active path", () => {
  const c = pctx();
  const [o] = buildOffers([entry("tokyo", { path: "/root/tokyo" })], [], c);
  assert.equal(o.project, "tokyo");
  assert.match(o.buttons.find((b) => b.id === "run")!.prompt!, /readiness-audit tokyo/);
  assert.ok(c.logs.some((l) => /tokyo/.test(l) && /rule 1/.test(l)));
});

test("T118 rule 1: registry entry matching an also_at server path runs in the active checkout", () => {
  const c = pctx();
  const [o] = buildOffers(
    [entry("FashionDemo", { path: "/root/projects/FashionDemo", also_at: ["server:/var/local/fashiondemo"], next_action: "research-features" })],
    [], c,
  );
  assert.equal(o.project, "fashiondemo");
  const p = o.buttons.find((b) => b.id === "run")!.prompt!;
  assert.match(p, /market-swot project \/root\/projects\/FashionDemo/);
  assert.doesNotMatch(p, /\/var\/local\/fashiondemo/);
  assert.ok(c.logs.some((l) => /rule 1/.test(l)));
});

test("T118 rule 2: unregistered server project is an ad-hoc project at its active path", () => {
  const c = pctx();
  const [o] = buildOffers([entry("board", { path: "/root/board", next_action: "research-features" })], [], c);
  assert.equal(o.project, "board");
  assert.match(o.buttons.find((b) => b.id === "run")!.prompt!, /market-swot project \/root\/board/);
  assert.ok(c.logs.some((l) => /board/.test(l) && /rule 2/.test(l)));
});

test("T118 rule 3: Mac-only project gets a report-only card without Run buttons", () => {
  const c = pctx();
  const out = buildOffers(
    [entry("macapp", { host: "mac", path: "/Users/m/projects/macapp" }), entry("newmac", { host: "mac", path: "/Users/m/projects/newmac" })],
    recsFor("macapp", 3), c,
  );
  assert.equal(out.length, 2);
  for (const o of out) assert.equal(ids(o), "report,skip");
  assert.match(out[0].buttons.find((b) => b.id === "report")!.prompt!, /--report-only/);
  assert.equal(c.logs.filter((l) => /rule 3/.test(l)).length, 1);
  assert.ok(c.logs.some((l) => /macapp/.test(l) && /rule 1/.test(l)));
});

test("T118 no path: falls back to the registry by name, unknown is skipped", () => {
  const c = ctx({ getProject: (n: string) => (n === "known" ? ({ name: n, location: "server", path: "/srv/known" } as any) : undefined) });
  const out = buildOffers([entry("known"), entry("ghost")], [], c);
  assert.deepEqual(out.map((o) => o.project), ["known"]);
});
