// Test helper: a Control router on an ephemeral server with one logged-in device.
import express from "express";
import Database, { type Database as Db } from "better-sqlite3";
import { ControlStore } from "./store";
import { createControlRouter } from "./router";
import { LoginThrottle } from "./rate-limit";
import { serveApp } from "./test-http";
import type { ControlDeps } from "./auth";

export async function controlApp(extra: Partial<ControlDeps> = {}, db: Db = new Database(":memory:")) {
  const store = new ControlStore(db);
  const app = express();
  app.use("/control-api", createControlRouter({
    store, throttle: new LoginThrottle(), checkCredentials: (u, p) => u === "admin" && p === "pw", ...extra,
  }));
  const srv = await serveApp(app);
  const login = await srv.call("POST", "/control-api/v1/auth/login", { username: "admin", password: "pw", deviceName: "t" });
  const auth = { authorization: `Bearer ${login.json.deviceToken}` };
  const get = (p: string) => srv.call("GET", "/control-api/v1" + p, undefined, auth);
  const post = (p: string, body: unknown = {}) => srv.call("POST", "/control-api/v1" + p, body, auth);
  return { srv, store, auth, get, post, close: srv.close };
}
