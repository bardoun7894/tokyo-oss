import { spawn } from "child_process";
import * as db from "./db";
import { logAgentActivity } from "./auto_log";
import { PROJECTS, getProject } from "./project-registry";
import { buildInvocation, type AgentTarget, type Harness } from "./agent-harness";

// On startup: mark any "running" sessions as failed (process died on restart)
try {
  const stuck = db.getRecentAgentSessions(50).filter((s: any) => s.status === "running");
  for (const s of stuck) {
    db.updateAgentSession(s.id, { status: "failed", last_result: "Process lost (server restarted)" });
  }
  if (stuck.length > 0) console.log(`🤖 Cleaned ${stuck.length} stuck agent sessions`);
} catch {}

const PROJECT_PATHS: Record<string, string> = {
  shopdemo: "/var/local/shopdemo-monorepo",
  erpdemo: "/var/local/erpdemo",
  billing: "/var/local/billing-admin",
  studio: "/var/local/studio-ai-studio",
  lab: "/var/local/lab-app",
  tokyo: "/root/tokyo",
  hermes: "/root/.hermes/workspace",
  // laptop projects (clinic, up, ...) come from project-registry.ts and run via dsh over ssh
};

const MAX_OUTPUT = 3500; // Telegram message limit
// zen is one model call; dsh is a coding agent that may run tests and edit files.
const TIMEOUT_MS: Record<Harness, number> = {
  zen: 5 * 60 * 1000,
  dsh: 30 * 60 * 1000,
};

type OnComplete = (sessionId: number, result: string, success: boolean) => void;

// Track running processes
const runningProcesses = new Map<number, { pid: number; kill: () => void }>();

export function getProjectPath(project: string): string | null {
  return resolveTarget(project)?.path ?? null;
}

export function getProjectNames(): string[] {
  return [...new Set([...Object.keys(PROJECT_PATHS), ...PROJECTS.map((p) => p.name)])];
}

/** Server paths above win; anything else is looked up in the project registry. */
function resolveTarget(project: string): AgentTarget | null {
  const name = project.toLowerCase();
  if (PROJECT_PATHS[name]) return { name, location: "server", path: PROJECT_PATHS[name] };
  const ref = getProject(name);
  return ref ? { name: ref.name, location: ref.location, path: ref.path } : null;
}

export function startAgent(
  project: string,
  prompt: string,
  onComplete: OnComplete,
  harness: Harness = "zen",
): { sessionId: number; isNewSession: boolean } {
  const target = resolveTarget(project);
  if (!target) throw new Error(`Unknown project: ${project}`);
  // Refuse an impossible pairing (zen on a laptop project) before a session row exists.
  buildInvocation(target, harness, prompt);

  // Check if there's already a session for this project — continue it
  const existing = db.getActiveAgentForProject(target.name);
  if (existing) {
    const turn = (existing.turns || 0) + 1;
    db.updateAgentSession(existing.id, { turns: turn });
    runAgent(existing.id, target, prompt, harness, onComplete);
    return { sessionId: existing.id, isNewSession: false };
  }

  const sessionId = db.createAgentSession(target.name, target.path, prompt);
  runAgent(sessionId, target, prompt, harness, onComplete);
  return { sessionId, isNewSession: true };
}

export function continueAgent(
  sessionId: number,
  prompt: string,
  onComplete: OnComplete
): boolean {
  const session = db.getAgentSession(sessionId);
  if (!session) return false;

  const target = resolveTarget(session.project) ?? { name: session.project, location: "server", path: session.project_path };
  const turn = (session.turns || 0) + 1;
  db.updateAgentSession(sessionId, { status: "running", turns: turn });
  runAgent(sessionId, target, prompt, "zen", onComplete);
  return true;
}

export function stopAgent(sessionId: number): boolean {
  const proc = runningProcesses.get(sessionId);
  if (proc) {
    proc.kill();
    runningProcesses.delete(sessionId);
    db.updateAgentSession(sessionId, { status: "stopped", last_result: "Stopped by user" });
    return true;
  }
  db.updateAgentSession(sessionId, { status: "stopped" });
  return false;
}

export function listSessions(limit = 10) {
  return db.getRecentAgentSessions(limit);
}

function runAgent(
  sessionId: number,
  target: AgentTarget,
  prompt: string,
  harness: Harness,
  onComplete: OnComplete
) {
  // zen is a bare model call, so it gets Tokyo's context injected. dsh reads the
  // project itself and should not receive the owner's private Tokyo data.
  let fullPrompt = prompt;
  if (harness === "zen") {
    try {
      const { buildTokyoContext } = require("./claude-tasks");
      fullPrompt = buildTokyoContext() + "\n\n" + prompt;
    } catch {}
  }

  const inv = buildInvocation(target, harness, fullPrompt);
  const timeoutMs = TIMEOUT_MS[harness];
  const timeoutLabel = `${Math.round(timeoutMs / 60000)} minutes`;

  console.log(`🤖 Agent #${sessionId}: ${harness} on ${target.name} (${target.location}) "${prompt.slice(0, 60)}..."`);

  let output = "";
  let killed = false;

  const proc = spawn(inv.command, inv.args, {
    cwd: inv.cwd,
    env: { ...process.env, HOME: "/root" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });

  db.updateAgentSession(sessionId, { pid: proc.pid || 0 });

  runningProcesses.set(sessionId, {
    pid: proc.pid || 0,
    kill: () => { killed = true; proc.kill("SIGTERM"); },
  });

  proc.stdout.on("data", (data) => {
    output += data.toString();
    // Cap output to prevent memory issues
    if (output.length > 50000) {
      output = output.slice(-50000);
    }
  });

  // dsh streams its reasoning to stderr; keep it out of the Telegram report.
  proc.stderr.on("data", (data) => {
    if (harness === "zen") output += data.toString();
  });

  // Timeout handler
  const timer = setTimeout(() => {
    if (!killed) {
      killed = true;
      proc.kill("SIGTERM");
      db.updateAgentSession(sessionId, {
        status: "timeout",
        last_result: output.slice(-MAX_OUTPUT) || `Timed out after ${timeoutLabel}`,
      });
      runningProcesses.delete(sessionId);
      onComplete(sessionId, `⏰ Agent timed out after ${timeoutLabel}. Partial output:\n\n` + output.slice(-2000), false);
    }
  }, timeoutMs);

  proc.on("close", (code) => {
    clearTimeout(timer);
    runningProcesses.delete(sessionId);

    if (killed) return; // Already handled

    const trimmed = output.length > MAX_OUTPUT
      ? output.slice(-MAX_OUTPUT) + "\n...(output truncated)"
      : output;

    const success = code === 0;
    const status = success ? "done" : "failed";

    db.updateAgentSession(sessionId, {
      status,
      last_result: trimmed,
    });

    console.log(`🤖 Agent #${sessionId} ${status} (exit=${code}, ${output.length} chars)`);
    if (success) {
      const agentSession = db.getAgentSession(sessionId);
      if (agentSession) {
        const durationMinutes = (Date.now() - new Date(agentSession.started_at).getTime()) / 60000;
        logAgentActivity(agentSession.project, durationMinutes, trimmed);
      }
    }
    onComplete(sessionId, trimmed, success);
  });

  proc.on("error", (err) => {
    clearTimeout(timer);
    runningProcesses.delete(sessionId);
    db.updateAgentSession(sessionId, { status: "failed", last_result: err.message });
    onComplete(sessionId, `❌ Agent error: ${err.message}`, false);
  });
}

export function formatSessionList(sessions: any[]): string {
  if (sessions.length === 0) return "No agent sessions.";

  const statusIcon: Record<string, string> = {
    running: "⏱",
    done: "✅",
    failed: "❌",
    stopped: "🛑",
    timeout: "⏰",
  };

  return sessions.map((s) => {
    const icon = statusIcon[s.status] || "❓";
    const age = timeSince(s.updated_at);
    return `${icon} #${s.id} *${s.project}* — ${s.status} (${s.turns} turn${s.turns > 1 ? "s" : ""}, ${age})`;
  }).join("\n");
}

function timeSince(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}


// [item 3] Hermes persona run — Telegram -> Hermes acts, via the working Claude
// subscription (the official `claude` CLI), reusing the same background runner as
// /agent. Routed through Tokyo's single poller; no second Telegram poller.
const HERMES_PREAMBLE = [
  "You are Hermes, the owner's autonomous agent running as root on the host server.",
  "You have full shell access and the dev-stack skills under /root/.claude/skills.",
  "Act on the request directly and safely, then report back concisely in plain text.",
  "If the task is destructive or ambiguous, do the safe read-only part first and say what you'd need to proceed.",
  "",
  "TASK: ",
].join("\n");

export function startHermes(prompt: string, onComplete: OnComplete): { sessionId: number; isNewSession: boolean } {
  return startAgent("hermes", HERMES_PREAMBLE + prompt, onComplete);
}
