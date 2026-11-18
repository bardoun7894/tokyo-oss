import { InlineKeyboard } from "grammy";
import type { Skill } from "./types";
import { proposeLaptopCommand } from "../laptop-bridge";

const skill: Skill = {
  name: "run-on-laptop",
  description:
    "Run a shell command on the user's Mac laptop over Tailscale SSH. Requires Telegram confirmation (inline Run/Cancel buttons). Use for: opening apps, inspecting local folders, running CLIs like opencode/claude, reading/writing files on the Mac.",
  category: "devops",
  args: [
    { name: "command", type: "string", description: "Shell command to run on the Mac", required: true },
    {
      name: "reason",
      type: "string",
      description: "One-line reason shown in the confirmation prompt",
      required: false,
      default: "",
    },
  ],
  async execute(ctx, args) {
    const cmd = String(args.command || "").trim();
    if (!cmd) return { success: false, output: "command is required" };

    const { id, blocked } = proposeLaptopCommand(ctx.bot, ctx.chatId, cmd);
    if (blocked) return { success: false, output: blocked };

    const keyboard = new InlineKeyboard()
      .text("✅ Run", `laptop_yes:${id}`)
      .text("❌ Cancel", `laptop_no:${id}`);

    const reasonLine = args.reason ? `\n_${args.reason}_\n` : "";
    const text = `🔐 *Run on laptop?*${reasonLine}\n\`\`\`\n${cmd}\n\`\`\`\n\n_(expires in 5 min)_`;
    await ctx.bot.api
      .sendMessage(ctx.chatId, text, { parse_mode: "Markdown", reply_markup: keyboard })
      .catch(async () => {
        await ctx.bot.api.sendMessage(ctx.chatId, text.replace(/[*_`]/g, ""), {
          reply_markup: keyboard,
        });
      });

    return {
      success: true,
      output: `Confirmation sent to Telegram (id: ${id}). Awaiting approval.`,
    };
  },
};

export default skill;
