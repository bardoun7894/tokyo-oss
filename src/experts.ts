import { getProjectNames } from "./agents";

export interface Expert {
  name: string;
  description: string;
  systemPrompt: string;
}

const EXPERTS: Record<string, Expert> = {
  "code-review": {
    name: "Code Review",
    description: "Review recent changes for bugs, security issues, and code quality",
    systemPrompt: `You are a senior code reviewer. Review the recent changes in this project:
1. Run: git diff HEAD~3 to see recent changes
2. Check for bugs, security issues, edge cases, code quality
3. Give a concise report: what's good, what needs fixing, severity
Keep it actionable — no fluff.`,
  },
  "debug": {
    name: "Debug Expert",
    description: "Analyze errors, read logs, identify root cause",
    systemPrompt: `You are a debugging expert. Analyze the issue described:
1. Read relevant source files
2. Check for recent error patterns in the code
3. Identify root cause
4. Suggest a specific fix with code
Be precise — point to exact files and lines.`,
  },
  "deploy-check": {
    name: "Deploy Readiness",
    description: "Check if project is ready to deploy — build, errors, configs",
    systemPrompt: `You are a deployment engineer. Check if this project is ready to deploy:
1. Run the build command (npm run build, tsc, etc.)
2. Check for compilation errors
3. Verify config files (.env.example vs .env, etc.)
4. Check git status — uncommitted changes?
5. Report: READY or NOT READY with blockers`,
  },
  "project-status": {
    name: "Project Status",
    description: "Analyze project health — recent commits, code state, open issues",
    systemPrompt: `You are a project analyst. Give a status report:
1. Run: git log --oneline -10 to see recent activity
2. Check package.json for dependencies and scripts
3. Look at the main source structure
4. Report: what was done recently, what seems in progress, what might be stale
Keep it concise — bullet points, not paragraphs.`,
  },
  "security-audit": {
    name: "Security Audit",
    description: "Check for exposed secrets, SQL injection, XSS, auth problems",
    systemPrompt: `You are a security auditor. Audit this project:
1. Check for hardcoded secrets, API keys, passwords in source files
2. Check for SQL injection vulnerabilities (raw queries without parameterization)
3. Check for XSS risks (unescaped user input in templates)
4. Check auth/session handling
5. Check .gitignore — are secrets excluded?
Report findings with severity: CRITICAL, HIGH, MEDIUM, LOW.`,
  },
  "client-update": {
    name: "Client Update",
    description: "Generate a client-friendly progress report",
    systemPrompt: `You are a project manager writing an update for the client. Generate a SHORT, professional progress update:
1. Check git log for recent work
2. Summarize what's DONE (completed features/fixes)
3. What's IN PROGRESS
4. What's NEXT
Write in simple language — no technical jargon. 5-8 lines max.
Output in both Arabic and English.`,
  },
};

export function getExpert(name: string): Expert | null {
  return EXPERTS[name.toLowerCase()] || null;
}

export function listExperts(): { name: string; description: string }[] {
  return Object.entries(EXPERTS).map(([key, expert]) => ({
    name: key,
    description: expert.description,
  }));
}

export async function runExpert(
  expertName: string,
  project: string,
  context?: string,
): Promise<{ result: string; success: boolean; expert: string }> {
  const expert = getExpert(expertName);
  if (!expert) {
    return {
      result: `Unknown expert: ${expertName}\n\nAvailable: ${Object.keys(EXPERTS).join(", ")}`,
      success: false,
      expert: expertName,
    };
  }

  const projects = getProjectNames();
  if (!projects.includes(project.toLowerCase())) {
    return {
      result: `Unknown project: ${project}\n\nAvailable: ${projects.join(", ")}`,
      success: false,
      expert: expertName,
    };
  }

  const prompt = context
    ? `${expert.systemPrompt}\n\nAdditional context: ${context}`
    : expert.systemPrompt;

  try {
    const { runClaudeTask } = await import("./claude-tasks");
    const { result, success } = await runClaudeTask(project, prompt);
    return { result, success, expert: expert.name };
  } catch (err: any) {
    return { result: `Expert failed: ${err.message}`, success: false, expert: expert.name };
  }
}
