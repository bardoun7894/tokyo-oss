import express from "express";
import type { AgentScanner } from "./agent-scan";
import type { Godhome } from "./godhome";

/**
 * Read-only panel routes: what runs where (GET /agents) and how the machines are (GET /system).
 * Nothing here starts, stops or prompts anything.
 */
export interface PanelDeps {
  scanner?: AgentScanner;
  godhome?: Godhome;
  /** Projects that can take a task from the phone, with their default engine. */
  taskProjects?: () => { name: string; engine: "claude" | "dsh" }[];
}

export function panelRoutes(deps: PanelDeps): express.Router {
  const r = express.Router();

  r.get("/agents", async (_req, res) => {
    const [scan, gh] = await Promise.all([
      deps.scanner ? deps.scanner.scan() : Promise.resolve({ agents: [], hosts: { server: false, mac: false } }),
      deps.godhome?.agents() ?? Promise.resolve(null),
    ]);
    res.json({
      // pid is used for the id only; the phone never gets a handle it could act on.
      processes: scan.agents.map(({ pid: _pid, ...a }) => a),
      hosts: scan.hosts,
      godhome: gh ?? { reachable: false, herdr: [], graphRuns: [], launches: [] },
    });
  });

  r.get("/system", async (_req, res) => {
    const gh = await (deps.godhome?.system() ?? Promise.resolve(null));
    res.json(gh ?? { reachable: false, services: [], quota: [], costs: null });
  });

  r.get("/tasks/options", (_req, res) => {
    res.json({ engines: ["claude", "dsh"], projects: deps.taskProjects?.() ?? [] });
  });

  return r;
}
