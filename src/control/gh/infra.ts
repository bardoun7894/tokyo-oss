import express from "express";
import { fromWrite, baseName, clean, pick, readRoute, rows, writeRoute, type GhArea } from "./common";
import type { AllowEntry } from "../ops-restart";

// K1..K8 (spec 012 plan section 3, research-gh field allowlist): fleet, schedules, monitor, network, endpoints, host projects.
// Only the named fields are copied. Link hrefs, addresses, ports, binds, pids, process names, cwd and command lines never leave.

export interface InfraDeps extends GhArea {
  allowlist(): readonly AllowEntry[];
}

const unitName = (n: unknown): string => (typeof n === "string" ? n.replace(/\.service$/, "") : "");
const ONE_PER_MINUTE = { max: 1, windowMs: 60_000, perRoute: true };

/** A host key for the phone: a plain label (`server`, `mac`), else a numbered stand-in; never an address. */
function hostLabel(key: string, i: number): string {
  return /^[A-Za-z][A-Za-z0-9_-]{0,29}$/.test(key) ? key : `host ${i + 1}`;
}

export function infraRoutes(d: InfraDeps): express.Router {
  const r = express.Router();
  const now = d.now ?? Date.now;
  const c = d.client;

  // K1: fleet units. `restartId` is the Tokyo allowlist id (S2 restarts it) when the unit's name and kind are on that list.
  readRoute(r, d, "/ops/gh/fleet", () => [c.read("fleetServices")], ([body]) => {
    const list = d.allowlist();
    return {
      units: rows(body?.services).map((u) => {
        const entry = list.find((e) => e.kind === u.kind && unitName(e.name) === unitName(u.name));
        return { id: d.ids.opaque("unit", String(u.name ?? ""), now()), ...pick(u, ["name", "kind", "status", "active", "enabled"], 80), ...(entry ? { restartId: entry.id } : {}) };
      }),
    };
  });

  // K2: timers. No command line is ever requested or copied.
  readRoute(r, d, "/ops/gh/schedules", () => [c.read("fleetSchedules")], ([body]) => ({
    schedules: rows(body?.schedules).map((s) => ({ id: d.ids.opaque("timer", String(s.name ?? ""), now()), ...pick(s, ["name", "next", "last", "source"], 80) })),
  }));

  // K3: containers, links, hosts, services and tool models, as counts and labels.
  readRoute(r, d, "/ops/gh/monitor", () => [c.read("monitor")], ([m]) => {
    const hosts = Object.entries((m?.hosts && typeof m.hosts === "object" ? m.hosts : {}) as Record<string, unknown>).slice(0, 10);
    const tools = (m?.tools && typeof m.tools === "object" ? m.tools : {}) as Record<string, unknown>;
    return {
      containers: { ...pick(m?.containers, ["running", "exited", "total"]), list: rows(m?.containers?.list).map((x) => pick(x, ["name", "state", "status"], 80)) },
      links: { ...pick(m?.links, ["up", "down"]), list: rows(m?.links?.list).map((x) => pick(x, ["name", "ms", "note", "up"], 80)) },
      hosts: Object.fromEntries(hosts.map(([k, v], i) => [hostLabel(k, i), pick(v, ["cpu", "disk", "ram", "uptime"], 40)])),
      services: rows(m?.services).map((s) => pick(s, ["id", "kind", "status", "where", "label"], 80)),
      tools: Object.fromEntries(["claude", "opencode", "pi"].filter((k) => typeof tools[k] === "string").map((k) => [k, clean(tools[k], 80)])),
      tokens: pick(m?.tokens, ["total"]),
    };
  });

  // K4: network sweep as labels and counts.
  readRoute(r, d, "/ops/gh/network", () => [c.read("network"), c.read("networkAlerts")], ([n, a]) => {
    const exposure = n?.exposure?.data;
    const entries: unknown[] = Array.isArray(exposure?.entries) ? exposure.entries : [];
    const delivery = Array.isArray(a?.deliveries) ? a.deliveries[0] : undefined;
    return {
      chains: rows(n?.chains?.data).map((x) => pick(x, ["id", "label", "state", "reason"], 80)),
      links: rows(n?.links?.data).map((x) => pick(x, ["id", "kind", "state", "ms", "label"], 80)),
      nodes: rows(n?.nodes?.data).map((x) => pick(x, ["name", "online", "state", "lastSeen"], 60)),
      exposure: { ...pick(exposure, ["state"], 20), total: entries.length, unexpected: entries.filter((e) => typeof e === "object" && e !== null && !(e as any).expected).length },
      alerts: { ...pick(a, ["mode"], 20), alerted: Array.isArray(a?.alerted) ? a.alerted.length : 0, ...(typeof delivery?.ok === "boolean" ? { lastDeliveryOk: delivery.ok } : {}) },
    };
  });

  // K5: start a network sweep (GodHome runs it in the background over ssh).
  writeRoute(r, d, {
    code: "K5", method: "post", path: "/ops/gh/network/refresh", cap: "ops:write", limit: ONE_PER_MINUTE,
    run: async () => fromWrite(await c.write("networkRefresh"), { subject: "network" }),
  });

  // K6: GodHome's services list ("Endpoints" in the app). Ports, binds, directories and URLs are dropped.
  readRoute(r, d, "/ops/gh/endpoints", () => [c.read("services")], ([body]) => ({
    services: rows(body?.services).map((s) => ({
      id: d.ids.opaque("endpoint", String(s.id ?? s.name ?? ""), now()), name: baseName(s.name), ...pick(s, ["kind", "status", "project", "infra", "http"], 80),
    })),
  }));

  // K7: refresh that list.
  writeRoute(r, d, {
    code: "K7", method: "post", path: "/ops/gh/endpoints/refresh", cap: "ops:write", limit: ONE_PER_MINUTE,
    run: async () => fromWrite(await c.write("servicesRefresh"), { subject: "endpoints" }),
  });

  // K8: repos on the host. `?refresh=1` is the one place the floored GodHome refresh is asked for.
  readRoute(r, d, "/ops/gh/host-projects", (req) => [c.read(req.query.refresh === "1" ? "projectsRefresh" : "projects")], ([body]) => ({
    projects: rows(body?.projects).map((p) => ({ ...pick(p, ["name", "branch", "dirty", "hasKb", "workflows", "lastCommitAgo"], 60), ...pick(p, ["lastCommit"], 80) })),
  }));

  return r;
}
