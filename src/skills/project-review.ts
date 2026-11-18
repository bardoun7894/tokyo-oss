import type { Skill } from "./types";
import { startAgent, getProjectNames } from "../agents";

const skill: Skill = {
  name: "project-review",
  description: "Code review a project using Claude Code agent",
  category: "devops",
  args: [
    { name: "project", type: "string", description: "Project name (shopdemo, erpdemo, tokyo, etc.)", required: true },
    { name: "focus", type: "string", description: "Optional focus area (security, performance, bugs, etc.)", required: false },
  ],
  async execute(ctx, args) {
    const project = args.project.toLowerCase();
    if (!getProjectNames().includes(project)) {
      return { success: false, output: `Unknown project: ${project}. Available: ${getProjectNames().join(", ")}` };
    }

    const focus = args.focus ? ` Focus on: ${args.focus}.` : "";
    const prompt = `Review the codebase for issues, bugs, security problems, and improvements. Give a summary of findings with file paths and line numbers.${focus}`;

    await ctx.sendUpdate(`Starting code review on *${project}*...`);

    return new Promise((resolve) => {
      try {
        const { sessionId } = startAgent(project, prompt, async (sid, result, success) => {
          // Also send the result directly to chat
          try {
            const header = `${success ? "+" : "x"} *Code Review — ${project}* (Agent #${sid})`;
            const output = result.length > 3500 ? result.slice(0, 3500) + "\n...(truncated)" : result;
            await ctx.bot.api.sendMessage(ctx.chatId, `${header}\n\n${output}`, { parse_mode: "Markdown" }).catch(() =>
              ctx.bot.api.sendMessage(ctx.chatId, `Code Review — ${project} (Agent #${sid})\n\n${output}`)
            );
          } catch {}
          resolve({ success, output: result.slice(0, 3500) });
        });
        // Don't wait for completion — return immediately since agent runs in background
        resolve({
          success: true,
          output: `Agent #${sessionId} started reviewing *${project}*. Results will be sent when done.`,
        });
      } catch (err: any) {
        resolve({ success: false, output: `Failed to start review: ${err.message}` });
      }
    });
  },
};

export default skill;
