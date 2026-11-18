import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { controlApp } from "../test-app";
import { OpsStore } from "../ops-store";
import type { AllowEntry } from "../ops-restart";
import type { Cap } from "../store";
import { GhIds } from "./ids";
import { ghRoutes, type GhDeps } from "./index";
import { assertWithinExample, fakeGh, fixture } from "./test-support";

const NOW = Date.parse("2026-10-17T13:00:00Z");

async function setup(caps: Cap[] = ["ops:read", "ops:write"], allowlist: AllowEntry[] = []) {
  const db = new Database(":memory:");
  const ops = new OpsStore(db);
  const gh = fakeGh(() => NOW);
  const deps: GhDeps = { client: gh, ids: new GhIds(db), ops, allowlist: () => allowlist, now: () => NOW };
  const t = await controlApp({ gh: deps }, db);
  t.store.setCaps(t.store.listDevices()[0]!.id, caps);
  const audits = () => db.prepare("SELECT action, subject, result FROM control_ops_audit ORDER BY id").all() as { action: string; subject: string; result: string }[];
  return { ...t, gh, deps, audits };
}

const entry = (over: Partial<AllowEntry> = {}): AllowEntry => ({ id: "nginx", kind: "systemd", name: "nginx", label: "Nginx", cooldownSec: 300, ...over });

test("T5.2 K1..K4, K6, K8 map the T0.5 fixtures to exactly the contract example's fields", async () => {
  const unit0 = fixture("fleet_services").services[0].name;
  const t = await setup(undefined, [entry({ name: unit0 })]);
  for (const [code, path] of [["K1", "/ops/gh/fleet"], ["K2", "/ops/gh/schedules"], ["K3", "/ops/gh/monitor"], ["K4", "/ops/gh/network"], ["K6", "/ops/gh/endpoints"], ["K8", "/ops/gh/host-projects"]] as const) {
    const r = await t.get(path);
    assert.equal(r.status, 200, code);
    assert.equal(r.json.reachable, true, code);
    assert.ok(!Number.isNaN(Date.parse(r.json.fetchedAt)), code);
    // Only the first two list items were mapped into the example, so a field that first appears in a later item is allowed by name.
    assertWithinExample(code, r.json, ["chains[].reason"]);
  }
  await t.close();
});

test("T5.2 fleet units carry restartId only when the unit is on the Tokyo allowlist (same name and kind, .service ignored)", async () => {
  const body = { services: [
    { name: "pi-dashboard.service", kind: "systemd", active: true, status: "running", enabled: true, since: "x" },
    { name: "herdr", kind: "systemd", active: true, status: "running", enabled: true },
    { name: "proxyapi", kind: "docker", active: true, status: "running", enabled: false },
    { name: "mesh-control", kind: "systemd", active: false, status: "dead", enabled: true },
  ] };
  const t = await setup(["ops:read"], [entry({ id: "pi", name: "pi-dashboard" }), entry({ id: "cli", kind: "systemd", name: "proxyapi" }), entry({ id: "mc", kind: "docker", name: "mesh-control" })]);
  t.gh.bodies.fleetServices = body;
  const units = (await t.get("/ops/gh/fleet")).json.units as any[];
  assert.deepEqual(units.map((u) => u.restartId ?? null), ["pi", null, null, null]);
  assert.ok(units.every((u) => /^g_[0-9a-f]{12}$/.test(u.id)));
  assert.equal(new Set(units.map((u) => u.id)).size, 4);
  assert.ok(!("since" in units[0]));
  const again = (await t.get("/ops/gh/fleet")).json.units as any[];
  assert.deepEqual(again.map((u) => u.id), units.map((u) => u.id), "ids are stable");
  await t.close();
});

test("T5.2 schedules have no command field, whatever GodHome sends", async () => {
  const t = await setup(["ops:read"]);
  t.gh.bodies.fleetSchedules = { schedules: [{ name: "backup.timer", source: "cron", next: "n", last: "l", command: "curl -H 'Authorization: Bearer sk-abc' x", cmd: "y", exec: "z", ExecStart: "w", line: "0 3 * * * /root/backup.sh" }] };
  const r = await t.get("/ops/gh/schedules");
  assert.deepEqual(Object.keys(r.json.schedules[0]).sort(), ["id", "last", "name", "next", "source"]);
  assert.ok(!/curl|sk-|Bearer|backup\.sh/.test(JSON.stringify(r.json)));
  await t.close();
});

test("T5.2 monitor and network keep counts and labels: no link hrefs, addresses, ports, binds, pids or process names", async () => {
  const t = await setup(["ops:read"]);
  t.gh.bodies.monitor = {
    containers: { running: 2, exited: 1, total: 3, list: [{ name: "web", state: "running", status: "Up 3 hours", ports: "0.0.0.0:8080->80/tcp", id: "abc" }] },
    links: { up: 1, down: 0, list: [{ name: "site", href: "https://10.1.2.3:8443/x", up: true, ms: 20, note: "ok" }] },
    hosts: { server: { host: "100.64.0.9", cpu: 1, ram: 2, disk: 3, uptime: "1d" }, "100.64.0.10": { host: "x", cpu: 5, ram: 6, disk: 7, uptime: "2d" } },
    services: [{ id: "tokyo", kind: "pm2", status: "online", where: "server", label: "Tokyo (:3030)", port: 3030, dir: "/root/tokyo" }],
    tools: { claude: "opus", opencode: "m", pi: "p", secret: "sk-zzz" }, tokens: { total: 5, byTool: { pi: 1 } },
  };
  const m = (await t.get("/ops/gh/monitor")).json;
  const dump = JSON.stringify(m);
  assert.ok(!/10\.1\.2\.3|8443|100\.64|0\.0\.0\.0|8080|3030|href|sk-zzz|\/root\//.test(dump), dump);
  assert.equal(m.services[0].label, "Tokyo");
  assert.deepEqual(Object.keys(m.hosts), ["server", "host 2"]);
  t.gh.bodies.network = {
    nodes: { data: [{ name: "mac", ip: "100.64.0.2", online: true, state: "ok", lastSeen: "t" }] },
    links: { data: [{ id: "l1", label: "mac -> server (:22)", from: "100.64.0.2", to: "x", kind: "tailnet", state: "ok", detail: "ssh root@10.0.0.1", ms: 9 }] },
    chains: { data: [{ id: "c1", label: "web", state: "down", reason: "port 8080 closed", steps: [{ detail: "/root/x/y" }] }] },
    exposure: { data: { state: "warn", entries: [{ port: 9961, bind: "0.0.0.0", process: "node", pid: 4, expected: false, cmdline: "/usr/bin/node /root/x.js", cwd: "/root/x" }, { port: 22, expected: true }] } },
  };
  t.gh.bodies.networkAlerts = { mode: "send", alerted: [{ key: "10.0.0.1:22", label: "x" }], deliveries: [{ ok: true, dry: false, events: ["e"] }] };
  const n = (await t.get("/ops/gh/network")).json;
  assert.deepEqual(n.exposure, { state: "warn", total: 2, unexpected: 1 });
  assert.deepEqual(n.alerts, { mode: "send", alerted: 1, lastDeliveryOk: true });
  assert.ok(!/100\.64|10\.0\.0|9961|8080|0\.0\.0\.0|\/usr|\/root|:22/.test(JSON.stringify(n)), JSON.stringify(n));
  await t.close();
});

test("T5.2 endpoints keep a base name, kind, status, project, infra and http only; ids are opaque", async () => {
  const t = await setup(["ops:read"]);
  t.gh.bodies.services = { services: [{ id: "static:/srv/app", name: "/srv/www/my-site", kind: "static", project: "my-site", status: "up", http: 200, binds: ["0.0.0.0:80"], links: [{ url: "https://x.example/", kind: "public" }], dir: "/srv/www/my-site", port: 80, containerPort: 8080, detail: "d", process: "nginx", infra: false }] };
  const s = (await t.get("/ops/gh/endpoints")).json.services[0];
  assert.deepEqual(Object.keys(s).sort(), ["http", "id", "infra", "kind", "name", "project", "status"]);
  assert.equal(s.name, "my-site");
  assert.match(s.id, /^g_[0-9a-f]{12}$/);
  await t.close();
});

test("T5.2 host projects: name, branch, dirty, kb, workflows and last commit only; refresh=1 uses the floored refresh read", async () => {
  const t = await setup(["ops:read"]);
  t.gh.bodies.projects = { projects: [{ name: "app", path: "/root/app", branch: "main", dirty: 2, hasKb: true, workflows: 3, lastCommit: "x".repeat(200), lastCommitAgo: "2h", error: "boom /root/app" }] };
  const p = (await t.get("/ops/gh/host-projects")).json.projects[0];
  assert.deepEqual(Object.keys(p).sort(), ["branch", "dirty", "hasKb", "lastCommit", "lastCommitAgo", "name", "workflows"]);
  assert.equal(p.lastCommit.length, 80);
  assert.equal(t.gh.reads.at(-1)!.key, "projects");
  await t.get("/ops/gh/host-projects?refresh=1");
  assert.equal(t.gh.reads.at(-1)!.key, "projectsRefresh");
  await t.get("/ops/gh/host-projects?refresh=2");
  assert.equal(t.gh.reads.at(-1)!.key, "projects");
  await t.close();
});

test("T5.2 a string with a path or a secret is scrubbed in every mapped field", async () => {
  const t = await setup(["ops:read"]);
  t.gh.bodies.monitor = { containers: { running: 1, exited: 0, total: 1, list: [{ name: "c", state: "running", status: "exited in /root/app/data with sk-live-abcdefghijklmnop" }] }, links: { up: 0, down: 0, list: [] }, hosts: {}, services: [], tools: {}, tokens: {} };
  const dump = JSON.stringify((await t.get("/ops/gh/monitor")).json);
  assert.ok(!/\/root\/app|sk-live/.test(dump), dump);
  await t.close();
});

test("T5.2 GodHome down: reads are 200 with reachable:false and empty lists, writes are 503", async () => {
  const t = await setup();
  t.gh.down = true;
  for (const p of ["/ops/gh/fleet", "/ops/gh/schedules", "/ops/gh/monitor", "/ops/gh/network", "/ops/gh/endpoints", "/ops/gh/host-projects"]) {
    const r = await t.get(p);
    assert.equal(r.status, 200, p);
    assert.equal(r.json.reachable, false, p);
  }
  assert.deepEqual((await t.get("/ops/gh/fleet")).json.units, []);
  const w = await t.post("/ops/gh/network/refresh");
  assert.equal(w.status, 503);
  assert.equal(w.json.error.code, "unavailable");
  await t.close();
});

test("T5.2 reads need ops:read; K5 and K7 need ops:write", async () => {
  const none = await setup([]);
  for (const p of ["/ops/gh/fleet", "/ops/gh/schedules", "/ops/gh/monitor", "/ops/gh/network", "/ops/gh/endpoints", "/ops/gh/host-projects"]) assert.equal((await none.get(p)).status, 403, p);
  await none.close();
  const ro = await setup(["ops:read"]);
  assert.equal((await ro.post("/ops/gh/network/refresh")).status, 403);
  assert.equal((await ro.post("/ops/gh/endpoints/refresh")).status, 403);
  assert.equal(ro.gh.writes.length, 0);
  await ro.close();
});

test("T5.2 K5 and K7: one GodHome refresh each, audited, 1 per 60 s per route (K5 does not use up K7)", async () => {
  const t = await setup();
  const a = await t.post("/ops/gh/network/refresh");
  assert.deepEqual([a.status, a.json], [200, { ok: true }]);
  const b = await t.post("/ops/gh/network/refresh");
  assert.equal(b.status, 429);
  assert.equal(b.json.error.code, "rate_limited");
  const c = await t.post("/ops/gh/endpoints/refresh");
  assert.deepEqual([c.status, c.json], [200, { ok: true }]);
  assert.equal((await t.post("/ops/gh/endpoints/refresh")).status, 429);
  assert.deepEqual(t.gh.writes.map((w) => w.key), ["networkRefresh", "servicesRefresh"]);
  assert.deepEqual(t.audits().map((a) => [a.action, a.result]), [["gh.K5", "ok"], ["gh.K7", "ok"]]);
  await t.close();
});

test("T5.2 only K8 asks for the projects refresh", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(__dirname + "/infra.ts", "utf8");
  assert.equal((src.match(/projectsRefresh/g) ?? []).length, 1);
});
