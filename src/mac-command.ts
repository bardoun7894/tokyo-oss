import type { Bot } from "grammy";
import { InlineKeyboard, InputFile } from "grammy";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { proposeLaptopCommand, runOnLaptopDirect } from "./laptop-bridge";

// /mac — control the owner's Mac from Telegram (alias /laptop).
//   /mac              status (battery, uptime, tailscale, screen bridge, lightpanda)
//   /mac shot         screenshot of the whole screen
//   /mac open <App>   open an app (asks first)
//   /mac run <cmd>    run a shell command (asks first)
// Screenshots go through the herdr "screenbridge" pane: a plain ssh session on the
// Mac has no screen access, the pane (started from Warp) does.

const BRIDGE = "~/.claude/skills-parked/drive-screen/scripts/tokyo-bridge.sh";
const SHOT = "/tmp/tokyo-shot.jpg";

export type MacAction =
  | { kind: "status" }
  | { kind: "shot" }
  | { kind: "help" }
  | { kind: "open"; app: string }
  | { kind: "run"; cmd: string }
  | { kind: "error"; msg: string };

const APP_NAME = /^[\p{L}\p{N} ._+-]{1,60}$/u;

export function parseMacArgs(input: string): MacAction {
  const s = (input ?? "").trim();
  if (!s || s.toLowerCase() === "status") return { kind: "status" };
  const head = s.split(/\s+/)[0];
  const arg = s.slice(head.length).trim();
  switch (head.toLowerCase()) {
    case "shot":
    case "screenshot":
    case "screen":
      return { kind: "shot" };
    case "open":
      if (!arg) return { kind: "error", msg: "Usage: /mac open <App name>" };
      if (!APP_NAME.test(arg)) return { kind: "error", msg: "App name may only use letters, digits, spaces, dot, dash and plus." };
      return { kind: "open", app: arg };
    case "run":
      if (!arg) return { kind: "error", msg: "Usage: /mac run <command>" };
      return { kind: "run", cmd: arg };
    default:
      return { kind: "help" };
  }
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function openCommand(app: string): string {
  return `open -a ${shellQuote(app)}`;
}

export const HELP =
  "💻 Mac control\n\n" +
  "/mac — status\n" +
  "/mac shot — screenshot\n" +
  "/mac open <App> — open an app (asks first)\n" +
  "/mac run <cmd> — run a command (asks first)";

const STATUS_CMD = [
  `pmset -g batt | grep -Eo '[0-9]+%;[^;]*' | head -1 | sed 's/^/BATT=/'`,
  `uptime | sed 's/^/UPTIME=/'`,
  `/usr/local/bin/tailscale status --json 2>/dev/null | grep -q '"BackendState": "Running"' && echo TAILSCALE=ok || echo TAILSCALE=down`,
  `${BRIDGE} status >/dev/null 2>&1 && echo BRIDGE=ok || echo BRIDGE=down`,
  `curl -s -m 2 http://127.0.0.1:9222/json/version >/dev/null && echo LIGHTPANDA=ok || echo LIGHTPANDA=down`,
].join("; ");

export function formatStatus(out: string): string {
  const kv: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const mm = line.match(/^([A-Z]+)=(.*)$/);
    if (mm) kv[mm[1]] = mm[2].trim();
  }
  const mark = (v?: string) => (v === "ok" ? "ok" : "down");
  return [
    "💻 Mac is online",
    `Battery: ${kv.BATT || "unknown"}`,
    `Uptime: ${(kv.UPTIME || "unknown").replace(/\s+/g, " ")}`,
    `Tailscale: ${mark(kv.TAILSCALE)}`,
    `Screen bridge: ${mark(kv.BRIDGE)}`,
    `Lightpanda: ${mark(kv.LIGHTPANDA)}`,
  ].join("\n");
}

function scpFromMac(remote: string, local: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("scp", ["-q", "-o", "ConnectTimeout=10", "-o", "BatchMode=yes", `mac:${remote}`, local],
      { timeout: 60_000 }, (err) => resolve(!err));
  });
}

async function takeShot(): Promise<{ file?: string; error?: string }> {
  const clear = await runOnLaptopDirect(`rm -f ${SHOT}; ${BRIDGE} status >/dev/null 2>&1 && echo BRIDGE_UP`);
  if (clear.code !== 0 && !clear.stdout) return { error: "Mac is offline." };
  if (!clear.stdout.includes("BRIDGE_UP")) return { error: "Screen bridge is down. It restarts by itself within a minute; try again." };
  // Typed into the bridge pane. Write to a temp file, then mv, so the wait below never sees half a file.
  const typed = `screencapture -x /tmp/tokyo-shot-raw.png && sips -Z 1600 -s format jpeg /tmp/tokyo-shot-raw.png --out /tmp/tokyo-shot.tmp.jpg >/dev/null && mv /tmp/tokyo-shot.tmp.jpg ${SHOT}; rm -f /tmp/tokyo-shot-raw.png`;
  const sent = await runOnLaptopDirect(`${BRIDGE} run ${shellQuote(typed)}`);
  if (sent.code !== 0) return { error: `Could not reach the screen bridge: ${(sent.stderr || sent.stdout).trim().slice(0, 200)}` };
  const wait = await runOnLaptopDirect(`for i in $(seq 1 20); do [ -s ${SHOT} ] && exit 0; sleep 1; done; exit 1`);
  if (wait.code !== 0) return { error: "Screenshot did not appear within 20 s (is the bridge pane busy?)." };
  const local = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tokyo-shot-")), "mac.jpg");
  if (!(await scpFromMac(SHOT, local))) return { error: "Could not copy the screenshot from the Mac." };
  return { file: local };
}

function askToRun(ctx: any, cmd: string) {
  const { id, blocked } = proposeLaptopCommand(null, ctx.chat.id, cmd);
  if (blocked) return ctx.reply(`❌ ${blocked}`);
  const kb = new InlineKeyboard().text("✅ Run", `laptop_yes:${id}`).text("❌ Cancel", `laptop_no:${id}`);
  return ctx.reply(`💻 Run on the Mac?\n\n${cmd}`, { reply_markup: kb });
}

export function registerMacCommand(bot: Bot, isOwner: (ctx: any) => boolean): void {
  bot.command(["mac", "laptop"], async (ctx: any) => {
    if (!isOwner(ctx)) { await ctx.reply("Unauthorized."); return; }
    const action = parseMacArgs(String(ctx.match ?? ""));
    switch (action.kind) {
      case "help":
        await ctx.reply(HELP);
        return;
      case "error":
        await ctx.reply(action.msg);
        return;
      case "status": {
        const r = await runOnLaptopDirect(STATUS_CMD);
        if (!r.stdout.includes("TAILSCALE=")) {
          await ctx.reply(`💻 Mac is offline or not answering.\n${r.stderr.trim().slice(0, 300)}`);
          return;
        }
        await ctx.reply(formatStatus(r.stdout));
        return;
      }
      case "shot": {
        await ctx.reply("📸 Taking a screenshot...");
        const r = await takeShot();
        if (r.error || !r.file) { await ctx.reply(`❌ ${r.error}`); return; }
        try {
          await ctx.replyWithPhoto(new InputFile(r.file), { caption: "Mac screen" });
        } finally {
          fs.rmSync(path.dirname(r.file), { recursive: true, force: true });
        }
        return;
      }
      case "open":
        await askToRun(ctx, openCommand(action.app));
        return;
      case "run":
        await askToRun(ctx, action.cmd);
        return;
    }
  });
}
