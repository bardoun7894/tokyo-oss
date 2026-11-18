import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Side-effect import for tests whose import graph reaches db.ts (which opens
// the database at module load). Import it FIRST so TOKYO_DB_PATH points at a
// scratch file instead of <repo>/life.db, which a non-root test run cannot create.
if (!process.env.TOKYO_DB_PATH) {
  const dir = mkdtempSync(join(tmpdir(), "tokyo-test-db-"));
  process.env.TOKYO_DB_PATH = join(dir, "life.db");
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
}
