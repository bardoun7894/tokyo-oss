import type { Skill } from "./types";

const PROJECTS: Record<string, string> = {
  tokyo: "/root/tokyo",
  shopdemo: "/var/local/shopdemo-monorepo",
  erpdemo: "/var/local/erpdemo",
  billing: "/var/local/billing-admin",
  studio: "/var/local/studio-ai-studio",
  lab: "/var/local/lab-app",
  clinic: "/root/clinic-app",
};

const skill: Skill = {
  name: "git-report",
  description: "Git activity across all projects (recent commits, changes)",
  category: "analytics",
  args: [
    { name: "days", type: "number", description: "Days to look back (default 7)", required: false, default: 7 },
  ],
  async execute(ctx, args) {
    const days = args.days || 7;
    await ctx.sendUpdate(`Scanning git activity (last ${days} days)...`);

    const results: string[] = [];
    for (const [name, path] of Object.entries(PROJECTS)) {
      const { stdout: log, code } = await ctx.runCommand(
        `git -C ${path} log --oneline --since="${days} days ago" --all 2>/dev/null | head -10`
      );
      if (code !== 0 || !log.trim()) {
        results.push(`*${name}*: No recent activity`);
        continue;
      }
      const { stdout: branch } = await ctx.runCommand(`git -C ${path} branch --show-current 2>/dev/null`);
      const { stdout: status } = await ctx.runCommand(`git -C ${path} status --short 2>/dev/null | head -5`);
      const commitCount = log.trim().split("\n").length;
      let entry = `*${name}* (${branch.trim()}) — ${commitCount} commit${commitCount > 1 ? "s" : ""}\n\`\`\`\n${log.trim()}\n\`\`\``;
      if (status.trim()) {
        entry += `\nUncommitted:\n\`\`\`\n${status.trim()}\n\`\`\``;
      }
      results.push(entry);
    }

    return { success: true, output: results.join("\n\n") };
  },
};

export default skill;
