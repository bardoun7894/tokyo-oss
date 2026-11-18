import { exec } from 'child_process';
import { promisify } from 'util';
import { getProjectPath, getProjectNames } from './agents';
import { runCommand } from './shell';
import { runModelCli } from './model-cli';

const PI_CMD = process.env.PI_CLI || 'pi';
// Async so a 2-minute pi run no longer freezes the bot's event loop.
const execAsync = promisify(exec);

export async function runClaudeTask(
  project: string, prompt: string,
): Promise<{ result: string; success: boolean }> {
  const projectPath = getProjectPath(project);
  if (!projectPath) {
    return { result: 'Unknown project: ' + project + '\nAvailable: ' + getProjectNames().join(', '), success: false };
  }
  const context = await gatherProjectContext(projectPath);
  const fullPrompt = 'Project: ' + project + '\nPath: ' + projectPath + '\n\n' + context + '\n\nTask: ' + prompt;
  try {
    const stdout = await runModelCli(PI_CMD, ['-p', '--mode', 'text', '--no-session', '--no-tools'], fullPrompt, {
      timeout: 120_000,
      env: { ...process.env, PI_OFFLINE: '1' },
    });
    return { result: stdout.trim() || '(no output)', success: true };
  } catch (err: any) {
    console.error('[claude-tasks] Error:', err.message);
    return { result: 'Pi task failed: ' + err.message, success: false };
  }
}

export function buildTokyoContext(): string {
  const projects = getProjectNames();
  return ['Tokyo Life OS', 'Projects: ' + projects.join(', '), 'Stack: Node.js + TypeScript'].join('\n');
}

async function gatherProjectContext(projectPath: string): Promise<string> {
  const parts: string[] = [];
  const gl = await runCommand('git -C ' + projectPath + ' log --oneline -10 2>/dev/null');
  if (gl.code === 0 && gl.stdout.trim()) parts.push('Commits:\n' + gl.stdout.trim());
  const gs = await runCommand('git -C ' + projectPath + ' status --short 2>/dev/null');
  if (gs.code === 0 && gs.stdout.trim()) parts.push('Status:\n' + gs.stdout.trim());
  return parts.join('\n\n') || '(no context)';
}
