import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { MAX_PROMPT, previewOf, promptAudit, startRunVia } from "./start";

test("promptAudit: length, sha256 and a 60-char redacted one-line preview, never the full prompt", () => {
  const prompt = `Fix the login.\nUse Bearer abcdefghijklmnop1234567890 and sk-${"a".repeat(30)} please. ${"x".repeat(200)}`;
  const a = promptAudit(prompt);
  assert.equal(a.len, prompt.length);
  assert.equal(a.sha256, crypto.createHash("sha256").update(prompt).digest("hex"));
  assert.ok(a.preview.length <= 60);
  assert.ok(!a.preview.includes("\n"));
  assert.ok(!/abcdefghijklmnop|sk-a/.test(a.preview));
  assert.ok(!JSON.stringify(a).includes(prompt));
});

test("promptAudit: a secret that straddles the cut is redacted before the cut, not after", () => {
  const prompt = `${"y".repeat(45)} Bearer ${"Z".repeat(40)}`;
  assert.ok(!promptAudit(prompt).preview.includes("ZZZZ"));
});

test("previewOf is the first 200 chars, redacted; the limit is 4000", () => {
  assert.equal(previewOf("ab cd ".repeat(100)).length, 200);
  assert.equal(MAX_PROMPT, 4000);
});

test("startRunVia: createOffer first, then answerAction with the run id; the prompt rides only in the button", async () => {
  const order: string[] = [];
  const prompt = "Add a dark mode toggle to the settings page.";
  const createOffer = async (a: any) => { order.push("create"); (createOffer as any).args = a; return { ok: true as const, id: "offer1", project: a.project }; };
  const answerAction = async (...args: any[]) => { order.push("answer"); (answerAction as any).args = args; return { status: "applied" as const, offer: {} as any, reply: "ok" }; };
  const start = startRunVia({ createOffer: createOffer as any, answerAction: answerAction as any });
  const out = await start({ project: "alpha", prompt, variant: "kb-dev", runId: "r1234567" });
  assert.deepEqual(out, { ok: true });
  assert.deepEqual(order, ["create", "answer"]);
  const a = (createOffer as any).args;
  assert.equal(a.project, "alpha");
  assert.equal(a.from, "control-app");
  assert.equal(a.buttons.length, 1);
  assert.equal(a.buttons[0].prompt, prompt);
  assert.ok(!a.title.includes(prompt) && !a.body.includes(prompt) && !a.buttons[0].label.includes(prompt));
  assert.deepEqual((answerAction as any).args, ["offer1", a.buttons[0].id, "app", { runId: "r1234567" }]);
});

test("startRunVia: maps every failure to not_found, conflict or unavailable", async () => {
  const applied = { status: "applied" as const, offer: {} as any, reply: "" };
  const mk = (create: any, answer: any) => startRunVia({ createOffer: async () => create, answerAction: async () => answer });
  const a = { project: "p", prompt: "x", variant: "kb-dev" as const, runId: "r" };
  assert.deepEqual(await mk({ ok: false, kind: "unknown_project", error: "e" }, applied)(a), { ok: false, kind: "not_found", message: "No such project" });
  assert.equal((await mk({ ok: false, kind: "unavailable", error: "telegram bot not ready" }, applied)(a) as any).kind, "unavailable");
  assert.equal((await mk({ ok: true, id: "o", project: "p" }, { status: "already", offer: {} })(a) as any).kind, "conflict");
  assert.equal((await mk({ ok: true, id: "o", project: "p" }, { status: "missing" })(a) as any).kind, "unavailable");
  const thrown = startRunVia({ createOffer: async () => { throw new Error("Bearer tk_leak"); }, answerAction: async () => applied });
  const out: any = await thrown(a);
  assert.equal(out.kind, "unavailable");
  assert.ok(!JSON.stringify(out).includes("tk_leak"));
});
