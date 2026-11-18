import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Point TOKYO_MEDIA_DIR at a fresh temp dir. Call at the top of a test file,
 * before importing the module under test, and call the returned cleanup in after().
 */
export function useTempMediaDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "tokyo-media-"));
  process.env.TOKYO_MEDIA_DIR = dir;
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      delete process.env.TOKYO_MEDIA_DIR;
    },
  };
}
