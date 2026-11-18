import { test } from "node:test";
import assert from "node:assert/strict";
import { AllowlistCache, loadAllowlist, resolveRestart, targetOf, validateEntry, type AllowEntry, type AllowFs } from "./ops-restart";

const entry = (over: Record<string, unknown> = {}) => ({ id: "crm", kind: "docker", name: "crmdemo-backend-1", label: "CRM backend", cooldownSec: 300, ...over });

/** An injected file system: `files` maps a path to its content; stat answers from `meta`. */
function fakeFs(content: string | null, meta: Partial<{ mode: number; uid: number; mtimeMs: number }> = {}) {
  const calls = { stat: 0, read: 0 };
  let current = content;
  let mtime = meta.mtimeMs ?? 1;
  const fs: AllowFs = {
    stat: () => { calls.stat++; return current === null ? null : { mode: meta.mode ?? 0o100600, uid: meta.uid ?? 0, mtimeMs: mtime }; },
    read: () => { calls.read++; return current ?? ""; },
  };
  return { fs, calls, set: (c: string | null, m?: number) => { current = c; if (m !== undefined) mtime = m; } };
}
const warns = () => { const w: string[] = []; return { w, warn: (m: string) => { w.push(m); } }; };

test("a missing file is an empty allowlist and logs nothing", () => {
  const f = fakeFs(null);
  const { w, warn } = warns();
  assert.deepEqual(loadAllowlist("/etc/tokyo/ops-restart.json", f.fs, warn), []);
  assert.deepEqual(w, []);
});

test("valid entries load; label and cooldownSec default; pm2 and systemd entries are accepted", () => {
  const f = fakeFs(JSON.stringify([
    entry(),
    { id: "p", kind: "pm2", name: "portfolio-next" },
    { id: "u", kind: "systemd", name: "user@111.service", label: "User manager", cooldownSec: 60 },
  ]));
  const { w, warn } = warns();
  assert.deepEqual(loadAllowlist("/x", f.fs, warn), [
    { id: "crm", kind: "docker", name: "crmdemo-backend-1", label: "CRM backend", cooldownSec: 300 },
    { id: "p", kind: "pm2", name: "portfolio-next", label: "portfolio-next", cooldownSec: 300 },
    { id: "u", kind: "systemd", name: "user@111.service", label: "User manager", cooldownSec: 60 },
  ]);
  assert.deepEqual(w, []);
});

test("validateEntry rejects shell characters, .., a leading -, an 81 char name, tokyo, bad kinds and bad cooldowns", () => {
  const bad: [string, Record<string, unknown>][] = [
    ["semicolon", { name: "a;rm" }], ["space", { name: "a b" }], ["dollar", { name: "a$b" }], ["dotdot", { name: "a..b" }],
    ["leading dash", { name: "-rf" }], ["81 chars", { name: "a".repeat(81) }], ["empty", { name: "" }], ["slash", { name: "a/b" }],
    ["tokyo", { name: "tokyo" }], ["Tokyo upper", { name: "Tokyo" }], ["tokyo.service", { kind: "systemd", name: "tokyo.service" }],
    ["kind shell", { kind: "shell" }], ["no kind", { kind: undefined }], ["cooldown negative", { cooldownSec: -1 }], ["cooldown float", { cooldownSec: 1.5 }],
    ["cooldown huge", { cooldownSec: 86401 }], ["id with space", { id: "a b" }], ["empty id", { id: "" }], ["label not string", { label: 5 }],
  ];
  for (const [why, over] of bad) assert.equal(validateEntry(entry(over)).ok, false, why);
  for (const raw of [null, "x", 5, [], undefined]) assert.equal(validateEntry(raw).ok, false);
  const ok = validateEntry(entry({ name: "my-tokyo-helper", cooldownSec: 0 }));
  assert.equal(ok.ok, true, "tokyo inside the name is not Tokyo; cooldown 0 is allowed");
  assert.equal(validateEntry(entry({ name: "a".repeat(80) })).ok, true);
});

test("a duplicate id and a rejected entry are dropped with a warning that carries no entry content", () => {
  const f = fakeFs(JSON.stringify([entry(), entry({ name: "other-1" }), entry({ id: "t", name: "tokyo" }), entry({ id: "z", name: "z;z" })]));
  const { w, warn } = warns();
  const list = loadAllowlist("/x", f.fs, warn);
  assert.deepEqual(list.map((e) => e.id), ["crm"]);
  assert.equal(w.length, 3);
  assert.ok(w.every((m) => !/tokyo|z;z|other-1/.test(m)), "a warning names the position and the reason, not the entry");
});

test("a file that is not 0600, not owned by root, or not valid JSON loads nothing and warns once", () => {
  const body = JSON.stringify([entry()]);
  for (const [why, meta] of [["mode 0644", { mode: 0o100644 }], ["mode 0660", { mode: 0o100660 }], ["mode 0400", { mode: 0o100400 }], ["owner 1000", { uid: 1000 }]] as const) {
    const f = fakeFs(body, meta);
    const { w, warn } = warns();
    assert.deepEqual(loadAllowlist("/x", f.fs, warn), [], why);
    assert.equal(w.length, 1, why);
    assert.equal(f.calls.read, 0, `${why}: the content is not even read`);
  }
  for (const text of ["{not json", JSON.stringify({ entries: [entry()] }), "5"]) {
    const { w, warn } = warns();
    assert.deepEqual(loadAllowlist("/x", fakeFs(text).fs, warn), [], text);
    assert.equal(w.length, 1, text);
  }
});

test("AllowlistCache reads once per mtime, reloads when it changes, and drops everything if the file becomes unsafe or goes away", () => {
  const f = fakeFs(JSON.stringify([entry()]), { mtimeMs: 10 });
  const { warn } = warns();
  const cache = new AllowlistCache("/x", f.fs, warn);
  assert.equal(cache.get().length, 1);
  assert.equal(cache.get().length, 1);
  assert.equal(f.calls.read, 1, "the second get used the cache");
  f.set(JSON.stringify([entry(), entry({ id: "b", name: "b-1" })]), 11);
  assert.equal(cache.get().length, 2);
  assert.equal(f.calls.read, 2);
  f.set(null);
  assert.deepEqual(cache.get(), [], "file removed: empty allowlist");
  f.set(JSON.stringify([entry()]), 12);
  assert.equal(cache.get().length, 1);
});

// --- T4.2: target resolution from a raw GodHome incident item ---

const item = (title: string, over: Record<string, unknown> = {}) => ({ id: `check:${title.split(":")[0]}:1`, kind: "check", project: "server", check: title.split(":")[0], title, ...over });
const T = (i: Record<string, unknown>) => targetOf(i);

test("targetOf: only docker, unit and pm2 checks on project server resolve, from the real titles", () => {
  const cases: [string, ReturnType<typeof targetOf>][] = [
    ["docker: crmdemo-postgres-1 exited (restart=unless-stopped):", { kind: "docker", name: "crmdemo-postgres-1" }],
    ["docker: 9501bc562a82_studio2-dev-sites created (restart=unless-stopped):", { kind: "docker", name: "9501bc562a82_studio2-dev-sites" }],
    ["docker: mtapichk not running", { kind: "docker", name: "mtapichk" }],
    ["unit: x.service loaded failed failed Some unit", { kind: "systemd", name: "x.service" }],
    ["unit: user@111.service loaded failed failed User Manager for UID 111", { kind: "systemd", name: "user@111.service" }],
    ["pm2: portfolio-next restarts=65358 (was 64236)", { kind: "pm2", name: "portfolio-next" }],
    ["site: www.shopdemo.com 000", null],
    ["disk: <path> 89% (df -P)", null],
    ["backup: shopdemo 0 bytes (under 1KB)", null],
  ];
  for (const [title, want] of cases) assert.deepEqual(T(item(title)), want, title);
});

test("targetOf: a crafted or option-like title yields nothing", () => {
  for (const title of [
    "docker: a; rm -rf / exited", "docker: $(id) exited", "docker: -rf exited", "docker: ../x exited", "docker: a|b exited", "docker: `id` exited",
    "unit: foo exited", "unit: a;b.service loaded failed", "pm2: x;y restarts=3", "pm2: -x restarts=3", "docker:  exited", `docker: ${"a".repeat(81)} exited`,
  ]) assert.equal(T(item(title)), null, title);
});

test("targetOf: tokyo is never a target, whatever the title or target field says", () => {
  for (const title of ["docker: tokyo exited", "unit: tokyo.service loaded failed", "pm2: tokyo restarts=2", "docker: Tokyo exited"]) assert.equal(T(item(title)), null, title);
  assert.equal(T(item("docker: x exited", { target: "tokyo" })), null);
});

test("targetOf: kind, project and host gate the result", () => {
  const title = "docker: crmdemo-postgres-1 exited (restart=unless-stopped):";
  assert.equal(T(item(title, { project: "shopdemo" }))?.name, undefined, "a check of another project");
  assert.equal(T(item(title, { kind: "agent" })), null);
  assert.equal(T(item(title, { kind: "review" })), null);
  assert.equal(T(item(title, { host: "mac", target: "crmdemo-postgres-1" })), null, "a Mac-host incident");
  assert.equal(T(item(title, { host: "hetzner" })), null);
  assert.deepEqual(T(item(title, { host: "app-server" })), { kind: "docker", name: "crmdemo-postgres-1" });
  assert.deepEqual(T(item(title)), { kind: "docker", name: "crmdemo-postgres-1" }, "events from before H1 have no host: project server is enough");
});

test("targetOf: an H1 target wins over a conflicting title; an unusable target falls back to the title", () => {
  assert.deepEqual(T(item("docker: other-name exited (1)", { target: "real-name", host: "app-server" })), { kind: "docker", name: "real-name" });
  assert.deepEqual(T(item("unit: other.service loaded failed", { target: "real.service" })), { kind: "systemd", name: "real.service" });
  assert.deepEqual(T(item("pm2: other restarts=3", { target: "real-app" })), { kind: "pm2", name: "real-app" });
  assert.deepEqual(T(item("docker: title-name exited", { target: "a;b" })), { kind: "docker", name: "title-name" });
  assert.deepEqual(T(item("unit: title.service loaded failed", { target: "notaservice" })), { kind: "systemd", name: "title.service" });
  assert.equal(T(item("site: www.shopdemo.com 000", { target: "www.shopdemo.com" })), null, "a site target is not restartable");
  assert.equal(T(item("docker: a;b exited", { target: "x y" })), null);
});

const LIST: AllowEntry[] = [
  { id: "pg", kind: "docker", name: "crmdemo-postgres-1", label: "CRM postgres", cooldownSec: 300 },
  { id: "u", kind: "systemd", name: "x.service", label: "X", cooldownSec: 300 },
  { id: "app", kind: "pm2", name: "portfolio-next", label: "Portfolio", cooldownSec: 300 },
  { id: "same", kind: "pm2", name: "crmdemo-postgres-1", label: "pm2 app with a docker name", cooldownSec: 300 },
];

test("resolveRestart: an exact (kind, name) match on the allowlist; a resolvable target that is not listed gets none", () => {
  assert.equal(resolveRestart(item("docker: crmdemo-postgres-1 exited"), LIST)?.id, "pg", "docker incident, not the pm2 entry of the same name");
  assert.equal(resolveRestart(item("unit: x.service loaded failed"), LIST)?.id, "u", "unit maps to systemd");
  assert.equal(resolveRestart(item("pm2: portfolio-next restarts=3"), LIST)?.id, "app");
  assert.equal(resolveRestart(item("docker: 9501bc562a82_studio2-dev-sites created (restart=unless-stopped):"), LIST), null, "resolves but is not listed");
  assert.deepEqual(T(item("docker: 9501bc562a82_studio2-dev-sites created")), { kind: "docker", name: "9501bc562a82_studio2-dev-sites" });
  assert.equal(resolveRestart(item("docker: CRMAI-POSTGRES-1 exited"), LIST), null, "names are case sensitive");
  assert.equal(resolveRestart(item("docker: crmdemo-postgres-1 exited"), []), null, "empty allowlist");
  assert.equal(resolveRestart(item("docker: a; rm -rf / exited"), LIST), null);
  assert.equal(resolveRestart(item("docker: crmdemo-postgres-1 exited", { host: "mac" }), LIST), null);
});

// --- T4.3: argv, state mapping and the runner ---

import { parseState, restartArgv, runRestart, stateArgv, type Exec, type ExecResult } from "./ops-restart";

const res = (over: Partial<ExecResult> = {}): ExecResult => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...over });

test("restartArgv is exactly systemctl, docker or pm2 with the name as one element, and refuses anything unsafe", () => {
  assert.deepEqual(restartArgv({ kind: "systemd", name: "x.service" }), ["systemctl", "restart", "x.service"]);
  assert.deepEqual(restartArgv({ kind: "docker", name: "crmdemo-postgres-1" }), ["docker", "restart", "crmdemo-postgres-1"]);
  assert.deepEqual(restartArgv({ kind: "pm2", name: "portfolio-next" }), ["pm2", "restart", "portfolio-next"]);
  for (const name of ["tokyo", "TOKYO", "-rf", "a;b", "a b", "a$b", "../x", ""]) assert.throws(() => restartArgv({ kind: "docker", name }), /unsafe/, name);
  assert.deepEqual(stateArgv({ kind: "systemd", name: "x.service" }), ["systemctl", "is-active", "x.service"]);
  assert.deepEqual(stateArgv({ kind: "docker", name: "web" }), ["docker", "inspect", "-f", "{{.State.Status}}", "web"]);
  assert.deepEqual(stateArgv({ kind: "pm2", name: "app" }), ["pm2", "jlist"]);
});

test("parseState maps each tool's answer to active, inactive, failed or unknown; systemctl's non-zero exit still carries the word", () => {
  const sd = (s: string, code = 0) => parseState({ kind: "systemd", name: "x.service" }, res({ stdout: s + "\n", code }));
  assert.deepEqual([sd("active"), sd("inactive", 3), sd("failed", 3), sd("activating"), sd(""), sd("garbage")], ["active", "inactive", "failed", "unknown", "unknown", "unknown"]);
  const dk = (s: string) => parseState({ kind: "docker", name: "web" }, res({ stdout: s + "\n" }));
  assert.deepEqual([dk("running"), dk("exited"), dk("created"), dk("paused"), dk("dead"), dk("restarting"), dk("")], ["active", "inactive", "inactive", "inactive", "failed", "unknown", "unknown"]);
  const jl = (list: unknown[], pre = "") => parseState({ kind: "pm2", name: "app" }, res({ stdout: pre + JSON.stringify(list) }));
  const p = (name: string, status: string) => ({ name, pm2_env: { status } });
  assert.deepEqual([jl([p("app", "online")]), jl([p("app", "stopped")]), jl([p("app", "errored")]), jl([p("app", "launching")]), jl([p("other", "online")]), jl([], "[PM2] noise\n")], ["active", "inactive", "failed", "unknown", "unknown", "unknown"]);
  assert.equal(parseState({ kind: "pm2", name: "app" }, res({ stdout: "not json" })), "unknown");
});

/** A scripted exec: every call is recorded; `answers` are served in order for the state reads. */
function scripted(first: ExecResult, states: ExecResult[]) {
  const calls: string[][] = [];
  let reads = 0;
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    if (calls.length === 1) return first;
    return states[Math.min(reads++, states.length - 1)]!;
  };
  return { exec, calls };
}

test("runRestart: restart, then a state read; polls up to 10 s while the state is unknown; a timeout or a non-zero exit is not ok", async () => {
  const t = { kind: "docker", name: "web" } as const;
  const slept: number[] = [];
  const sleep = async (ms: number) => { slept.push(ms); };
  let s = scripted(res(), [res({ stdout: "running" })]);
  assert.deepEqual(await runRestart(t, { exec: s.exec, sleep }), { ok: true, state: "active" });
  assert.deepEqual(s.calls, [["docker", "restart", "web"], ["docker", "inspect", "-f", "{{.State.Status}}", "web"]]);
  assert.deepEqual(slept, [], "an immediate answer does not wait");

  s = scripted(res(), [res({ stdout: "restarting" }), res({ stdout: "restarting" }), res({ stdout: "running" })]);
  assert.deepEqual(await runRestart(t, { exec: s.exec, sleep }), { ok: true, state: "active" });
  assert.equal(slept.length, 2);

  slept.length = 0;
  s = scripted(res(), [res({ stdout: "restarting" })]);
  assert.deepEqual(await runRestart(t, { exec: s.exec, sleep }), { ok: true, state: "unknown" });
  assert.equal(slept.reduce((a, b) => a + b, 0), 10_000, "gives up after 10 s");

  s = scripted(res({ timedOut: true, code: null }), [res({ stdout: "running" })]);
  assert.deepEqual(await runRestart(t, { exec: s.exec, sleep }), { ok: false, state: "failed" });
  assert.equal(s.calls.length, 1, "no state read after a timeout");

  s = scripted(res({ code: 1, stderr: "boom" }), [res({ stdout: "exited" })]);
  assert.deepEqual(await runRestart(t, { exec: s.exec, sleep }), { ok: false, state: "inactive" });

  s = scripted(res(), [res({ stdout: "dead" })]);
  assert.deepEqual(await runRestart(t, { exec: s.exec, sleep }), { ok: false, state: "failed" }, "restart returned 0 but the thing is failed");
  slept.length = 0;
  s = scripted(res(), [res({ stdout: "exited" })]);
  assert.deepEqual(await runRestart(t, { exec: s.exec, sleep }), { ok: true, state: "inactive" });
  assert.deepEqual(slept, [], "inactive is final, no polling");
});

// --- review R2: pm2 selectors that are not one app ---

test("R2: for kind pm2 the names `all`, all-digit ids and namespaces are rejected in validateEntry, targetOf and restartArgv", () => {
  for (const name of ["all", "ALL", "0", "1", "42", "default", "Default"]) {
    assert.equal(validateEntry(entry({ kind: "pm2", name })).ok, false, `validateEntry pm2 ${name}`);
    assert.equal(T(item(`pm2: ${name} restarts=3`)), null, `targetOf title pm2 ${name}`);
    assert.equal(T(item("pm2: real-app restarts=3", { target: name })), null, `targetOf target pm2 ${name}`);
    assert.throws(() => restartArgv({ kind: "pm2", name }), /unsafe/, `restartArgv pm2 ${name}`);
    assert.throws(() => stateArgv({ kind: "pm2", name }), /unsafe/, `stateArgv pm2 ${name}`);
  }
  assert.deepEqual(restartArgv({ kind: "pm2", name: "app-1" }), ["pm2", "restart", "app-1"], "a digit inside a name is fine");
  assert.deepEqual(restartArgv({ kind: "pm2", name: "all-sites" }), ["pm2", "restart", "all-sites"], "`all` as a prefix is fine");
  assert.equal(validateEntry(entry({ kind: "pm2", name: "portfolio-next" })).ok, true);
});

test("R2: the same names stay allowed for docker and systemd, where they are ordinary names", () => {
  for (const kind of ["docker", "systemd"] as const) {
    assert.equal(validateEntry(entry({ kind, name: "all" })).ok, true, `${kind} all`);
    assert.equal(validateEntry(entry({ kind, name: "default" })).ok, true, `${kind} default`);
    assert.deepEqual(restartArgv({ kind, name: "all" }).slice(1), ["restart", "all"]);
  }
  assert.deepEqual(T(item("docker: default exited")), { kind: "docker", name: "default" });
});

// --- spec 012 T3.2: exact self-exclusion (F8, R2) ---

import { isSelf } from "./ops-restart";

test("T3.2: tokyo, TOKYO, pm2-root.service, pm2 all, 1 and default are rejected by the loader and by restartArgv", () => {
  const bad: [string, Record<string, unknown>][] = [
    ["tokyo", { kind: "pm2", name: "tokyo" }], ["TOKYO", { kind: "pm2", name: "TOKYO" }], ["pm2-root.service", { kind: "systemd", name: "pm2-root.service" }],
    ["PM2-ROOT.SERVICE", { kind: "systemd", name: "PM2-ROOT.SERVICE" }], ["all", { kind: "pm2", name: "all" }], ["1", { kind: "pm2", name: "1" }], ["default", { kind: "pm2", name: "default" }],
    ["docker tokyo", { kind: "docker", name: "tokyo" }],
  ];
  for (const [why, over] of bad) {
    assert.deepEqual(validateEntry(entry(over)), { ok: false, error: "name is reserved" }, why);
    assert.throws(() => restartArgv({ kind: over.kind as "pm2", name: over.name as string }), /unsafe/, why);
  }
});

test("T3.2: tokyo-shop, tokyo-demo-shop, tokyo-supplier and tokyo-jobs-web.service are accepted and get the usual argv", () => {
  for (const [kind, name] of [["pm2", "tokyo-shop"], ["pm2", "tokyo-demo-shop"], ["pm2", "tokyo-supplier"], ["systemd", "tokyo-jobs-web.service"], ["docker", "tokyobot"]] as const) {
    const v = validateEntry(entry({ kind, name }));
    assert.equal(v.ok, true, name);
    assert.deepEqual(restartArgv({ kind, name }), [kind === "systemd" ? "systemctl" : kind, "restart", name]);
  }
});

test("T3.2: a unit whose facts say pm2 resurrect with PM2_HOME=/root/.pm2 is rejected; another home, or no facts, is not", () => {
  const unit = (over: Record<string, unknown>) => entry({ kind: "systemd", name: "pm2-other.service", ...over });
  const resurrect = "/usr/lib/node_modules/pm2/bin/pm2 resurrect";
  assert.equal(validateEntry(unit({ execStart: resurrect, environment: "PATH=<stripped> PM2_HOME=/root/.pm2" })).ok, false);
  assert.equal(validateEntry(unit({ execStart: resurrect, environment: "PM2_HOME=/home/tokyo-agent/.pm2" })).ok, true);
  assert.equal(validateEntry(unit({ execStart: "/usr/bin/node app.js", environment: "PM2_HOME=/root/.pm2" })).ok, true);
  assert.equal(validateEntry(unit({})).ok, true, "the fact is judged only when it is passed");
  assert.equal(validateEntry(unit({ execStart: 5 })).ok, false);
  assert.equal(validateEntry(unit({ environment: "x".repeat(301) })).ok, false);
  assert.equal(isSelf("systemd", "x.service", { execStart: resurrect, environment: "PM2_HOME=/root/.pm2" }), true);
});

test("T3.2: the loader keeps the accepted names, drops the rejected ones and names neither in its warnings", () => {
  const f = fakeFs(JSON.stringify([
    entry({ id: "a", kind: "pm2", name: "tokyo-shop" }), entry({ id: "b", kind: "pm2", name: "tokyo" }), entry({ id: "c", kind: "systemd", name: "pm2-root.service" }),
    entry({ id: "d", kind: "systemd", name: "tokyo-jobs-web.service" }), entry({ id: "e", kind: "pm2", name: "all" }),
  ]));
  const { w, warn } = warns();
  assert.deepEqual(loadAllowlist("/x", f.fs, warn).map((e) => e.id), ["a", "d"]);
  assert.equal(w.length, 3);
  assert.ok(w.every((m) => !/tokyo|pm2-root|all/.test(m.replace(/^.*?entry \d+ rejected/, ""))), "warnings carry position and rule only");
});

test("T3.2: targetOf follows the same rule: tokyo-shop resolves, tokyo and pm2-root.service never do", () => {
  assert.deepEqual(T(item("pm2: tokyo-shop restarts=3")), { kind: "pm2", name: "tokyo-shop" });
  assert.deepEqual(T(item("unit: tokyo-jobs-web.service loaded failed failed Jobs")), { kind: "systemd", name: "tokyo-jobs-web.service" });
  assert.equal(T(item("pm2: tokyo restarts=3")), null);
  assert.equal(T(item("unit: pm2-root.service loaded failed failed PM2")), null);
  assert.equal(T(item("pm2: web restarts=3", { target: "all" })), null, "a pm2 selector as H1 target");
  assert.equal(T(item("pm2: web restarts=3", { target: "1" })), null);
  assert.equal(T(item("unit: x.service loaded failed", { target: "pm2-root.service" })), null);
});
