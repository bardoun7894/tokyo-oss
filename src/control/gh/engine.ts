import express from "express";
import { prepareToken } from "../actions/tokens";
import { findTrigger, TRIGGER_KIND } from "../actions/kinds/gh_trigger_fire";
import { clean, fromWrite, isOutcome, iso, pick, readRoute, refuse, resolveOpaque, rows, writeRoute, type GhArea } from "./common";
import { plainName } from "./client";

// K15..K24 (research-gh field allowlist): playbook lessons, workflow graphs and loops (GodHome triggers). Graph prompts and system text,
// loop inputs, watch paths and error text never leave. Running a graph or firing a loop is a fingerprint action (kinds/gh_*.ts).

const LESSON_KIND = "lesson";
const MAX_NODES = 100;
const MAX_EDGES = 300;

const strings = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max).map((x) => clean(x, 40)) : []);

function schedule(t: Record<string, unknown>): string | undefined {
  if (t.kind === "cron" && typeof t.cron === "string") return clean(t.cron, 60);
  if (t.kind === "continuous" && typeof t.everySec === "number") return `every ${t.everySec} s`;
  if (t.kind === "reflection" && typeof t.everyRuns === "number") return `every ${t.everyRuns} runs`;
  return undefined;
}

export function engineRoutes(d: GhArea): express.Router {
  const r = express.Router();
  const now = d.now ?? Date.now;
  const c = d.client;

  // K15: pending and approved lessons. Their files, run ids and scope are not copied.
  const lessons = (list: unknown) => rows(list).map((l) => ({
    id: d.ids.opaque(LESSON_KIND, String(l.id ?? ""), now()), ...pick(l, ["graph", "drafted", "approved", "flagged"], 80), ...pick(l, ["text"], 600),
  }));
  readRoute(r, d, "/ops/gh/playbook", () => [c.read("playbook")], ([b]) => ({ pending: lessons(b?.pending), approved: lessons(b?.approved) }));

  // K16 / K17: approve or reject a lesson. The client sends the opaque id; the GodHome id is resolved here.
  for (const [code, path, key, gone] of [
    ["K16", "/ops/gh/playbook/:id/approve", "lessonApprove", undefined],
    ["K17", "/ops/gh/playbook/:id/reject", "lessonReject", (j: any) => j?.ok === false],
  ] as const) {
    writeRoute(r, d, {
      code, method: "post", path, cap: "ops:write",
      run: async (req) => {
        const id = String(req.params.id);
        const got = resolveOpaque(d.ids, LESSON_KIND, id);
        if (isOutcome(got)) return got;
        return fromWrite(await c.write(key, { seg: [got.source] }), { subject: id, gone });
      },
    });
  }

  // K18: the graphs.
  readRoute(r, d, "/ops/gh/graphs", () => [c.read("graphs")], ([b]) => ({
    graphs: rows(b?.graphs).map((g) => ({ ...pick(g, ["name", "nodes", "edges", "loops", "valid"], 80), ...pick(g, ["description"], 160) })),
  }));

  // K19: one graph's shape: nodes (id, kind, model, role ref, tools, place, output type) and edges. No prompt, system or output text.
  readRoute(r, d, "/ops/gh/graphs/:name", (req) => [c.read("graph", { name: plainName("graph name", req.params.name) })], ([b]) => {
    const g = b?.graph;
    return {
      graph: {
        ...pick(g, ["name", "maxTransitions"], 80), ...pick(g, ["description"], 160),
        nodes: rows(g?.nodes, MAX_NODES).map((n) => ({
          ...pick(n, ["id", "kind", "model", "ref", "thinking", "x", "y"], 80), tools: strings(n.tools, 30),
          ...(typeof (n.output as any)?.type === "string" ? { outputType: clean((n.output as any).type, 40) } : {}),
        })),
        edges: rows(g?.edges, MAX_EDGES).map((e) => pick(e, ["from", "to"], 80)),
      },
    };
  }, { notFound404: true });

  // K20: prepare a graph run. The graph must exist now; nothing is sent to GodHome until the confirm (X16, kind gh_graph_run).
  writeRoute(r, d, {
    code: "K20", method: "post", path: "/ops/gh/graphs/:name/run", cap: "ops:run",
    run: async (req, device) => {
      const name = plainName("graph name", req.params.name);
      const got = await c.read("graph", { name });
      if (got.notFound) return refuse(404, "not_found", "No such graph", { subject: name });
      if (!got.reachable || got.data === null) return refuse(503, "unavailable", "GodHome is not reachable", { subject: name });
      const { actionId, expiresAt } = prepareToken(d.ops, { kind: "gh_graph_run", deviceId: device.id, subject: name, targetId: name, now: now() });
      return { status: 200, body: { actionId, kind: "gh_graph_run", label: clean(name, 80), expiresAt: iso(expiresAt) }, result: "ok", subject: name };
    },
  });

  // K21: the loops (GodHome triggers) with their brakes and counters.
  readRoute(r, d, "/ops/gh/loops", () => [c.read("triggers")], ([b]) => ({
    loops: rows(b?.triggers).map((t) => ({
      id: d.ids.opaque(TRIGGER_KIND, String(t.id ?? ""), now()), ...pick(t, ["graph", "kind", "enabled"], 80),
      ...(schedule(t) !== undefined ? { schedule: schedule(t) } : {}), ...pick(t, ["maxRuns", "maxCalls", "runs", "calls"]),
      ...(typeof t.lastFiredAt === "number" && Number.isFinite(t.lastFiredAt) ? { lastFiredAt: iso(t.lastFiredAt) } : {}),
    })),
  }));

  // K22: prepare firing a loop now (X16, kind gh_trigger_fire).
  writeRoute(r, d, {
    code: "K22", method: "post", path: "/ops/gh/loops/:id/fire", cap: "ops:run",
    run: async (req, device) => {
      const id = String(req.params.id);
      const found = resolveOpaque(d.ids, TRIGGER_KIND, id);
      if (isOutcome(found)) return found;
      const t = await findTrigger({ client: c, ids: d.ids }, id, false);
      if (t === "down") return refuse(503, "unavailable", "GodHome is not reachable", { subject: id });
      if (t === null) return refuse(404, "not_found", "That loop is gone", { subject: id });
      const { actionId, expiresAt } = prepareToken(d.ops, { kind: "gh_trigger_fire", deviceId: device.id, subject: id, targetId: id, now: now() });
      return { status: 200, body: { actionId, kind: "gh_trigger_fire", label: clean(t.graph, 80), expiresAt: iso(expiresAt) }, result: "ok", subject: id };
    },
  });

  // K23 / K24: reset a loop's counters, delete a loop. `ops:write`; the app asks the owner to confirm first (CS).
  writeRoute(r, d, {
    code: "K23", method: "post", path: "/ops/gh/loops/:id/reset", cap: "ops:write",
    run: async (req) => {
      const id = String(req.params.id);
      const got = resolveOpaque(d.ids, TRIGGER_KIND, id);
      if (isOutcome(got)) return got;
      return fromWrite(await c.write("triggerReset", { seg: [got.source] }), { subject: id, gone: (j) => j?.ok === false });
    },
  });
  writeRoute(r, d, {
    code: "K24", method: "delete", path: "/ops/gh/loops/:id", cap: "ops:write",
    run: async (req) => {
      const id = String(req.params.id);
      const got = resolveOpaque(d.ids, TRIGGER_KIND, id);
      if (isOutcome(got)) return got;
      return fromWrite(await c.write("triggerDelete", { seg: [got.source] }), { subject: id, gone: (j) => j?.ok === false });
    },
  });

  return r;
}
