import type { Skill } from "./types";
import { matchProject, getProject, TOKYO_KB_PATH, type ProjectRef } from "../project-registry";
import { exec } from "child_process";

const TIMEOUT_MS = 120_000;
const PROXY_URL = "http://100.64.0.1:8317";

function runRemote(
  host: "mac" | null,
  cmd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const wrapped = host ? `ssh -o ConnectTimeout=10 -o BatchMode=yes ${host} ${JSON.stringify(cmd)}` : cmd;
  return new Promise((resolve) => {
    exec(
      wrapped,
      { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, shell: "/bin/bash" },
      (error, stdout, stderr) => {
        resolve({ stdout, stderr, code: (error as any)?.code ?? 0 });
      },
    );
  });
}

function queryCmd(kbPath: string, question: string): string {
  const token = process.env.CLIPROXY_API_KEY || "";
  const env = [
    "export PATH=/opt/homebrew/bin:/Users/owner/.local/bin:$PATH",
    `export ANTHROPIC_BASE_URL=${PROXY_URL}`,
    `export ANTHROPIC_API_KEY=${token}`,
  ].join(" && ");
  return `${env} && cd ${kbPath} && uv run --quiet python scripts/query.py ${JSON.stringify(question)}`;
}

function host(p: ProjectRef): "mac" | null {
  return p.location === "laptop" ? "mac" : null;
}

const skill: Skill = {
  name: "kb-query",
  description:
    "Ask the knowledge base a question. Always reads Tokyo's KB; if a project is named (or a WA client/group name matches), also reads that project's KB. Read-only, no confirmation required.",
  category: "system",
  args: [
    { name: "question", type: "string", description: "What to ask the KB", required: true },
    {
      name: "project",
      type: "string",
      description:
        "Project canonical name (e.g. up, erpdemo, studio) OR a WhatsApp client/group name to auto-match. Leave empty for Tokyo KB only.",
      required: false,
      default: "",
    },
  ],
  async execute(ctx, args) {
    const question = String(args.question || "").trim();
    if (!question) return { success: false, output: "question is required" };

    const projectInput = String(args.project || "").trim();
    let matched: ProjectRef | null = null;
    if (projectInput) {
      matched = getProject(projectInput) || matchProject(projectInput);
    }

    const targets: { label: string; host: "mac" | null; kbPath: string }[] = [
      { label: "tokyo", host: "mac", kbPath: TOKYO_KB_PATH },
    ];
    if (matched?.kbPath && matched.kbPath !== TOKYO_KB_PATH) {
      targets.push({ label: matched.name, host: host(matched), kbPath: matched.kbPath });
    }

    const results = await Promise.all(
      targets.map(async (t) => {
        await ctx.sendUpdate(`🔎 Querying KB: ${t.label}…`);
        const res = await runRemote(t.host, queryCmd(t.kbPath, question));
        const body = (res.stdout || res.stderr).trim();
        return { label: t.label, ok: res.code === 0, body: body.slice(0, 3500) || "(empty)" };
      }),
    );

    let projNote = "";
    if (projectInput && !matched) projNote = `\n_(no project matched "${projectInput}" — showed Tokyo KB only)_\n`;

    const output = results
      .map((r) => `### KB: ${r.label} ${r.ok ? "" : "(error)"}\n${r.body}`)
      .join("\n\n---\n\n");

    return { success: true, output: `${projNote}${output}` };
  },
};

export default skill;
