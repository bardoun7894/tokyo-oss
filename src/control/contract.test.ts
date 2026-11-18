import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "./contract";

test("enums match the plan.md API reference", () => {
  assert.deepEqual([...C.HOSTS], ["mac", "server"]);
  assert.deepEqual([...C.OFFER_KINDS], ["action", "deploy", "mission"]);
  assert.deepEqual([...C.OFFER_STATES], ["pending", "approved", "declined", "expired"]);
  assert.deepEqual([...C.OFFER_CHANNELS], ["telegram", "app", "terminal", "whatsapp"]);
  assert.deepEqual([...C.RUN_STATUSES], ["queued", "running", "succeeded", "failed", "stopped"]);
  assert.deepEqual([...C.RUN_SOURCES], ["tokyo", "jdelegate", "herdr", "server-agent"]);
  assert.deepEqual([...C.HARNESSES], ["claude", "codex", "gemini", "opencode"]);
  assert.deepEqual([...C.TIERS], ["trivial", "simple", "medium", "hard"]);
  assert.deepEqual([...C.GAP_SEVERITIES], ["P0", "P1", "P2", "P3"]);
  assert.deepEqual([...C.GAP_SOURCES], ["readiness-audit", "defects"]);
  assert.deepEqual([...C.LOG_KINDS], ["assistant", "tool", "result", "system"]);
  assert.deepEqual([...C.NEXT_ACTIONS], ["write-specs", "fix-defects", "implement-open-tasks", "research-features", "verdict", "needs-llm"]);
  assert.deepEqual([...C.ERROR_CODES], ["unauthorized", "bad_request", "not_found", "conflict", "report_only", "rate_limited", "unavailable", "forbidden", "not_registered"]);
});

test("normalisers", () => {
  assert.equal(C.normHost("laptop"), "mac");
  assert.equal(C.normHost("mac"), "mac");
  assert.equal(C.normHost("server"), "server");
  assert.equal(C.normHost("mars"), null);
  assert.equal(C.normRunStatus("ok"), "succeeded");
  assert.equal(C.normRunStatus("error"), "failed");
  assert.equal(C.normRunStatus("running"), "running");
  assert.equal(C.normRunStatus("weird"), null);
  assert.equal(C.normSeverity(undefined), "P2");
  assert.equal(C.normSeverity("P1"), "P1");
  assert.equal(C.normSeverity("high"), "P2");
  assert.equal(C.normGapSource(undefined), "readiness-audit");
  assert.equal(C.normGapSource("defects"), "defects");
  assert.equal(C.normGapSource("x"), "readiness-audit");
});

test("offer state mapping: decline buttons -> declined, others -> approved", () => {
  for (const b of ["skip", "reject"]) assert.equal(C.stateForButton(b), "declined");
  for (const b of ["run", "spec1", "spec2", "spec3", "report", "deploy", "approve", "custom"]) assert.equal(C.stateForButton(b), "approved");
  assert.equal(C.stateForOffer({ state: "pending" }), "pending");
  assert.equal(C.stateForOffer({ state: "superseded" }), "expired");
  assert.equal(C.stateForOffer({ state: "expired" }), "expired");
  assert.equal(C.stateForOffer({ state: "answered", answeredButton: "skip" }), "declined");
  assert.equal(C.stateForOffer({ state: "answered", answeredButton: "run" }), "approved");
  assert.equal(C.normChannel("whatsapp"), "whatsapp");
  assert.equal(C.normChannel("cli"), null);
});

test("alreadyBody is the flat 409 shape", () => {
  assert.deepEqual(C.alreadyBody("telegram", Date.parse("2026-10-09T09:00:00Z")),
    { error: "already", answeredBy: { channel: "telegram", at: "2026-10-09T09:00:00.000Z" } });
  assert.deepEqual(C.errorBody("not_found", "no such run"), { error: { code: "not_found", message: "no such run" } });
});

const T = Date.parse("2026-10-09T09:00:00Z");
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;

test("viewRun: every field serialized, enums respected, laptop -> mac", () => {
  const v = C.viewRun({ id: "9f31ac02", project: "tokyo", source: "herdr", status: "running", model: "m", harness: "claude",
    worker: "w", tier: "hard", promptPreview: "x".repeat(300), startedAt: T, endedAt: null, exitCode: null, host: "laptop", offerId: "a1", workspace: "ws" });
  assert.deepEqual(Object.keys(v).sort(), ["endedAt", "exitCode", "harness", "host", "id", "model", "offerId", "project", "promptPreview", "source", "startedAt", "status", "tier", "worker"]);
  assert.equal(v.host, "mac");
  assert.equal(v.promptPreview.length, 200);
  assert.match(v.startedAt, ISO);
  assert.equal(v.endedAt, null);
  assert.ok(C.RUN_SOURCES.includes(v.source) && C.RUN_STATUSES.includes(v.status));
  assert.ok(!("workspace" in v), "workspace label is not exposed");
});

test("viewRun: unknown enum values become null/defaults, never leak", () => {
  const v = C.viewRun({ id: "9f31ac02", project: "p", source: "zzz", status: "ok", model: null, harness: "gpt", worker: null, tier: "huge",
    promptPreview: "", startedAt: T, endedAt: T, exitCode: 0, host: "mars", offerId: null, workspace: null });
  assert.equal(v.status, "succeeded");
  assert.equal(v.harness, null);
  assert.equal(v.tier, null);
  assert.equal(v.source, "tokyo");
  assert.equal(v.host, "server");
});

test("viewGap and viewLogEvent", () => {
  assert.deepEqual(C.viewGap({ code: "G1", text: "t" }), { code: "G1", text: "t", severity: "P2", source: "readiness-audit" });
  assert.deepEqual(C.viewGap({ code: "G2", text: "t", severity: "P0", source: "defects", extra: 1 } as any), { code: "G2", text: "t", severity: "P0", source: "defects" });
  const e = C.viewLogEvent({ t: T, kind: "assistant", text: "y".repeat(5000), tool: undefined });
  assert.match(e.t, ISO);
  assert.equal(e.text.length, 2000);
  assert.equal(e.tool, null);
  assert.equal(C.viewLogEvent({ t: T, kind: "bogus", text: "a" }).kind, "system");
});

test("viewOffer: allow-listed fields, state from button, buttons for kinds", () => {
  const pending = C.viewOffer({ id: "a1b2c3d4", kind: "action", project: "tokyo", title: "T", body: "b".repeat(2000), from: "f",
    state: "pending", missionId: null, buttons: [{ id: "run", label: "Run", extra: 1 } as any], createdAt: T, expiresAt: T + 1, answeredButton: null, channel: null, answeredAt: null, secret: "x" } as any);
  assert.deepEqual(Object.keys(pending).sort(), ["answeredAt", "answeredButton", "body", "buttons", "channel", "createdAt", "expiresAt", "from", "id", "kind", "missionId", "project", "state", "title"]);
  assert.equal(pending.body.length, 1500);
  assert.deepEqual(pending.buttons, [{ id: "run", label: "Run" }]);
  assert.equal(pending.state, "pending");
  const done = C.viewOffer({ id: "a", kind: "deploy", project: "p", title: "t", body: "b", from: null, state: "answered", missionId: null, buttons: C.DEPLOY_BUTTONS,
    createdAt: T, expiresAt: T, answeredButton: "skip", channel: "terminal", answeredAt: T });
  assert.equal(done.state, "declined");
  assert.equal(done.channel, "terminal");
  assert.deepEqual(done.buttons.map((b) => b.label), ["Deploy", "Not now"]);
  assert.deepEqual(C.MISSION_BUTTONS.map((b) => b.label), ["Approve", "Skip"]);
  const exp = C.viewOffer({ id: "a", kind: "action", project: "p", title: "t", body: "", from: null, state: "superseded", missionId: null, buttons: [], createdAt: T, expiresAt: T, answeredButton: null, channel: "telegram", answeredAt: null });
  assert.equal(exp.state, "expired");
  assert.equal(exp.channel, null, "channel null while pending or expired");
});

test("viewProject: normalises host, nextAction and clamps completeness", () => {
  const p = C.viewProject({ name: "tokyo", host: "laptop", customer: false, completeness: 9, nextAction: "nonsense" });
  assert.equal(p.host, "mac");
  assert.equal(p.nextAction, "needs-llm");
  assert.equal(p.completeness, 4);
  assert.equal(C.viewProject({ name: "t", host: "server", customer: true, completeness: 3, nextAction: "fix-defects" }).nextAction, "fix-defects");
});
