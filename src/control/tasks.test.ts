import { test } from "node:test";
import assert from "node:assert/strict";
import { controlApp } from "./test-app";

// The fake mission store: propose() records the call and returns the new mission id.
async function setup() {
  const calls: any[] = [];
  const app = await controlApp({
    tasks: {
      getProject: (n) => (n === "tokyo" ? ({ name: "tokyo" } as any) : undefined),
      propose: async (project, msg) => { calls.push({ project: project.name, msg }); return "4f2a9c1b"; },
    },
  });
  return { ...app, calls };
}

test("a valid task proposes one mission and answers awaiting_approval, never ran", async () => {
  const s = await setup();
  const r = await s.post("/tasks", { project: "tokyo", text: "add dark mode" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { status: "awaiting_approval", missionId: "4f2a9c1b", offerId: "4f2a9c1b", project: "tokyo" });
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].project, "tokyo");
  assert.equal(s.calls[0].msg.content, "add dark mode");
  assert.equal(s.calls[0].msg.sender_name, "owner (control app)");
  await s.close();
});

test("unknown project is 404, a bad body is 400, and nothing is proposed", async () => {
  const s = await setup();
  assert.equal((await s.post("/tasks", { project: "nope", text: "x" })).status, 404);
  assert.equal((await s.post("/tasks", { project: "tokyo", text: "" })).status, 400);
  assert.equal((await s.post("/tasks", { project: "tokyo", text: "x".repeat(2001) })).status, 400);
  assert.equal((await s.post("/tasks", { project: "tokyo" })).status, 400);
  assert.equal((await s.post("/tasks", { project: 5, text: "x" })).status, 400);
  assert.equal((await s.post("/tasks", { project: "tokyo", text: "x".repeat(2000) })).status, 200);
  assert.equal(s.calls.length, 1);
  await s.close();
});

test("a project without mission config (propose returns null) is 404", async () => {
  const app = await controlApp({ tasks: { getProject: () => ({ name: "tokyo" } as any), propose: async () => null } });
  assert.equal((await app.post("/tasks", { project: "tokyo", text: "x" })).status, 404);
  await app.close();
});

test("10 tasks a minute per X-Real-IP, the 11th is 429; another address is not affected", async () => {
  const s = await setup();
  const ip = (a: string) => ({ ...s.auth, "x-real-ip": a });
  for (let i = 0; i < 10; i++) assert.equal((await s.srv.call("POST", "/control-api/v1/tasks", { project: "tokyo", text: "t" }, ip("1.1.1.1"))).status, 200);
  const over = await s.srv.call("POST", "/control-api/v1/tasks", { project: "tokyo", text: "t" }, ip("1.1.1.1"));
  assert.equal(over.status, 429);
  assert.ok(over.headers["retry-after"]);
  assert.equal((await s.srv.call("POST", "/control-api/v1/tasks", { project: "tokyo", text: "t" }, ip("2.2.2.2"))).status, 200);
  await s.close();
});

test("tasks need a device token", async () => {
  const s = await setup();
  assert.equal((await s.srv.call("POST", "/control-api/v1/tasks", { project: "tokyo", text: "x" })).status, 401);
  await s.close();
});
