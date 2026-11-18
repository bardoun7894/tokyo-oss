import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import os from "os";
import routes from "./routes";
import db, { getDashboardPasswordHash, setDashboardPasswordHash, saveDashboardSession, getDashboardSession, clearDashboardSessions, pruneDashboardSessions } from "../db";
import { ControlStore } from "../control/store";
import { createControlRouter } from "../control/router";
import { revokeAllDevices } from "../control/auth";
import { liveRouteDeps } from "../control/wiring";
import { isTrustedAddress, trustedNetworks } from "./net-guard";
import { registerInternalStatus } from "./internal-status";
import { registerInternalDeploy } from "./internal-deploy";
import { registerInternalOwnerWhatsApp } from "./internal-owner-whatsapp";
import { registerInternalActionOffer } from "./internal-action-offer";
import { registerInternalIncidentOffer } from "./internal-incident-offer";
import { registerInternalTriage } from "./internal-triage";
import { registerInternalControlRun } from "./internal-control-run";
import { registerInternalFeed } from "./internal-feed";
import { liveFeed } from "../control/feed-live";

const DASHBOARD_DIR = path.join(__dirname, "..", "..", "dashboard", "dist");

// Sessions live in the database (src/db.ts), so a restart no longer signs every
// device out. Only the hash of a token is stored.
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createSession(): string {
  const token = crypto.randomBytes(32).toString("hex");
  saveDashboardSession(hashToken(token), Date.now() + SESSION_TTL);
  return token;
}

function isValidSession(token: string | undefined): boolean {
  if (!token) return false;
  return getDashboardSession(hashToken(token)) !== undefined;
}

// Credentials are compared byte-for-byte in constant time. A plain === returns on
// the first differing byte, which leaks the password one character at a time to
// anyone who can measure the response.
function sameSecret(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, which would itself leak length.
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

// A password set from Settings (salted scrypt in life.db) wins; until one is set,
// DASHBOARD_PASS from .env is the password.
export function checkPassword(candidate: string, envPassword: string): boolean {
  const stored = getDashboardPasswordHash();
  if (!stored) return sameSecret(candidate, envPassword);
  return sameSecret(hashPassword(candidate, stored.salt), stored.hash);
}

// Per-address login throttle. The network gate already keeps the public internet
// out; this bounds what a foothold on the tailnet can grind through.
const LOGIN_WINDOW = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;
const loginFailures = new Map<string, { count: number; until: number }>();

function loginBlockedFor(addr: string): number {
  const rec = loginFailures.get(addr);
  if (!rec) return 0;
  if (Date.now() > rec.until) { loginFailures.delete(addr); return 0; }
  return rec.count >= LOGIN_MAX_FAILURES ? rec.until - Date.now() : 0;
}

function noteLoginFailure(addr: string): void {
  const rec = loginFailures.get(addr);
  if (rec && Date.now() <= rec.until) rec.count += 1;
  else loginFailures.set(addr, { count: 1, until: Date.now() + LOGIN_WINDOW });
}

/**
 * Where to listen. Loopback always, plus the tailnet addresses this host has.
 * If Tailscale is down at boot there is no tailnet address to bind, and binding
 * loopback alone would make the dashboard unreachable from the phone -- so that
 * case widens to 0.0.0.0 and leans on the network gate, loudly.
 */
function dashboardHosts(): string[] {
  const override = process.env.DASHBOARD_HOSTS;
  if (override && override !== "auto") {
    return override.split(",").map(h => h.trim()).filter(Boolean);
  }
  const tailnet: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && isTrustedAddress(a.address)) tailnet.push(a.address);
    }
  }
  if (tailnet.length === 0) {
    console.warn("[dashboard] no tailnet address found -- binding 0.0.0.0 behind the network gate");
    return ["0.0.0.0"];
  }
  return ["127.0.0.1", ...tailnet];
}

function getReactHTML(sessionToken: string): string | null {
  const indexPath = path.join(DASHBOARD_DIR, "index.html");
  if (!fs.existsSync(indexPath)) return null;
  const html = fs.readFileSync(indexPath, "utf-8");
  return html.replace('window.__TOKEN__ = "__TOKEN__"', `window.__TOKEN__ = ${JSON.stringify(sessionToken)}`);
}

export function startDashboard(port: number): void {
  const username = process.env.DASHBOARD_USER || "admin";
  const password = process.env.DASHBOARD_PASS || process.env.DASHBOARD_TOKEN;
  if (!password) {
    console.warn("No DASHBOARD_PASS or DASHBOARD_TOKEN set — dashboard disabled.");
    return;
  }

  const pruned = pruneDashboardSessions();
  if (pruned > 0) console.log(`🔑 Dropped ${pruned} expired dashboard session(s)`);

  const app = express();
  // /control-api parses its own body (64 KB limit, envelope errors); everything else keeps the default parser.
  const defaultJson = express.json();
  app.use((req, res, next) => (req.path.startsWith("/control-api/") ? next() : defaultJson(req, res, next)));
  const controlStore = new ControlStore(db);

  // Network gate -- first middleware, so it also covers /login and the login API.
  // socket.remoteAddress, never req.ip: req.ip honours X-Forwarded-For when
  // trustProxy is on, and a header the caller controls cannot be the basis of an
  // access decision.
  app.use((req, res, next) => {
    if (isTrustedAddress(req.socket?.remoteAddress)) return next();
    console.warn(`[dashboard] refused ${req.method} ${req.path} from ${req.socket?.remoteAddress ?? "unknown"}`);
    res.status(403).json({ error: "Dashboard is reachable from loopback and the tailnet only" });
  });

  // Control mobile API: own bearer auth, so before the dashboard session middleware, after the net gate.
  app.use("/control-api", createControlRouter({
    store: controlStore,
    ...liveRouteDeps(db),
    checkCredentials: (u, p) => {
      // Both comparisons always run (same reasoning as the dashboard login).
      const userOk = sameSecret(u, username);
      const passOk = checkPassword(p, password);
      return userOk && passOk;
    },
  }));

  // Loopback-only status for another local service: after the net-guard, before
  // the session auth, so a same-host process polls it without a dashboard login.
  registerInternalStatus(app);
  // Same gate, for "Deploy it?" raised by a Claude session Tokyo did not start.
  registerInternalDeploy(app);
  // Owner self-chat on WhatsApp for the factory's alerts (`owner-notify`).
  registerInternalOwnerWhatsApp(app);
  // And for generic action cards (`tokyo-offer`).
  registerInternalActionOffer(app);
  // Incident approval cards: the answer signals an on-call Temporal workflow.
  registerInternalIncidentOffer(app);
  registerInternalTriage(app);
  registerInternalControlRun(app, () => controlStore);
  // Messages that reach the owner's Telegram without going through Tokyo's bot.
  registerInternalFeed(app, liveFeed);

  // Allow static assets without auth
  app.get("/favicon.ico", (_req, res) => res.status(204).end());
  app.use("/assets", express.static(path.join(DASHBOARD_DIR, "assets"), { maxAge: "1y" }));

  // Login page (no auth needed)
  app.get("/login", (_req, res) => {
    const html = getReactHTML("");
    if (!html) {
      res.status(503).type("text").send("Dashboard not built -- run `npm run build` in dashboard/");
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  });

  // Login API (no auth needed)
  app.post("/api/auth/login", (req, res) => {
    const addr = req.socket?.remoteAddress ?? "unknown";
    const blockedFor = loginBlockedFor(addr);
    if (blockedFor > 0) {
      res.status(429).json({ error: `Too many attempts -- retry in ${Math.ceil(blockedFor / 1000)}s` });
      return;
    }
    const { username: u, password: p } = req.body || {};
    // Both comparisons always run: short-circuiting on the username would answer
    // "is this a real user?" faster than "is this the right password?".
    const userOk = typeof u === "string" && sameSecret(u, username);
    const passOk = typeof p === "string" && checkPassword(p, password);
    if (userOk && passOk) {
      loginFailures.delete(addr);
      res.json({ token: createSession() });
      return;
    }
    noteLoginFailure(addr);
    res.status(401).json({ error: "Invalid credentials" });
  });

  // Auth middleware
  app.use((req, res, next) => {
    // Get session from cookie or Authorization header
    const cookie = req.headers.cookie?.split(";").find(c => c.trim().startsWith("tokyo_session="));
    const sessionToken = cookie?.split("=")[1]?.trim();
    const bearer = req.headers.authorization?.replace("Bearer ", "");

    const token = bearer || sessionToken;

    if (isValidSession(token)) return next();

    // If it's an API call, return 401 JSON
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Otherwise redirect to login
    res.redirect("/login");
  });

  // Change password (behind auth). Shares the login throttle, and signs out every
  // other session so a cookie issued under the old password stops working.
  app.post("/api/auth/password", (req, res) => {
    const addr = req.socket?.remoteAddress ?? "unknown";
    const blockedFor = loginBlockedFor(addr);
    if (blockedFor > 0) {
      res.status(429).json({ error: `Too many attempts -- retry in ${Math.ceil(blockedFor / 1000)}s` });
      return;
    }
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== "string" || !checkPassword(currentPassword, password)) {
      noteLoginFailure(addr);
      res.status(403).json({ error: "Current password is wrong" });
      return;
    }
    if (typeof newPassword !== "string" || newPassword.length < 10 || newPassword.length > 200) {
      res.status(400).json({ error: "New password must be 10 to 200 characters" });
      return;
    }
    const salt = crypto.randomBytes(16).toString("hex");
    setDashboardPasswordHash(salt, hashPassword(newPassword, salt));

    const cookie = req.headers.cookie?.split(";").find(c => c.trim().startsWith("tokyo_session="));
    const current = req.headers.authorization?.replace("Bearer ", "") || cookie?.split("=")[1]?.trim();
    clearDashboardSessions(current ? hashToken(current) : undefined);
    revokeAllDevices(controlStore);
    console.log("🔑 Dashboard password changed from Settings");
    res.json({ ok: true });
  });

  // Serve dashboard
  const serveDashboard = (req: express.Request, res: express.Response) => {
    // Get session token to inject into React app
    const cookie = req.headers.cookie?.split(";").find(c => c.trim().startsWith("tokyo_session="));
    const sessionToken = cookie?.split("=")[1]?.trim() || req.headers.authorization?.replace("Bearer ", "") || "";

    const html = getReactHTML(sessionToken);
    if (!html) {
      res.status(503).type("text").send("Dashboard not built -- run `npm run build` in dashboard/");
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  };

  app.get("/", serveDashboard);

  // Business WhatsApp link QR. After the session middleware above, so it needs a dashboard login.

  // Mount API routes
  app.use(routes);

  // SPA fallback: every non-API GET gets the React shell, so a deep link or a
  // reload on any client-side route works without listing routes here.
  app.get("/{*splat}", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    serveDashboard(req, res);
  });

  // Bind only where the dashboard is meant to be reachable. A refused SYN beats a
  // 403: the request never reaches Node, so there is nothing to grind against.
  for (const host of dashboardHosts()) {
    app.listen(port, host, () => {
      console.log(`📊 Dashboard listening on ${host}:${port} (React)`);
    }).on("error", (err: NodeJS.ErrnoException) => {
      console.error(`[dashboard] cannot bind ${host}:${port} -- ${err.message}`);
    });
  }
  console.log(`📊 Dashboard trusts ${trustedNetworks().join(", ")} and loopback`);
}
