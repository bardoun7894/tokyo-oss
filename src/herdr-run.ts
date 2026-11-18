import { randomBytes } from "crypto";

// Runs Claude Code in a herdr workspace — the Mac's herdr for laptop projects, root's
// herdr on app-server for server ones — so every run can be watched live and survives a
// dropped connection. The prompt (client text) only ever travels as a file over stdin:
// no command line built here contains it.

export interface ExecResult { code: number; stdout: string; stderr: string }
export type Exec = (argv: string[], opts?: { input?: string; timeoutMs?: number }) => Promise<ExecResult>;

export interface HerdrRunEnv {
  model: string;
  /** Claude Code `--effort`, from the Jev pick (run-model.ts). Omitted = CLI default. */
  effort?: string;
  proxyUrl: string;
  authToken: string;
  /** Set only on an approved deploy run: the offer the deploy-guard hook checks (TOKYO_OFFER*). */
  offer?: { id: string; project: string };
}

/** The `offer` part of a run env: present only when the run carries an offer id. */
export function offerRunEnv(offerId: string | undefined, project: string): { offer?: { id: string; project: string } } {
  return offerId ? { offer: { id: offerId, project } } : {};
}

const MAC_HOME = "/Users/owner";
const AGENT_HOME = "/home/tokyo-agent";
const SSH_MAC = ["ssh", "-o", "ConnectTimeout=10", "-o", "BatchMode=yes", "mac"];
const MAC_PATH = `export PATH=${MAC_HOME}/.local/bin:/opt/homebrew/bin:$PATH`;

export const newRunId = () => randomBytes(4).toString("hex");
export const runLabel = (id: string) => `tokyo-run-${id}`;

function checkId(id: string) {
  if (!/^[0-9a-f]{8}$/.test(id)) throw new Error(`invalid run id ${JSON.stringify(id)}`);
}
function checkOffset(n: number, what: string) {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`invalid ${what} ${n}`);
}
// The label goes to `hsess kill` (over ssh on the Mac), so it is a plain token.
function checkLabel(label: string) {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(label) || label.startsWith(".")) throw new Error(`invalid workspace label ${JSON.stringify(label)}`);
}
function checkPath(p: string) {
  if (!/^\/[A-Za-z0-9._\/-]+$/.test(p)) throw new Error(`unsafe project path ${JSON.stringify(p)}`);
}
// Model and effort are inlined into the shell line, so they are validated like the path.
function checkModel(env: HerdrRunEnv) {
  if (!/^[A-Za-z0-9._-]+$/.test(env.model)) throw new Error(`unsafe model ${JSON.stringify(env.model)}`);
  if (env.effort !== undefined && !/^(low|medium|high|xhigh|max)$/.test(env.effort)) {
    throw new Error(`unsafe effort ${JSON.stringify(env.effort)}`);
  }
}

// Offer id and project name are inlined into the shell line, so they are validated like the model.
function offerVars(env: HerdrRunEnv): string[] {
  if (!env.offer) return [];
  if (!/^[A-Za-z0-9-]{1,36}$/.test(env.offer.id) || !/^[A-Za-z0-9._-]{1,80}$/.test(env.offer.project)) {
    throw new Error(`unsafe offer ${JSON.stringify(env.offer)}`);
  }
  return [`TOKYO_OFFER=${env.offer.id}`, `TOKYO_OFFER_PROJECT=${env.offer.project}`];
}

const claudeFlags = (env: HerdrRunEnv) =>
  `--dangerously-skip-permissions --model ${env.model}${env.effort ? ` --effort ${env.effort}` : ""} --output-format stream-json --verbose`;
const claudeLine = (env: HerdrRunEnv, dir: string) =>
  `claude -p ${claudeFlags(env)} < ${dir}/prompt.md 2>&1 | tee ${dir}/run.jsonl`;

/** First line of every server run's prompt.md: the contract the gate loop below relies on. */
export const GATE_CONTRACT =
  "For server tests/builds/merges that may queue, use gate-submit instead of gate-run, write your state, and end your answer with WAITING-GATE <id>; you will be resumed. Never use run_in_background: this run ends when you answer.";

/** How many times one run may wait for a gate and be resumed. */
export const GATE_RESUME_CYCLES = 3;

/**
 * The server run: claude, then the gate loop (D4). When claude's final answer ends with
 * `WAITING-GATE <id>` (a gate-submit ticket) the run writes "waiting-gate <id>" to <dir>/state,
 * runs `gate-wait <id> 15000` with no claude alive, and resumes the same session with the gate
 * result, appending to run.jsonl. With `gateHost` (a deployRemote project) the wait runs over ssh on that host. After GATE_RESUME_CYCLES it stops resuming and leaves a note.
 * A run that never prints the marker behaves like the old one-liner. It is inlined into
 * `bash -c '...'`, so it must not contain a single quote. exit_code is written last.
 */
export function claudeRunScript(env: HerdrRunEnv, dir: string, gateHost?: string): string {
  if (gateHost !== undefined && !/^[A-Za-z0-9._-]+$/.test(gateHost)) throw new Error(`unsafe gate host: ${gateHost}`);
  // A remote project's gate tickets live on its own host (the run submits them over ssh), so wait there.
  const gateWait = gateHost ? `ssh -o BatchMode=yes ${gateHost} gate-wait` : "gate-wait";
  return String.raw`${claudeLine(env, dir)}
rc=$?
gate_marker() {
  tail -n 200 ${dir}/run.jsonl | grep "\"type\":\"result\"" | tail -n 1 | grep -v "\"is_error\":true" \
    | grep -oE "WAITING-GATE [A-Za-z0-9._-]+(\\\\n| )*\"[,}]" | sed "s/^WAITING-GATE \([A-Za-z0-9._-]*\).*/\1/" | head -n 1
}
bg_resumed=0
gate_cycles=0
while [ "$rc" -eq 0 ]; do
  gid=$(gate_marker)
  if [ -n "$gid" ]; then
    if [ "$gate_cycles" -ge ${GATE_RESUME_CYCLES} ]; then
      echo "{\"type\":\"tokyo-note\",\"note\":\"gate-wait-limit: ${GATE_RESUME_CYCLES} gate waits used, the run still ended with WAITING-GATE $gid\"}" >> ${dir}/run.jsonl
      echo "gate-wait-limit $gid" > ${dir}/state
      break
    fi
    gate_cycles=$((gate_cycles + 1))
    sid=$(grep -o "\"session_id\":\"[A-Za-z0-9-]*\"" ${dir}/run.jsonl | tail -n 1 | sed "s/.*:\"\(.*\)\"/\1/")
    echo "waiting-gate $gid" > ${dir}/state
    ${gateWait} "$gid" 15000 > ${dir}/gate.out 2>&1 < /dev/null
    first=$(head -n 1 ${dir}/gate.out)
    case "$first" in "gate $gid finished rc="*) ;; *) first="gate $gid did not finish ($first)" ;; esac
    { printf "%s; output tail:\n" "$first"; tail -n +2 ${dir}/gate.out | tail -n 40; printf "\n; continue from where you stopped\n"; } > ${dir}/resume.md
    if [ -z "$sid" ]; then
      echo "{\"type\":\"tokyo-note\",\"note\":\"gate-resume-failed: no session_id in run.jsonl\"}" >> ${dir}/run.jsonl
      echo "gate-resume-failed $gid" > ${dir}/state
      break
    fi
    echo "resumed after $gid" > ${dir}/state
    claude -p ${claudeFlags(env)} --resume "$sid" < ${dir}/resume.md 2>&1 | tee -a ${dir}/run.jsonl
    rc=$?
  elif [ "$bg_resumed" -eq 0 ] && grep -qE "\"run_in_background\"[[:space:]]*:[[:space:]]*true" ${dir}/run.jsonl; then
    bg_resumed=1
    sid=$(grep -o "\"session_id\":\"[A-Za-z0-9-]*\"" ${dir}/run.jsonl | tail -n 1 | sed "s/.*:\"\(.*\)\"/\1/")
    if [ -z "$sid" ]; then
      echo "{\"type\":\"tokyo-note\",\"note\":\"background-resume-failed: no session_id\"}" >> ${dir}/run.jsonl
      echo "background-resume-failed" > ${dir}/state
      break
    fi
    printf "%s\n" "This run ends when you answer, so background tasks are killed and never reported. Do not use run_in_background. For tests or builds that may queue, use gate-submit and end your answer with WAITING-GATE <id>; otherwise run the command in the foreground. Continue from where you stopped." > ${dir}/resume.md
    echo "resumed-after-background" > ${dir}/state
    claude -p ${claudeFlags(env)} --resume "$sid" < ${dir}/resume.md 2>&1 | tee -a ${dir}/run.jsonl
    rc=$?
  else
    break
  fi
done
echo $rc > ${dir}/exit_code`;
}

export function laptopLauncher(id: string, projectPath: string, env: HerdrRunEnv): string {
  checkId(id); checkPath(projectPath); checkModel(env);
  const dir = `${MAC_HOME}/.tokyo-runs/${id}`;
  return [
    "#!/bin/bash",
    `export PATH=/opt/homebrew/bin:${MAC_HOME}/.local/bin:$PATH`,
    `export ANTHROPIC_BASE_URL=${env.proxyUrl}`,
    `export ANTHROPIC_AUTH_TOKEN=${env.authToken}`,
    ...offerVars(env).map((v) => `export ${v}`),
    `cd ${projectPath} || { echo 1 > ${dir}/exit_code; exit 1; }`,
    "set -o pipefail",
    claudeLine(env, dir),
    `echo $? > ${dir}/exit_code`,
    // Close only this run's own pane once it is done (result is already in run.jsonl / exit_code).
    `${MAC_HOME}/.local/bin/herdr pane close "$HERDR_PANE_ID" >/dev/null 2>&1`,
    "",
  ].join("\n");
}

/**
 * `asRoot` is for approved deploy runs only (they must write root-owned checkouts); every other
 * server run drops to tokyo-agent. The run dir stays under AGENT_HOME either way, so host.read
 * (run as root) reaches exit_code and run.jsonl for both.
 */
export function serverLauncher(id: string, projectPath: string, env: HerdrRunEnv, opts: { asRoot?: boolean; gateHost?: string } = {}): string {
  checkId(id); checkPath(projectPath); checkModel(env);
  const dir = `${AGENT_HOME}/.tokyo-runs/${id}`;
  const inner = `cd ${projectPath} || { echo 1 > ${dir}/exit_code; exit 1; }; set -o pipefail; ${claudeRunScript(env, dir, opts.gateHost)}`;
  // Claude Code refuses --dangerously-skip-permissions as root unless it is told it runs in a sandbox.
  // The root deploy run needs /usr/bin first (node v22, not /usr/local/bin's v26) and the sbin dirs (runuser).
  const offer = offerVars(env).map((v) => `${v} `).join("");
  const rootPath = [...new Set([
    "/usr/bin", "/usr/sbin", "/sbin", "/bin", "/usr/local/bin",
    "/root/.local/bin",
  ])].join(":");
  const run = opts.asRoot
    ? `env PATH=${rootPath} ${offer}` +
      `ANTHROPIC_BASE_URL=${env.proxyUrl} ANTHROPIC_AUTH_TOKEN=${env.authToken} IS_SANDBOX=1 bash -c '${inner}'`
    : `sudo -u tokyo-agent -H env PATH=${AGENT_HOME}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin ${offer}` +
      `ANTHROPIC_BASE_URL=${env.proxyUrl} ANTHROPIC_AUTH_TOKEN=${env.authToken} bash -c '${inner}'`;
  return [
    "#!/bin/bash",
    run,
    // Close only this run's own pane once it is done (result is already in run.jsonl / exit_code).
    `/root/.local/bin/herdr pane close "$HERDR_PANE_ID" >/dev/null 2>&1`,
    "",
  ].join("\n");
}

/** Where a run's files live and how to reach them, per host. */
export interface HerdrHost {
  dir(id: string): string;
  prepare(id: string, prompt: string, launcher: string): Promise<void>;
  start(id: string, projectPath: string): Promise<void>;
  read(id: string, file: "exit_code" | "run.jsonl"): Promise<string | null>;
  /** Complete lines of run.jsonl after `offset` (at most `maxBytes`) and the offset after them. */
  readFrom(id: string, offset: number, maxBytes: number): Promise<{ text: string; offset: number }>;
  /** Byte length of run.jsonl, or null when it does not exist yet. */
  size(id: string): Promise<number | null>;
  /** Closes the herdr workspace (`hsess kill <label>`). */
  stop(label: string): Promise<void>;
}

/** Cuts a chunk to complete lines; a chunk that fills maxBytes without any newline is taken whole. */
function completeLines(chunk: Buffer, offset: number, maxBytes: number): { text: string; offset: number } {
  const nl = chunk.lastIndexOf(0x0a);
  const used = nl >= 0 ? nl + 1 : chunk.length >= maxBytes ? chunk.length : 0;
  return { text: chunk.subarray(0, used).toString("utf8"), offset: offset + used };
}

function streamCmd(id: string, dir: string, offset: number, maxBytes: number): string {
  checkId(id); checkOffset(offset, "offset");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error(`invalid maxBytes ${maxBytes}`);
  return `tail -c +${offset + 1} ${dir}/run.jsonl | head -c ${maxBytes}`;
}

async function must(r: Promise<ExecResult>, what: string) {
  const x = await r;
  if (x.code !== 0) throw new Error(`${what}: ${(x.stderr || x.stdout).trim().slice(0, 300)}`);
  return x;
}

export function laptopHost(exec: Exec): HerdrHost {
  const dir = (id: string) => (checkId(id), `${MAC_HOME}/.tokyo-runs/${id}`);
  return {
    dir,
    async prepare(id, prompt, launcher) {
      await must(exec([...SSH_MAC, `mkdir -p -m 700 ${dir(id)}`]), "mkdir on mac");
      await must(exec([...SSH_MAC, `cat > ${dir(id)}/prompt.md`], { input: prompt }), "write prompt on mac");
      await must(exec([...SSH_MAC, `umask 077; cat > ${dir(id)}/run.sh`], { input: launcher }), "write launcher on mac");
    },
    async start(id, projectPath) {
      checkPath(projectPath);
      await must(exec([...SSH_MAC, `${MAC_PATH}; hsess new ${runLabel(id)} -c ${projectPath} bash ${dir(id)}/run.sh`]), "hsess new on mac");
    },
    async read(id, file) {
      const r = await exec([...SSH_MAC, file === "run.jsonl" ? `tail -c 400000 ${dir(id)}/${file}` : `cat ${dir(id)}/${file}`]);
      return r.code === 0 ? r.stdout : null;
    },
    async readFrom(id, offset, maxBytes) {
      const r = await exec([...SSH_MAC, streamCmd(id, dir(id), offset, maxBytes)]);
      return r.code === 0 ? completeLines(Buffer.from(r.stdout), offset, maxBytes) : { text: "", offset };
    },
    async size(id) {
      const r = await exec([...SSH_MAC, `wc -c < ${dir(id)}/run.jsonl`]);
      return r.code === 0 ? Number(r.stdout.trim()) : null;
    },
    async stop(label) {
      checkLabel(label);
      await must(exec([...SSH_MAC, `${MAC_PATH}; hsess kill ${label}`]), "hsess kill on mac");
    },
  };
}

export function serverHost(exec: Exec): HerdrHost {
  const dir = (id: string) => (checkId(id), `${AGENT_HOME}/.tokyo-runs/${id}`);
  const launcherPath = (id: string) => `/root/.tokyo-runs/${id}.sh`;
  return {
    dir,
    async prepare(id, prompt, launcher) {
      // Root deploy runs get a root-owned run dir and prompt so tokyo-agent cannot rewrite the prompt or plant symlinks.
      const asRoot = launcher.includes("IS_SANDBOX=1");
      const as = asRoot ? [] : ["sudo", "-n", "-u", "tokyo-agent"];
      await must(exec([...as, "mkdir", "-p", "-m", "700", dir(id)]), "mkdir run dir");
      await must(exec([...as, "tee", `${dir(id)}/prompt.md`], { input: `${GATE_CONTRACT}\n\n${prompt}` }), "write prompt");
      await must(exec(["install", "-d", "-m", "700", "/root/.tokyo-runs"]), "mkdir launcher dir");
      await must(exec(["bash", "-c", `umask 077; cat > ${launcherPath(id)}`], { input: launcher }), "write launcher");
    },
    async start(id, projectPath) {
      checkPath(projectPath);
      await must(exec(["hsess", "new", runLabel(id), "-c", projectPath, "bash", launcherPath(id)]), "hsess new");
    },
    async read(id, file) {
      const r = await exec(file === "run.jsonl" ? ["tail", "-c", "400000", `${dir(id)}/${file}`] : ["cat", `${dir(id)}/${file}`]);
      return r.code === 0 ? r.stdout : null;
    },
    async readFrom(id, offset, maxBytes) {
      const r = await exec(["bash", "-c", streamCmd(id, dir(id), offset, maxBytes)]);
      return r.code === 0 ? completeLines(Buffer.from(r.stdout), offset, maxBytes) : { text: "", offset };
    },
    async size(id) {
      const r = await exec(["bash", "-c", `wc -c < ${dir(id)}/run.jsonl`]);
      return r.code === 0 ? Number(r.stdout.trim()) : null;
    },
    async stop(label) {
      checkLabel(label);
      await must(exec(["hsess", "kill", label]), "hsess kill");
    },
  };
}

/** The final answer from Claude's stream-json log, and whether Claude flagged it as an error. */
export function streamResult(jsonl: string | null): { text: string; isError: boolean } {
  for (const line of (jsonl ?? "").trim().split("\n").reverse()) {
    try {
      const j = JSON.parse(line);
      if (j.type === "result") return { text: String(j.result ?? ""), isError: !!j.is_error };
    } catch { /* partial or non-JSON line */ }
  }
  return { text: "", isError: true };
}

/** The model named in Claude's stream-json init event, if the log has one. */
export function streamModel(jsonl: string | null): string | null {
  for (const line of (jsonl ?? "").split("\n").slice(0, 20)) {
    try {
      const j = JSON.parse(line);
      if (j.type === "system" && j.subtype === "init" && typeof j.model === "string") return j.model;
    } catch { /* partial or non-JSON line */ }
  }
  return null;
}

export interface HerdrRunResult { ok: boolean; exitCode: number | null; output: string; label: string; model?: string }

export async function runInHerdr(
  host: HerdrHost,
  projectPath: string,
  prompt: string,
  launcher: (id: string) => string,
  opts: { id?: string; pollMs?: number; capMs: number; sleep?: (ms: number) => Promise<void>; onStarted?: (label: string, id: string) => Promise<void>; isCancelled?: () => boolean },
): Promise<HerdrRunResult> {
  const id = opts.id ?? newRunId();
  const label = runLabel(id);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  await host.prepare(id, prompt, launcher(id));
  await host.start(id, projectPath);
  await opts.onStarted?.(label, id);

  const deadline = Date.now() + opts.capMs;
  let exitText: string | null = null;
  while ((exitText = await host.read(id, "exit_code")) === null) {
    if (opts.isCancelled?.()) return { ok: false, exitCode: null, output: `Run stopped from the Control app (herdr workspace ${label}).`, label };
    if (Date.now() > deadline) return { ok: false, exitCode: null, output: `Claude did not finish within ${Math.round(opts.capMs / 60000)} min; still open in herdr workspace ${label}.`, label };
    await sleep(opts.pollMs ?? 15_000);
  }
  const exitCode = Number(exitText.trim());
  const jsonl = await host.read(id, "run.jsonl");
  const r = streamResult(jsonl);
  const model = streamModel(jsonl);
  return { ok: exitCode === 0 && !r.isError, exitCode, output: r.text, label, ...(model ? { model } : {}) };
}
