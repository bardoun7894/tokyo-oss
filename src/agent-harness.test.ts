import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentCommand, buildInvocation, shellQuote } from "./agent-harness";

const server = { name: "shopdemo", location: "server" as const, path: "/var/local/shopdemo-monorepo" };
const laptop = { name: "up", location: "laptop" as const, path: "/Users/owner/projects/up" };

test("a bare project and task keeps today's zen behaviour", () => {
  assert.deepEqual(parseAgentCommand("shopdemo fix the login bug"), {
    kind: "run", harness: "zen", project: "shopdemo", prompt: "fix the login bug",
  });
});

test("a leading harness name picks the harness and is not part of the task", () => {
  assert.deepEqual(parseAgentCommand("dsh up add dark mode"), {
    kind: "run", harness: "dsh", project: "up", prompt: "add dark mode",
  });
  assert.deepEqual(parseAgentCommand("ZEN ShopDemo summarize the repo"), {
    kind: "run", harness: "zen", project: "shopdemo", prompt: "summarize the repo",
  });
});

test("a missing task falls back to the old default", () => {
  assert.deepEqual(parseAgentCommand("dsh shopdemo"), {
    kind: "run", harness: "dsh", project: "shopdemo", prompt: "Check the project for issues and fix them",
  });
});

test("stop and empty input are recognised", () => {
  assert.deepEqual(parseAgentCommand("stop 12"), { kind: "stop", id: 12 });
  assert.deepEqual(parseAgentCommand("stop"), { kind: "stop", id: null });
  assert.deepEqual(parseAgentCommand("   "), { kind: "help" });
  assert.deepEqual(parseAgentCommand("dsh"), { kind: "help" });
});

test("dsh on a server project runs the launcher in the project directory, prompt as one argv entry", () => {
  const inv = buildInvocation(server, "dsh", "fix it; rm -rf /");
  assert.equal(inv.command, "/usr/local/bin/dsh-agent");
  assert.deepEqual(inv.args, ["headless", "fix it; rm -rf /"]);
  assert.equal(inv.cwd, server.path);
});

test("zen on a server project keeps the model shim", () => {
  const inv = buildInvocation(server, "zen", "summarize");
  assert.equal(inv.command, "/usr/local/bin/tokyo-zen-cli");
  assert.deepEqual(inv.args, ["summarize"]);
  assert.equal(inv.cwd, server.path);
});

test("dsh on a laptop project goes over ssh with every value shell-quoted", () => {
  const inv = buildInvocation(laptop, "dsh", "it's $(whoami) `id`");
  assert.equal(inv.command, "ssh");
  assert.deepEqual(inv.args.slice(0, 5), ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", "mac"]);
  assert.equal(
    inv.args[5],
    "cd '/Users/owner/projects/up' && /Users/owner/.local/bin/dsh-agent headless 'it'\\''s $(whoami) `id`'",
  );
  assert.equal(inv.cwd, undefined);
});

test("zen is refused for laptop projects rather than run on the wrong host", () => {
  assert.throws(() => buildInvocation(laptop, "zen", "x"), /laptop/);
});

test("shellQuote survives quotes and is inert in a POSIX shell", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.equal(shellQuote(""), "''");
});
