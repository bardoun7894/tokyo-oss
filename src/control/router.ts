import express, { type NextFunction, type Request, type Response } from "express";
import { bearerAuth, deviceRoutes, loginHandler, type ControlDeps } from "./auth";
import { errorBody } from "./contract";
import { countsRoutes } from "./counts";
import { factoryRoutes } from "./factory";
import { factoryRegistryRoutes } from "./factory-routes";
import { feedRoutes } from "./feed";
import { offersRoutes } from "./offers";
import { opsRoutes } from "./ops";
import { panelRoutes } from "./panel";
import { projectsRoutes } from "./projects";
import { rateLimit } from "./rate-limit";
import { runsRoutes } from "./runs";
import { tasksRoutes } from "./tasks";
import { writeSpecRoutes } from "./write-spec";
import { pushRoutes } from "./push/routes";
import { agentsRoutes } from "./agents/routes";
import { servicesRoutes } from "./services/routes";
import { lifeRoutes } from "./life/index";
import { ghRoutes } from "./gh/index";

const BODY_LIMIT = "64kb";

/**
 * The Control API, to be mounted at `/control-api`. Everything under it ends here: the final
 * handlers answer 404 for any path the v1 router does not own, so no request that came in
 * through this prefix can fall through to the dashboard or the internal endpoints.
 */
export function createControlRouter(deps: ControlDeps): express.Router {
  const root = express.Router();
  root.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  root.use(express.json({ limit: BODY_LIMIT }));

  const v1 = express.Router();
  v1.post("/auth/login", loginHandler(deps));
  v1.use(bearerAuth(deps));
  v1.use(rateLimit({ max: 120, windowMs: 60_000, key: (req) => (req as Request & { deviceId?: string }).deviceId ?? "anon" }));
  v1.use(deviceRoutes(deps));
  const now = deps.now ?? Date.now;
  const monitor = deps.monitor;
  if (monitor) v1.use(async (req, _res, next) => { if (/^\/(offers|runs|counts)\b/.test(req.path)) await monitor.refresh(); next(); });
  if (deps.projects) v1.use(projectsRoutes(deps.projects, deps.store));
  if (deps.offers) v1.use(offersRoutes(deps.offers, monitor));
  if (deps.projects && deps.offers && deps.writeSpec) v1.use(writeSpecRoutes(deps.writeSpec, deps.projects, deps.offers, deps.store, now));
  if (deps.tasks) v1.use(tasksRoutes(deps.tasks));
  if (deps.feed) v1.use(feedRoutes(deps.feed));
  if (deps.panel) v1.use(panelRoutes(deps.panel));
  if (deps.factory) v1.use(factoryRoutes(deps.factory));
  v1.use(factoryRegistryRoutes());
  if (deps.ops) v1.use(opsRoutes({ ...deps.ops, tasks: deps.ops.tasks ?? deps.tasks, runs: deps.ops.runs ?? { getRun: (id) => deps.store.getRun(id) }, now: deps.ops.now ?? now }));
  if (deps.push) v1.use(pushRoutes(deps.push));
  if (deps.agents) v1.use(agentsRoutes(deps.agents));
  if (deps.services) v1.use(servicesRoutes(deps.services));
  if (deps.life) v1.use(lifeRoutes(deps.life));
  if (deps.gh) v1.use(ghRoutes(deps.gh));
  v1.use(runsRoutes(deps.store, deps.runs, monitor));
  v1.use(countsRoutes(deps.store, deps.offers, now, monitor, deps.factory, deps.ops));
  root.use("/v1", v1);

  root.use((_req, res) => { res.status(404).json(errorBody("not_found", "Not found")); });
  root.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err?.type === "entity.too.large") return res.status(413).json(errorBody("bad_request", "Request body too large"));
    if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) return res.status(400).json(errorBody("bad_request", "Malformed JSON"));
    console.error("[control-api]", err?.message ?? err);
    res.status(500).json(errorBody("unavailable", "Internal error"));
  });
  return root;
}
