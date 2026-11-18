import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "./factory";
import { status } from "./factory-test-util";

/** Stub `ssh` (marker + exit 1) on PATH and a stub `factory` (FACTORY_BIN) that records its argv and echoes JSON. */
function stubs(reply: string) {
  const dir = mkdtempSync(join(tmpdir(), "factory-local-"));
  const marker = join(dir, "ssh-called");
  const argvLog = join(dir, "argv.log");
  const bin = join(dir, "factory");
  writeFileSync(join(dir, "ssh"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argvLog}'\ncat <<'EOF'\n${reply}\nEOF\n`);
  chmodSync(join(dir, "ssh"), 0o755);
  chmodSync(bin, 0o755);
  const saved = { PATH: process.env.PATH, FACTORY_BIN: process.env.FACTORY_BIN };
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.FACTORY_BIN = bin;
  const calls = () => (existsSync(argvLog) ? readFileSync(argvLog, "utf8").trim().split("\n") : []);
  const restore = () => {
    process.env.PATH = saved.PATH;
    if (saved.FACTORY_BIN === undefined) delete process.env.FACTORY_BIN;
    else process.env.FACTORY_BIN = saved.FACTORY_BIN;
  };
  return { marker, calls, restore };
}

test("default executor never spawns ssh", async () => {
  const s = stubs(JSON.stringify(status()));
  try {
    const board = await new Factory().status();
    assert.equal(existsSync(s.marker), false, "ssh was spawned");
    assert.deepEqual(s.calls(), ["status --json"]);
    assert.equal(board.reachable, true);
  } finally {
    s.restore();
  }
});

test("status flow fix retry pause resume use fixed argv", async () => {
  const s = stubs(JSON.stringify({ ok: true, message: "" }));
  try {
    const f = new Factory({ ttlMs: 0 });
    await f.status();
    await f.flow("007-login-form");
    await f.fix("007-login-form", "claude");
    await f.fix("007-login-form", "agent");
    await f.retry("007-login-form");
    await f.setPaused(true);
    await f.setPaused(false);
    assert.deepEqual(s.calls(), [
      "status --json",
      "flow 007-login-form --json",
      "fix 007-login-form --runtime claude --json",
      "fix 007-login-form --runtime agent --json",
      "retry 007-login-form",
      "pause",
      "resume",
    ]);
    assert.equal(existsSync(s.marker), false, "ssh was spawned");
  } finally {
    s.restore();
  }
});

test("a missing factory binary rejects instead of resolving", async () => {
  const s = stubs("{}");
  process.env.FACTORY_BIN = "/nonexistent/factory";
  try {
    const board = await new Factory().status();
    assert.equal(board.reachable, false);
    assert.equal(existsSync(s.marker), false, "ssh was spawned");
  } finally {
    s.restore();
  }
});
