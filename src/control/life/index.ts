import express from "express";
import { requireCap } from "../auth";
import type { Device } from "../store";
import { stubRoutes } from "../stub";
import { lifeGateway, type GatewayDeps } from "./gateway";
import { buildManifest } from "./manifest";
import { defaultMedia } from "./media";

/** The life gateway (L0 and L*): the gateway and manifest are T4.2 to T4.5, the nginx upload location and its switch are Z4. */
export interface LifeDeps extends GatewayDeps {}

export function lifeRoutes(deps: LifeDeps): express.Router {
  const r = express.Router();
  const uploads = { ...defaultMedia(), ...deps.media }.uploads;
  // L0: what this device may do in each Life section.
  r.get("/life/manifest", requireCap("life:read"), (_req, res) => {
    res.json(buildManifest((res.locals.device as Device).caps, uploads()));
  });
  r.use("/life/api", lifeGateway(deps));
  r.use(stubRoutes(["/life"]));
  return r;
}
