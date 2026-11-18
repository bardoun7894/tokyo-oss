// Test helper: raw http client against an ephemeral express server (keeps request paths unnormalised).
import http from "http";
import type { AddressInfo } from "net";
import type { Express } from "express";

export async function serveApp(app: Express) {
  const server = app.listen(0, "127.0.0.1");
  server.unref(); // a failing test must not keep the runner alive
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const data = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
      const req = http.request({ host: "127.0.0.1", port, method, path, headers: { ...(data !== undefined ? { "content-type": "application/json" } : {}), ...headers } }, (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => { let json: any = null; try { json = JSON.parse(buf); } catch { json = buf; } resolve({ status: res.statusCode!, json, headers: res.headers }); });
      });
      req.on("error", reject);
      if (data !== undefined) req.write(data);
      req.end();
    });
  return { call, close: () => new Promise<void>((r) => server.close(() => r())) };
}
