import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import express from "express";
import Database from "better-sqlite3";
import { bearerAuth, type ControlDeps } from "./auth";
import { LoginThrottle } from "./rate-limit";
import { ControlStore } from "./store";
import { serveApp } from "./test-http";
import { factoryRegistryRoutes, type FactoryCtl } from "./factory-routes";

const reader = (available = true) => ({
  listJobs: () => ({ available: true as const, jobs: [], nextOffset: null }),
  getJob: () => ({ available: true as const, job: null }),
  projectsSummary: () => available
    ? ({ available: true as const, projects: [{ project: "alpha", halted: false, paused: false, lastGrade: null, openProblems: {} }] })
    : ({ available: false as const }),
});

async function app(opts: { caps?: boolean; ctl?: FactoryCtl; available?: boolean } = {}) {
  const store = new ControlStore(new Database(":memory:"));
  const deps: ControlDeps = { store, throttle: new LoginThrottle(), checkCredentials: () => true };
  const token = crypto.randomBytes(32).toString("hex");
  const device = store.createDevice({ name: "t", tokenHash: crypto.createHash("sha256").update(token).digest("hex"), now: Date.now() });
  if (opts.caps !== false) store.setCaps(device.id, ["ops:read", "ops:write", "ops:run"]);
  const calls: string[][] = [];
  const ctl: FactoryCtl = opts.ctl ?? (async (argv) => { calls.push(argv); return { code: 0 }; });
  const srv = express();
  srv.use(express.json());
  srv.use("/control-api/v1", bearerAuth(deps), factoryRegistryRoutes(reader(opts.available) as never, ctl));
  const s = await serveApp(srv);
  const post = (p: string, body?: unknown) => s.call("POST", "/control-api/v1" + p, body, { authorization: `Bearer ${token}` });
  return { s, post, calls };
}

test("401 without token", async () => {
  const { s } = await app();
  for (const verb of ["halt", "unhalt", "pause", "unpause"]) {
    const r = await s.call("POST", `/control-api/v1/factory/projects/alpha/${verb}`, {});
    assert.equal(r.status, 401, verb);
    assert.equal(r.json.error.code, "unauthorized");
  }
});

test("403 without capability", async () => {
  const { post, calls } = await app({ caps: false });
  for (const verb of ["halt", "unhalt", "pause", "unpause"]) {
    const r = await post(`/factory/projects/alpha/${verb}`, {});
    assert.equal(r.status, 403, verb);
    assert.equal(r.json.error.code, "forbidden");
  }
  assert.equal(calls.length, 0);
});

test("unknown project 404", async () => {
  const { post, calls } = await app();
  for (const p of ["nope", "a%20b", "..%2Fx", "x".repeat(65)]) {
    const r = await post(`/factory/projects/${p}/halt`, {});
    assert.equal(r.status, 404, p);
    assert.equal(r.json.error.code, "not_found");
  }
  assert.equal(calls.length, 0);
});

test("503 when the registry is unavailable", async () => {
  const { post, calls } = await app({ available: false });
  const r = await post("/factory/projects/alpha/halt", {});
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, "unavailable");
  assert.equal(calls.length, 0);
});

test("halt calls factoryctl with fixed argv", async () => {
  const { post, calls } = await app();
  const r = await post("/factory/projects/alpha/halt", { reason: "stop\u0000 now\n" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, project: "alpha", action: "halt" });
  assert.deepEqual(calls, [["halt", "alpha", "--reason=stop now"]]);
  const bare = await post("/factory/projects/alpha/pause");
  assert.equal(bare.status, 200);
  assert.deepEqual(calls[1], ["pause", "alpha"]);
  // unhalt and unpause take no --reason in factoryctl, so a reason is accepted but not passed
  assert.equal((await post("/factory/projects/alpha/unhalt", { reason: "ok" })).status, 200);
  assert.equal((await post("/factory/projects/alpha/unpause", {})).status, 200);
  assert.deepEqual(calls.slice(2), [["unhalt", "alpha"], ["unpause", "alpha"]]);
});

test("400 on a bad reason", async () => {
  const { post, calls } = await app();
  for (const reason of [5, ["a"], "x".repeat(201)]) {
    const r = await post("/factory/projects/alpha/halt", { reason });
    assert.equal(r.status, 400, String(reason));
    assert.equal(r.json.error.code, "bad_request");
  }
  assert.equal(calls.length, 0);
});

test("factoryctl failure is a 502 with its exit code and no stderr", async () => {
  const { post } = await app({ ctl: async () => ({ code: 3 }) });
  const r = await post("/factory/projects/alpha/halt", {});
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, "unavailable");
  assert.equal(r.json.exitCode, 3);
  const spawnFail = await app({ ctl: async () => ({ code: null }) });
  const r2 = await spawnFail.post("/factory/projects/alpha/halt", {});
  assert.equal(r2.status, 502);
  assert.equal(r2.json.exitCode, null);
});

test("no shell string", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-ctl-"));
  const out = path.join(dir, "argv.txt");
  const pwned = path.join(dir, "pwned");
  const bin = path.join(dir, "fake-factoryctl");
  fs.writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> ${out}; done\nexit 0\n`, { mode: 0o755 });
  process.env.FACTORYCTL_BIN = bin;
  try {
    // the real default executor, through the router
    const real = await realApp();
    const reason = `x; touch ${pwned} $(touch ${pwned}) \`touch ${pwned}\``;
    const r = await real.post("/factory/projects/alpha/halt", { reason });
    assert.equal(r.status, 200);
    assert.equal(fs.existsSync(pwned), false);
    assert.deepEqual(fs.readFileSync(out, "utf8").split("\n").slice(0, -1), ["halt", "alpha", `--reason=${reason}`]);
  } finally {
    delete process.env.FACTORYCTL_BIN;
  }
});

async function realApp() {
  const store = new ControlStore(new Database(":memory:"));
  const deps: ControlDeps = { store, throttle: new LoginThrottle(), checkCredentials: () => true };
  const token = crypto.randomBytes(32).toString("hex");
  const device = store.createDevice({ name: "t", tokenHash: crypto.createHash("sha256").update(token).digest("hex"), now: Date.now() });
  store.setCaps(device.id, ["ops:run"]);
  const srv = express();
  srv.use(express.json());
  srv.use("/control-api/v1", bearerAuth(deps), factoryRegistryRoutes(reader() as never));
  const s = await serveApp(srv);
  return { post: (p: string, body?: unknown) => s.call("POST", "/control-api/v1" + p, body, { authorization: `Bearer ${token}` }) };
}
