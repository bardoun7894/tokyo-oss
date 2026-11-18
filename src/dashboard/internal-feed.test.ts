import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import Database from "better-sqlite3";
import { FeedStore } from "../control/feed";
import { serveApp } from "../control/test-http";
import { registerInternalFeed } from "./internal-feed";

async function setup() {
  const feed = new FeedStore(new Database(":memory:"));
  const app = express();
  app.use(express.json());
  registerInternalFeed(app, () => feed);
  const srv = await serveApp(app);
  return { feed, ...srv, post: (b: unknown, h: Record<string, string> = {}) => srv.call("POST", "/api/internal/feed", b, h) };
}

test("a loopback sender adds a feed entry; the kind is classified when not given", async () => {
  const s = await setup();
  const a = await s.post({ source: "server-health", text: "[server-health] disk 91% on /" });
  assert.equal(a.status, 200);
  const b = await s.post({ source: "godhome", text: "network alert", kind: "incident" });
  assert.equal(b.status, 200);
  const items = s.feed.list({ limit: 10 });
  assert.equal(items.length, 2);
  assert.equal(items.find((i) => i.source === "godhome")!.kind, "incident");
  await s.close();
});

test("bad bodies are 400 and a proxied request is refused", async () => {
  const s = await setup();
  assert.equal((await s.post({ source: "a b", text: "x" })).status, 400);
  assert.equal((await s.post({ source: "x", text: "" })).status, 400);
  assert.equal((await s.post({ source: "x", text: "y", kind: "nope" })).status, 400);
  assert.equal((await s.post({ source: "x", text: "y" }, { "x-real-ip": "1.2.3.4" })).status, 403);
  assert.equal(s.feed.list({ limit: 10 }).length, 0);
  await s.close();
});
