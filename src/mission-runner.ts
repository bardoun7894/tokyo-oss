import type { Database } from "better-sqlite3";
import type { MissionProject } from "./mission-config";
import { getMission, transitionMission, type MissionRow } from "./mission-store";
import { cloneSteps, createStep, runStep, createdPane, workspaceIdFor, sessionLabel, wrapPrompt, fillArgv, clonePath, launcherScript, launcherPath, taskPath, RUN_DIR } from "./mission-commands";
import { parseRunModel, pickArgv, type RunModel } from "./run-model";
import { decideDeploy } from "./mission-gate";

// Drives an approved mission: clone → Claude in a herdr pane → tests → gate → deploy.
// Every side effect goes through injected deps, so the whole flow is replayable
// in tests and nothing here builds a shell string from client text.

export interface ExecResult { code: number; stdout: string; stderr: string }

export interface RunnerDeps {
  db: Database;
  config: Map<string, MissionProject>;
  now: () => number;
  exec: (argv: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<ExecResult>;
  fs: { write: (path: string, text: string) => void; read: (path: string) => string | null };
  notify: (m: MissionRow, text: string, opts?: { offerDeploy?: boolean }) => Promise<void>;
}

const HARD_CAP_MS = 60 * 60_000;
/** answered_by for missions Jev started without a ✅: they never deploy by themselves. */
export const JEV_AUTO = "jev-auto";
const tail = (s: string, n = 1500) => (s.length > n ? "…" + s.slice(-n) : s);
/** Root reading a clone owned by tokyo-agent would otherwise hit git's "dubious ownership" refusal. */
const gitRoot = (dir: string, ...args: string[]) => ["git", "-c", "safe.directory=*", "-C", dir, ...args];
/** A command run as tokyo-agent in the clone; the path is the only thing in the shell string. */
const asAgent = (dir: string, argv: string[]) =>
  ["sudo", "-n", "-u", "tokyo-agent", "--", "bash", "-lc", `cd '${dir}' && exec "$@"`, "mission", ...argv];

async function fail(deps: RunnerDeps, m: MissionRow, from: MissionRow["state"][], reason: string) {
  transitionMission(deps.db, m.id, from, "failed", { hold_reason: tail(reason, 800) }, deps.now());
  await deps.notify(m, `Mission ${m.id} (${m.project}) failed: ${tail(reason, 600)}`);
}

export async function startMission(deps: RunnerDeps, id: string): Promise<void> {
  const m = getMission(deps.db, id);
  if (!m || m.state !== "approved") return;
  const cfg = deps.config.get(m.project);
  if (!cfg) return fail(deps, m, ["approved"], `no mission config for project ${m.project}`);
  const dir = clonePath(id);

  const base = await deps.exec(gitRoot(cfg.repo, "rev-parse", "HEAD"));
  if (base.code !== 0) return fail(deps, m, ["approved"], `cannot read ${cfg.repo} HEAD: ${base.stderr}`);

  const [clone, branch, chown] = cloneSteps(cfg.repo, id);
  for (const step of [clone, branch, gitRoot(dir, "config", "user.name", "Tokyo Mission"), gitRoot(dir, "config", "user.email", "missions@tokyo.local")]) {
    const r = await deps.exec(step);
    if (r.code !== 0) return fail(deps, m, ["approved"], `${step.slice(0, 3).join(" ")}: ${r.stderr || r.stdout}`);
  }
  deps.fs.write(`${dir}/prompt.md`, wrapPrompt({ id, project: m.project, sender: m.sender, task: m.prompt }));
  const r1 = await deps.exec(chown);
  if (r1.code !== 0) return fail(deps, m, ["approved"], `chown: ${r1.stderr || r1.stdout}`);
  // Launcher: root-owned, 700, outside the clone — written and locked before herdr runs it.
  await deps.exec(["install", "-d", "-o", "root", "-g", "root", "-m", "700", RUN_DIR]);
  const engine = m.engine ?? "claude";
  let runModel: RunModel | undefined;
  if (engine === "claude") {
    // Jev picks model + effort from the raw task (root-only file, never argv). Any
    // failure leaves `runModel` unset, i.e. the login's default model, as before.
    deps.fs.write(taskPath(id), m.prompt);
    const picked = await deps.exec(pickArgv(["--file", taskPath(id)]), { timeoutMs: 15_000 });
    await deps.exec(["rm", "-f", taskPath(id)]);
    if (picked.code === 0) {
      const choice = parseRunModel(picked.stdout, "");
      if (choice.model) runModel = choice;
    }
  }
  deps.fs.write(launcherPath(id), launcherScript(id, engine, runModel));
  const r2 = await deps.exec(["chmod", "700", launcherPath(id)]);
  if (r2.code !== 0) return fail(deps, m, ["approved"], `chmod launcher: ${r2.stderr || r2.stdout}`);
  const created = await deps.exec(createStep(id));
  if (created.code !== 0) return fail(deps, m, ["approved"], `herdr workspace create: ${created.stderr || created.stdout}`);
  let pane: string;
  try {
    pane = createdPane(created.stdout);
  } catch (e: any) {
    return fail(deps, m, ["approved"], String(e?.message ?? e));
  }
  const run = await deps.exec(runStep(pane, id));
  if (run.code !== 0) return fail(deps, m, ["approved"], `herdr pane run: ${run.stderr || run.stdout}`);
  // The column predates herdr; it holds the workspace label.
  const moved = transitionMission(deps.db, id, ["approved"], "running", {
    base_commit: base.stdout.trim(), branch: `mission/${id}`, clone_path: dir, tmux_session: sessionLabel(id),
  }, deps.now());
  if (moved) await deps.notify(m, `Mission ${id} (${m.project}) started. Watch it live in GodHome → Terminals → mission-${id}.`);
}

/** Close the mission's herdr workspace, if it is still open. */
async function closeSession(deps: RunnerDeps, id: string): Promise<void> {
  const list = await deps.exec(["herdr", "workspace", "list"]);
  const ws = workspaceIdFor(list.stdout, sessionLabel(id));
  if (ws) await deps.exec(["herdr", "workspace", "close", ws]);
}

function lastResult(jsonl: string | null): string {
  if (!jsonl) return "";
  const lines = jsonl.trim().split("\n").reverse();
  for (const l of lines) {
    try {
      const j = JSON.parse(l);
      if (j.type === "result") return String(j.result ?? "");
    } catch { /* partial line */ }
  }
  return "";
}

export async function pollMission(deps: RunnerDeps, id: string): Promise<void> {
  const m = getMission(deps.db, id);
  if (!m || m.state !== "running") return;
  const cfg = deps.config.get(m.project)!;
  const dir = clonePath(id);

  const exitText = deps.fs.read(`${dir}/exit_code`);
  if (exitText === null) {
    if (deps.now() - m.updated_at > HARD_CAP_MS) {
      await closeSession(deps, id);
      return fail(deps, m, ["running"], "Claude did not finish within 60 minutes; session killed");
    }
    return;
  }
  const exitCode = Number(exitText.trim());
  const result = m.engine === "dsh"
    ? (deps.fs.read(`${dir}/result.txt`) ?? "").trim()
    : lastResult(deps.fs.read(`${dir}/run.jsonl`));
  transitionMission(deps.db, id, ["running"], "running", { exit_code: exitCode, result: tail(result, 3000) }, deps.now());
  if (exitCode !== 0) return fail(deps, m, ["running"], `Claude exited ${exitCode}. ${result}`);

  const commits = await deps.exec(gitRoot(dir, "rev-list", "--count", "HEAD", `^${m.base_commit}`));
  if (Number(commits.stdout.trim()) < 1) {
    transitionMission(deps.db, id, ["running"], "held", { hold_reason: `no commit — Claude said: ${tail(result, 500)}` }, deps.now());
    return deps.notify(m, `Mission ${id} (${m.project}): no commit, nothing to deploy.\nClaude: ${tail(result, 800)}`);
  }

  // Tests, as tokyo-agent, in the clone.
  let tests: "passed" | "failed" | "unverified" = "unverified";
  let testOut = "";
  if (cfg.test.length) {
    const work = cfg.workdir ? `${dir}/${cfg.workdir}` : dir;
    tests = "passed";
    for (const step of [...cfg.setup, ...cfg.test]) {
      const r = await deps.exec(asAgent(work, fillArgv(step, { clone: dir, id })), { timeoutMs: 20 * 60_000 });
      testOut += `$ ${step.join(" ")}\n${r.stdout}${r.stderr}\n`;
      if (r.code !== 0) { tests = "failed"; break; }
    }
  }
  const verifiedState = tests === "passed" ? "verified" : tests === "failed" ? "failed" : "unverified";
  transitionMission(deps.db, id, ["running"], verifiedState, { test_output: tail(testOut, 4000) }, deps.now());
  if (tests === "failed") {
    return deps.notify(m, `Mission ${id} (${m.project}): tests failed — nothing deployed.\n${tail(testOut, 800)}`);
  }

  const readiness = await deployReadiness(deps, m, cfg);
  const decision = decideDeploy({ tests, projectConfirmed: cfg.confirmed, liveDirtyFiles: readiness.dirty, mergeable: readiness.mergeable, autoDeploy: m.answered_by !== JEV_AUTO });
  if (decision.action === "deploy") {
    await deployMission(deps, id, { override: false });
    return;
  }
  transitionMission(deps.db, id, [verifiedState], "held", { hold_reason: decision.reason }, deps.now());
  if (decision.action === "hold" && decision.reason === "auto-deploy is off" && readiness.mergeable) {
    await deps.notify(m, `Mission ${id} (${m.project}) is done and its tests passed. Deploy it?\nClaude: ${tail(result, 500)}\nOr reply "deploy ${id}".`, { offerDeploy: true });
    return;
  }
  await deps.notify(m,
    `Mission ${id} (${m.project}) finished but is held: ${decision.reason}.\n` +
    `Claude: ${tail(result, 500)}\n` +
    (readiness.mergeable ? `Reply "deploy ${id}" to deploy anyway.` : "It cannot fast-forward, so it cannot be deployed from here."),
    { offerDeploy: readiness.mergeable });
}

async function deployReadiness(deps: RunnerDeps, m: MissionRow, cfg: MissionProject) {
  const dir = clonePath(m.id);
  const status = await deps.exec(["git", "-C", cfg.repo, "status", "--porcelain"]);
  const dirty = status.stdout.split("\n").filter((l) => l.trim()).length;
  const fetch = await deps.exec(gitRoot(cfg.repo, "fetch", dir, `mission/${m.id}:refs/missions/${m.id}`));
  const ff = fetch.code === 0 && (await deps.exec(["git", "-C", cfg.repo, "merge-base", "--is-ancestor", "HEAD", `refs/missions/${m.id}`])).code === 0;
  return { dirty, mergeable: ff };
}

/**
 * Tokyo's own deploy is `pm2 restart tokyo`, which kills the process running the
 * deploy mid-step. So at every start, a mission still "deploying" is finalized
 * here by its health check instead of waiting forever for a result that died
 * with the old process.
 */
export async function recoverDeploying(deps: RunnerDeps): Promise<number> {
  const rows = deps.db.prepare("SELECT id FROM missions WHERE state = 'deploying'").all() as { id: string }[];
  for (const { id } of rows) {
    const m = getMission(deps.db, id)!;
    const cfg = deps.config.get(m.project);
    let ok = false;
    let note = "no health check configured; restart completed";
    if (cfg?.health) {
      const h = await deps.exec(["curl", "-s", "-o", "/dev/null", "-m", "15", "-w", "%{http_code}", cfg.health.url]);
      const status = Number(h.stdout.trim());
      ok = status === cfg.health.expectStatus;
      note = `health ${cfg.health.url} → ${status}`;
    } else ok = true;
    transitionMission(deps.db, id, ["deploying"], ok ? "deployed" : "deploy_failed",
      { deploy_output: tail(`${m.deploy_output ?? ""}\nfinalized after restart: ${note}`, 4000) }, deps.now());
    await deps.notify(m, ok
      ? `Mission ${id} (${m.project}) deployed (confirmed after restart: ${note}).`
      : `Mission ${id} (${m.project}) deploy FAILED after restart (${note}). Roll back with: git -C ${cfg?.repo} reset --hard ${m.base_commit}`);
  }
  return rows.length;
}

/**
 * Merge (fast-forward only) and run the project's deploy. `override` is the
 * owner's "deploy <id>": it skips the dirty / unverified / unconfirmed holds,
 * but never failed tests and never a branch that does not fast-forward.
 */
export async function deployMission(deps: RunnerDeps, id: string, opts: { override: boolean }): Promise<{ ok: boolean; reason?: string }> {
  const m = getMission(deps.db, id);
  if (!m) return { ok: false, reason: "unknown mission" };
  const cfg = deps.config.get(m.project)!;
  const from: MissionRow["state"][] = opts.override ? ["held"] : ["verified"];
  if (!from.includes(m.state)) return { ok: false, reason: `mission is ${m.state}` };
  if (opts.override && !m.test_output && cfg.test.length) return { ok: false, reason: "tests never ran" };

  const ready = await deployReadiness(deps, m, cfg);
  if (!ready.mergeable) {
    const reason = "mission branch does not fast-forward the live branch";
    transitionMission(deps.db, id, from, "held", { hold_reason: reason }, deps.now());
    return { ok: false, reason };
  }
  if (!transitionMission(deps.db, id, from, "deploying", {}, deps.now())) return { ok: false, reason: "already deploying" };

  let out = "";
  const run = async (argv: string[]) => {
    const r = await deps.exec(argv, { cwd: cfg.repo, timeoutMs: 20 * 60_000 });
    out += `$ ${argv.join(" ")}\n${r.stdout}${r.stderr}\n`;
    return r.code === 0;
  };
  let ok = await run(["git", "-C", cfg.repo, "merge", "--ff-only", `refs/missions/${id}`]);
  for (const step of [...cfg.preDeploy, ...cfg.deploy]) {
    if (!ok) break;
    ok = await run(fillArgv(step, { clone: clonePath(id), id }));
  }
  if (ok && cfg.health) {
    const h = await deps.exec(["curl", "-s", "-o", "/dev/null", "-m", "15", "-w", "%{http_code}", cfg.health.url]);
    const status = Number(h.stdout.trim());
    out += `health ${cfg.health.url} → ${status}\n`;
    ok = status === cfg.health.expectStatus;
  }
  transitionMission(deps.db, id, ["deploying"], ok ? "deployed" : "deploy_failed", { deploy_output: tail(out, 4000) }, deps.now());
  await deps.notify(m, ok
    ? `Mission ${id} (${m.project}) deployed.\n${tail(m.result ?? "", 400)}`
    : `Mission ${id} (${m.project}) deploy FAILED. Roll back with: git -C ${cfg.repo} reset --hard ${m.base_commit}\n${tail(out, 800)}`);
  return ok ? { ok } : { ok, reason: "deploy failed" };
}
