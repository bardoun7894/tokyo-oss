import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// mac-command imports laptop-bridge -> db.ts, which opens its file at load time.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokyo-mac-cmd-"));
process.env.TOKYO_DB_PATH = path.join(dir, "life.db");

let m: typeof import("./mac-command");
let lb: typeof import("./laptop-bridge");
before(async () => {
  m = await import("./mac-command");
  lb = await import("./laptop-bridge");
});

test("empty or status -> status", () => {
  assert.deepEqual(m.parseMacArgs(""), { kind: "status" });
  assert.deepEqual(m.parseMacArgs("  status "), { kind: "status" });
});

test("shot aliases", () => {
  for (const s of ["shot", "screenshot", "Screen"]) assert.deepEqual(m.parseMacArgs(s), { kind: "shot" });
});

test("open validates the app name", () => {
  assert.deepEqual(m.parseMacArgs("open Google Chrome"), { kind: "open", app: "Google Chrome" });
  assert.equal(m.parseMacArgs("open").kind, "error");
  assert.equal(m.parseMacArgs("open Warp; rm -rf ~").kind, "error");
  assert.equal(m.parseMacArgs("open $(whoami)").kind, "error");
});

test("run keeps the command verbatim", () => {
  assert.deepEqual(m.parseMacArgs("run echo $HOME | wc -c"), { kind: "run", cmd: "echo $HOME | wc -c" });
  assert.equal(m.parseMacArgs("run").kind, "error");
});

test("unknown word -> help", () => {
  assert.equal(m.parseMacArgs("dance").kind, "help");
});

test("openCommand quotes the app name", () => {
  assert.equal(m.openCommand("Google Chrome"), "open -a 'Google Chrome'");
  assert.equal(m.shellQuote("it's"), `'it'\\''s'`);
});

test("formatStatus reads KEY=value lines", () => {
  const out = "BATT=84%; discharging\nUPTIME=up 3 days\nTAILSCALE=ok\nBRIDGE=down\nLIGHTPANDA=ok\n";
  const s = m.formatStatus(out);
  assert.match(s, /Battery: 84%; discharging/);
  assert.match(s, /Tailscale: ok/);
  assert.match(s, /Screen bridge: down/);
  assert.match(s, /Lightpanda: ok/);
});

test("ssh args pass the command as one argv entry, no local shell", () => {
  const args = lb.sshArgs("echo $HOME `id` $(whoami)");
  assert.equal(args[args.length - 1], "echo $HOME `id` $(whoami)");
  assert.equal(args[args.length - 2], "mac");
  assert.ok(args.includes("BatchMode=yes"));
  assert.ok(args.includes("-n"));
});

test("exitCode never reports a killed or failed ssh as success", () => {
  assert.equal(lb.exitCode(null), 0);
  assert.equal(lb.exitCode({ code: 3 }), 3);
  assert.equal(lb.exitCode({ code: null, killed: true, signal: "SIGTERM" }), 124);
  assert.equal(lb.exitCode({ code: "ENOENT" }), 127);
  assert.equal(lb.exitCode({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), 1);
});
