import type { Skill } from "./types";

const skill: Skill = {
  name: "backup",
  description: "Backup SQLite database and .env config",
  category: "system",
  args: [],
  async execute(ctx) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupDir = "/root/backups";

    const steps = [
      { label: "Create backup directory", cmd: `mkdir -p ${backupDir}` },
      { label: "Backup database", cmd: `cp /root/tokyo/life.db ${backupDir}/life-${timestamp}.db` },
      { label: "Backup .env", cmd: `cp /root/tokyo/.env ${backupDir}/env-${timestamp}.bak` },
      { label: "Cleanup old backups (keep 10)", cmd: `ls -t ${backupDir}/life-*.db 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null; echo "Done"` },
      { label: "Verify", cmd: `ls -lh ${backupDir}/life-${timestamp}.db` },
    ];

    const results: string[] = [];
    for (const step of steps) {
      await ctx.sendUpdate(`${step.label}...`);
      const r = await ctx.runCommand(step.cmd);
      const icon = r.code === 0 ? "+" : "x";
      results.push(`${icon} ${step.label}: ${(r.stdout || r.stderr).trim().slice(0, 200)}`);
    }

    return { success: true, output: `\`\`\`\n${results.join("\n")}\n\`\`\`` };
  },
};

export default skill;
