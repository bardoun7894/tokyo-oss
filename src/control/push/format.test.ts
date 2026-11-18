import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildNtfy, buildPayload, GateCounter, type PushEvent } from "./format";

const examples = JSON.parse(readFileSync(join(process.cwd(), "specs", "012-full-control", "contract-examples.json"), "utf8")).pushPayloads as Record<string, any>;

/** The event behind a contract example. */
function eventOf(p: any): PushEvent {
  switch (p.t) {
    case "approval.new": return { type: p.t, id: p.id, project: p.p };
    case "deploy.result": return { type: p.t, id: p.id, project: p.p, outcome: p.o };
    case "run.finished": return { type: p.t, id: p.id, project: p.p };
    case "run.failed": return { type: p.t, id: p.id, project: p.p, outcome: p.o };
    case "incident.new": return { type: p.t, id: p.id, level: p.s, title: p.title.replace(/^Incident: /, "") };
    case "reminder": return { type: p.t, id: p.id, title: p.title, section: p.p };
    default: return { type: "test", id: p.id };
  }
}
const ok = (e: PushEvent) => {
  const r = buildPayload(e);
  assert.ok(r.ok, JSON.stringify(r));
  return r.payload as unknown as Record<string, unknown>;
};

test("every payload type matches its example in contract-examples.json", () => {
  assert.deepEqual(Object.keys(examples).sort(), ["approval.new", "deploy.result", "incident.new", "reminder", "run.failed", "run.finished", "test"]);
  for (const [t, example] of Object.entries(examples)) assert.deepEqual(ok(eventOf(example)), example, t);
});

test("titles: deploy outcomes, run stopped, and the 80 character clamp", () => {
  assert.equal(ok({ type: "deploy.result", id: "3fa9c1d2", project: "demo-site", outcome: "failed" }).title, "Deploy failed: demo-site");
  assert.equal(ok({ type: "deploy.result", id: "3fa9c1d2", project: "demo-site", outcome: "skipped" }).title, "Deploy skipped: demo-site");
  assert.equal(ok({ type: "run.failed", id: "5e6f7a8b", project: "demo-app", outcome: "stopped" }).title, "Run stopped: demo-app");
  const long = ok({ type: "incident.new", id: "i_a1b2c3d4e5f6", level: "warning", title: "x".repeat(300) });
  assert.equal((long.title as string).length, 80);
  assert.match(long.title as string, /…$/);
});

test("scrub: absolute paths and secrets in titles are removed before the gate; relative text stays", () => {
  const p = ok({ type: "incident.new", id: "i_a1b2c3d4e5f6", level: "critical", title: "Disk full on /var/lib/docker/overlay2 now" });
  assert.equal(p.title, "Incident: Disk full on ... now");
  assert.equal(ok({ type: "reminder", id: "r_f0e1d2c3b4a5", title: "Reminder: Fajr prayer" }).title, "Reminder: Fajr prayer");
});

test("a reminder carries its Life section as p; without a section there is no p", () => {
  for (const section of ["finance", "deen", "journal", "today"] as const) {
    assert.equal(ok({ type: "reminder", id: "r_f0e1d2c3b4a5", title: "Reminder: x", section }).p, section);
  }
  assert.equal("p" in ok({ type: "reminder", id: "r_f0e1d2c3b4a5", title: "Reminder: x" }), false);
});

test("the section 5 gate rejects a path, tk_, sk-, Bearer, a phone number in title or p, and more than 1 KB", () => {
  const rejected: PushEvent[] = [
    { type: "approval.new", id: "3fa9c1d2", project: "a/b" },
    { type: "incident.new", id: "i_a1b2c3d4e5f6", level: "critical", title: "token tk_abcdef0123 leaked" },
    { type: "incident.new", id: "i_a1b2c3d4e5f6", level: "critical", title: "key sk-abc used" },
    { type: "incident.new", id: "i_a1b2c3d4e5f6", level: "critical", title: "Authorization Bearer abc123" },
    { type: "incident.new", id: "i_a1b2c3d4e5f6", level: "critical", title: "call +971 50 123 4567 now" },
    { type: "incident.new", id: "i_a1b2c3d4e5f6", level: "critical", title: "call 0501234567 now" },
    { type: "approval.new", id: "3fa9c1d2", project: "+971501234567" },
    { type: "run.finished", id: "x".repeat(2000), project: "demo-site" },
    { type: "run.finished", id: "tk_0123456789ab", project: "demo-site" },
  ];
  for (const e of rejected) {
    const r = buildPayload(e);
    assert.equal(r.ok, false, JSON.stringify(e).slice(0, 80));
  }
});

test("the phone pattern is checked on title and p only: an all-digit id, a date and a short number pass", () => {
  assert.ok(buildPayload({ type: "run.finished", id: "12345678", project: "demo-site" }).ok);
  assert.ok(buildPayload({ type: "test", id: "1234567890123" }).ok, "13 digit id");
  assert.ok(buildPayload({ type: "incident.new", id: "i_a1b2c3d4e5f6", level: "warning", title: "Backup 2026-10-17 took 42 s" }).ok);
  assert.ok(buildPayload({ type: "reminder", id: "r_f0e1d2c3b4a5", title: "Reminder: 5 prayers, 3 left" }).ok);
});

test("a rejected payload counts, never logs its text", () => {
  const counter = new GateCounter();
  const logged: string[] = [];
  const orig = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = (...a: unknown[]) => { logged.push(a.join(" ")); };
  try {
    const r = buildPayload({ type: "incident.new", id: "i_a1b2c3d4e5f6", level: "critical", title: "secret tk_THISMUSTNOTLEAK" }, counter);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(!JSON.stringify(r).includes("THISMUSTNOTLEAK"), "the reason carries no text");
    buildPayload({ type: "test", id: "1" }, counter);
  } finally {
    [console.log, console.warn, console.error] = orig;
  }
  assert.equal(counter.rejected, 1);
  assert.deepEqual(logged.filter((l) => l.includes("THISMUSTNOTLEAK")), []);
});

test("the o3 formatter gives ntfy-native title, tags and a controlapp:// click target", () => {
  const n = buildNtfy({ type: "approval.new", id: "3fa9c1d2", project: "demo-site" });
  assert.ok(n.ok);
  if (n.ok) {
    assert.deepEqual(n.payload, { title: "Approval needed: demo-site", message: "Open Approvals", tags: ["approval"], click: "controlapp://open/offers/3fa9c1d2" });
  }
  const clicks = [
    [{ type: "deploy.result", id: "3fa9c1d2", project: "d", outcome: "succeeded" }, "controlapp://open/offers/3fa9c1d2"],
    [{ type: "run.finished", id: "1a2b3c4d", project: "d" }, "controlapp://open/runs/1a2b3c4d"],
    [{ type: "run.failed", id: "1a2b3c4d", project: "d", outcome: "failed" }, "controlapp://open/runs/1a2b3c4d"],
    [{ type: "incident.new", id: "i_a1b2c3d4e5f6", level: "critical", title: "t" }, "controlapp://open/incidents/i_a1b2c3d4e5f6"],
    [{ type: "reminder", id: "r_f0e1d2c3b4a5", title: "Reminder: Fajr" }, "controlapp://open/reminders"],
    [{ type: "reminder", id: "r_f0e1d2c3b4a5", title: "Reminder: Fajr", section: "deen" }, "controlapp://open/reminders/deen"],
    [{ type: "reminder", id: "r_f0e1d2c3b4a5", title: "Reminder: Rent due today", section: "finance" }, "controlapp://open/reminders/finance"],
    [{ type: "test", id: "1" }, "controlapp://open/settings"],
  ] as const;
  for (const [e, click] of clicks) {
    const r = buildNtfy(e as PushEvent);
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.payload.click, click);
  }
  assert.equal(buildNtfy({ type: "approval.new", id: "3fa9c1d2", project: "tk_x" }).ok, false, "the same gate applies");
});
