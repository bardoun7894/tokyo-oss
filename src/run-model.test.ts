import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRunModel, pickArgv } from "./run-model";

const FALLBACK = "claude-opus-5-5";

test("a Claude pick from jev-launch becomes the run's model and effort", () => {
  const out = JSON.stringify({ harness: "claude", model: "claude-haiku-4-5-20251001", effort: "low", tier: "T1" });
  assert.deepEqual(parseRunModel(out, FALLBACK), { model: "claude-haiku-4-5-20251001", effort: "low", tier: "T1" });
});

test("anything that could break the shell line, or is not Claude, falls back", () => {
  for (const out of [
    JSON.stringify({ harness: "claude", model: "claude-x; rm -rf /", effort: "low" }),
    JSON.stringify({ harness: "claude", model: "claude-fable-5-1", effort: "high && curl" }),
    JSON.stringify({ harness: "codex", model: "gpt-6-sol", effort: "medium" }),
    "not json",
    "",
  ]) {
    const got = parseRunModel(out, FALLBACK);
    assert.equal(got.model, out.includes("high && curl") ? "claude-fable-5-1" : FALLBACK, out);
    if (out.includes("high && curl")) assert.equal(got.effort, undefined);
  }
});

test("the client's text never goes on the command line", () => {
  assert.deepEqual(pickArgv(["--stdin"]), ["jev-launch", "claude", "--print", "--no-fallback", "--stdin"]);
  assert.deepEqual(pickArgv(["--file", "/root/missions/.run/4f2a9c1b.task"]).slice(-2), [
    "--file",
    "/root/missions/.run/4f2a9c1b.task",
  ]);
});
