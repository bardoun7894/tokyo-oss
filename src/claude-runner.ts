import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { spawn, exec } from "child_process";
import { randomUUID } from "crypto";
import type { ProjectRef } from "./project-registry";
import { getProject } from "./project-registry";
import { DeployOffers, deployPrompt, isDeployPrompt, offerText, reportsNotDeployed, runsAsRoot, type DeployAnswer, type DeployOffer } from "./deploy-offers";
import { ActionOffers } from "./action-offers";
import { defaultActionOfferStore } from "./action-offers-store";
import { DeployOfferStore } from "./deploy-offers-store";
import { createActionOfferFlow } from "./action-offer-flow";
import { runInHerdr, laptopHost, serverHost, laptopLauncher, serverLauncher, offerRunEnv, type Exec } from "./herdr-run";
import { ControlStore } from "./control/store";
import { recordRunFinished, recordRunQueued, recordRunStarted } from "./control/runs";
import { parseRunModel, pickArgv, type RunModel } from "./run-model";
import type { PendingRef } from "./tg-approval";
import { sendWhatsAppMessage } from "./whatsapp";
import {
  enqueueLaptopTask,
  nextPendingLaptopTask,
  markLaptopTaskRunning,
  finishLaptopTask,
  countPendingLaptopTasks,
} from "./db";
import db from "./db";

const MAX_RUNTIME_MS = 15 * 60 * 1000;
const PENDING_TTL_MS = 5 * 60 * 1000;
const TELEGRAM_CHUNK = 3800;
const REACH_TIMEOUT_MS = 6000;
const DRAIN_INTERVAL_MS = 60_000;

const CLAUDE_BIN_LAPTOP = "/Users/owner/.local/bin/claude";
const PROXY_URL_LAPTOP = "http://100.64.0.1:8317";
// Model via proxy (Anthropic-compatible gateway, Max subscription), laptop or local.
// Was gemini-2.5-flash, which the gateway no longer serves ("unknown provider"), so
// approved coding runs failed. Coding runs are T3 work: Opus 5. 2026-09-18.
// Fallback only: each run normally gets the model Jev picks for its task (run-model.ts).
// Opus 5.5 is the only Opus the owner allows (tiers.json opus_policy).
const MODEL = process.env.CLAUDE_RUN_MODEL || "claude-opus-5-5";
const AUTH_TOKEN = process.env.CLIPROXY_API_KEY || "";

const CLAUDE_BIN_AGENT = "/home/tokyo-agent/.npm-global/bin/claude";
const PROXY_URL_LOCAL = "http://127.0.0.1:8317";
const AGENT_USER = "tokyo-agent";

function proxyToken(): string {
  return process.env.CLIPROXY_API_KEY || "";
}

interface WAContext {
  clientJid: string;
  senderName: string;
  originalMessage: string;
  variant?: "kb-dev" | "tech-company";
}

interface Pending {
  project: ProjectRef;
  prompt: string;
  reason: string;
  chatId: number;
  createdAt: number;
  wa?: WAContext;
  variant: "kb-dev" | "tech-company";
  /** Runs started from an action card never end with "Deploy it?" (FR-A7). */
  noDeployOffer?: boolean;
  /** Run id recorded by the Control API before the run started (T218 adopts it). */
  controlRunId?: string;
  /** The deploy offer this run answers; recorded on the run row (G6). */
  offerId?: string;
}

const pending = new Map<string, Pending>();

let controlStore: ControlStore | null = null;
const runStore = () => (controlStore ??= new ControlStore(db));

const deployOffers = new DeployOffers(new DeployOfferStore(db));
let runnerBot: Bot | null = null;

let actionFlow: ReturnType<typeof createActionOfferFlow> | null = null;
let actionOffers: ActionOffers | null = null;
function getActionFlow() {
  if (!actionFlow) {
    actionOffers = new ActionOffers({ store: defaultActionOfferStore() });
    actionFlow = createActionOfferFlow({
      offers: actionOffers,
      getBot: () => runnerBot,
      chatId: parseInt(process.env.TELEGRAM_USER_ID || "0"),
      now: () => Date.now(),
      getProject,
      sendSignal: (s) => require("./temporal/signal").signalWorkflow(s),
      startRun: async (r) => {
        const bot = runnerBot;
        if (!bot) throw new Error("telegram bot not ready");
        await executeOrQueue(
          bot,
          { project: r.project, prompt: r.prompt, reason: r.reason, chatId: r.chatId, createdAt: Date.now(), variant: "kb-dev", noDeployOffer: r.noDeployOffer, controlRunId: r.runId },
          false,
        );
      },
    });
  }
  return actionFlow;
}

/** Generic action card from a session or script (`tokyo-offer ask`). */
export const offerActionFromSession: ReturnType<typeof createActionOfferFlow>["offerActionFromSession"] =
  (a) => getActionFlow().offerActionFromSession(a);
/** Incident approval card from the on-call system; the answer is a Temporal signal. */
export const offerIncidentFromSession: ReturnType<typeof createActionOfferFlow>["offerIncident"] =
  (a) => getActionFlow().offerIncident(a);
export const incidentOfferStatus: ReturnType<typeof createActionOfferFlow>["incidentOfferStatus"] =
  (id) => getActionFlow().incidentOfferStatus(id);
export const actionOfferStatus: ReturnType<typeof createActionOfferFlow>["actionOfferStatus"] =
  (id) => getActionFlow().actionOfferStatus(id);
/** The one place an action card is answered, from any channel. */
export const answerActionOffer: ReturnType<typeof createActionOfferFlow>["answerActionOffer"] =
  (id, button, channel) => getActionFlow().answerActionOffer(id, button, channel);

/** After a successful run: "Deploy it?", unless the run came from an action card. */
export async function offerDeployAfterRun(bot: Bot, p: Pending): Promise<void> {
  if (p.noDeployOffer) return;
  await offerDeploy(bot, p);
}

/** Every successful coding run ends with "Deploy it?"; a deploy run itself does not. */
async function offerDeploy(
  bot: Bot, p: { project: ProjectRef; chatId: number; prompt: string; summary?: string; from?: string; sha?: string },
): Promise<DeployOffer | null> {
  if (isDeployPrompt(p.prompt)) return null;
  const pin = await pinSha(p.project, p.sha);
  if (!pin.ok) {
    await bot.api.sendMessage(p.chatId, `No deploy offered for ${p.project.name}: ${pin.error}`).catch(() => {});
    return null;
  }
  const offer = deployOffers.create({ project: p.project, chatId: p.chatId, now: Date.now(), summary: p.summary, from: p.from, sha: pin.sha });
  const kb = new InlineKeyboard().text("🚀 Deploy", `claude_deploy:${offer.id}`).text("Not now", `claude_nodeploy:${offer.id}`);
  const m = await bot.api.sendMessage(p.chatId, offerText(offer), { reply_markup: kb }).catch(() => null);
  if (m) deployOffers.setTelegramMessageId(offer.id, m.message_id);
  return offer;
}

/**
 * A remote-deploy project is deployed at one commit, fixed when the offer is made: the one given, else github/main
 * right now. If that cannot be read the offer is refused; an unpinned offer would deploy main as of approval.
 */
async function pinSha(project: ProjectRef, sha?: string): Promise<{ ok: true; sha?: string } | { ok: false; error: string }> {
  if (project.deployNote && !(sha && /^[0-9a-f]{7,40}$/i.test(sha))) {
    return { ok: false, error: `${project.name} deploys one pinned commit, so nothing was offered. Pass --sha <7-40 hex commit on origin/main>.` };
  }
  if (!project.deployRemote || sha) return { ok: true, sha };
  const resolved = await runnerHooks.resolveSha(project).catch(() => undefined);
  if (!resolved) return { ok: false, error: `could not pin the commit to deploy (cannot read github/main on ${project.deployRemote.host}), so nothing was offered. Retry, or pass --sha.` };
  if (!/^[0-9a-f]{40}$/.test(resolved)) return { ok: false, error: `could not pin the commit to deploy (unexpected sha from ${project.deployRemote.host}), so nothing was offered. Retry, or pass --sha.` };
  return { ok: true, sha: resolved };
}

/**
 * "Deploy it?" for a session Tokyo did not start — a terminal or herdr Claude
 * finishing a task calls this through `tokyo-deploy ask`. The owner answers on
 * Telegram, or back in the terminal; both land in answerDeployOffer().
 */
export async function offerDeployFromSession(
  projectName: string, summary?: string, from?: string, sha?: string,
): Promise<{ ok: true; id: string; project: string } | { ok: false; error: string }> {
  const chatId = parseInt(process.env.TELEGRAM_USER_ID || "0");
  if (!runnerBot || !chatId) return { ok: false, error: "telegram bot not ready" };
  const project = getProject(projectName);
  if (!project) return { ok: false, error: `unknown project ${JSON.stringify(projectName)}` };
  const pin = await pinSha(project, sha);
  if (!pin.ok) return { ok: false, error: pin.error };
  const offer = await offerDeploy(runnerBot, { project, chatId, prompt: "", summary, from, sha: pin.sha });
  return offer ? { ok: true, id: offer.id, project: project.name } : { ok: false, error: "not offered" };
}

export function deployOfferStatus(id: string): { state: DeployOffer["state"]; project: string; channel?: string; runId?: string; sha?: string } | null {
  const o = deployOffers.get(id, Date.now());
  return o ? { state: o.state, project: o.project.name, channel: o.channel, runId: o.runId, sha: o.sha } : null;
}

/** The one place an offer is answered, from any channel. "deploy" starts the deploy run. */
export async function answerDeployOffer(id: string, answer: "deploy" | "skip", channel: string): Promise<string> {
  const r = await answerDeployOfferDetailed(id, answer, channel);
  if (r.status === "missing") return `No open deploy offer ${id} (expired or unknown).`;
  if (r.status === "already") return `Deploy offer ${id} was already ${r.offer.state} on ${r.offer.channel}.`;
  return r.reply;
}

/** Same answer, structured, for the Control API. take() runs before the first await. */
export async function answerDeployOfferDetailed(id: string, answer: "deploy" | "skip", channel: string): Promise<DeployAnswer> {
  const r = deployOffers.take(id, answer, channel, Date.now());
  if (r.status !== "applied") return r;
  const o = r.offer;
  if (channel !== "telegram") await retireDeployCard(o, `\n\nAnswered on ${channel}: ${answer === "deploy" ? "Deploy" : "Not now"}`);
  const done = (reply: string): DeployAnswer => ({ status: "applied", offer: o, reply });
  if (answer === "skip") return done(`Not deploying ${o.project.name}. The work stays on its branch.`);
  const bot = runnerBot;
  if (!bot) return done("telegram bot not ready");
  if ((o.project.deployRemote || o.project.deployNote) && !o.sha) return done(`Not deploying ${o.project.name}: this offer has no pinned commit. Ask again.`);
  if (o.project.deployRemote && o.sha) {
    const live = await runnerHooks.liveHead(o.project).catch(() => undefined);
    if (live && sameSha(live, o.sha)) {
      const msg = `${o.project.name} is already live at ${o.sha.slice(0, 8)} on ${o.project.deployRemote.host}; nothing to deploy.`;
      console.log(`[deploy] offer ${o.id} (${o.project.name}) approved on ${channel} -> skipped, ${msg}`);
      await bot.api.sendMessage(o.chatId, `✅ ${msg}`).catch(() => {});
      return done(msg);
    }
  }
  // The run id is chosen here, as for a write-spec run, so the offer carries it from the moment of approval.
  const runId = randomUUID().slice(0, 8);
  deployOffers.setRunId(o.id, runId);
  console.log(`[deploy] offer ${o.id} (${o.project.name}) approved on ${channel} -> run ${runId}`);
  const prompt = deployPrompt(o.summary, o.project, o.sha);
  try {
    recordRunQueued(runStore(), { id: runId, project: o.project.name, host: o.project.location === "server" ? "server" : "mac", prompt, now: Date.now(), offerId: o.id });
  } catch (e: any) { console.warn("[control] queued run record failed:", e?.message || e); }
  const p: Pending = {
    project: o.project, prompt, reason: `deploy approved on ${channel}`,
    chatId: o.chatId, createdAt: Date.now(), variant: "kb-dev", controlRunId: runId, offerId: o.id,
  };
  if (channel !== "telegram") {
    await bot.api.sendMessage(o.chatId, `🚀 Deploy of ${o.project.name} approved from the ${channel} — running…`).catch(() => {});
  }
  const behind = startDeployRun(bot, p, runId, (err) => {
    bot.api.sendMessage(o.chatId, `Deploy run errored: ${err?.message || err}`).catch(() => {});
  });
  if (behind) return done(`A deploy of ${o.project.name} is already queued or running. This one is queued behind run ${behind} and starts when that run ends.`);
  return done(`Deploying ${o.project.name}…`);
}

/** The newest deploy run per project that is queued or running; a new one waits for its `done`. */
const deployTails = new Map<string, { runId: string; done: Promise<void> }>();

/**
 * Start an approved deploy run, at most one per project at a time: a second approval waits for the
 * run before it, so two deploys of the same code never overlap. Returns the run it waits behind, if any.
 * The tail is registered before the first await, so two approvals in a row always see each other.
 */
function startDeployRun(bot: Bot, p: Pending, runId: string, onError: (err: any) => void): string | undefined {
  const name = p.project.name;
  const prev = deployTails.get(name);
  const run = (prev?.done ?? Promise.resolve()).then(() => executeOrQueue(bot, p, false)).catch(onError);
  const entry = { runId, done: run };
  deployTails.set(name, entry);
  run.then(() => { if (deployTails.get(name) === entry) deployTails.delete(name); });
  return prev?.runId;
}

/** Drop the buttons of a deploy card and note where it was answered. Telegram failures never matter here. */
async function retireDeployCard(o: DeployOffer, note: string): Promise<void> {
  if (!runnerBot || o.telegramMessageId === undefined) return;
  try {
    await runnerBot.api.editMessageText(o.chatId, o.telegramMessageId, offerText(o) + note, { reply_markup: { inline_keyboard: [] } });
  } catch {
    /* message gone or unchanged */
  }
}

/** What the Control API needs from the offer stores and the answer paths. */
export function controlOfferBackends() {
  const flow = getActionFlow();
  const offers = actionOffers!;
  return {
    now: () => Date.now(),
    listActions: () => offers.list(Date.now()),
    listDeploys: () => deployOffers.list(Date.now()),
    getDeploy: (id: string) => deployOffers.get(id, Date.now()),
    answerAction: (id: string, button: string, channel: string, opts?: { runId?: string }) => flow.answerActionOfferDetailed(id, button, channel, opts),
    answerDeploy: answerDeployOfferDetailed,
    pendingActionFor: (project: string) => offers.listPendingCards(Date.now()).find((o) => o.project === project),
    pendingOfferFor: (project: string): string | null =>
      offers.listPendingCards(Date.now()).find((o) => o.project === project)?.id ??
      deployOffers.listPending(Date.now()).find((o) => o.project.name === project)?.id ?? null,
    createOffer: flow.offerActionFromSession,
    listMissions: () => require("./mission-wiring").listMissionsForControl() as import("./mission-store").MissionRow[],
    answerMission: (id: string, answer: "approve" | "decline", channel: string) => require("./mission-wiring").answerMissionDetailed(id, answer, channel) as Promise<import("./control/mission-offers").MissionAnswer>,
    proposeMission: (project: import("./project-registry").ProjectRef, msg: { content: string; sender_name: string; jid: string }, engine?: "claude" | "dsh") =>
      require("./mission-wiring").proposeServerMissionId(project, msg, engine) as Promise<string | null>,
    missionProjects: () => require("./mission-wiring").listMissionProjects() as { name: string; engine: "claude" | "dsh" }[],
  };
}

/** Start a run now, without the ✅ card — for tasks Jev routed with confidence. Never deploys by itself. */
/** Newest ✅ card still waiting in this chat. */
export function latestPendingRun(chatId: number): PendingRef | null {
  cleanupExpired();
  let best: PendingRef | null = null;
  for (const [id, p] of pending) {
    if (p.chatId !== chatId) continue;
    if (!best || p.createdAt > best.createdAt) best = { kind: "run", id, createdAt: p.createdAt, project: p.project.name };
  }
  return best;
}

/** Newest "Deploy it?" card still waiting in this chat. */
export function latestDeployOffer(chatId: number): PendingRef | null {
  const o = deployOffers.pendingFor(chatId, Date.now())[0];
  return o ? { kind: "deploy", id: o.id, createdAt: o.createdAt, project: o.project.name } : null;
}

/** Answer a ✅ card by id — from the button or from a typed "yes". */
export async function answerPendingRun(id: string, yes: boolean): Promise<string> {
  const p = pending.get(id);
  if (!p) return "That request already expired — send it again.";
  pending.delete(id);
  if (!yes) return `Cancelled. Nothing ran in ${p.project.name}.`;
  const bot = runnerBot;
  if (!bot) return "telegram bot not ready";
  executeOrQueue(bot, p, false).catch((err) => {
    bot.api.sendMessage(p.chatId, `Claude run errored: ${err?.message || err}`).catch(() => {});
  });
  return `Starting Claude in ${p.project.name} (${p.project.location})…`;
}

export function runClaudeNow(
  bot: Bot,
  chatId: number,
  project: ProjectRef,
  prompt: string,
  reason: string,
  wa?: WAContext,
): void {
  const p: Pending = { project, prompt, reason, chatId, createdAt: Date.now(), wa, variant: wa?.variant ?? "kb-dev" };
  executeOrQueue(bot, p, false).catch((err) => {
    bot.api.sendMessage(chatId, `Claude run errored: ${err?.message || err}`).catch(() => {});
  });
}

function cleanupExpired(): void {
  const now = Date.now();
  for (const [id, p] of pending.entries()) {
    if (now - p.createdAt > PENDING_TTL_MS) pending.delete(id);
  }
}

export function proposeClaudeRun(
  chatId: number,
  project: ProjectRef,
  prompt: string,
  reason: string,
  wa?: WAContext,
): string {
  cleanupExpired();
  const id = randomUUID().slice(0, 8);
  const variant = wa?.variant ?? "kb-dev";
  pending.set(id, { project, prompt, reason, chatId, createdAt: Date.now(), wa, variant });
  return id;
}

function reachMac(): Promise<boolean> {
  return new Promise((resolve) => {
    exec(
      `ssh -o ConnectTimeout=5 -o BatchMode=yes mac "echo ok"`,
      { timeout: REACH_TIMEOUT_MS, shell: "/bin/bash" },
      (error) => resolve(!error),
    );
  });
}

// Pulls a short git snapshot of the project for prompt context.
function gitSnapshot(project: ProjectRef): Promise<string> {
  const gitScript = `cd ${project.path} && echo "=== branch ===" && git branch --show-current 2>&1 && echo "=== last 10 commits ===" && git log --oneline -10 2>&1 && echo "=== status ===" && git status --short 2>&1 | head -30 && echo "=== staged diff stat ===" && git diff --cached --stat 2>&1 | head -20`;
  const cmd =
    project.location === "server"
      ? `bash -c ${JSON.stringify(gitScript)}`
      : `ssh -o ConnectTimeout=5 -o BatchMode=yes mac ${JSON.stringify(gitScript)}`;
  return new Promise((resolve) => {
    exec(cmd, { timeout: 10_000, shell: "/bin/bash", maxBuffer: 1_000_000 }, (_err, stdout) => {
      resolve((stdout || "").trim().slice(0, 3000));
    });
  });
}

function wrapPrompt(
  project: ProjectRef,
  raw: string,
  gitCtx: string,
  variant: "kb-dev" | "tech-company" = "kb-dev",
): string {
  const kbLine = project.kbPath
    ? `This project HAS a knowledge base at ai-knowledge-base/. You MUST consult it first.`
    : `This project has no local knowledge base — fall back to the user-global KB via the /kb-query skill.`;

  const entrySkillStep =
    variant === "tech-company"
      ? [
          `3. Invoke the Skill tool with skill="tech-company". Act as a full tech company — assign work to the following personas IN ONE CONTEXT and have each produce a short report:`,
          `   - Frontend (UI/UX): layout, copy, accessibility, responsive.`,
          `   - Backend (API/DB/jobs): data flow, endpoints, migrations, reliability.`,
          `   - DevOps (infra): build, deploy, SSL, env, monitoring.`,
          `   - QA (testing): edge cases, regression risk, test coverage gaps.`,
          `   - Design (brand/visual): tone, polish, alignment with the rest of the product.`,
          `   Do NOT spawn real subagents via the Task tool for this variant — the persona style is intentional. Real fan-out is reserved for the claude-code variant.`,
        ].join("\n")
      : `3. If the task is non-trivial → invoke Skill tool with skill="kb-dev" and let the pipeline run. If it's a <=3-step fix → use /writing-plans → /executing-plans.`;

  const extraReportFields =
    variant === "tech-company"
      ? `personas_used: <comma-separated list of the persona names that contributed findings>\n`
      : ``;

  const variantHeader =
    variant === "tech-company"
      ? `RUN VARIANT: tech-company — deliver a client-facing team report, not a code-change task.`
      : `RUN VARIANT: claude-code — ship real changes through the full dev-stack pipeline.`;

  return [
    `You are Claude Code running non-interactively in project "${project.name}" (${project.location}).`,
    `You were dispatched by Tokyo (a Telegram/WhatsApp bot) to complete a real task. The user is not watching the terminal — finish the work and report.`,
    variantHeader,
    ``,
    `YOU MUST follow the standing rules in ~/.claude/CLAUDE.md, especially:`,
    ` - /kb-dev is the preferred entry point for any non-trivial feature, bug fix, refactor, or ship request.`,
    ` - /kb-spec must bridge every /speckit.* phase (pre → specify, plan → plan, tasks → tasks, implement → implement, post after tasks).`,
    ` - Before answering any question about history/decisions/architecture, /kb-query first and cite [[wikilinks]].`,
    ` - For work that touches 2+ independent subsystems, spawn the orchestrator subagent via the Task tool (subagent_type="orchestrator") and let it fan out specialists.`,
    ` - test-driven-development, verification-before-completion, requesting-code-review and systematic-debugging are non-negotiable before claiming done.`,
    ``,
    `DETERMINISTIC PHASE ORDER for THIS run:`,
    `1. Invoke the Skill tool with skill="kb-query" and a derived question about this task. ${kbLine}`,
    `2. Review git state (already pre-fetched below, but re-run git log -p for any file the task mentions).`,
    entrySkillStep,
    `4. Before touching real production code paths, run /kb-spec pre (and plan/tasks as the work grows). Skip only for one-line fixes or for tech-company-variant runs that don't ship code.`,
    `5. Implement, run tests (test-driven-development skill), verify (verification-before-completion skill). For tech-company variant, no code changes are required — the deliverable is the multi-persona report.`,
    `6. Commit on a feature branch (never main). Do not push. Skip if tech-company variant with no code changes.`,
    `7. KB CAPTURE — mandatory final step, even on small fixes:`,
    `   a. Write a task-capture markdown to \`ai-knowledge-base/raw/tokyo-task-\${Date.now()}.md\` containing: task prompt, key decisions, files changed with one-line reason each, any new wikilinks, deferred follow-ups.`,
    `   b. Invoke the Skill tool with skill="kb-ingest" to process that raw file into knowledge/ articles.`,
    `   c. If the project has no KB (no ai-knowledge-base/ folder), skip silently.`,
    ``,
    `STRUCTURED OUTPUT — at the very end, print exactly this block so Tokyo can parse it:`,
    `<tokyo-report>`,
    `kb_query_ran: <yes|no>`,
    `kb_spec_phases: <pre, plan, tasks, or "skipped: reason">`,
    `orchestrator_used: <yes|no + reason>`,
    `variant: ${variant}`,
    `branch: <branch name>`,
    `files_changed: <count>`,
    extraReportFields +
      `summary: <one paragraph for the user>`,
    `client_reply: <one friendly sentence if this task came from a WA client, else empty>`,
    `follow_ups: <bullet list of any deferred work>`,
    `</tokyo-report>`,
    ``,
    `=== Git context (pre-fetched by Tokyo) ===`,
    gitCtx || "(no git context available)",
    `=== End git context ===`,
    ``,
    `=== Task ===`,
    raw,
    `=== End task ===`,
  ].join("\n");
}

// Every Claude run happens in a herdr workspace (the Mac's for laptop projects, root's on
// the server), watchable live. The prompt goes over stdin into a file, never into argv.
const HERDR_CAP_MS = 60 * 60 * 1000;

export const execArgv: Exec = (argv, opts) =>
  new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { timeout: opts?.timeoutMs ?? 60_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ code: 1, stdout, stderr: stderr + String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.on("error", (e) => {
      stderr += String(e);
    });
    child.stdin.end(opts?.input ?? "");
  });

async function sendChunked(bot: Bot, chatId: number, text: string, prefix = ""): Promise<void> {
  const full = prefix + text;
  for (let i = 0; i < full.length; i += TELEGRAM_CHUNK) {
    const slice = full.slice(i, i + TELEGRAM_CHUNK);
    await bot.api
      .sendMessage(chatId, `\`\`\`\n${slice}\n\`\`\``, { parse_mode: "Markdown" })
      .catch(() => bot.api.sendMessage(chatId, slice));
  }
}

async function summarizeForClient(rawOutput: string): Promise<string> {
  // Use the last 300 chars of Claude's output as a simple client-facing summary.
  const tail = rawOutput.trim().split(/\n+/).slice(-6).join("\n").slice(-500);
  return `✅ ${tail}`.slice(0, 900);
}

async function runClaudeOnHost(
  bot: Bot,
  chatId: number,
  project: ProjectRef,
  prompt: string,
  sourceLabel: string,
  wa?: WAContext,
  replyToClient = false,
  variant: "kb-dev" | "tech-company" = "kb-dev",
  controlRunId?: string,
  offerId?: string,
): Promise<{ ok: boolean; output: string }> {
  const hostLabel = project.location === "server" ? "server" : "laptop";
  await bot.api
    .sendMessage(chatId, `📸 Fetching git snapshot for *${project.name}* (${hostLabel})…`, {
      parse_mode: "Markdown",
    })
    .catch(() => {});
  const gitCtx = await gitSnapshot(project);

  const wrapped = wrapPrompt(project, prompt, gitCtx, variant);
  const onServer = project.location === "server";
  // Jev picks model + effort from the client task (stdin, never argv); any failure keeps MODEL.
  const picked = await execArgv(pickArgv(["--stdin"]), { input: prompt, timeoutMs: 15_000 });
  const runModel: RunModel = picked.code === 0 ? parseRunModel(picked.stdout, MODEL) : { model: MODEL };
  const env = {
    model: runModel.model,
    effort: runModel.effort,
    proxyUrl: onServer ? PROXY_URL_LOCAL : PROXY_URL_LAPTOP,
    authToken: AUTH_TOKEN,
    ...offerRunEnv(offerId, project.name),
  };
  const startedAt = Date.now();
  let run: { ok: boolean; exitCode: number | null; output: string; model?: string };
  // The Control API's run list: recording must never fail or slow down the run itself.
  const record = (fn: (s: ControlStore) => void) => { try { fn(runStore()); } catch (e: any) { console.warn("[control] run record failed:", e?.message || e); } };
  let recordedId = controlRunId;
  try {
    run = await runInHerdr(
      onServer ? serverHost(execArgv) : laptopHost(execArgv),
      project.path,
      wrapped,
      (id) => (onServer ? serverLauncher(id, project.path, env, { asRoot: runsAsRoot(prompt, offerId), gateHost: project.deployRemote?.host }) : laptopLauncher(id, project.path, env)),
      {
        id: controlRunId,
        capMs: HERDR_CAP_MS,
        isCancelled: () => { try { return !!recordedId && runStore().getRun(recordedId)?.status === "stopped"; } catch { return false; } },
        onStarted: async (label, id) => {
          recordedId = id;
          record((s) => recordRunStarted(s, {
            id, project: project.name, host: onServer ? "server" : "mac", prompt,
            model: runModel.model, tier: runModel.tier ?? null, label, now: Date.now(), offerId,
          }));
          await bot.api
            .sendMessage(
              chatId,
              `🤖 ${sourceLabel} Claude (${runModel.model}${runModel.tier ? `, ${runModel.tier}` : ""}) working in ${project.name} — herdr workspace ${label} on the ${hostLabel}\n` +
                `prompt: ${prompt.slice(0, 200)}${prompt.length > 200 ? "…" : ""}`,
            )
            .catch(() => {});
        },
      },
    );
  } catch (e: any) {
    run = { ok: false, exitCode: null, output: `Could not start the herdr run: ${e?.message || e}` };
  }
  // A deploy that exited 0 but reports "NOT DEPLOYED" is a failed run, for the app and for Telegram.
  if (run.ok && isDeployPrompt(prompt) && reportsNotDeployed(run.output)) run = { ...run, ok: false };
  if (recordedId) {
    const id = recordedId;
    record((s) => recordRunFinished(s, id, { ok: run.ok, exitCode: run.exitCode, model: run.model, now: Date.now() }));
  }
  const stdoutBuf = run.output;
  const stderrBuf = "";

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const code = run.exitCode ?? -1;
  const ok = run.ok;
  const icon = ok ? "✅" : "❌";

  await bot.api
    .sendMessage(
      chatId,
      `${icon} Claude finished in *${project.name}* (${elapsed}s, exit ${code})`,
      { parse_mode: "Markdown" },
    )
    .catch(() => {});

  const out = stdoutBuf.trim();
  const err = stderrBuf.trim();
  if (out) await sendChunked(bot, chatId, out);
  if (err) await sendChunked(bot, chatId, err, "[stderr]\n");
  if (!out && !err) await bot.api.sendMessage(chatId, "(no output)").catch(() => {});

  if (ok && replyToClient && wa?.clientJid) {
    try {
      const summary = await summarizeForClient(out || err || "");
      await sendWhatsAppMessage(wa.clientJid, summary);
      await bot.api
        .sendMessage(chatId, `📤 Sent summary to WA client ${wa.senderName}.`, {
          parse_mode: "Markdown",
        })
        .catch(() => {});
    } catch (e: any) {
      await bot.api
        .sendMessage(chatId, `⚠️ Failed to reply to WA client: ${e?.message || e}`)
        .catch(() => {});
    }
  }

  return { ok, output: [out, err && `[stderr] ${err}`].filter(Boolean).join("\n\n") };
}

async function executeOrQueue(bot: Bot, p: Pending, replyToClient: boolean): Promise<void> {
  if (p.project.location === "server") {
    const r = await runClaudeOnHost(bot, p.chatId, p.project, p.prompt, "▶️", p.wa, replyToClient, p.variant, p.controlRunId, p.offerId);
    if (r.ok) await offerDeployAfterRun(bot, p);
    return;
  }

  const reachable = await runnerHooks.reach();
  if (!reachable) {
    const id = enqueueLaptopTask(
      p.project.name,
      p.prompt,
      p.reason,
      p.chatId,
      p.variant === "tech-company" ? "tech-company" : "claude-code",
      { controlRunId: p.controlRunId, offerId: p.offerId },
    );
    const pendingCount = countPendingLaptopTasks();
    await bot.api
      .sendMessage(
        p.chatId,
        `💤 Mac offline — *queued* task #${id} for *${p.project.name}* (${p.variant}).\n_(${pendingCount} pending total. Drainer retries every 60s.)_`,
        { parse_mode: "Markdown" },
      )
      .catch(() => {});
    return;
  }

  const r = await runnerHooks.run(bot, p.chatId, p.project, p.prompt, "▶️", p.wa, replyToClient, p.variant, p.controlRunId, p.offerId);
  if (r.ok) await offerDeployAfterRun(bot, p);
}

/** The two calls that leave the process (ssh to the Mac, the herdr run); a test replaces them. */
function sameSha(a: string, b: string): boolean {
  const x = a.toLowerCase(), y = b.toLowerCase();
  return Math.min(x.length, y.length) >= 7 && (x.startsWith(y) || y.startsWith(x));
}

/** Read-only git on the project's deploy host (ssh). Undefined when it cannot be read. */
async function remoteGit(r: NonNullable<ProjectRef["deployRemote"]>, args: string): Promise<string | undefined> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(r.host) || !/^[A-Za-z0-9._\/-]+$/.test(r.path)) return undefined;
  const { execFile } = await import("child_process");
  return new Promise((resolve) =>
    execFile("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", r.host, `git -C ${r.path} ${args}`], { timeout: 30_000 }, (err, out) => resolve(err ? undefined : String(out).trim().split(/\s/)[0] || undefined)),
  );
}

export const runnerHooks = {
  /** github/main of a remote-deploy project, read without touching its checkout. */
  resolveSha: (async (p) => (p.deployRemote ? remoteGit(p.deployRemote, "ls-remote github refs/heads/main") : undefined)) as (p: ProjectRef) => Promise<string | undefined>,
  /** HEAD of the live checkout on the project's deploy host. */
  liveHead: (async (p) => (p.deployRemote ? remoteGit(p.deployRemote, "rev-parse HEAD") : undefined)) as (p: ProjectRef) => Promise<string | undefined>,
  reach: reachMac as () => Promise<boolean>,
  run: runClaudeOnHost as typeof runClaudeOnHost,
};

export async function drainOnce(bot: Bot): Promise<void> {
  const row = nextPendingLaptopTask();
  if (!row) return;
  const reachable = await runnerHooks.reach();
  if (!reachable) return;

  const project = getProject(row.project);
  if (!project) {
    finishLaptopTask(row.id, false, `Unknown project: ${row.project}`);
    return;
  }
  markLaptopTaskRunning(row.id);
  const variant: "kb-dev" | "tech-company" =
    row.layer === "tech-company" ? "tech-company" : "kb-dev";
  // The run row and offer the task was queued with move on from queued; a row from before the link columns has neither.
  const result = await runnerHooks.run(
    bot,
    row.chat_id,
    project,
    row.prompt,
    `♻️ Resumed queued task #${row.id}`,
    undefined,
    false,
    variant,
    row.control_run_id ?? undefined,
    row.offer_id ?? undefined,
  );
  finishLaptopTask(row.id, result.ok, result.output);
  if (result.ok) await offerDeploy(bot, { project, chatId: row.chat_id, prompt: row.prompt });
}

export function registerClaudeRunner(bot: Bot): void {
  runnerBot = bot;
  bot.callbackQuery(/^claude_yes:(\S+)$/, async (ctx) => {
    const id = ctx.match[1];
    const p = pending.get(id);
    if (!p) {
      await ctx.answerCallbackQuery({ text: "Expired or already handled" });
      return;
    }
    pending.delete(id);
    await ctx.answerCallbackQuery({ text: "Starting…" });
    await ctx
      .editMessageText(`🤖 *Approved* — ${p.project.name}…`, { parse_mode: "Markdown" })
      .catch(() => {});
    executeOrQueue(bot, p, false).catch((err) => {
      bot.api.sendMessage(p.chatId, `Claude run errored: ${err?.message || err}`).catch(() => {});
    });
  });

  bot.callbackQuery(/^claude_yes_reply:(\S+)$/, async (ctx) => {
    const id = ctx.match[1];
    const p = pending.get(id);
    if (!p) {
      await ctx.answerCallbackQuery({ text: "Expired or already handled" });
      return;
    }
    pending.delete(id);
    await ctx.answerCallbackQuery({ text: "Starting + will reply client…" });
    await ctx
      .editMessageText(
        `🤖 *Approved + reply client* — ${p.project.name}…`,
        { parse_mode: "Markdown" },
      )
      .catch(() => {});
    executeOrQueue(bot, p, true).catch((err) => {
      bot.api.sendMessage(p.chatId, `Claude run errored: ${err?.message || err}`).catch(() => {});
    });
  });

  bot.callbackQuery(/^claude_(deploy|nodeploy):(\S+)$/, async (ctx) => {
    const answer = ctx.match[1] === "deploy" ? "deploy" : "skip";
    const reply = await answerDeployOffer(ctx.match[2], answer, "telegram");
    await ctx.answerCallbackQuery({ text: reply.slice(0, 190) }).catch(() => {});
    await ctx.editMessageText(answer === "deploy" && reply.startsWith("Deploying") ? `🚀 ${reply}` : reply).catch(() => {});
  });

  bot.callbackQuery(/^act:([0-9a-f]{8}):([a-z0-9_-]{1,16})$/, async (ctx) => {
    const reply = await answerActionOffer(ctx.match[1], ctx.match[2], "telegram");
    await ctx.answerCallbackQuery({ text: reply.slice(0, 190) }).catch(() => {});
  });

  bot.callbackQuery(/^claude_no:(\S+)$/, async (ctx) => {
    const id = ctx.match[1];
    pending.delete(id);
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    await ctx.editMessageText("❌ Cancelled.").catch(() => {});
  });

  // Escalate a pending task to tech-company (full team) and run
  bot.callbackQuery(/^claude_tc:(\S+)$/, async (ctx) => {
    const id = ctx.match[1];
    const p = pending.get(id);
    if (!p) {
      await ctx.answerCallbackQuery({ text: "Expired or already handled" });
      return;
    }
    pending.delete(id);
    const upgraded: Pending = { ...p, variant: "tech-company" };
    await ctx.answerCallbackQuery({ text: "Full team starting…" });
    await ctx
      .editMessageText(`🏢 *Full team* approved — ${p.project.name}…`, { parse_mode: "Markdown" })
      .catch(() => {});
    executeOrQueue(bot, upgraded, false).catch((err) => {
      bot.api.sendMessage(p.chatId, `Claude run errored: ${err?.message || err}`).catch(() => {});
    });
  });

  setInterval(() => {
    drainOnce(bot).catch(() => {});
  }, DRAIN_INTERVAL_MS);
}
