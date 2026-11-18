import type { Bot } from "grammy";
import { execFile } from "child_process";
import { randomUUID } from "crypto";
import {
  createLaptopPending,
  getLaptopPending,
  deleteLaptopPending,
  purgeExpiredLaptopPending,
} from "./db";

export const PENDING_TTL_MS = 5 * 60 * 1000;

const TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 4000;

const BLOCKED_PATTERNS: RegExp[] = [
  /rm\s+-rf\s+\/\s*$/,
  /rm\s+-rf\s+~\s*$/,
  /rm\s+-rf\s+\$HOME\s*$/,
  /rm\s+-rf\s+\/Users\/owner\s*$/,
  /mkfs\./,
  /dd\s+if=.*of=\/dev\//,
  /:\(\)\s*\{\s*:\s*\|\s*:&\s*\}\s*;\s*:/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bhalt\b/,
];

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests and for registerLaptopBridge
// ---------------------------------------------------------------------------

export function proposeLaptopCommand(
  _bot: Bot | null,
  chatId: number,
  cmd: string,
  dbOverride?: import("better-sqlite3").Database,
): { id: string; blocked?: string } {
  for (const pat of BLOCKED_PATTERNS) {
    if (pat.test(cmd)) return { id: "", blocked: "Blocked: destructive command pattern." };
  }
  purgeExpiredLaptopPending(PENDING_TTL_MS, dbOverride);
  const id = randomUUID().slice(0, 8);
  createLaptopPending(id, chatId, cmd, dbOverride);
  return { id };
}

/**
 * Claim a pending confirmation (approve path).
 * Atomically: if the row exists and is not expired, delete it and return { status: 'ok', cmd, chatId }.
 * If the row is expired, delete it and return { status: 'expired' }.
 * If the row does not exist, return { status: 'missing' }.
 */
export function claimLaptopPending(
  id: string,
  dbOverride?: import("better-sqlite3").Database,
): { status: "ok" | "expired" | "missing"; cmd?: string; chatId?: number } {
  const p = getLaptopPending(id, dbOverride);
  if (!p) return { status: "missing" };

  if (Date.now() - p.created_at > PENDING_TTL_MS) {
    deleteLaptopPending(id, dbOverride);
    return { status: "expired" };
  }

  deleteLaptopPending(id, dbOverride);
  return { status: "ok", cmd: p.cmd, chatId: p.chat_id };
}

/**
 * Cancel a pending confirmation (reject path).
 * Silently no-ops if the row is already gone.
 */
export function cancelLaptopPending(
  id: string,
  dbOverride?: import("better-sqlite3").Database,
): void {
  deleteLaptopPending(id, dbOverride);
}

// ---------------------------------------------------------------------------
// SSH runner
// ---------------------------------------------------------------------------

// ssh argv for one command on the Mac. The command is a single argv entry and no
// local shell runs, so $VAR, $(...) and backticks expand on the Mac, not on this server.
export function sshArgs(cmd: string): string[] {
  return ["-n", "-o", "ConnectTimeout=10", "-o", "BatchMode=yes", "mac", cmd];
}

// Exit code for a finished ssh. A killed child (timeout) has code null, which used to
// read as 0 and report a cut-off run as success.
export function exitCode(error: any): number {
  if (!error) return 0;
  if (typeof error.code === "number") return error.code;
  if (error.killed || error.signal) return 124;
  if (error.code === "ENOENT") return 127;
  return 1;
}

function runOnLaptop(cmd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      "ssh",
      sshArgs(cmd),
      { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const trimOut =
          stdout.length > MAX_OUTPUT ? stdout.slice(0, MAX_OUTPUT) + "\n... (truncated)" : stdout;
        const trimErr =
          stderr.length > MAX_OUTPUT ? stderr.slice(0, MAX_OUTPUT) + "\n... (truncated)" : stderr;
        const code = exitCode(error);
        const note = code === 124 ? `\n(timed out after ${TIMEOUT_MS / 1000} s)` : "";
        resolve({ stdout: trimOut, stderr: trimErr + note, code });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Grammy callback registration
// ---------------------------------------------------------------------------

export function registerLaptopBridge(bot: Bot, isOwner: (ctx: any) => boolean): void {
  bot.callbackQuery(/^laptop_yes:(\S+)$/, async (ctx) => {
    if (!isOwner(ctx)) { await ctx.answerCallbackQuery({ text: "Unauthorized" }); return; }
    const id = ctx.match[1];
    const verdict = claimLaptopPending(id);

    if (verdict.status !== "ok") {
      const text = verdict.status === "expired" ? "Expired" : "Expired or already handled";
      await ctx.answerCallbackQuery({ text });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Running on laptop..." });
    await ctx
      .editMessageText(`💻 *Running on laptop:*\n\`\`\`\n${verdict.cmd}\n\`\`\``, { parse_mode: "Markdown" })
      .catch(() => {});
    const result = await runOnLaptop(verdict.cmd!);
    const icon = result.code === 0 ? "✅" : "❌";
    const output = (result.stdout || result.stderr).trim().slice(0, 3500) || "(no output)";
    const msg = `${icon} Laptop exit ${result.code}\n\`\`\`\n${output}\n\`\`\``;
    await ctx.api.sendMessage(verdict.chatId!, msg, { parse_mode: "Markdown" }).catch(async () => {
      await ctx.api.sendMessage(verdict.chatId!, `${icon} Laptop exit ${result.code}\n${output}`);
    });
  });

  bot.callbackQuery(/^laptop_no:(\S+)$/, async (ctx) => {
    if (!isOwner(ctx)) { await ctx.answerCallbackQuery({ text: "Unauthorized" }); return; }
    const id = ctx.match[1];
    cancelLaptopPending(id);
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    await ctx.editMessageText("❌ Laptop command cancelled.").catch(() => {});
  });
}

export function runOnLaptopDirect(cmd: string) {
  return runOnLaptop(cmd);
}
