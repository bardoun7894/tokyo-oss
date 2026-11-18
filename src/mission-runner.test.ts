import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initMissions, createMission, answerMission, getMission } from "./mission-store";
import { loadMissionConfig } from "./mission-config";
import { startMission, pollMission, deployMission, recoverDeploying, type RunnerDeps, type ExecResult } from "./mission-runner";
import { transitionMission } from "./mission-store";
import { parseApprovalReply } from "./mission-approval";

const CONFIG = loadMissionConfig(JSON.stringify({ projects: [
  { name: "tokyo", repo: "/root/tokyo", setup: [["ln", "-s", "/root/tokyo/node_modules", "{clone}/node_modules"]],
    test: [["npm", "test"]], deploy: [["pm2", "restart", "tokyo", "--update-env"]],
    health: { url: "http://127.0.0.1:3030/login", expectStatus: 200 }, confirmed: true },
  { name: "lab", repo: "/var/local/lab", test: [], deploy: [["docker", "compose", "up", "-d"]], confirmed: false },
] }));

type Rule = { match: (argv: string[]) => boolean; reply: Partial<ExecResult> };

function harness(rules: Rule[] = [], files: Record<string, string> = {}) {
  const db = new Database(":memory:");
  initMissions(db);
  let clock = Date.parse("2026-09-17T15:00:00Z");
  const calls: string[][] = [];
  const written: Record<string, string> = {};
  const notes: string[] = [];
  const offers: string[] = [];
  const defaults: Rule[] = [
    { match: (a) => a.includes("rev-parse"), reply: { stdout: "base123\n" } },
    { match: (a) => a.includes("rev-list"), reply: { stdout: "1\n" } },
    { match: (a) => a.includes("status") && a.includes("--porcelain"), reply: { stdout: "" } },
    { match: (a) => a.includes("--is-ancestor"), reply: { code: 0 } },
    { match: (a) => a[0] === "curl", reply: { stdout: "200" } },
    { match: (a) => a[0] === "herdr" && a[2] === "create", reply: { stdout: JSON.stringify({ id: "x", result: { root_pane: { pane_id: "wZ:p1" } } }) } },
    { match: (a) => a[0] === "herdr" && a[2] === "list", reply: { stdout: JSON.stringify({ id: "x", result: { workspaces: [] } }) } },
  ];
  const deps: RunnerDeps = {
    db,
    config: CONFIG,
    now: () => clock,
    exec: async (argv) => {
      calls.push(argv);
      const r = [...rules, ...defaults].find((x) => x.match(argv));
      return { code: 0, stdout: "", stderr: "", ...(r?.reply ?? {}) };
    },
    fs: {
      write: (p, t) => { written[p] = t; },
      read: (p) => (p in files ? files[p] : null),
    },
    notify: async (m, text, opts) => { notes.push(text); if (opts?.offerDeploy) offers.push(m.id); },
  };
  const approved = (project = "tokyo") => {
    const id = createMission(db, { project, prompt: "fix the typo", sender: "Client", jid: "212600@s.whatsapp.net", now: clock, ttlMs: 1_800_000 });
    answerMission(db, id, "approve", "whatsapp", clock);
    return id;
  };
  return { db, deps, calls, written, notes, offers, files, approved, tick: (ms: number) => { clock += ms; } };
}

const has = (calls: string[][], ...parts: string[]) => calls.some((c) => parts.every((p) => c.includes(p)));

// ------------------------------------------------------------------ start

test("start: clone, record base, write prompt as a file, chown, open the herdr pane, move to running", async () => {
  const h = harness();
  const id = h.approved();
  await startMission(h.deps, id);
  const m = getMission(h.db, id)!;
  assert.equal(m.state, "running");
  assert.equal(m.base_commit, "base123");
  assert.equal(m.tmux_session, `mission-${id}`);
  assert.equal(m.branch, `mission/${id}`);
  const dir = `/srv/missions/${id}`;
  assert.match(h.written[`${dir}/prompt.md`], /```client-message\nfix the typo\n```/);
  const order = h.calls.map((c) => c.join(" "));
  const idx = (s: string) => order.findIndex((c) => c.includes(s));
  assert.ok(idx("git clone") < idx("checkout -b") && idx("checkout -b") < idx("chown") && idx("chown") < idx("herdr workspace create"),
    "clone → branch → chown → herdr");
  assert.ok(idx("herdr workspace create") < idx("herdr pane run wZ:p1"), "launcher runs in the pane herdr created");
  assert.ok(has(h.calls, "herdr", "run", "wZ:p1", `bash /srv/missions/.run/${id}.sh`), "only the launcher path is typed");
  assert.ok(has(h.calls, "config", "user.name"), "commit identity set in the clone");
  assert.ok(h.notes.some((n) => n.includes(`mission-${id}`)), "owner told where to watch");
});

test("start refuses a mission that is not approved, and never starts twice", async () => {
  const h = harness();
  const id = createMission(h.db, { project: "tokyo", prompt: "x", sender: "c", jid: "j", now: Date.now(), ttlMs: 1_800_000 });
  await startMission(h.deps, id);
  assert.equal(getMission(h.db, id)!.state, "proposed");
  assert.equal(h.calls.length, 0);
  const a = h.approved();
  await startMission(h.deps, a);
  const n = h.calls.length;
  await startMission(h.deps, a);
  assert.equal(h.calls.length, n, "second start did nothing");
});

test("a failed clone fails the mission and tells the owner", async () => {
  const h = harness([{ match: (a) => a.includes("clone"), reply: { code: 128, stderr: "fatal: destination exists" } }]);
  const id = h.approved();
  await startMission(h.deps, id);
  const m = getMission(h.db, id)!;
  assert.equal(m.state, "failed");
  assert.match(m.hold_reason ?? "", /fatal: destination exists/);
  assert.ok(h.notes.some((n) => n.includes("failed")));
});

// ------------------------------------------------------------------ poll

async function started(h: ReturnType<typeof harness>) {
  const id = h.approved();
  await startMission(h.deps, id);
  return id;
}

test("poll while Claude is still working does nothing", async () => {
  const h = harness();
  const id = await started(h);
  const before = h.calls.length;
  await pollMission(h.deps, id);
  assert.equal(getMission(h.db, id)!.state, "running");
  assert.equal(h.calls.length, before);
});

test("a run past the hard cap is killed and failed", async () => {
  const list = { stdout: "" };
  const h = harness([{ match: (a) => a[0] === "herdr" && a[2] === "list", reply: list }]);
  const id = await started(h);
  list.stdout = JSON.stringify({ result: { workspaces: [{ label: "mission-00000000", workspace_id: "wOther" }, { label: `mission-${id}`, workspace_id: "wM" }] } });
  h.tick(61 * 60_000);
  await pollMission(h.deps, id);
  assert.equal(getMission(h.db, id)!.state, "failed");
  assert.ok(has(h.calls, "herdr", "workspace", "close", "wM"), "its own workspace is closed");
  assert.ok(!has(h.calls, "close", "wOther"), "another mission's workspace is left alone");
});

function finished(h: ReturnType<typeof harness>, id: string, exit = "0") {
  h.files[`/srv/missions/${id}/exit_code`] = exit + "\n";
  h.files[`/srv/missions/${id}/run.jsonl`] =
    '{"type":"system"}\n{"type":"result","subtype":"success","is_error":false,"result":"Fixed the typo and committed."}\n';
}

test("happy path: Claude exits 0 with a commit, tests pass, clean live dir, fast-forward → deployed", async () => {
  const h = harness();
  const id = await started(h);
  finished(h, id);
  await pollMission(h.deps, id);
  const m = getMission(h.db, id)!;
  assert.equal(m.state, "deployed", m.hold_reason ?? "");
  assert.equal(m.result, "Fixed the typo and committed.");
  assert.ok(has(h.calls, "sudo", "tokyo-agent", "npm", "test"), "tests run as tokyo-agent");
  assert.ok(has(h.calls, "ln", "-s", "/root/tokyo/node_modules", `/srv/missions/${id}/node_modules`), "setup placeholders filled");
  assert.ok(has(h.calls, "fetch", `/srv/missions/${id}`), "root fetches the mission branch");
  assert.ok(has(h.calls, "merge", "--ff-only", `refs/missions/${id}`), "fast-forward only");
  assert.ok(has(h.calls, "pm2", "restart", "tokyo"), "deploy command ran");
  assert.ok(h.notes.some((n) => n.includes("deployed")));
  const order = h.calls.map((c) => c.join(" "));
  assert.ok(order.findIndex((c) => c.includes("merge --ff-only")) < order.findIndex((c) => c.includes("pm2 restart")), "merge before deploy");
});

test("Claude exit non-zero → failed, no tests, no deploy", async () => {
  const h = harness();
  const id = await started(h);
  finished(h, id, "1");
  await pollMission(h.deps, id);
  assert.equal(getMission(h.db, id)!.state, "failed");
  assert.equal(has(h.calls, "npm", "test"), false);
  assert.equal(has(h.calls, "pm2"), false);
});

test("no commit → held with Claude's own explanation, nothing deployed", async () => {
  const h = harness([{ match: (a) => a.includes("rev-list"), reply: { stdout: "0\n" } }]);
  const id = await started(h);
  finished(h, id);
  await pollMission(h.deps, id);
  const m = getMission(h.db, id)!;
  assert.equal(m.state, "held");
  assert.match(m.hold_reason ?? "", /no commit/);
  assert.equal(has(h.calls, "pm2"), false);
});

test("failing tests stop the mission before any merge", async () => {
  const h = harness([{ match: (a) => a.includes("npm") && a.includes("test"), reply: { code: 1, stdout: "not ok 3 - login redirects" } }]);
  const id = await started(h);
  finished(h, id);
  await pollMission(h.deps, id);
  const m = getMission(h.db, id)!;
  assert.equal(m.state, "failed");
  assert.match(m.test_output ?? "", /not ok 3/);
  assert.equal(has(h.calls, "merge"), false);
  assert.equal(has(h.calls, "pm2"), false);
});

test("dirty live checkout holds the deploy and names the count", async () => {
  const h = harness([{ match: (a) => a.includes("--porcelain"), reply: { stdout: " M src/a.ts\n?? b.txt\n" } }]);
  const id = await started(h);
  finished(h, id);
  await pollMission(h.deps, id);
  const m = getMission(h.db, id)!;
  assert.equal(m.state, "held");
  assert.match(m.hold_reason ?? "", /2 uncommitted files/);
  assert.equal(has(h.calls, "merge", "--ff-only"), false);
  assert.ok(h.notes.some((n) => n.includes(`deploy ${id}`)), "owner told how to deploy by hand");
});

test("a project with no tests ends unverified and held", async () => {
  const h = harness();
  const id = await started(h, );
  void id;
  const lab = h.approved("lab");
  await startMission(h.deps, lab);
  finished(h, lab);
  await pollMission(h.deps, lab);
  const m = getMission(h.db, lab)!;
  assert.equal(m.state, "held");
  assert.match(m.hold_reason ?? "", /no tests ran/);
});

// ------------------------------------------------------------------ manual deploy override

test("owner override deploys a held mission past dirty/unverified/unconfirmed — never past failed tests or a non-fast-forward", async () => {
  const dirty = harness([{ match: (a) => a.includes("--porcelain"), reply: { stdout: " M x\n" } }]);
  const id = await started(dirty);
  finished(dirty, id);
  await pollMission(dirty.deps, id);
  assert.equal(getMission(dirty.db, id)!.state, "held");
  const r = await deployMission(dirty.deps, id, { override: true });
  assert.equal(r.ok, true);
  assert.equal(getMission(dirty.db, id)!.state, "deployed");

  const diverged = harness([{ match: (a) => a.includes("--is-ancestor"), reply: { code: 1 } }]);
  const d = await started(diverged);
  finished(diverged, d);
  await pollMission(diverged.deps, d);
  assert.equal(getMission(diverged.db, d)!.state, "held");
  const r2 = await deployMission(diverged.deps, d, { override: true });
  assert.equal(r2.ok, false);
  assert.match(r2.reason ?? "", /does not fast-forward/);
  assert.equal(has(diverged.calls, "pm2"), false);
});

test("a failed health check after deploy is deploy_failed with the rollback commit", async () => {
  const h = harness([{ match: (a) => a[0] === "curl", reply: { stdout: "502" } }]);
  const id = await started(h);
  finished(h, id);
  await pollMission(h.deps, id);
  const m = getMission(h.db, id)!;
  assert.equal(m.state, "deploy_failed");
  assert.match(m.deploy_output ?? "", /health .* 502/);
  assert.ok(h.notes.some((n) => n.includes("base123")), "owner gets the commit to roll back to");
});

test("a tokyo deploy restarts the process running it: the next start finalizes 'deploying' by health check", async () => {
  const h = harness();
  const id = await started(h);
  // Simulate the moment pm2 killed Tokyo mid-deploy.
  transitionMission(h.db, id, ["running"], "verified", {}, Date.now());
  transitionMission(h.db, id, ["verified"], "deploying", {}, Date.now());
  const n = await recoverDeploying(h.deps);
  assert.equal(n, 1);
  assert.equal(getMission(h.db, id)!.state, "deployed");
  assert.ok(h.notes.some((t) => t.includes("deployed") && t.includes("after restart")));

  const bad = harness([{ match: (a) => a[0] === "curl", reply: { stdout: "000" } }]);
  const b = await started(bad);
  transitionMission(bad.db, b, ["running"], "verified", {}, Date.now());
  transitionMission(bad.db, b, ["verified"], "deploying", {}, Date.now());
  await recoverDeploying(bad.deps);
  assert.equal(getMission(bad.db, b)!.state, "deploy_failed");
  assert.ok(bad.notes.some((t) => t.includes("base123")), "rollback commit included");
});

test("dsh engine: launcher written root-only outside the clone, result read from result.txt", async () => {
  const h = harness();
  const id = createMission(h.db, { project: "tokyo", prompt: "fix the typo", sender: "c", jid: "j", now: Date.now(), ttlMs: 1_800_000, engine: "dsh" });
  answerMission(h.db, id, "approve", "whatsapp", Date.now());
  await startMission(h.deps, id);
  assert.equal(getMission(h.db, id)!.state, "running");
  assert.match(h.written[`/srv/missions/.run/${id}.sh`], /dsh --profile headless/);
  assert.ok(h.calls.some((c) => c[0] === "chmod" && c.includes("700") && c.includes(`/srv/missions/.run/${id}.sh`)), "launcher is chmod 700");
  const runIdx = h.calls.findIndex((c) => c[0] === "herdr" && c[2] === "run");
  const chmodIdx = h.calls.findIndex((c) => c[0] === "chmod");
  assert.ok(chmodIdx < runIdx, "locked down before herdr runs it");
  h.files[`/srv/missions/${id}/exit_code`] = "0\n";
  h.files[`/srv/missions/${id}/result.txt`] = "Fixed the typo and committed on mission branch.\n";
  await pollMission(h.deps, id);
  assert.equal(getMission(h.db, id)!.result, "Fixed the typo and committed on mission branch.");
  assert.equal(getMission(h.db, id)!.state, "deployed");
});

test("'deploy <id>' parses as a deploy override reply", () => {
  assert.deepEqual(parseApprovalReply("deploy 4f2a9c1b"), { answer: "deploy", id: "4f2a9c1b" });
  assert.deepEqual(parseApprovalReply("انشر 4f2a9c1b"), { answer: "deploy", id: "4f2a9c1b" });
});

test("a mission Jev started without a ✅ never deploys by itself: it holds and offers a Deploy button", async () => {
  const h = harness();
  const id = createMission(h.db, { project: "tokyo", prompt: "fix the typo", sender: "Client", jid: "212600@s.whatsapp.net", now: h.deps.now(), ttlMs: 1_800_000 });
  answerMission(h.db, id, "approve", "jev-auto", h.deps.now());
  await startMission(h.deps, id);
  finished(h, id);
  await pollMission(h.deps, id);
  assert.equal(getMission(h.db, id)!.state, "held");
  assert.ok(!has(h.calls, "pm2", "restart", "tokyo"), "nothing deployed");
  assert.deepEqual(h.offers, [id]);
  assert.ok(h.notes.some((n) => n.includes("Deploy it?")));

  const r = await deployMission(h.deps, id, { override: true });
  assert.equal(r.ok, true);
  assert.equal(getMission(h.db, id)!.state, "deployed");
});
