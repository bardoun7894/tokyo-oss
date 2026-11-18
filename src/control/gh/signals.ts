import express from "express";
import { clean, fromWrite, numMap, pick, readRoute, refuse, rows, stableId, writeRoute, type GhArea } from "./common";
import { GhInputError } from "./client";
import { GH_ID } from "./ids";

// K9..K14 (research-gh field allowlist): world events, control sites and missions, inbox, hygiene. No GodHome mission write and no
// hygiene fix route exist here: a mission is answered from its Approvals card (`/offers`), a fix is not offered in 004.

const ONE_PER_MINUTE = { max: 1, windowMs: 60_000, perRoute: true };
const MISSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FIX_ID = /^[a-z0-9_]{1,40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const DEFAULT_WORLD_LIMIT = 50;
const MAX_WORLD_LIMIT = 500;
const MAX_MISSIONS = 50;

/** `since` (ISO-8601) and `limit` (an integer, 1..500, default 50) of K9, or a GhInputError (the route answers 400). */
function worldParams(q: express.Request["query"]): { since?: string; limit: number } {
  const { since, limit } = q;
  if (since !== undefined && (typeof since !== "string" || !ISO.test(since) || Number.isNaN(Date.parse(since)))) throw new GhInputError("since must be ISO-8601");
  if (limit !== undefined && (typeof limit !== "string" || !/^\d{1,4}$/.test(limit) || Number(limit) < 1 || Number(limit) > MAX_WORLD_LIMIT)) throw new GhInputError(`limit must be an integer 1 to ${MAX_WORLD_LIMIT}`);
  return { ...(since !== undefined ? { since } : {}), limit: limit === undefined ? DEFAULT_WORLD_LIMIT : Number(limit) };
}

export function signalsRoutes(d: GhArea): express.Router {
  const r = express.Router();
  const now = d.now ?? Date.now;
  const c = d.client;

  // K9: hosts, projects, what needs the owner, workers and recent events. The `life` block of GodHome's world state is never read.
  readRoute(r, d, "/ops/gh/world", (req) => [c.read("worldState"), c.read("worldEvents", worldParams(req.query))], ([s, e]) => ({
    hosts: rows(s?.hosts).map((h) => pick(h, ["id", "name", "up"], 60)),
    projects: rows(s?.projects).map((p) => ({ ...pick(p, ["slug", "status", "kind", "host", "work_30d", "xp"], 60), counts: numMap(p.counts), ...(typeof p.last_event_ts === "string" ? { lastEventAt: clean(p.last_event_ts, 40) } : {}) })),
    needsYou: rows(s?.needs_you).map((n) => pick(n, ["project", "title", "since"], 160)),
    workers: rows(s?.workers).map((w) => ({ id: stableId("worker", String(w.id ?? w.label ?? "")), ...pick(w, ["label", "model", "project", "source", "started", "status", "host"], 80) })),
    events: rows(e?.events).map((x) => ({ id: stableId("event", String(x.id ?? `${x.ts}|${x.title}`)), ...pick(x, ["ts", "kind", "host", "project", "status", "actor", "model", "source"], 80), ...pick(x, ["title"], 160) })),
  }));

  // K10: sites (status, latency, git facts), missions as links to their Approvals card, what needs the owner.
  readRoute(r, d, "/ops/gh/control", () => [c.read("control")], ([body]) => ({
    sites: rows(body?.sites?.sites).map((s) => ({ ...pick(s, ["name", "deploy"], 80), health: pick(s.health, ["state", "ms"], 40), git: pick(s.git, ["branch", "commit", "ahead", "behind", "dirty", "ago"], 80) })),
    missions: rows(body?.missions?.missions).filter((m) => typeof m.id === "string" && MISSION_ID.test(m.id)).slice(0, MAX_MISSIONS)
      .map((m) => ({ missionId: m.id as string, ...pick(m, ["project", "state"], 60) })),
    needsYou: rows(body?.needsYou).map((n) => pick(n, ["kind", "severity", "tab", "title"], 160)),
  }));

  // K11: re-check the sites now (GodHome runs it in the background).
  writeRoute(r, d, {
    code: "K11", method: "post", path: "/ops/gh/control/sites/refresh", cap: "ops:write", limit: ONE_PER_MINUTE,
    run: async () => fromWrite(await c.write("sitesRefresh"), { subject: "sites" }),
  });

  // K12: failed runs and units that need attention. The id stands for {kind, title, at}, which K13 sends back to GodHome.
  readRoute(r, d, "/ops/gh/inbox", () => [c.read("inbox")], ([body]) => ({
    items: rows(body?.items).filter((i) => typeof i.kind === "string" && typeof i.title === "string" && i.kind.length <= 60 && i.title.length <= 300 && (i.at === undefined || (typeof i.at === "string" && i.at.length <= 40)))
      .map((i) => ({
        id: d.ids.opaque("inbox", JSON.stringify({ kind: i.kind, title: i.title, ...(i.at !== undefined ? { at: i.at } : {}) }), now()),
        ...pick(i, ["kind", "title", "at", "runId"], 160),
      })),
  }));

  // K13: dismiss one inbox item by its opaque id.
  writeRoute(r, d, {
    code: "K13", method: "post", path: "/ops/gh/inbox/:id/dismiss", cap: "ops:write",
    run: async (req) => {
      const id = String(req.params.id);
      if (!GH_ID.test(id)) return refuse(400, "bad_request", `id must match ${GH_ID.source}`, { subject: id.slice(0, 40) });
      const source = d.ids.resolve("inbox", id);
      if (source === null) return refuse(404, "not_found", "No such inbox item", { subject: id });
      return fromWrite(await c.write("inboxDismiss", { body: JSON.parse(source) }), { subject: id });
    },
  });

  // K14: findings and the names of the fixes. There is no fix action.
  readRoute(r, d, "/ops/gh/hygiene", () => [c.read("hygieneFindings"), c.read("hygieneFixes")], ([f, x]) => ({
    errors: Array.isArray(f?.errors) ? f.errors.length : typeof f?.errors === "number" ? f.errors : 0,
    findings: rows(f?.findings).map((i) => ({ id: stableId("finding", `${i.check}|${i.scope}`), ...pick(i, ["check", "severity", "scope", "fix", "cheap"], 80), ...pick(i, ["title"], 120) })),
    fixes: Object.entries((x && typeof x === "object" ? x : {}) as Record<string, any>).filter(([k, v]) => FIX_ID.test(k) && typeof v === "object" && v !== null).slice(0, 30)
      .map(([k, v]) => ({ id: k, ...pick(v, ["label", "safety"], 80), needsTarget: v.needs_target === true })),
  }));

  return r;
}
