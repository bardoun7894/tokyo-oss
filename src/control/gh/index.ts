import express from "express";
import type { ActionKind } from "../actions/confirm";
import type { AllowEntry } from "../ops-restart";
import type { GhArea } from "./common";
import { ghGraphRunKind } from "../actions/kinds/gh_graph_run";
import { ghTriggerFireKind } from "../actions/kinds/gh_trigger_fire";
import { ghFactoryRunKind } from "../actions/kinds/gh_factory_run";
import { terminalKillKind } from "../actions/kinds/terminal_kill";
import { catalogRoutes } from "./catalog";
import { engineRoutes } from "./engine";
import { factoryRoutes } from "./factory";
import { infraRoutes } from "./infra";
import { signalsRoutes } from "./signals";
import { terminalsRoutes } from "./terminals";

/** The GodHome extras (K1..K36): the shared parts every module is built from, plus the Tokyo restart allowlist (K1's `restartId`). */
export interface GhDeps extends GhArea {
  allowlist(): readonly AllowEntry[];
}

/** The action kinds of the GodHome area; wiring hands them to the ops confirm route (X16). */
export function ghKinds(deps: GhDeps): ActionKind[] {
  const k = { ops: deps.ops, client: deps.client, feed: deps.feed };
  return [ghGraphRunKind(k), ghTriggerFireKind({ ...k, ids: deps.ids }), ghFactoryRunKind(k), terminalKillKind({ ...k, ids: deps.ids })];
}

export function ghRoutes(deps: GhDeps): express.Router {
  const r = express.Router();
  r.use(infraRoutes(deps));
  r.use(signalsRoutes(deps));
  r.use(engineRoutes(deps));
  r.use(factoryRoutes(deps));
  r.use(catalogRoutes(deps));
  r.use(terminalsRoutes(deps));
  return r;
}
