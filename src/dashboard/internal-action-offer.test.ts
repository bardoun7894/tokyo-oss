import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";
import { registerInternalActionOffer } from "./internal-action-offer";

// A fake claude-runner: the routes' job is validation and the loopback gate,
// the offer flow itself is tested in action-offer-flow.test.ts.
function fakeRunner() {
  const calls: string[] = [];
  const answered = new Set<string>();
  const runner: any = {
    offerActionFromSession: async (a: any) => {
      calls.push(`offer ${a.project} | ${a.title} | ${a.body} | ${(a.buttons ?? []).map((b: any) => b.id).join(",") || "-"} | ${a.from ?? "-"}`);
      return a.project === "nope"
        ? { ok: false, kind: "unknown_project", error: 'unknown project "nope"' }
        : { ok: true, id: "ab12cd34", project: a.project };
    },
    actionOfferStatus: (id: string) =>
      id === "ab12cd34" ? { state: "pending", project: "tokyo", title: "Tokyo is 3/4" } : null,
    answerActionOffer: async (id: string, button: string, channel: string) => {
      calls.push(`answer ${id} ${button} ${channel}`);
      if (answered.has(id)) return `Offer ${id} was already answered on telegram.`;
      answered.add(id);
      return "Running…";
    },
  };
  return { runner, calls };
}

async function serve(runner: any) {
  const app = express();
  app.use(express.json());
  registerInternalActionOffer(app, () => runner);
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
  return { call, close: () => server.close() };
}

const BODY = { project: "tokyo", title: "Tokyo is 3/4", body: "fix defects", from: "finish-apps" };

test("create, status, answer once then already", async () => {
  const { runner, calls } = fakeRunner();
  const s = await serve(runner);
  try {
    const a = await s.call("POST", "/api/internal/action-offer", BODY);
    assert.deepEqual(a, { status: 200, json: { id: "ab12cd34", project: "tokyo" } });
    assert.deepEqual((await s.call("GET", "/api/internal/action-offer/ab12cd34")).json, {
      state: "pending", project: "tokyo", title: "Tokyo is 3/4",
    });
    const first = await s.call("POST", "/api/internal/action-offer/ab12cd34/answer", { button: "run" });
    assert.deepEqual(first, { status: 200, json: { reply: "Running…" } });
    const second = await s.call("POST", "/api/internal/action-offer/ab12cd34/answer", { button: "skip", channel: "term<x>" });
    assert.match(second.json.reply, /already answered/);
    assert.deepEqual(calls, [
      "offer tokyo | Tokyo is 3/4 | fix defects | - | finish-apps",
      "answer ab12cd34 run terminal",
      "answer ab12cd34 skip termx",
    ]);
  } finally {
    s.close();
  }
});

test("explicit buttons are passed through", async () => {
  const { runner, calls } = fakeRunner();
  const s = await serve(runner);
  try {
    const r = await s.call("POST", "/api/internal/action-offer", { ...BODY, buttons: [{ id: "go", label: "Go", prompt: "do it" }, { id: "no", label: "No" }] });
    assert.equal(r.status, 200);
    assert.match(calls[0], /\| go,no \|/);
  } finally {
    s.close();
  }
});

test("bad input is refused before the runner is called", async () => {
  const { runner, calls } = fakeRunner();
  const s = await serve(runner);
  try {
    const post = (b: unknown) => s.call("POST", "/api/internal/action-offer", b);
    assert.equal((await post({ ...BODY, title: "" })).status, 400, "missing title");
    assert.equal((await post({ project: "tokyo", body: "x" })).status, 400, "no title at all");
    assert.equal((await post({ title: "t" })).status, 400, "missing project");
    assert.equal((await post({ ...BODY, buttons: [] })).status, 400, "zero buttons");
    assert.equal((await post({ ...BODY, buttons: [{ id: "BAD ID", label: "x" }] })).status, 400, "bad button id");
    assert.equal((await post({ ...BODY, buttons: "run" })).status, 400, "buttons not an array");
    assert.equal((await s.call("POST", "/api/internal/action-offer/ab12cd34/answer", {})).status, 400, "no button");
    assert.equal((await s.call("POST", "/api/internal/action-offer/XYZ/answer", { button: "run" })).status, 400, "bad id");
    assert.deepEqual(calls, []);
    assert.equal((await post({ ...BODY, project: "nope" })).status, 404, "unknown project");
    assert.equal((await s.call("GET", "/api/internal/action-offer/deadbeef")).status, 404, "unknown id");
    assert.equal((await s.call("GET", "/api/internal/action-offer/..%2F..")).status, 404);
  } finally {
    s.close();
  }
});

test("a proxied request (X-Forwarded-For / X-Real-IP) is refused with 403", async () => {
  const { runner, calls } = fakeRunner();
  const s = await serve(runner);
  try {
    for (const h of [{ "x-forwarded-for": "1.2.3.4" }, { "x-real-ip": "1.2.3.4" }] as Record<string, string>[]) {
      assert.equal((await s.call("POST", "/api/internal/action-offer", BODY, h)).status, 403);
      assert.equal((await s.call("GET", "/api/internal/action-offer/ab12cd34", undefined, h)).status, 403);
      assert.equal((await s.call("POST", "/api/internal/action-offer/ab12cd34/answer", { button: "run" }, h)).status, 403);
    }
    assert.deepEqual(calls, []);
  } finally {
    s.close();
  }
});
