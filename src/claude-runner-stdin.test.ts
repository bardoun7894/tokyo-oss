import "./test-db-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execArgv } from "./claude-runner.js";

test("execArgv survives EPIPE when the child exits without reading stdin", async () => {
  const r = await execArgv(["sh", "-c", "exit 3"], { input: "x".repeat(1_000_000) });
  assert.equal(r.code, 3);
});
