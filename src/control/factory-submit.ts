import { execFile } from "child_process";

/** `factory submit` exits with this code when the project is halted. */
export const HALTED_EXIT = 97;

const SAFE_NAME = /^[a-z0-9._-]+$/;
/** `PROJECT:OWNER:SHA12:EPOCH` */
const JOB_ID = /^[a-z0-9._-]+:[a-z0-9._-]+:[0-9a-f]{12}:\d+$/;
const SUBMIT_TIMEOUT_MS = 3000;

export interface FactorySubmitOptions { bin?: string; timeoutMs?: number }
export interface FactorySubmitResult { jobId: string | null; halted: boolean }

/**
 * Run the fixed `factory submit PROJECT --brief FILE --owner WHO` (execFile, no shell). Never throws: a bad name, a timeout,
 * a spawn error or a non-zero exit gives `jobId: null`; exit 97 also sets `halted`.
 */
export function factorySubmitResult(
  project: string, briefFile: string, owner: string, opts: FactorySubmitOptions = {},
): Promise<FactorySubmitResult> {
  const none: FactorySubmitResult = { jobId: null, halted: false };
  if (typeof project !== "string" || typeof owner !== "string" || typeof briefFile !== "string") return Promise.resolve(none);
  if (!SAFE_NAME.test(project) || !SAFE_NAME.test(owner)) return Promise.resolve(none);
  // Under the node test runner the live binary is never called (it would write the live registry); tests pass `bin` or FACTORY_BIN.
  if (!opts.bin && !process.env.FACTORY_BIN && process.env.NODE_TEST_CONTEXT) return Promise.resolve(none);
  const bin = opts.bin ?? (process.env.FACTORY_BIN || "/usr/local/bin/factory");
  return new Promise((resolve) => {
    try {
      execFile(
        bin, ["submit", project, "--brief", briefFile, "--owner", owner],
        { timeout: opts.timeoutMs ?? SUBMIT_TIMEOUT_MS, maxBuffer: 64 * 1024 },
        (err: any, stdout) => {
          if (err) return resolve({ jobId: null, halted: typeof err.code === "number" && !err.killed && err.code === HALTED_EXIT });
          const first = String(stdout).split("\n")[0].trim();
          resolve({ jobId: JOB_ID.test(first) ? first : null, halted: false });
        },
      );
    } catch {
      resolve(none);
    }
  });
}

export async function factorySubmit(
  project: string, briefFile: string, owner: string, opts?: FactorySubmitOptions,
): Promise<string | null> {
  return (await factorySubmitResult(project, briefFile, owner, opts)).jobId;
}
