import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { execFile } from "child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import db from "./db";
import { getProject, type ProjectRef } from "./project-registry";
import { loadMissionConfig, type MissionProject } from "./mission-config";
import { initMissions, createMission, answerMission, expireMissions, getMission, listMissions, type MissionRow } from "./mission-store";
import type { MissionAnswer } from "./control/mission-offers";
import { parseApprovalReply, isOwnSelfChat, approvalCardText, parseTaskCommand } from "./mission-approval";
import { startMission, pollMission, deployMission, recoverDeploying, JEV_AUTO, type RunnerDeps, type ExecResult } from "./mission-runner";
import type { PendingRef } from "./tg-approval";
import { MISSION_ROOT } from "./mission-commands";

// Glue between the tested mission modules and the live bot: Telegram buttons,
// WhatsApp self-chat replies, and the timer that moves missions along.

const CHAT_ID = parseInt(process.env.TELEGRAM_USER_ID || "0");
const TTL_MS = 30 * 60_000;
let bot: Bot | null = null;
let config = new Map<string, MissionProject>();

function exec(argv: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { cwd: opts?.cwd, timeout: opts?.timeoutMs ?? 120_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf-8" },
      (err: any, stdout, stderr) => resolve({
        code: err ? (typeof err.code === "number" ? err.code : err.killed ? 124 : 1) : 0,
        stdout: stdout ?? "",
        stderr: (stderr ?? "") + (err && typeof err.code === "string" ? `${argv[0]}: ${err.code}` : ""),
      }));
  });
}

/** Owner's own chat, from the live WhatsApp socket (lazy require: whatsapp.ts imports this module's caller). */
function ownJids(): { jid: string; lid?: string } | null {
  try { return require("./whatsapp").getOwnJids(); } catch { return null; }
}

async function sendBoth(text: string, keyboard?: InlineKeyboard): Promise<void> {
  if (bot && CHAT_ID) {
    await bot.api.sendMessage(CHAT_ID, text, keyboard ? { reply_markup: keyboard } : {})
      .catch((e: any) => console.error("[missions] telegram send failed:", e?.description || e?.message));
  }
  const me = ownJids();
  if (me) {
    const self = `${me.jid.split("@")[0].split(":")[0]}@s.whatsapp.net`;
    await require("./whatsapp").sendWhatsAppMessage(self, text)
      .catch((e: any) => console.error("[missions] whatsapp self send failed:", e?.message));
  }
}

function deps(): RunnerDeps {
  return {
    db: db as any,
    config,
    now: () => Date.now(),
    exec,
    fs: {
      write: (p, t) => writeFileSync(p, t, "utf-8"),
      read: (p) => (existsSync(p) ? readFileSync(p, "utf-8") : null),
    },
    notify: async (m: MissionRow, text: string, opts?: { offerDeploy?: boolean }) =>
      sendBoth(text, opts?.offerDeploy ? new InlineKeyboard().text("🚀 Deploy", `mission_deploy:${m.id}`) : undefined),
  };
}

export function hasMissionConfig(project: string): boolean {
  return config.has(project);
}

/** Projects a mission can start in, with their configured engine (the Control app's task options). */
export function listMissionProjects(): { name: string; engine: "claude" | "dsh" }[] {
  return [...config.values()].map((p) => ({ name: p.name, engine: p.engine }));
}

export async function proposeServerMission(
  project: ProjectRef, msg: { content: string; sender_name: string; jid: string }, engine?: "claude" | "dsh",
): Promise<boolean> {
  return (await proposeServerMissionId(project, msg, engine)) !== null;
}

/** proposeServerMission, returning the new mission id (null when the project has no mission config). */
export async function proposeServerMissionId(
  project: ProjectRef, msg: { content: string; sender_name: string; jid: string }, engine?: "claude" | "dsh",
): Promise<string | null> {
  const cfg = config.get(project.name);
  if (!cfg) return null;
  const chosen = engine ?? cfg.engine;
  const id = createMission(db as any, { project: project.name, prompt: msg.content.trim(), sender: msg.sender_name, jid: msg.jid, now: Date.now(), ttlMs: TTL_MS, engine: chosen });
  const status = await exec(["git", "-C", cfg.repo, "status", "--porcelain"]);
  const text = approvalCardText({
    id, project: project.name, sender: msg.sender_name, prompt: msg.content, branch: `mission/${id}`, engine: chosen,
    tests: cfg.test.map((a) => a.join(" ")), deploy: cfg.deploy.map((a) => a.join(" ")),
    autoDeploy: true, confirmed: cfg.confirmed, liveDirtyFiles: status.stdout.split("\n").filter((l) => l.trim()).length,
  });
  const kb = new InlineKeyboard().text("✅ Run", `mission_yes:${id}`).text("❌ Cancel", `mission_no:${id}`);
  await sendBoth(text, kb);
  return id;
}

/** Start a server mission right away (Jev routed it). It stops before deploy and asks. */
export async function autoStartServerMission(
  project: ProjectRef, msg: { content: string; sender_name: string; jid: string }, why: string,
): Promise<boolean> {
  const cfg = config.get(project.name);
  if (!cfg) return false;
  const id = createMission(db as any, { project: project.name, prompt: msg.content.trim(), sender: msg.sender_name, jid: msg.jid, now: Date.now(), ttlMs: TTL_MS, engine: cfg.engine });
  answerMission(db as any, id, "approve", JEV_AUTO, Date.now());
  await sendBoth(`Mission ${id} (${project.name}) from ${msg.sender_name} started without a ✅ — ${why}.\n"${msg.content.slice(0, 300)}"\nYou'll be asked before anything deploys.`);
  void startMission(deps(), id);
  return true;
}

/** Newest mission waiting on the owner: proposed (run?) or held (deploy?). */
export function latestMissionPending(): PendingRef | null {
  const now = Date.now();
  // The table only exists once initMissionWiring ran; missions may be disabled.
  let row: { id: string; project: string; state: string; created_at: number; updated_at: number } | undefined;
  try {
    row = (db as any).prepare(
    `SELECT id, project, state, created_at, updated_at FROM missions
      WHERE state = 'held' OR (state = 'proposed' AND expires_at > ?)
      ORDER BY updated_at DESC LIMIT 1`,
    ).get(now) as typeof row;
  } catch {
    return null;
  }
  if (!row) return null;
  return {
    kind: row.state === "held" ? "mission_deploy" : "mission",
    id: row.id,
    createdAt: row.updated_at ?? row.created_at,
    project: row.project,
  };
}

/** Answer a mission card by id — from the button or from a typed "yes". */
export async function answerMissionByKind(id: string, kind: "mission" | "mission_deploy", yes: boolean, channel: string): Promise<string> {
  if (kind === "mission_deploy") {
    if (!yes) return `Not deploying mission ${id}. The work stays on its branch.`;
    return applyAnswer(id, "deploy", channel);
  }
  return applyAnswer(id, yes ? "approve" : "decline", channel);
}

async function applyAnswer(id: string, answer: "approve" | "decline" | "deploy", channel: string): Promise<string> {
  if (answer === "deploy") {
    const r = await deployMission(deps(), id, { override: true });
    return r.ok ? `Deploying mission ${id}…` : `Mission ${id} not deployed: ${r.reason}`;
  }
  const r = answerMission(db as any, id, answer, channel, Date.now());
  if (r.status === "applied") {
    if (r.state === "approved") void startMission(deps(), id);
    return `Mission ${id} ${r.state}${r.state === "approved" ? " — starting" : ""}.`;
  }
  if (r.status === "already") return `Mission ${id} was already ${r.state} (by ${r.answeredBy}).`;
  if (r.status === "expired") return `Mission ${id} expired.`;
  return `No mission ${id}.`;
}

/** Every mission, for the Control API's mission offers. Empty while missions are disabled. */
export function listMissionsForControl(): MissionRow[] {
  try { return listMissions(db as any, 200); } catch { return []; }
}

/** The Control API answering a mission offer: the same exactly-once store update as the Telegram button. */
export async function answerMissionDetailed(id: string, answer: "approve" | "decline", channel: string): Promise<MissionAnswer> {
  const r = answerMission(db as any, id, answer, channel, Date.now());
  const mission = getMission(db as any, id);
  if (r.status === "unknown" || !mission) return { status: "missing" };
  if (r.status === "expired") return { status: "expired", mission };
  if (r.status === "already") return { status: "already", mission };
  if (r.state === "approved") void startMission(deps(), id);
  return { status: "applied", mission, reply: `Mission ${id} ${r.state}${r.state === "approved" ? " — starting" : ""}.` };
}

/** Called for every live WhatsApp message I send. Returns true if it was a mission reply. */
export async function handleMissionReply(chatJid: string, text: string, fromMe: boolean): Promise<boolean> {
  const me = ownJids();
  if (!me || !isOwnSelfChat(chatJid, me.jid, fromMe, me.lid)) return false;
  const cmd = parseTaskCommand(text);
  if (cmd) {
    const project = getProject(cmd.project);
    if (!project || !config.has(project.name)) {
      await sendBoth(`No mission config for "${cmd.project}". Missions run for: ${[...config.keys()].join(", ")}.`);
      return true;
    }
    return proposeServerMission(project, { content: cmd.task, sender_name: "owner (self-chat)", jid: chatJid }, cmd.engine);
  }
  const parsed = parseApprovalReply(text);
  if (!parsed || !getMission(db as any, parsed.id)) return false;
  await sendBoth(await applyAnswer(parsed.id, parsed.answer, "whatsapp"));
  return true;
}

export function initMissionWiring(b: Bot): void {
  bot = b;
  try {
    config = loadMissionConfig(readFileSync(`${process.cwd()}/missions.config.json`, "utf-8"));
  } catch (e: any) {
    console.error("[missions] config not loaded, missions disabled:", e?.message);
    return;
  }
  initMissions(db as any);
  mkdirSync(MISSION_ROOT, { recursive: true, mode: 0o755 });

  b.callbackQuery(/^mission_deploy:([0-9a-f]{8})$/, async (ctx) => {
    const reply = await applyAnswer(ctx.match[1], "deploy", "telegram");
    await ctx.answerCallbackQuery({ text: reply.slice(0, 190) }).catch(() => {});
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  b.callbackQuery(/^mission_(yes|no):([0-9a-f]{8})$/, async (ctx) => {
    const answer = ctx.match[1] === "yes" ? "approve" : "decline";
    const reply = await applyAnswer(ctx.match[2], answer, "telegram");
    await ctx.answerCallbackQuery({ text: reply.slice(0, 190) }).catch(() => {});
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  void recoverDeploying(deps()).catch((e) => console.error("[missions] recover error:", e));

  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      for (const id of expireMissions(db as any, Date.now())) await sendBoth(`Mission ${id} expired without an answer.`);
      const active = (db as any).prepare("SELECT id, state FROM missions WHERE state IN ('approved','running')").all() as { id: string; state: string }[];
      for (const m of active) {
        if (m.state === "approved") await startMission(deps(), m.id);
        else await pollMission(deps(), m.id);
      }
    } catch (e) {
      console.error("[missions] tick error:", e);
    } finally {
      busy = false;
    }
  }, 20_000).unref?.();
  console.log(`[missions] ready: ${[...config.keys()].join(", ")}`);
}
