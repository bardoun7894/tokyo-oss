import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentScanner, detect, parseEtime, parsePs, type Exec } from "./agent-scan";
import { Godhome, mapGraphRun, mapLaunch } from "./godhome";
import { controlApp } from "./test-app";

const T0 = Date.parse("2026-10-16T12:00:00Z");

test("parseEtime reads ps etime forms", () => {
  assert.equal(parseEtime("00:05"), 5);
  assert.equal(parseEtime("13:19:10"), 13 * 3600 + 19 * 60 + 10);
  assert.equal(parseEtime("01-08:25:53"), 86400 + 8 * 3600 + 25 * 60 + 53);
  assert.equal(parseEtime("junk"), 0);
});

test("detect goes by the program name, never by words in the arguments", () => {
  assert.deepEqual(detect("/Users/x/.local/share/claude/versions/2.1.301 --dangerously-skip-permissions --model opus --append-system-prompt run pi and codex"),
    { harness: "claude", model: "opus", kind: "interactive" });
  assert.deepEqual(detect("/x/claude_agent_sdk/_bundled/claude --output-format stream-json --model claude-sonnet-4-6"),
    { harness: "claude", model: "claude-sonnet-4-6", kind: "sdk" });
  assert.deepEqual(detect("pi"), { harness: "pi", model: null, kind: "interactive" });
  assert.deepEqual(detect("node /usr/lib/node_modules/pi/bin/pi -p fix"), { harness: "pi", model: null, kind: "headless" });
  assert.deepEqual(detect("opencode serve --port 4097"), { harness: "opencode", model: null, kind: "service" });
  assert.equal(detect("/Users/x/.codex/plugins/cache/ChatGPT for Chrome chrome-extension://abc"), null);
  assert.equal(detect("grep claude"), null);
  // An interactive session whose system prompt mentions `fusion -p ...` is still interactive.
  assert.deepEqual(detect("/x/claude/versions/2.1.301 --dangerously-skip-permissions --model opus --append-system-prompt run fusion --mode json -p /opinion --resume abc"),
    { harness: "claude", model: "opus", kind: "interactive" });
  assert.equal(detect("bash -c claude -p hi"), null);
});

const PS_SERVER = [
  " 913895  9-00:34:00 pi",
  "2822198 5-20:40:47 opencode serve --port 4097 --hostname 127.0.0.1",
  "  1000  00:10 bash",
].join("\n");
const PS_MAC = " 6152 01-08:25:53 /Users/m/.local/share/claude/versions/2.1.300 --model opus --append-system-prompt SECRET PROMPT\n";

function fakeExec(opts: { macDown?: boolean } = {}) {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const mac = cmd === "ssh";
    if (mac && opts.macDown) throw Error("ssh: connect timed out");
    const tool = mac ? args[args.indexOf("mac") + 1] : cmd;
    if (tool === "ps") return mac ? PS_MAC : PS_SERVER;
    if (tool === "lsof") return mac ? "p6152\nn/Users/m/projects/tokyo\n" : "p913895\nn/root/godhome (deleted)\np2822198\nn/root\n";
    throw Error(`unexpected ${cmd}`);
  };
  return { exec, calls };
}

test("the scanner lists both hosts with project folder names, and caches", async () => {
  const f = fakeExec();
  const s = new AgentScanner({ exec: f.exec, now: () => T0 });
  const { agents, hosts } = await s.scan();
  assert.deepEqual(hosts, { server: true, mac: true });
  assert.deepEqual(agents.map((a) => [a.host, a.harness, a.project, a.kind]).sort(), [
    ["mac", "claude", "tokyo", "interactive"], ["server", "opencode", "root", "service"], ["server", "pi", "godhome", "interactive"],
  ]);
  assert.ok(!JSON.stringify(agents).includes("SECRET"), "the command line never leaves");
  const n = f.calls.length;
  await s.scan();
  assert.equal(f.calls.length, n, "second scan within the TTL is cached");
});

test("a Mac that does not answer is marked down; the server rows stay", async () => {
  const s = new AgentScanner({ exec: fakeExec({ macDown: true }).exec, now: () => T0 });
  const { agents, hosts } = await s.scan();
  assert.deepEqual(hosts, { server: true, mac: false });
  assert.ok(agents.every((a) => a.host === "server"));
});

test("GodHome rows are mapped field by field: no cwd, no input, no output paths", () => {
  const run = mapGraphRun({ id: "r1", graph: "dev-loop", cwd: "/root/tokyo", input: "secret prompt", started: T0, done: true, ok: false, ended: T0 + 1000, error: "gate failed", calls: 2 })!;
  assert.deepEqual(run, { id: "r1", graph: "dev-loop", project: "tokyo", status: "failed", startedAt: new Date(T0).toISOString(), endedAt: new Date(T0 + 1000).toISOString(), error: "gate failed", calls: 2 });
  const l = mapLaunch({ key: "launch-1", runId: "qb-1", pid: 5, started: T0, exited: null, output: "▶ quick_build qb-1  repo=/root/tokyo-sssf\n▶ report → /root/projects/sf/runs/qb-1  (PASS)\n" })!;
  assert.equal(l.status, "running");
  assert.equal(l.project, "tokyo-sssf");
  assert.ok(!l.summary.includes("/root"), l.summary);
});

function fakeGodhome(down = false) {
  const seen: string[] = [];
  const fetch = (async (url: string, init: any) => {
    seen.push(`${url} ${init.headers.authorization}`);
    if (down) throw Error("ECONNREFUSED");
    const path = url.replace("http://gh/api", "");
    const body: Record<string, unknown> = {
      "/fleet/services": { services: [{ name: "herdr", kind: "systemd", active: true, status: "running", since: "Mon", env: { KEY: "x" } }] },
      "/quota": { providers: [{ id: "openrouter", label: "OpenRouter", state: "empty", headline: "-$0.20 left", detail: "spent", keyFound: true }] },
      "/costs": { jev: { today: 0.1, d7: 1, d30: 2 } },
      "/herdr/agents": { agents: [{ name: "fix-login", state: "working", cwd: "/root/board" }] },
      "/runs": { runs: [] },
      "/factory/launches": { launches: [] },
    };
    return { status: 200, json: async () => body[path] } as any;
  }) as any;
  return { gh: new Godhome({ url: "http://gh/api", token: () => "tok", fetch, now: () => T0 }), seen };
}

test("GET /system and /agents serve GodHome through the allowlist with its token; a down GodHome is reachable:false", async () => {
  const g = fakeGodhome();
  const app = await controlApp({ panel: { godhome: g.gh, scanner: new AgentScanner({ exec: fakeExec().exec, now: () => T0 }), taskProjects: () => [{ name: "tokyo", engine: "claude" }] } });
  const sys = await app.get("/system");
  assert.equal(sys.status, 200);
  assert.equal(sys.json.reachable, true);
  assert.deepEqual(sys.json.services, [{ name: "herdr", kind: "systemd", up: true, status: "running", since: "Mon" }]);
  assert.equal(sys.json.quota[0].headline, "-$0.20 left");
  assert.deepEqual(sys.json.costs, { jevToday: 0.1, jevWeek: 1, jevMonth: 2 });
  assert.ok(g.seen.every((s) => s.endsWith("Bearer tok")));
  const ag = await app.get("/agents");
  assert.equal(ag.json.godhome.herdr[0].project, "board");
  assert.equal(ag.json.processes.length, 3);
  assert.ok(ag.json.processes.every((p: any) => !("pid" in p)));
  const opts = await app.get("/tasks/options");
  assert.deepEqual(opts.json, { engines: ["claude", "dsh"], projects: [{ name: "tokyo", engine: "claude" }] });
  await app.close();

  const down = await controlApp({ panel: { godhome: fakeGodhome(true).gh } });
  const s2 = await down.get("/system");
  assert.equal(s2.status, 200);
  assert.deepEqual(s2.json, { reachable: false, services: [], quota: [], costs: null });
  await down.close();
});

test("parsePs skips blank and malformed lines", () => {
  assert.deepEqual(parsePs("\n  12 00:01 pi\nnot a row\n"), [{ pid: 12, elapsedSec: 1, args: "pi" }]);
});
