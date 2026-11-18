import express from "express";
import { errorBody } from "./contract";

/** An area that is mounted but not built yet: every path under `prefixes` answers 501 in the control envelope (spec 012 T1.0). */
export function stubRoutes(prefixes: readonly string[]): express.Router {
  const r = express.Router();
  r.use(prefixes as string[], (_req, res) => { res.status(501).json(errorBody("unavailable", "Not implemented")); });
  return r;
}
