import express from "express";
import { clean, fromWrite, pick, readRoute, refuse, rows, writeRoute, type GhArea } from "./common";

// K31..K34 (research-gh field allowlist): the model catalogue with health, cached quota and costs; roles; skills. Key names, sources,
// prompts, system text and repo rows never leave. There is no probe and no `quota?fresh=1`: neither route exists in the GET table.

const MAX_MODELS = 200;
const MODEL_ID = /^[A-Za-z0-9._:@+\-[\]]+(?:\/[A-Za-z0-9._:@+\-[\]]+)+$/;

const strings = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max).map((x) => clean(x, 40)) : []);

/** `{input, output}` of GodHome as `{inPrice, outPrice}`: no reply carries an "input" or "output" key (the A4 leak patterns). */
function prices(cost: unknown): Record<string, unknown> {
  const p = pick(cost, ["input", "output"]);
  return { ...(p.input !== undefined ? { inPrice: p.input } : {}), ...(p.output !== undefined ? { outPrice: p.output } : {}) };
}

/** The catalogue's models: yours first, then free, then paid, each id once. */
function allModels(m: any): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const list of [m?.yours, m?.free, m?.paid]) {
    for (const row of rows(list, MAX_MODELS)) {
      if (typeof row.id !== "string" || seen.has(row.id) || out.length >= MAX_MODELS) continue;
      seen.add(row.id);
      out.push(row);
    }
  }
  return out;
}

export function catalogRoutes(d: GhArea): express.Router {
  const r = express.Router();
  const c = d.client;

  // K31: models with health, the cached quota (never a fresh probe) and costs.
  readRoute(r, d, "/ops/gh/models", () => [c.read("models"), c.read("modelsHealth"), c.read("quota"), c.read("costs")], ([m, h, q, costs]) => {
    const list = allModels(m);
    const health = (h?.models && typeof h.models === "object" ? h.models : {}) as Record<string, unknown>;
    return {
      counts: pick(m?.counts, ["total", "yours", "free", "paid"]),
      models: list.map((x) => ({ ...pick(x, ["id", "name", "provider", "enabled", "free", "reasoning", "context", "providerKnown"], 120), cost: prices(x.cost) })),
      health: Object.fromEntries(list.filter((x) => Object.hasOwn(health, x.id as string)).map((x) => [clean(x.id, 120), pick(health[x.id as string], ["ok", "ms", "status"], 40)])),
      quota: rows(q?.providers, 30).map((p) => pick(p, ["id", "label", "state", "used", "headline"], 80)),
      costs: { jev: pick(costs?.jev, ["today", "d7", "d30"]), openrouter: pick(costs?.openrouter, ["daily", "weekly", "monthly"]) },
    };
  });

  // K32: enable or disable a model. The id (`provider/model`, with the slash raw or as %2F) must be in the catalogue GodHome lists now.
  writeRoute(r, d, {
    code: "K32", method: "post", path: "/ops/gh/models/*id/enabled", cap: "ops:write",
    run: async (req) => {
      // `*id` (Express 5 wildcard, one value per segment), not `:id`: nginx decodes %2F before the upstream (proxy_pass carries a URI), so the id arrives as provider/model either way.
      const raw = (req.params as Record<string, string | string[]>).id;
      const id = Array.isArray(raw) ? raw.join("/") : String(raw ?? "");
      const enabled = (req.body ?? {}).enabled;
      if (typeof enabled !== "boolean") return refuse(400, "bad_request", "enabled must be true or false", { subject: id.slice(0, 120) });
      if (id.length > 200 || !MODEL_ID.test(id) || id.split("/").some((s) => /^\.+$/.test(s))) return refuse(400, "bad_request", "id must be provider/model", { subject: id.slice(0, 120) });
      const params = JSON.stringify({ enabled });
      const got = await c.read("models", {}, { fresh: true });
      if (!got.reachable || got.data === null) return refuse(503, "unavailable", "GodHome is not reachable", { params, subject: id });
      if (!allModels(got.data).some((x) => x.id === id)) return refuse(404, "not_found", "No such model", { params, subject: id });
      return fromWrite(await c.write("modelEnabled", { body: { id, enabled } }), { params, subject: id });
    },
  });

  // K33: the role library, without prompt or system text.
  readRoute(r, d, "/ops/gh/roles", () => [c.read("roles")], ([b]) => ({
    roles: rows(b?.roles, 100).map((x) => ({ ...pick(x, ["id", "label", "model", "thinking", "builtin", "gate"], 80), ...pick(x, ["specialty"], 160), tools: strings(x.tools, 30), statuses: strings(x.statuses, 20) })),
  }));

  // K34: skill names and the skill graph's tiers and node counts.
  readRoute(r, d, "/ops/gh/skills", () => [c.read("skills"), c.read("skillsGraph")], ([s, g]) => ({
    skills: rows(s?.skills, 300).map((x) => pick(x, ["name"], 80)),
    graph: { tiers: strings(g?.tiers, 10), nodes: rows(g?.nodes, 300).map((x) => pick(x, ["name", "tier", "in", "out"], 80)) },
  }));

  return r;
}
