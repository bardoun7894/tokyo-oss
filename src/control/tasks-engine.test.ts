import { test } from "node:test";
import assert from "node:assert/strict";
import { controlApp } from "./test-app";

test("POST /tasks passes a chosen engine to the proposal and rejects an unknown one", async () => {
  const engines: unknown[] = [];
  const app = await controlApp({
    tasks: { getProject: () => ({ name: "tokyo" } as any), propose: async (_p, _m, engine) => { engines.push(engine); return "4f2a9c1b"; } },
  });
  assert.equal((await app.post("/tasks", { project: "tokyo", text: "x", engine: "dsh" })).status, 200);
  assert.equal((await app.post("/tasks", { project: "tokyo", text: "x" })).status, 200);
  const bad = await app.post("/tasks", { project: "tokyo", text: "x", engine: "rm -rf" });
  assert.equal(bad.status, 400);
  assert.deepEqual(engines, ["dsh", undefined]);
  await app.close();
});
