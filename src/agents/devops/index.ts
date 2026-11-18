import type { Agent, AgentContext, AgentResult } from "../types";
import type { AgentEvent } from "../event-bus";
import * as db from "../../db";
import { runCommand, getServerStatus, getActiveClaudeSessions } from "../../shell";
import {
  startAgent, continueAgent, stopAgent, listSessions,
  getProjectNames, formatSessionList, getProjectPath,
} from "../../agents";
import { getSkillsPromptSection, executeSkill, listSkills, getSkill } from "../../skills";

const devopsAgent: Agent = {
  name: "devops",
  domain: "devops",
  description: "The owner's coding assistant and server manager — manages Claude Code agents, Pi, shell commands, deployments.",

  handles: [],

  keywords: [
    "agent", "server", "deploy", "docker", "pm2", "code", "fix", "bug",
    "build", "review", "shopdemo", "erpdemo", "billing", "studio", "clinic",
    "tokyo", "lab",
    // coding words
    "feature", "implement", "refactor", "test", "lint", "debug",
    // Arabic
    "صلح", "باغ", "خطأ", "كود", "برمج",
    // server/infra
    "cpu", "ram", "disk", "uptime", "logs", "nginx",
    // skills
    "skill", "backup", "health-check", "git-report", "weekly-plan",
    "deen-report", "shop-analytics", "project-review",
    // tools
    "pi", "expert", "laptop",
  ],

  commands: [
    "agent", "agents", "pi", "expert", "run", "server",
    "skills", "skill", "laptop",
  ],

  actions: [
    "run_command", "claude_task", "pi_task", "expert", "laptop_command", "skill",
  ],

  getSystemPromptSection(): string {
    const skillsSection = getSkillsPromptSection();
    return `## Server access
You have FULL shell access to the owner's VPS VPS (Ubuntu, 24GB RAM, 8 CPU). Use run_command for ANY server task the owner asks for.

### Project paths on the server:
- Tokyo (this app): /root/tokyo
- ShopDemo (startup): /var/local/shopdemo-monorepo (Next.js + Laravel)
- ErpDemo Platform: /var/local/erpdemo (React + Laravel + Gemini AI)
- Billing Admin: /var/local/billing-admin (Laravel + Filament + Firebase)
- Studio AI Studio: /var/local/studio-ai-studio (Next.js + Laravel + FastAPI)
- Lab App App: /var/local/lab-app (Flask + SQLAlchemy)

### Common commands:
- Server: uptime, free -h, df -h, top -bn1 | head -20
- Docker: docker ps, docker logs [container], docker stats --no-stream
- PM2: pm2 list, pm2 logs [app] --lines 20 --nostream
- Git: git -C /path/to/repo status, git -C /path/to/repo log --oneline -10, git -C /path/to/repo pull
- Project: cd /var/local/project && npm run build, docker-compose up -d
- Deploy: git pull && npm install && npm run build && pm2 restart [app]
- Logs: tail -50 /path/to/log, journalctl -u service --lines 30

### Safety:
- NEVER run: rm -rf /, drop database, format disk, or destructive operations
- NEVER use sqlite3 or run_command to query the life.db database — use the built-in actions instead
- ASK before: git push, docker-compose down, pm2 delete, database migrations
- OK without asking: git status, git log, npm run build, docker ps, pm2 logs, ls, cat

## Coding Actions
- {"type": "run_command", "command": "..."} — Execute a shell command on the server. Use for: checking server status, Docker, PM2, disk/CPU/RAM, logs, deployments, git operations, running scripts. Max 60s timeout. NEVER run destructive commands.
- {"type": "claude_task", "project": "shopdemo|erpdemo|billing|studio|lab|tokyo", "prompt": "..."} — Run Claude Code CLI in headless mode on a project to fix bugs, implement features, review code, or solve issues. Runs in background. Use when the owner says things like "fix the bug in shopdemo", "add dark mode to erpdemo", "review studio code". This spawns a full Claude Code agent that can read/edit files in the project.

## Coding Tools — Pi is DEFAULT

You have coding agents. **ALWAYS prefer pi_task** unless the task explicitly requires writing/changing code.

### pi_task — DEFAULT CHOICE (Pi agent)
Use for: checking code, verifying if something is implemented, code analysis, summaries, reviews, status checks, explaining code, project status, verifying client requests, reading files, checking git history.
Fast (1-3 min). This is your GO-TO tool for any code-related question.

- {"type":"pi_task","project":"clinic","prompt":"check if the appointment card redesign is implemented"}
- {"type":"pi_task","project":"shopdemo","prompt":"summarize recent changes"}

### claude_task — ONLY for writing code
Use ONLY when the owner explicitly asks to: fix a bug, add a feature, refactor code, implement something, deploy.
Slower (3-5 min). Makes actual code changes. Do NOT use for checking/reading/reviewing.

### expert — Specialized Analysis
Use for deep domain analysis. Available: code-review, debug, deploy-check, project-status, security-audit, client-update.

- {"type":"expert","expert":"code-review","project":"shopdemo"}
- {"type":"expert","expert":"debug","project":"clinic","context":"login page broken"}
- {"type":"expert","expert":"deploy-check","project":"billing"}
- {"type":"expert","expert":"client-update","project":"studio"}

### Decision rule:
- "check if X is done" → pi_task
- "is X implemented?" → pi_task
- "what's the status?" → pi_task
- "review the code" → pi_task or expert:code-review
- "fix the bug" / "صلح الباغ" → claude_task (actually changes code)
- "add feature" / "ضف ميزة" → claude_task (actually changes code)

Server projects: shopdemo, erpdemo, billing, studio, lab, tokyo
Remote projects (the owner's laptop via SSH): clinic

## Laptop Access
The owner's MacBook is connected via SSH tunnel. You can run commands on it:
- {"type":"laptop_command","command":"ls ~/clinic_app/clinic/lib"} — browse files
- {"type":"laptop_command","command":"git -C ~/clinic_app/clinic log --oneline -5"} — check git
- {"type":"laptop_command","command":"flutter --version"} — check tools

Use laptop_command when the owner asks about his laptop, files on his Mac, or anything that needs local access.
The clinic project is at ~/clinic_app/clinic on the laptop.
${skillsSection}`;
  },

  async getContextSection(): Promise<string> {
    const sections: string[] = [];

    // Agent sessions
    const sessions = db.getRecentAgentSessions(5);
    if (sessions.length === 0) {
      sections.push("### Agent Sessions (Tokyo-started)\nNo recent agent sessions.");
    } else {
      const sessionLines = sessions.map((s: any) => {
        const statusIcon = s.status === "running" ? "⏱" : s.status === "done" ? "✅" : s.status === "failed" ? "❌" : "🛑";
        const resultPreview = s.last_result ? s.last_result.slice(0, 200) : "no output yet";
        return `- ${statusIcon} #${s.id} ${s.project} (${s.status}, ${s.turns} turns) — last: "${resultPreview}"`;
      });
      sections.push(`### Agent Sessions (Tokyo-started)\n${sessionLines.join("\n")}`);
    }

    // Live Claude Code sessions
    try {
      const live = await getActiveClaudeSessions();
      if (live.length === 0) {
        sections.push("### Live Claude Code Sessions (terminal)\nNo Claude Code sessions running on server.");
      } else {
        const liveLines = live.map((s) =>
          `- PID ${s.pid} on ${s.project} (${s.cwd}) — running ${s.uptime} — ${s.cmd}`
        );
        sections.push(`### Live Claude Code Sessions (terminal)\n${liveLines.join("\n")}`);
      }
    } catch {
      sections.push("### Live Claude Code Sessions (terminal)\nUnable to check live sessions.");
    }

    return sections.join("\n\n");
  },

  async handleEvent(_event: AgentEvent, _ctx: AgentContext): Promise<AgentResult> {
    return { success: false, output: "DevOps agent does not handle events." };
  },

  async handleCommand(command: string, args: string, ctx: AgentContext): Promise<AgentResult> {
    switch (command) {
      case "agent":
        return handleAgentCommand(args, ctx);
      case "agents":
        return handleAgentsCommand();
      case "pi":
        return handlePiCommand(args, ctx);
      case "expert":
        return handleExpertCommand(args, ctx);
      case "run":
        return handleRunCommand(args);
      case "server":
        return handleServerCommand();
      case "skills":
        return handleSkillsCommand();
      case "skill":
        return handleSkillCommand(args, ctx);
      case "laptop":
        return handleLaptopCommand(args, ctx);
      default:
        return { success: false, output: `Unknown command: ${command}` };
    }
  },

  async handleAction(action: Record<string, any>, ctx: AgentContext): Promise<string | void> {
    switch (action.type) {
      case "run_command":
        return handleRunCommandAction(action);
      case "claude_task":
        return handleClaudeTaskAction(action, ctx);
      case "pi_task":
        return handlePiTaskAction(action, ctx);
      case "expert":
        return handleExpertAction(action, ctx);
      case "laptop_command":
        return handleLaptopCommandAction(action);
      case "skill":
        return handleSkillAction(action, ctx);
    }
  },
};

// ==================
// Command Handlers
// ==================

async function handleAgentCommand(args: string, ctx: AgentContext): Promise<AgentResult> {
  const input = args.trim();
  if (!input) {
    return {
      success: true,
      output:
        `🤖 *Agent Orchestrator*\n\n` +
        `Run Claude Code agents on your projects:\n\n` +
        `/agent [project] [task] — start or continue session\n` +
        `/agents — list all sessions\n` +
        `/agent stop [id] — stop a running session\n\n` +
        `Projects: ${getProjectNames().join(", ")}\n\n` +
        `*Examples:*\n` +
        `  /agent shopdemo fix the login bug\n` +
        `  /agent shopdemo now add tests for it\n` +
        `  /agent erpdemo add dark mode\n` +
        `  /agent stop 1`,
    };
  }

  // Handle /agent stop [id]
  if (input.startsWith("stop")) {
    const id = parseInt(input.replace("stop", "").trim());
    if (!id) return { success: false, output: "Usage: /agent stop [session_id]" };
    const stopped = stopAgent(id);
    return {
      success: true,
      output: stopped ? `🛑 Agent #${id} stopped.` : `Agent #${id} not found or not running.`,
    };
  }

  const parts = input.split(/\s+/);
  const project = parts[0].toLowerCase();
  const prompt = parts.slice(1).join(" ") || "Check the project for issues and fix them";

  if (!getProjectNames().includes(project)) {
    return {
      success: false,
      output: `Unknown project: *${project}*\n\nAvailable: ${getProjectNames().join(", ")}`,
    };
  }

  try {
    const { sessionId, isNewSession } = startAgent(project, prompt, async (sid, result, success) => {
      const icon = success ? "✅" : "❌";
      const header = `${icon} *Agent #${sid} — ${project}*\n\n`;
      try {
        if (result.length > 3500) {
          await ctx.sendMessage(header + result.slice(0, 3500));
          if (result.length > 3500) {
            await ctx.sendMessage(result.slice(3500, 7000));
          }
        } else {
          await ctx.sendMessage(header + result);
        }
      } catch {
        await ctx.sendMessage(`Agent #${sid} (${project}): ${result.slice(0, 4000)}`);
      }
    });

    const action = isNewSession ? "Started" : "Continued";
    return {
      success: true,
      output:
        `🤖 *Agent #${sessionId} ${action}* on *${project}*\n\n` +
        `_"${prompt}"_\n\n` +
        `Running in background — I'll send the result when done.`,
    };
  } catch (err: any) {
    return { success: false, output: `❌ Failed: ${err.message}` };
  }
}

function handleAgentsCommand(): AgentResult {
  const sessions = listSessions(10);
  const list = formatSessionList(sessions);
  return { success: true, output: `🤖 *Agent Sessions:*\n\n${list}` };
}

async function handlePiCommand(args: string, ctx: AgentContext): Promise<AgentResult> {
  const input = args.trim();
  if (!input) {
    const projects = getProjectNames();
    return { success: true, output: `🔍 *Claude Task*\nUsage: /pi [project] [prompt]\n\nProjects: ${projects.join(", ")}` };
  }

  const parts = input.split(/\s+/);
  const project = parts[0].toLowerCase();
  const prompt = parts.slice(1).join(" ") || "Check the project for issues and give a status report";

  await ctx.sendMessage(`🔍 Running Claude task on *${project}*...`);

  try {
    const { runClaudeTask } = await import("../../claude-tasks");
    const { result, success } = await runClaudeTask(project, prompt);
    const icon = success ? "🔍" : "❌";
    return { success, output: `${icon} *Claude Task — ${project}*\n\n${result.slice(0, 3500)}` };
  } catch (err: any) {
    return { success: false, output: `❌ Claude task failed: ${err.message}` };
  }
}

async function handleExpertCommand(args: string, ctx: AgentContext): Promise<AgentResult> {
  const input = args.trim();
  if (!input) {
    const { listExperts } = await import("../../experts");
    const experts = listExperts();
    const list = experts.map(e => `  *${e.name}* — ${e.description}`).join("\n");
    return {
      success: true,
      output:
        `🧠 *Expert Agents*\n\n` +
        `/expert [name] [project] [context]\n\n` +
        `Available:\n${list}\n\n` +
        `Projects: ${getProjectNames().join(", ")}\n\n` +
        `*Examples:*\n` +
        `  /expert code-review shopdemo\n` +
        `  /expert debug clinic login page broken\n` +
        `  /expert deploy-check billing\n` +
        `  /expert client-update studio`,
    };
  }

  const parts = input.split(/\s+/);
  const expertName = parts[0].toLowerCase();
  const project = (parts[1] || "").toLowerCase();
  const context = parts.slice(2).join(" ") || undefined;

  if (!project) {
    return { success: false, output: `Usage: /expert ${expertName} [project] [context]` };
  }

  try {
    const { runExpert } = await import("../../experts");
    runExpert(expertName, project, context).then(async ({ result, success, expert }) => {
      const icon = success ? "🧠" : "❌";
      const truncated = result.length > 3500 ? result.slice(0, 3500) + "\n...(truncated)" : result;
      try {
        await ctx.sendMessage(`${icon} *${expert} — ${project}*\n\n${truncated}`);
      } catch {
        await ctx.sendMessage(`${icon} ${expert} (${project}):\n\n${truncated}`);
      }
    });

    return {
      success: true,
      output: `🧠 *${expertName}* analyzing *${project}*...${context ? `\n_"${context}"_` : ""}`,
    };
  } catch (err: any) {
    return { success: false, output: `❌ Expert failed: ${err.message}` };
  }
}

async function handleRunCommand(args: string): Promise<AgentResult> {
  const cmd = args.trim();
  if (!cmd) {
    return { success: false, output: "Usage: /run [command]\n\nExample: /run docker ps" };
  }
  const result = await runCommand(cmd);
  const output = result.stdout || result.stderr || "(no output)";
  const prefix = result.code === 0 ? "✅" : `❌ Exit code: ${result.code}`;
  return { success: true, output: `${prefix}\n\`\`\`\n${output}\n\`\`\`` };
}

async function handleServerCommand(): Promise<AgentResult> {
  const status = await getServerStatus();
  return { success: true, output: `🖥 *Server Status*\n\n${status}` };
}

function handleSkillsCommand(): AgentResult {
  const skills = listSkills();
  if (skills.length === 0) {
    return { success: true, output: "No skills loaded." };
  }
  const byCategory = new Map<string, typeof skills>();
  for (const s of skills) {
    const list = byCategory.get(s.category) || [];
    list.push(s);
    byCategory.set(s.category, list);
  }
  let msg = "⚡ *Available Skills:*\n\n";
  for (const [cat, items] of byCategory) {
    msg += `*${cat.toUpperCase()}*\n`;
    for (const s of items) {
      const argsStr = s.args.filter(a => a.required).map(a => a.name).join(", ");
      msg += `  \`${s.name}\`${argsStr ? ` [${argsStr}]` : ""} — ${s.description}\n`;
    }
    msg += "\n";
  }
  msg += "Run: `/skill <name> [args]`";
  return { success: true, output: msg };
}

async function handleSkillCommand(args: string, ctx: AgentContext): Promise<AgentResult> {
  const input = args.trim();
  if (!input) {
    return { success: false, output: "Usage: /skill <name> [args]\n\nSee /skills for available skills." };
  }
  const parts = input.split(/\s+/);
  const name = parts[0];
  const skill = getSkill(name);
  if (!skill) {
    return { success: false, output: `Unknown skill: *${name}*\n\nUse /skills to see available skills.` };
  }
  const skillArgs: Record<string, any> = {};
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].includes("=")) {
      const [k, ...v] = parts[i].split("=");
      skillArgs[k] = v.join("=");
    } else if (skill.args[i - 1]) {
      skillArgs[skill.args[i - 1].name] = parts[i];
    }
  }
  await ctx.sendMessage(`⚡ Running skill: *${name}*...`);
  const result = await executeSkill(name, skillArgs, ctx.bot, ctx.chatId);
  return {
    success: result.success,
    output: `${result.success ? "✅" : "❌"} *${name}*\n\n${result.output}`,
  };
}

async function handleLaptopCommand(args: string, ctx: AgentContext): Promise<AgentResult> {
  return {
    success: false,
    output: `💻 Laptop connectivity is not available on this server.`,
  };
}

// ==================
// Action Handlers
// ==================

async function handleRunCommandAction(action: Record<string, any>): Promise<string> {
  const result = await runCommand(action.command);
  const output = result.stdout || result.stderr || "(no output)";
  const status = result.code === 0 ? "✅" : `❌ (exit ${result.code})`;
  return `\n\`\`\`\n$ ${action.command}\n${output}\n\`\`\`\n${status}`;
}

async function handleClaudeTaskAction(action: Record<string, any>, ctx: AgentContext): Promise<string> {
  const project = action.project || "tokyo";
  const prompt = action.prompt || "Check the project for issues and fix them";

  try {
    const { sessionId, isNewSession } = startAgent(project, prompt, (sid, result) => {
      db.saveConversation("assistant", `🤖 Agent #${sid} (${project}) result:\n\n${result.slice(0, 3000)}`);
      // Send result to Telegram
      const truncated = result.length > 3500 ? result.slice(0, 3500) + "\n...(truncated)" : result;
      ctx.sendMessage(`🤖 *Agent #${sid} — ${project}*\n\n${truncated}`).catch(() => {
        ctx.sendMessage(`Agent #${sid} (${project}):\n\n${truncated}`).catch(() => {});
      });
    });
    const verb = isNewSession ? "Started" : "Continued";
    return `🤖 ${verb} Agent #${sessionId} on *${project}*: "${prompt.slice(0, 100)}"\n\nRunning in background.`;
  } catch (err: any) {
    return `❌ Failed to start agent: ${err.message}`;
  }
}

async function handlePiTaskAction(action: Record<string, any>, ctx: AgentContext): Promise<string> {
  const project = action.project || "tokyo";
  const prompt = action.prompt || "Check the project for issues";

  try {
    const { runClaudeTask } = await import("../../claude-tasks");
    const { result, success } = await runClaudeTask(project, prompt);
    const icon = success ? "🔍" : "❌";
    return `${icon} *Claude Task — ${project}*\n\n${result.slice(0, 3500)}`;
  } catch (err: any) {
    return `❌ Claude task failed: ${err.message}`;
  }
}

async function handleExpertAction(action: Record<string, any>, ctx: AgentContext): Promise<string> {
  const { runExpert: runExp } = await import("../../experts");
  const expertName = action.expert || "project-status";
  const project = action.project || "tokyo";
  const context = action.context;

  try {
    // Run expert in background, send result when done
    runExp(expertName, project, context).then(({ result, success, expert }) => {
      const icon = success ? "🧠" : "❌";
      db.saveConversation("assistant", `${icon} Expert ${expert} (${project}):\n\n${result.slice(0, 3000)}`);
      const truncated = result.length > 3500 ? result.slice(0, 3500) + "\n...(truncated)" : result;
      ctx.sendMessage(`${icon} *${expert} — ${project}*\n\n${truncated}`).catch(() => {
        ctx.sendMessage(`${icon} ${expert} (${project}):\n\n${truncated}`).catch(() => {});
      });
    });
    return `🧠 Expert *${expertName}* analyzing *${project}*... Results coming soon.`;
  } catch (err: any) {
    return `❌ Failed to start expert: ${err.message}`;
  }
}

async function handleLaptopCommandAction(action: Record<string, any>): Promise<string> {
  return `💻 Laptop connectivity is not available on this server.`;
}

async function handleSkillAction(action: Record<string, any>, ctx: AgentContext): Promise<string> {
  const result = await executeSkill(action.name, action.args || {}, ctx.bot, ctx.chatId);
  return `\n${result.success ? "✅" : "❌"} *${action.name}*\n${result.output}`;
}

export default devopsAgent;
