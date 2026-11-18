import { exec } from "child_process";

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 4000;

// Commands that are too dangerous even for the owner
const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\/\s*$/,
  /rm\s+-rf\s+\/root\s*$/,
  /rm\s+-rf\s+\/var\s*$/,
  /mkfs\./,
  /dd\s+if=.*of=\/dev\//,
  /:(){ :\|:& };:/,
  /shutdown/,
  /reboot$/,
  /halt$/,
  /init\s+0/,
];

export function runCommand(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return Promise.resolve({ stdout: "", stderr: "Blocked: dangerous command.", code: 1 });
    }
  }

  return new Promise((resolve) => {
    exec(command, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024, shell: "/bin/bash" }, (error, stdout, stderr) => {
      const trimOut = stdout.length > MAX_OUTPUT ? stdout.slice(0, MAX_OUTPUT) + "\n... (truncated)" : stdout;
      const trimErr = stderr.length > MAX_OUTPUT ? stderr.slice(0, MAX_OUTPUT) + "\n... (truncated)" : stderr;
      resolve({
        stdout: trimOut,
        stderr: trimErr,
        code: error?.code ?? 0,
      });
    });
  });
}

export async function getActiveClaudeSessions(): Promise<{ pid: number; cwd: string; project: string; cmd: string; uptime: string }[]> {
  try {
    const { stdout } = await runCommand(`ps aux | grep "[c]laude" | grep -v "grep"`);
    if (!stdout.trim()) return [];

    const sessions: { pid: number; cwd: string; project: string; cmd: string; uptime: string }[] = [];
    const lines = stdout.trim().split("\n");

    for (const line of lines) {
      const parts = line.split(/\s+/);
      const pid = parseInt(parts[1]);
      if (!pid) continue;

      // Get working directory
      let cwd = "unknown";
      try {
        const { stdout: cwdOut } = await runCommand(`readlink -f /proc/${pid}/cwd 2>/dev/null`);
        cwd = cwdOut.trim() || "unknown";
      } catch {}

      // Get uptime
      const { stdout: etimeOut } = await runCommand(`ps -o etime= -p ${pid} 2>/dev/null`);
      const uptime = etimeOut.trim() || "?";

      // Map path to project name
      const cmd = parts.slice(10).join(" ");
      let project = "unknown";
      if (cwd.includes("shopdemo")) project = "shopdemo";
      else if (cwd.includes("erpdemo")) project = "erpdemo";
      else if (cwd.includes("billing")) project = "billing";
      else if (cwd.includes("studio")) project = "studio";
      else if (cwd.includes("lab-Chemical")) project = "lab";
      else if (cwd.includes("tokyo")) project = "tokyo";
      else if (cwd.includes("clinic")) project = "clinic";

      sessions.push({ pid, cwd, project, cmd: cmd.slice(0, 80), uptime });
    }

    return sessions;
  } catch {
    return [];
  }
}

export async function getServerStatus(): Promise<string> {
  const cmds = [
    { label: "Uptime", cmd: "uptime -p" },
    { label: "CPU", cmd: "top -bn1 | grep 'Cpu(s)' | awk '{print $2}' | cut -d'%' -f1 | xargs -I{} echo '{}% used'" },
    { label: "RAM", cmd: "free -h | awk '/Mem:/{printf \"%s / %s (%s used)\", $3, $2, $3/$2*100\"%\"}'" },
    { label: "Disk", cmd: "df -h / | awk 'NR==2{printf \"%s / %s (%s)\", $3, $2, $5}'" },
    { label: "Docker", cmd: "docker ps --format '{{.Names}}: {{.Status}}' 2>/dev/null | head -15" },
    { label: "PM2", cmd: "pm2 jlist 2>/dev/null | node -e \"const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));d.forEach(p=>console.log(p.name+': '+p.pm2_env.status))\" 2>/dev/null || pm2 list --no-color 2>/dev/null | tail -n +4 | head -10" },
  ];

  const results: string[] = [];
  for (const { label, cmd } of cmds) {
    const { stdout } = await runCommand(cmd);
    results.push(`*${label}:* ${stdout.trim() || "N/A"}`);
  }
  return results.join("\n\n");
}
