import type { Skill } from "./types";

const skill: Skill = {
  name: "health-check",
  description: "Server health: CPU, RAM, disk, Docker, PM2, ports",
  category: "devops",
  args: [],
  async execute(ctx) {
    await ctx.sendUpdate("Checking server health...");

    const checks = [
      { label: "System", cmd: "uptime && echo '---' && free -h && echo '---' && df -h / | tail -1" },
      { label: "CPU", cmd: "top -bn1 | head -5" },
      { label: "Docker", cmd: "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || echo 'Docker not running'" },
      { label: "PM2", cmd: "pm2 jlist 2>/dev/null | node -e \"const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));d.forEach(p=>console.log(p.name+': '+p.pm2_env.status+' (restarts: '+p.pm2_env.restart_time+', cpu: '+p.monit.cpu+'%, mem: '+Math.round(p.monit.memory/1024/1024)+'MB)'))\" 2>/dev/null || echo 'PM2 not running'" },
      { label: "Ports", cmd: "ss -tlnp | grep -E ':3000|:3030|:5000|:8000|:8080|:8317' || echo 'No matching ports'" },
    ];

    const parts: string[] = [];
    for (const check of checks) {
      const result = await ctx.runCommand(check.cmd);
      const output = (result.stdout || result.stderr).slice(0, 600).trim();
      parts.push(`*${check.label}:*\n\`\`\`\n${output}\n\`\`\``);
    }

    return { success: true, output: parts.join("\n\n") };
  },
};

export default skill;
