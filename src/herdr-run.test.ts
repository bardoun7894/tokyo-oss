import { test } from "node:test";
import assert from "node:assert/strict";
import { laptopHost, offerRunEnv, serverHost, laptopLauncher, serverLauncher, runInHerdr, streamResult, type Exec } from "./herdr-run";

const ENV = { model: "claude-opus-5", proxyUrl: "http://127.0.0.1:8317", authToken: "tok" };
const EVIL = 'fix it "$(touch /tmp/pwned)" `id` \'; rm -rf ~';
const RESULT = '{"type":"system"}\n{"type":"result","is_error":false,"result":"Fixed and committed on feat/x."}\n';

function fake(pollsBeforeDone = 1) {
  const calls: { argv: string[]; input?: string }[] = [];
  let polls = 0;
  const exec: Exec = async (argv, opts) => {
    calls.push({ argv, input: opts?.input });
    const cmd = argv.join(" ");
    if (cmd.includes("exit_code") && (cmd.includes("cat ") || argv[0] === "cat")) {
      return polls++ < pollsBeforeDone ? { code: 1, stdout: "", stderr: "No such file" } : { code: 0, stdout: "0\n", stderr: "" };
    }
    if (cmd.includes("run.jsonl")) return { code: 0, stdout: RESULT, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

test("laptop: prompt goes over stdin only, run starts in the Mac's herdr, result read from stream-json", async () => {
  const f = fake(2);
  const started: string[] = [];
  const r = await runInHerdr(laptopHost(f.exec), "/Users/owner/projects/up", EVIL,
    (id) => laptopLauncher(id, "/Users/owner/projects/up", ENV),
    { id: "0a1b2c3d", capMs: 60_000, sleep: async () => {}, onStarted: async (l) => { started.push(l); } });

  assert.deepEqual(r, { ok: true, exitCode: 0, output: "Fixed and committed on feat/x.", label: "tokyo-run-0a1b2c3d" });
  assert.deepEqual(started, ["tokyo-run-0a1b2c3d"]);
  for (const c of f.calls) assert.ok(!c.argv.join(" ").includes("pwned"), `client text in argv: ${c.argv.join(" ")}`);
  assert.equal(f.calls.find((c) => c.argv.join(" ").includes("prompt.md"))?.input, EVIL);
  assert.ok(f.calls.some((c) => c.argv[0] === "ssh" && c.argv.at(-1)!.includes("hsess new tokyo-run-0a1b2c3d -c /Users/owner/projects/up")));
});

test("server: runs as tokyo-agent from a root-only launcher in root's herdr, prompt over stdin", async () => {
  const f = fake(0);
  const r = await runInHerdr(serverHost(f.exec), "/var/local/law", EVIL,
    (id) => serverLauncher(id, "/var/local/law", ENV), { id: "deadbeef", capMs: 60_000, sleep: async () => {} });
  assert.equal(r.ok, true);
  for (const c of f.calls) assert.ok(!c.argv.join(" ").includes("pwned"));
  assert.deepEqual(f.calls.find((c) => c.argv[0] === "hsess")!.argv, ["hsess", "new", "tokyo-run-deadbeef", "-c", "/var/local/law", "bash", "/root/.tokyo-runs/deadbeef.sh"]);
  assert.match(serverLauncher("deadbeef", "/var/local/law", ENV), /^sudo -u tokyo-agent -H env /m);
});

test("a run past the cap reports where it is still open instead of hanging", async () => {
  const f = fake(Infinity);
  const r = await runInHerdr(laptopHost(f.exec), "/Users/owner/projects/up", "x",
    (id) => laptopLauncher(id, "/Users/owner/projects/up", ENV), { id: "0a1b2c3d", capMs: -1, sleep: async () => {} });
  assert.equal(r.ok, false);
  assert.match(r.output, /tokyo-run-0a1b2c3d/);
});

test("unsafe ids and project paths are refused before anything runs", () => {
  assert.throws(() => laptopLauncher("../x", "/Users/a", ENV));
  assert.throws(() => laptopLauncher("0a1b2c3d", "/Users/a b;rm", ENV));
});

test("the Jev-picked effort reaches claude, and an unsafe model or effort is refused", () => {
  const picked = { ...ENV, model: "claude-haiku-4-5-20251001", effort: "low" };
  assert.match(laptopLauncher("0a1b2c3d", "/Users/a", picked), /--model claude-haiku-4-5-20251001 --effort low --output-format/);
  assert.doesNotMatch(laptopLauncher("0a1b2c3d", "/Users/a", ENV), /--effort/);
  assert.throws(() => serverLauncher("0a1b2c3d", "/var/local/law", { ...ENV, model: "x;rm -rf /" }), /unsafe model/);
  assert.throws(() => serverLauncher("0a1b2c3d", "/var/local/law", { ...ENV, effort: "high;id" }), /unsafe effort/);
});

test("streamResult: last result wins, a missing result counts as an error", () => {
  assert.deepEqual(streamResult(RESULT), { text: "Fixed and committed on feat/x.", isError: false });
  assert.equal(streamResult("garbage").isError, true);
});

test("a finished run closes only its own herdr pane instead of leaving a shell open", () => {
  for (const l of [laptopLauncher("0a1b2c3d", "/Users/a", ENV), serverLauncher("0a1b2c3d", "/var/local/law", ENV)]) {
    assert.ok(!l.includes("exec bash -l"));
    assert.match(l.trim().split("\n").at(-1)!, /^\S+\/herdr pane close "\$HERDR_PANE_ID"/);
  }
});

test("asRoot: the launcher runs claude directly as root, same run dir; the default still drops to tokyo-agent", () => {
  const root = serverLauncher("deadbeef", "/root/acme-site", ENV, { asRoot: true });
  assert.doesNotMatch(root, /sudo/);
  assert.match(root, /--dangerously-skip-permissions/);
  assert.match(root, /\/home\/tokyo-agent\/\.tokyo-runs\/deadbeef\/prompt\.md/);
  assert.match(root, /echo \$rc > \/home\/tokyo-agent\/\.tokyo-runs\/deadbeef\/exit_code/);
  assert.match(root, /IS_SANDBOX=1/);
  assert.match(root.trim().split("\n").at(-1)!, /^\S+\/herdr pane close "\$HERDR_PANE_ID"/);
  for (const l of [serverLauncher("deadbeef", "/root/acme-site", ENV), serverLauncher("deadbeef", "/root/acme-site", ENV, { asRoot: false })]) {
    assert.match(l, /^sudo -u tokyo-agent -H env /m);
    assert.doesNotMatch(l, /IS_SANDBOX/);
  }
});

test("root_deploy_launcher_path_has_usr_bin_first_and_sbin", () => {
  const root = serverLauncher("deadbeef", "/root/acme-site", ENV, { asRoot: true });
  const m = root.match(/env PATH=(\S+) /);
  assert.ok(m, "root launcher sets PATH");
  const parts = m![1].split(":");
  assert.deepEqual(parts.slice(0, 5), ["/usr/bin", "/usr/sbin", "/sbin", "/bin", "/usr/local/bin"]);
  assert.equal(new Set(parts).size, parts.length, "no duplicate PATH entries");
  assert.ok(parts.indexOf("/usr/bin") < parts.indexOf("/usr/local/bin"));
  assert.ok(parts.includes("/root/.local/bin"), "claude's dir stays on PATH");
  assert.ok(!parts.includes("/home/tokyo-agent/.npm-global/bin"), "root PATH must not include tokyo-agent-writable dirs");
});

test("non_root_launcher_path_unchanged", () => {
  const l = serverLauncher("deadbeef", "/root/acme-site", ENV);
  assert.match(l, /env PATH=\/home\/tokyo-agent\/\.npm-global\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin /);
  assert.doesNotMatch(l, /sbin/);
});

test("asRoot still validates the id, path and model", () => {
  assert.throws(() => serverLauncher("../x", "/root/acme-site", ENV, { asRoot: true }));
  assert.throws(() => serverLauncher("deadbeef", "/root/a b;rm", ENV, { asRoot: true }));
  assert.throws(() => serverLauncher("deadbeef", "/root/acme-site", { ...ENV, model: "x;id" }, { asRoot: true }), /unsafe model/);
});

// ---- gate resume loop (D4): the launcher's bash, run with a fake claude and a fake gate-wait ----
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { claudeRunScript } from "./herdr-run";

function gateRig(answers: string[], gateHost?: string, extraEvents: string[] = []) {
  const d = mkdtempSync(join(tmpdir(), "gaterig-"));
  const bin = join(d, "bin"); mkdirSync(bin);
  writeFileSync(join(d, "prompt.md"), "do the task");
  writeFileSync(join(d, "answers"), answers.join("\n") + "\n");
  writeFileSync(join(d, "extras"), extraEvents.join("\n") + "\n");
  // fake claude: logs argv + stdin, prints the next scripted answer as stream-json
  writeFileSync(join(bin, "claude"), `#!/bin/bash
n=$(( $(cat ${d}/n 2>/dev/null || echo 0) + 1 )); echo $n > ${d}/n
echo "$*" >> ${d}/claude.args; cat > ${d}/stdin.$n
a=$(sed -n "\${n}p" ${d}/answers)
ex=$(sed -n "\${n}p" ${d}/extras)
echo "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"session_id\\":\\"sess-abc\\"}"
[ -n "$ex" ] && echo "$ex"
echo "{\\"type\\":\\"result\\",\\"is_error\\":false,\\"result\\":\\"$a\\"}"
`);
  // fake ssh: records its args, drops the options and the host, runs the rest locally (the fake gate-wait below)
  writeFileSync(join(bin, "ssh"), `#!/bin/bash
echo "$*" >> ${d}/ssh.args; while [[ "$1" == -* ]]; do shift 2; done; shift; exec "$@"
`);
  chmodSync(join(bin, "ssh"), 0o755);
  writeFileSync(join(bin, "gate-wait"), `#!/bin/bash
echo "$*" >> ${d}/gate-wait.args; echo "gate $1 finished rc=7"; echo "tail line"
`);
  chmodSync(join(bin, "claude"), 0o755); chmodSync(join(bin, "gate-wait"), 0o755);
  const run = () => execFileSync("bash", ["-c", `export PATH=${bin}:$PATH; set -o pipefail; ${claudeRunScript(ENV, d, gateHost)}`], { encoding: "utf8" });
  const read = (f: string) => (existsSync(join(d, f)) ? readFileSync(join(d, f), "utf8") : null);
  return { run, read };
}

test("gate: no marker -> one claude call, no gate-wait, exit_code 0", () => {
  const g = gateRig(["all done"]);
  g.run();
  assert.equal(g.read("n")!.trim(), "1");
  assert.equal(g.read("gate-wait.args"), null);
  assert.equal(g.read("exit_code")!.trim(), "0");
});

test("gate: marker -> state file, gate-wait <id> 15000, then --resume <session_id> with the result", () => {
  const g = gateRig(["tests queued\\nWAITING-GATE t-12", "finished for real"]);
  g.run();
  assert.equal(g.read("gate-wait.args")!.trim(), "t-12 15000");
  const args = g.read("claude.args")!.trim().split("\n");
  assert.equal(args.length, 2);
  assert.doesNotMatch(args[0], /--resume/);
  assert.match(args[1], /--resume sess-abc/);
  assert.match(g.read("stdin.2")!, /gate t-12 finished rc=7; output tail:[\s\S]*tail line[\s\S]*continue from where you stopped/);
  assert.match(g.read("run.jsonl")!, /finished for real/);
  assert.match(g.read("run.jsonl")!, /tests queued/, "run.jsonl is appended, not replaced");
  assert.equal(g.read("exit_code")!.trim(), "0");
});

test("gate: remote project -> gate-wait runs over ssh on the host that owns the ticket", () => {
  const g = gateRig(["queued\\nWAITING-GATE t-9", "done"], "client-server");
  g.run();
  assert.match(g.read("ssh.args")!, /client-server gate-wait t-9 15000/);
  assert.equal(g.read("gate-wait.args")!.trim(), "t-9 15000");
  assert.match(g.read("stdin.2")!, /gate t-9 finished rc=7/);
});

test("gate: local project never uses ssh for gate-wait", () => {
  const g = gateRig(["queued\\nWAITING-GATE t-9", "done"]);
  g.run();
  assert.equal(g.read("ssh.args"), null);
});

test("gate: unsafe gate host is refused", () => {
  assert.throws(() => claudeRunScript(ENV, "/tmp/x", "a;rm -rf /"), /unsafe gate host/);
  assert.throws(() => serverLauncher("deadbeef", "/root/x", ENV, { gateHost: "x y" }), /unsafe gate host/);
});

test("gate: at most 3 resume cycles, then finish with the last answer and a note", () => {
  const g = gateRig(["a\\nWAITING-GATE g1", "b\\nWAITING-GATE g2", "c\\nWAITING-GATE g3", "d\\nWAITING-GATE g4"]);
  g.run();
  assert.equal(g.read("n")!.trim(), "4", "1 start + 3 resumes");
  assert.equal(g.read("gate-wait.args")!.trim().split("\n").length, 3);
  assert.match(g.read("run.jsonl")!, /"type":"tokyo-note".*gate-wait-limit/);
  assert.match(g.read("state")!, /gate-wait-limit/);
  assert.equal(g.read("exit_code")!.trim(), "0");
});

test("gate: server launcher carries the loop, laptop launcher does not", () => {
  assert.match(serverLauncher("deadbeef", "/root/x", ENV), /gate-wait/);
  assert.doesNotMatch(laptopLauncher("deadbeef", "/Users/a", ENV), /gate-wait/);
});

test("gate: server prompt.md starts with the gate-submit contract, laptop prompt.md is untouched", async () => {
  const f = fake(0);
  await runInHerdr(serverHost(f.exec), "/root/x", "the task", (id) => serverLauncher(id, "/root/x", ENV), { id: "deadbeef", capMs: 60_000, sleep: async () => {} });
  const server = f.calls.find((c) => c.argv.join(" ").includes("prompt.md"))!.input!;
  assert.match(server, /^For server tests\/builds\/merges that may queue, use gate-submit instead of gate-run, write your state, and end your answer with WAITING-GATE <id>; you will be resumed\. Never use run_in_background: this run ends when you answer\./);
  assert.ok(server.endsWith("the task"));
  const g = fake(0);
  await runInHerdr(laptopHost(g.exec), "/Users/a", "the task", (id) => laptopLauncher(id, "/Users/a", ENV), { id: "0a1b2c3d", capMs: 60_000, sleep: async () => {} });
  assert.equal(g.calls.find((c) => c.argv.join(" ").includes("prompt.md"))?.input, "the task");
});

const BG_EVENT = '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"gate-run appstudio 30m -- bash /tmp/test.sh","run_in_background":true}}]}}';
const BG_MSG = "This run ends when you answer, so background tasks are killed and never reported. Do not use run_in_background. For tests or builds that may queue, use gate-submit and end your answer with WAITING-GATE <id>; otherwise run the command in the foreground. Continue from where you stopped.";

test("background: run_in_background tool_use with no marker triggers one resume and state resumed-after-background", () => {
  const g = gateRig(["running in bg", "finished in fg"], undefined, [BG_EVENT]);
  g.run();
  assert.equal(g.read("n")!.trim(), "2");
  assert.equal(g.read("gate-wait.args"), null);
  assert.equal(g.read("state")!.trim(), "resumed-after-background");
  assert.equal(g.read("stdin.2")!.trim(), BG_MSG);
  const args = g.read("claude.args")!.trim().split("\n");
  assert.equal(args.length, 2);
  assert.match(args[1], /--resume sess-abc/);
  assert.equal(g.read("exit_code")!.trim(), "0");
});

test("background: a run without run_in_background does not resume", () => {
  const fgEvent = '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]}}';
  const g = gateRig(["all done"], undefined, [fgEvent]);
  g.run();
  assert.equal(g.read("n")!.trim(), "1");
  assert.equal(g.read("state"), null);
  assert.equal(g.read("exit_code")!.trim(), "0");
});

test("background: after background resume, a resumed answer ending with WAITING-GATE g1 runs gate-wait g1 and resumes again", () => {
  const g = gateRig(["running in bg", "submitted\\nWAITING-GATE g1", "all done"], undefined, [BG_EVENT]);
  g.run();
  assert.equal(g.read("n")!.trim(), "3");
  assert.equal(g.read("stdin.2")!.trim(), BG_MSG);
  assert.equal(g.read("gate-wait.args")!.trim(), "g1 15000");
  assert.match(g.read("stdin.3")!, /gate g1 finished rc=7/);
  assert.equal(g.read("state")!.trim(), "resumed after g1");
  assert.equal(g.read("exit_code")!.trim(), "0");
});

test("background: two background answers in a row still give only one background resume", () => {
  const g = gateRig(["running in bg 1", "running in bg 2", "unreachable"], undefined, [BG_EVENT, BG_EVENT]);
  g.run();
  assert.equal(g.read("n")!.trim(), "2");
  assert.equal(g.read("state")!.trim(), "resumed-after-background");
  assert.equal(g.read("exit_code")!.trim(), "0");
});

test("offer env: a run with an offer puts TOKYO_OFFER and TOKYO_OFFER_PROJECT in every launcher, root and tokyo-agent paths included", () => {
  const env = { ...ENV, ...offerRunEnv("ab12cd34", "tokyo") };
  const lap = laptopLauncher("0a1b2c3d", "/Users/a", env);
  assert.match(lap, /^export TOKYO_OFFER=ab12cd34$/m);
  assert.match(lap, /^export TOKYO_OFFER_PROJECT=tokyo$/m);
  const root = serverLauncher("deadbeef", "/root/tokyo", env, { asRoot: true });
  assert.match(root, /env PATH=\S+ TOKYO_OFFER=ab12cd34 TOKYO_OFFER_PROJECT=tokyo ANTHROPIC_BASE_URL=/);
  const agent = serverLauncher("deadbeef", "/root/tokyo", env);
  assert.match(agent, /^sudo -u tokyo-agent -H env PATH=\S+ TOKYO_OFFER=ab12cd34 TOKYO_OFFER_PROJECT=tokyo ANTHROPIC_BASE_URL=/m);
});

test("offer env: a run without an offer carries no TOKYO_OFFER", () => {
  assert.deepEqual(offerRunEnv(undefined, "tokyo"), {});
  assert.deepEqual(offerRunEnv("", "tokyo"), {});
  for (const l of [laptopLauncher("0a1b2c3d", "/Users/a", ENV), serverLauncher("deadbeef", "/root/x", ENV), serverLauncher("deadbeef", "/root/x", ENV, { asRoot: true })]) {
    assert.doesNotMatch(l, /TOKYO_OFFER/);
  }
});

test("offer env: unsafe offer id or project name is refused, nothing reaches the shell line", () => {
  assert.throws(() => laptopLauncher("0a1b2c3d", "/Users/a", { ...ENV, offer: { id: "x;id", project: "p" } }), /unsafe offer/);
  assert.throws(() => serverLauncher("deadbeef", "/root/x", { ...ENV, offer: { id: "ab12cd34", project: "p q$(id)" } }), /unsafe offer/);
});
