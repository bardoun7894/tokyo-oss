import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "http";
import Database from "better-sqlite3";
import type { AddressInfo } from "net";
import { registerInternalTriage } from "./internal-triage";
import { TriageStore } from "../finish-apps/triage-store";

async function serve() {
  const store = new TriageStore(new Database(":memory:"));
  const app = express();
  app.use(express.json());
  registerInternalTriage(app, () => store);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        { host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json", ...headers } },
        (res) => {
          let s = "";
          res.on("data", (c) => (s += c));
          res.on("end", () => resolve({ status: res.statusCode!, json: s ? JSON.parse(s) : null }));
        },
      );
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  return { call, store, close: () => server.close() };
}

const proj = (name: string, completeness: number) => ({ name, host: "server", completeness, next_action: "fix-defects" });
const rec = { name: "tokyo", recommendations: [{ code: "R1", title: "T", kind: "feature", why: "w", evidence: [], size: "S", impact: 1 }] };
const gap = { code: "G1", text: "x", severity: "P1", source: "readiness-audit" };

test("post, latest with recommendations and gaps", async () => {
  const s = await serve();
  const r = await s.call("POST", "/api/internal/triage", {
    date: "2026-10-09", projects: [proj("tokyo", 3), proj("b", 1)], recommendations: [rec], gaps: { tokyo: [gap] },
  });
  assert.equal(r.status, 200);
  const l = await s.call("GET", "/api/internal/triage/latest");
  assert.equal(l.status, 200);
  assert.equal(l.json.date, "2026-10-09");
  const t = l.json.projects.find((p: any) => p.name === "tokyo");
  assert.equal(t.completeness, 3);
  assert.equal(t.recommendations[0].code, "R1");
  assert.equal(t.gaps[0].code, "G1");
  assert.deepEqual(l.json.projects.find((p: any) => p.name === "b").recommendations, []);
  s.close();
});

test("upsert per (date, project); latest is the newest date", async () => {
  const s = await serve();
  await s.call("POST", "/api/internal/triage", { date: "2026-10-08", projects: [proj("tokyo", 2)], recommendations: [] });
  await s.call("POST", "/api/internal/triage", { date: "2026-10-09", projects: [proj("tokyo", 3)], recommendations: [] });
  await s.call("POST", "/api/internal/triage", { date: "2026-10-09", projects: [proj("tokyo", 4)], recommendations: [] });
  const l = await s.call("GET", "/api/internal/triage/latest");
  assert.equal(l.json.date, "2026-10-09");
  assert.equal(l.json.projects.length, 1);
  assert.equal(l.json.projects[0].completeness, 4);
  const h = await s.call("GET", "/api/internal/triage/history/tokyo");
  assert.deepEqual(h.json.history, [{ date: "2026-10-08", completeness: 2 }, { date: "2026-10-09", completeness: 4 }]);
  s.close();
});

test("history returns the last 30", async () => {
  const s = await serve();
  for (let i = 1; i <= 35; i++) {
    s.store.upsert(new Date(Date.UTC(2026, 0, i)).toISOString().slice(0, 10), "tokyo", proj("tokyo", i % 5), [], []);
  }
  const h = await s.call("GET", "/api/internal/triage/history/tokyo");
  assert.equal(h.json.history.length, 30);
  assert.equal(h.json.history[29].date, "2026-02-04");
  assert.equal(h.json.history[0].date, "2026-01-06");
  s.close();
});

test("latest on an empty store", async () => {
  const s = await serve();
  const l = await s.call("GET", "/api/internal/triage/latest");
  assert.equal(l.status, 200);
  assert.deepEqual(l.json, { date: null, projects: [] });
  s.close();
});

test("rejects malformed bodies and more than 500 projects", async () => {
  const s = await serve();
  const bad: unknown[] = [
    {},
    { date: "yesterday", projects: [], recommendations: [] },
    { date: "2026-10-09", projects: "x", recommendations: [] },
    { date: "2026-10-09", projects: [{ completeness: 1 }], recommendations: [] },
    { date: "2026-10-09", projects: [proj("../x", 1)], recommendations: [] },
    { date: "2026-10-09", projects: [proj("a", 1)], recommendations: "no" },
    { date: "2026-10-09", projects: Array.from({ length: 501 }, (_, i) => proj(`p${i}`, 1)), recommendations: [] },
  ];
  for (const b of bad) assert.equal((await s.call("POST", "/api/internal/triage", b)).status, 400, JSON.stringify(b).slice(0, 60));
  assert.equal((await s.call("GET", "/api/internal/triage/history/..%2Fx")).status, 400);
  s.close();
});

test("loopback only: proxied request is refused", async () => {
  const s = await serve();
  const ok = { date: "2026-10-09", projects: [proj("a", 1)], recommendations: [] };
  assert.equal((await s.call("POST", "/api/internal/triage", ok, { "x-forwarded-for": "1.2.3.4" })).status, 403);
  assert.equal((await s.call("GET", "/api/internal/triage/latest", undefined, { "x-real-ip": "1.2.3.4" })).status, 403);
  s.close();
});
