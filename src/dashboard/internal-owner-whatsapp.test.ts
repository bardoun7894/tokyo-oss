import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { serveApp } from "../control/test-http";
import { registerInternalOwnerWhatsApp, sendToOwnSelfChat } from "./internal-owner-whatsapp";

async function setup(send: (t: string) => Promise<boolean>) {
  const app = express();
  app.use(express.json());
  registerInternalOwnerWhatsApp(app, send);
  const srv = await serveApp(app);
  return { ...srv, post: (b: unknown, h: Record<string, string> = {}) => srv.call("POST", "/api/internal/owner-whatsapp", b, h) };
}

test("a loopback caller sends text; bad bodies are 400; a proxied request is refused", async () => {
  const sent: string[] = [];
  const s = await setup(async (t) => { sent.push(t); return true; });
  assert.equal((await s.post({ text: "hello" })).status, 200);
  assert.equal((await s.post({ text: "" })).status, 400);
  assert.equal((await s.post({ text: "x".repeat(4001) })).status, 400);
  assert.equal((await s.post({})).status, 400);
  assert.equal((await s.post({ text: "y" }, { "x-forwarded-for": "1.2.3.4" })).status, 403);
  assert.deepEqual(sent, ["hello"]);
  await s.close();
});

test("503 when WhatsApp is not connected or the send throws", async () => {
  const a = await setup(async () => false);
  assert.equal((await a.post({ text: "x" })).status, 503);
  await a.close();
  const b = await setup(async () => { throw new Error("WhatsApp not connected"); });
  const r = await b.post({ text: "x" });
  assert.equal(r.status, 503);
  assert.match(r.json.error, /not connected/);
  await b.close();
});

test("sendToOwnSelfChat addresses the bare self jid (device suffix dropped)", async () => {
  const calls: Array<[string, string]> = [];
  const wa: any = { getOwnJids: () => ({ jid: "100200:7@s.whatsapp.net" }), sendWhatsAppMessage: async (j: string, t: string) => { calls.push([j, t]); } };
  assert.equal(await sendToOwnSelfChat("hi", () => wa), true);
  assert.deepEqual(calls, [["100200@s.whatsapp.net", "hi"]]);
  assert.equal(await sendToOwnSelfChat("hi", () => ({ getOwnJids: () => null }) as any), false);
});
