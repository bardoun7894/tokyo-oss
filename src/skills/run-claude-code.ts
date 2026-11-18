import type { Skill } from "./types";
import { runClaudeNow } from "../claude-runner";
import { matchProject, getProject, listProjectNames } from "../project-registry";

const skill: Skill = {
  name: "run-claude-code",
  description:
    "Drive Claude Code inside a project to implement a task (fix, feature, refactor). Pick the project by canonical name OR by a WhatsApp client/group name (auto-matched). Starts immediately in a herdr workspace and asks before anything is deployed.",
  category: "devops",
  args: [
    {
      name: "project",
      type: "string",
      description: `Project name (canonical or WA alias). Known: ${listProjectNames().join(", ")}`,
      required: true,
    },
    {
      name: "prompt",
      type: "string",
      description: "The task/prompt to send to Claude Code (what to build, fix, or change)",
      required: true,
    },
    {
      name: "reason",
      type: "string",
      description: "Short why-now reason shown when the run starts",
      required: false,
      default: "",
    },
  ],
  async execute(ctx, args) {
    const projectInput = String(args.project || "").trim();
    const prompt = String(args.prompt || "").trim();
    if (!projectInput) return { success: false, output: "project is required" };
    if (!prompt) return { success: false, output: "prompt is required" };

    const project = getProject(projectInput) || matchProject(projectInput);
    if (!project) {
      return {
        success: false,
        output: `No project matched "${projectInput}". Known: ${listProjectNames().join(", ")}`,
      };
    }

    const reason = String(args.reason || "").trim();
    runClaudeNow(ctx.bot, ctx.chatId, project, prompt, reason || "asked on Telegram");

    return {
      success: true,
      output: `Started Claude in ${project.name} (${project.location}) in a herdr workspace. Progress and the result come as Telegram messages; nothing deploys until you press Deploy.`,
    };
  },
};

export default skill;
