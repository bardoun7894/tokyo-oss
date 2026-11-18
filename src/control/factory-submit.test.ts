import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factorySubmit, factorySubmitResult, HALTED_EXIT } from "./factory-submit";

const dir = mkdtempSync(join(tmpdir(), "factory-submit-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

function stub(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

const JOB = "myproj:alice:0123456789ab:1761300000";

test("rejects project with shell characters", async () => {
  const marker = join(dir, "spawned");
  const bin = stub("never", `touch ${marker}`);
  assert.equal(await factorySubmit("a;rm -rf x", "/tmp/b.md", "alice", { bin }), null);
  assert.equal(await factorySubmit("a b", "/tmp/b.md", "alice", { bin }), null);
  assert.equal(await factorySubmit("proj", "/tmp/b.md", "al;ice", { bin }), null);
  assert.equal(await factorySubmit("", "/tmp/b.md", "alice", { bin }), null);
  assert.equal(existsSync(marker), false);
});

test("passes fixed argv", async () => {
  const rec = join(dir, "argv.txt");
  const bin = stub("rec", `for a in "$@"; do printf '%s\\n' "$a" >> ${rec}; done\necho ${JOB}`);
  const id = await factorySubmit("myproj", "/tmp/brief file.md", "alice", { bin });
  assert.equal(id, JOB);
  assert.deepEqual(readFileSync(rec, "utf8").split("\n").slice(0, -1), [
    "submit", "myproj", "--brief", "/tmp/brief file.md", "--owner", "alice",
  ]);
});

test("returns the trimmed first stdout line when it is a job id", async () => {
  const bin = stub("noisy", `printf '  ${JOB}  \\nsecond line\\n'`);
  assert.equal(await factorySubmit("myproj", "/tmp/b.md", "alice", { bin }), JOB);
});

test("stdout that is not a job id resolves null", async () => {
  const bin = stub("junk", `echo "queued ok"`);
  assert.equal(await factorySubmit("myproj", "/tmp/b.md", "alice", { bin }), null);
});

test("non-zero exit resolves null", async () => {
  const bin = stub("fail", `echo ${JOB}\nexit 1`);
  assert.equal(await factorySubmit("myproj", "/tmp/b.md", "alice", { bin }), null);
});

test("exit 97 means halted", async () => {
  const bin = stub("halted", `exit ${HALTED_EXIT}`);
  assert.equal(HALTED_EXIT, 97);
  assert.equal(await factorySubmit("myproj", "/tmp/b.md", "alice", { bin }), null);
  assert.deepEqual(await factorySubmitResult("myproj", "/tmp/b.md", "alice", { bin }), { jobId: null, halted: true });
});

test("factorySubmitResult returns the job id on success", async () => {
  const bin = stub("ok", `echo ${JOB}`);
  assert.deepEqual(await factorySubmitResult("myproj", "/tmp/b.md", "alice", { bin }), { jobId: JOB, halted: false });
});

test("missing binary resolves null", async () => {
  assert.equal(await factorySubmit("myproj", "/tmp/b.md", "alice", { bin: join(dir, "does-not-exist") }), null);
});

test("uses FACTORY_BIN when no bin option is given", async () => {
  const bin = stub("envbin", `echo ${JOB}`);
  const prev = process.env.FACTORY_BIN;
  process.env.FACTORY_BIN = bin;
  try {
    assert.equal(await factorySubmit("myproj", "/tmp/b.md", "alice"), JOB);
  } finally {
    if (prev === undefined) delete process.env.FACTORY_BIN;
    else process.env.FACTORY_BIN = prev;
  }
});

test("times out after 3 s and resolves null", async () => {
  const bin = stub("sleepy", `sleep 10`);
  const t0 = Date.now();
  assert.equal(await factorySubmit("myproj", "/tmp/b.md", "alice", { bin }), null);
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
});

test("never calls the live factory under the test runner", async () => {
  const saved = process.env.FACTORY_BIN;
  delete process.env.FACTORY_BIN;
  try {
    assert.ok(process.env.NODE_TEST_CONTEXT, "runs under node --test");
    const t0 = Date.now();
    assert.deepEqual(await factorySubmitResult("demo", "/nonexistent/brief.md", "tester"), { jobId: null, halted: false });
    assert.ok(Date.now() - t0 < 200, "returned without spawning");
  } finally {
    if (saved !== undefined) process.env.FACTORY_BIN = saved;
  }
});
