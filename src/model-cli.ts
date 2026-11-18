import { execFile } from 'child_process';

export interface ModelCliOptions {
  timeout: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

// Runs a model CLI with the prompt on stdin. Passing the prompt as an argument
// failed with E2BIG once briefing prompts grew, and building a shell string from
// it let `$(...)` in an incoming message run on the server. execFile uses no shell.
export function runModelCli(
  cmd: string, args: string[], prompt: string, opts: ModelCliOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, {
      timeout: opts.timeout,
      maxBuffer: opts.maxBuffer ?? 100 * 1024,
      encoding: 'utf-8',
      env: opts.env ?? process.env,
    }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stdout, stderr }));
      resolve(stdout);
    });
    child.stdin?.on('error', () => {}); // CLI exiting early must not crash the bot with EPIPE
    child.stdin?.end(prompt);
  });
}
