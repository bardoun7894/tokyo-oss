import type { Skill } from "./types";

const PROJECT_PATHS: Record<string, string> = {
  shopdemo: "/var/local/shopdemo-monorepo",
  erpdemo: "/var/local/erpdemo",
  billing: "/var/local/billing-admin",
  studio: "/var/local/studio-ai-studio",
  lab: "/var/local/lab-app",
  tokyo: "/root/tokyo",
  clinic: "/root/clinic-app",
};

const skill: Skill = {
  name: "deploy",
  description: "Full deployment: git pull, install, build, restart, health check",
  category: "devops",
  args: [
    { name: "project", type: "string", description: "Project name (shopdemo, erpdemo, tokyo, etc.)", required: true },
  ],
  async execute(ctx, args) {
    const projectPath = PROJECT_PATHS[args.project];
    if (!projectPath) {
      return { success: false, output: `Unknown project: ${args.project}. Available: ${Object.keys(PROJECT_PATHS).join(", ")}` };
    }

    const steps = [
      { label: "Git pull", cmd: `git -C ${projectPath} pull`, critical: false },
      { label: "Install dependencies", cmd: `cd ${projectPath} && npm install --production 2>&1 | tail -5`, critical: false },
      { label: "Build", cmd: `cd ${projectPath} && npm run build 2>&1 | tail -20`, critical: true },
      { label: "Restart (PM2)", cmd: `pm2 restart ${args.project} 2>/dev/null || echo "No PM2 process for ${args.project}"`, critical: false },
      { label: "Health check", cmd: `sleep 2 && pm2 show ${args.project} --no-color 2>/dev/null | head -15 || echo "Check manually"`, critical: false },
    ];

    const results: string[] = [];
    for (const step of steps) {
      await ctx.sendUpdate(`${step.label}...`);
      const result = await ctx.runCommand(step.cmd);
      const icon = result.code === 0 ? "+" : "x";
      const output = (result.stdout || result.stderr).trim().slice(0, 500);
      results.push(`${icon} *${step.label}*\n\`\`\`\n${output}\n\`\`\``);

      if (result.code !== 0 && step.critical) {
        results.push("Stopping deployment due to build failure.");
        return { success: false, output: results.join("\n\n") };
      }
    }

    return { success: true, output: results.join("\n\n") };
  },
};

export default skill;
