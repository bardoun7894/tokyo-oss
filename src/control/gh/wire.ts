import type { Database } from "better-sqlite3";
import type { AllowEntry } from "../ops-restart";
import type { OpsStore } from "../ops-store";
import type { GhClient } from "./client";
import { GhIds } from "./ids";
import type { GhDeps } from "./index";

/** The GodHome area from its parts: the same client the agents area uses (one cache), the opaque id table, the Tokyo restart allowlist. */
export function wireGh(db: Database, ops: OpsStore, client: Pick<GhClient, "read" | "write">, allowlist: () => readonly AllowEntry[], feed?: GhDeps["feed"]): GhDeps {
  return { client, ids: new GhIds(db), ops, allowlist, feed };
}
