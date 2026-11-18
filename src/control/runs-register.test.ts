import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { recordRunFinished, recordRunStarted, setRunRegistryExec } from "./runs";
import { ControlStore } from "./store";

const T0 = Date.parse("2026-10-09T09:00:00Z");
const JOB = "tokyo:tokyo:0123456789ab:1760000000";
const FRUN_ID = "tokyo:srv:123:1760000001";

interface Call { bin: string; args: string[]; opts: { timeout?: number }; submitLogAtCall: string }

// A stub `factory` that logs its argv and the brief file content, plus an injected frun exec that records its calls.
function rig(execImpl?: (call: Call) => Promise<{ stdout: string }>) {
  const dir = mkdtempSync(join(tmpdir(), "runs-register-"));
  const log = join(dir, "submit.log");
  const factory = join(dir, "factory");
  writeFileSync(factory, `#!/bin/sh\necho "$@" >> ${log}\ncat "$4" >> ${log}\necho ${JOB}\n`);
  chmodSync(factory, 0o755);
  process.env.FACTORY_BIN = factory;
  process.env.FACTORY_FRUN = "/fake/frun";
  const calls: Call[] = [];
  setRunRegistryExec(async (bin, args, opts) => {
    let submitLogAtCall = "";
    try { submitLogAtCall = readFileSync(log, "utf8"); } catch { /* not written yet */ }
    const call = { bin, args, opts, submitLogAtCall };
    calls.push(call);
    return execImpl ? execImpl(call) : { stdout: args[0] === "start" ? FRUN_ID + "\n" : "" };
  });
  const store = new ControlStore(new Database(":memory:"));
  return { calls, store, log };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
};

const start = (id: string, over: Record<string, unknown> = {}) => ({
  id, project: "tokyo", host: "server" as const, prompt: "Fix the bug. Bearer abcdef123456", model: "sonnet", tier: "medium", label: `tokyo-run-${id}`, now: T0, ...over,
});

test("started run is registered", async () => {
  const { calls, store, log } = rig();
  recordRunStarted(store, start("r1"));
  await until(() => calls.length >= 1);
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.bin, "/fake/frun");
  assert.deepEqual(c.args, ["start", "--source", "tokyo", "--project", "tokyo", "--name", "r1", "--label", "tokyo-run-r1", "--job", JOB]);
  assert.equal(c.opts.timeout, 4000);
  // factory submit ran first, with the redacted prompt as the brief
  assert.match(c.submitLogAtCall, /^submit tokyo --brief \S+ --owner tokyo\n/);
  assert.match(c.submitLogAtCall, /Fix the bug\./);
  assert.doesNotMatch(readFileSync(log, "utf8"), /abcdef123456/);

  recordRunFinished(store, "r1", { ok: true, exitCode: null, now: T0 + 1000 });
  await until(() => calls.length >= 2);
  assert.deepEqual(calls[1].args, ["finish", FRUN_ID, "0"]);

  recordRunStarted(store, start("r2"));
  await until(() => calls.length >= 3);
  recordRunFinished(store, "r2", { ok: false, exitCode: 7, now: T0 + 2000 });
  await until(() => calls.length >= 4);
  assert.deepEqual(calls[3].args, ["finish", FRUN_ID, "7"]);
});

test("registry failure leaves the run unchanged", async () => {
  const plain = rig();
  setRunRegistryExec(undefined);
  process.env.FACTORY_BIN = "/nonexistent/factory";
  process.env.FACTORY_FRUN = "/nonexistent/frun";
  recordRunStarted(plain.store, start("r1"));
  recordRunFinished(plain.store, "r1", { ok: true, exitCode: 0, now: T0 + 1000 });
  const baseline = plain.store.getRun("r1");

  const failing = rig(async () => { throw new Error("frun exploded"); });
  assert.doesNotThrow(() => recordRunStarted(failing.store, start("r1")));
  await until(() => failing.calls.length >= 1);
  assert.doesNotThrow(() => recordRunFinished(failing.store, "r1", { ok: true, exitCode: 0, now: T0 + 1000 }));
  assert.deepEqual(failing.store.getRun("r1"), baseline);
  assert.equal(failing.store.listRuns({}).length, 1);

  const sync = rig();
  setRunRegistryExec(() => { throw new Error("sync throw"); });
  assert.doesNotThrow(() => recordRunStarted(sync.store, start("r1")));
  assert.doesNotThrow(() => recordRunFinished(sync.store, "r1", { ok: true, exitCode: 0, now: T0 + 1000 }));
  assert.deepEqual(sync.store.getRun("r1"), baseline);
});

test("only a newly inserted server run is registered", async () => {
  const { calls, store } = rig();
  recordRunStarted(store, start("m1", { host: "mac" }));
  recordRunStarted(store, start("s1"));
  await until(() => calls.length >= 1);
  recordRunStarted(store, start("s1"));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[calls[0].args.indexOf("--name") + 1], "s1");
});

test("project is normalised, and skipped when nothing is left", async () => {
  const { calls, store } = rig();
  recordRunStarted(store, start("n1", { project: "My Project" }));
  await until(() => calls.length >= 1);
  assert.equal(calls[0].args[calls[0].args.indexOf("--project") + 1], "my-project");
  recordRunStarted(store, start("n2", { project: "!!!" }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(calls.length, 1);
});
