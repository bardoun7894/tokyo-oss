import type { Database } from "better-sqlite3";
import type { RequestHandler } from "express";
import { OpsStore } from "../ops-store";
import type { LifeDeps } from "./index";

/**
 * The live life gateway. The dashboard router is loaded on the first request, not here: importing it opens life.db and pulls in
 * WhatsApp, so mounting the Control router (and every test that does) starts nothing.
 */
export function wireLife(db: Database): LifeDeps {
  let router: RequestHandler | null = null;
  const dashboard: RequestHandler = (req, res, next) => {
    router ??= require("../../dashboard/routes").default as RequestHandler;
    router(req, res, next);
  };
  return { dashboard, ops: new OpsStore(db) };
}
