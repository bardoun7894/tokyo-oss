import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "net";
import { registerInternalDeploy } from "./internal-deploy";

// A fake claude-runner: the routes' job is validation and the loopback gate,
// not the deploy itself, which is claude-runner's and tested there.
function fakeRunner() {
  const calls: string[] = [];
  const runner: any = {
    offerDeployFromSession: async (project: string, summary?: string, from?: string) => {
      calls.push(`offer ${project} ${summary ?? "-"} ${from ?? "-"}`);
      return project === "nope" ? { ok: false, error: "unknown project \"nope\"" } : { ok: true, id: "ab12cd34", project };
    },
    deployOfferStatus: (id: string) => (id === "ab12cd34" ? { state: "pending", project: "godhome" } : null),
    answerDeployOffer: async (id: string, answer: string, channel: string) => {
      calls.push(`answer ${id} ${answer} ${channel}`);
      return answer === "deploy" ? "Deploying godhome…" : "Not deploying godhome.";
    },
  };
  return { runner, calls };
}

async function serve(runner: any) {
  const app = express();
  app.use(express.json());
  registerInternalDeploy(app, () => runner);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, {
      method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() };
  };
  return { call, close: () => server.close() };
}

test("ask, status, answer round trip over loopback", async () => {
  const { runner, calls } = fakeRunner();
  const s = await serve(runner);
  try {
    const a = await s.call("POST", "/api/internal/deploy-offer", { project: "godhome", summary: "herdr terminals", from: "terminal" });
    assert.deepEqual(a, { status: 200, json: { id: "ab12cd34", project: "godhome" } });
    assert.deepEqual((await s.call("GET", "/api/internal/deploy-offer/ab12cd34")).json, { state: "pending", project: "godhome" });
    const y = await s.call("POST", "/api/internal/deploy-offer/ab12cd34/answer", { answer: "deploy" });
    assert.deepEqual(y, { status: 200, json: { reply: "Deploying godhome…" } });
    assert.deepEqual(calls, ["offer godhome herdr terminals terminal", "answer ab12cd34 deploy terminal"]);
  } finally {
    s.close();
  }
});

test("bad input is refused before the runner is called", async () => {
  const { runner, calls } = fakeRunner();
  const s = await serve(runner);
  try {
    assert.equal((await s.call("POST", "/api/internal/deploy-offer", {})).status, 400);
    assert.equal((await s.call("POST", "/api/internal/deploy-offer", { project: "nope" })).status, 404);
    assert.equal((await s.call("GET", "/api/internal/deploy-offer/..%2F..")).status, 404);
    assert.equal((await s.call("POST", "/api/internal/deploy-offer/ab12cd34/answer", { answer: "yes please" })).status, 400);
    assert.equal((await s.call("POST", "/api/internal/deploy-offer/XYZ/answer", { answer: "deploy" })).status, 400);
    assert.deepEqual(calls, ["offer nope - -"]);
  } finally {
    s.close();
  }
});

test("channel names are sanitised", async () => {
  const { runner, calls } = fakeRunner();
  const s = await serve(runner);
  try {
    await s.call("POST", "/api/internal/deploy-offer/ab12cd34/answer", { answer: "skip", channel: "term<script>inal" });
    assert.deepEqual(calls, ["answer ab12cd34 skip termscriptinal"]);
  } finally {
    s.close();
  }
});
