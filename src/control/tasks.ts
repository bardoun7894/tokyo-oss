import express from "express";
import type { ProjectRef } from "../project-registry";
import { errorBody } from "./contract";
import { PROJECT_NAME } from "./paging";
import { rateLimit } from "./rate-limit";

export const TASK_SENDER = "owner (control app)";
const MAX_TEXT = 2000;
export const ENGINES = ["claude", "dsh"] as const;
export type Engine = (typeof ENGINES)[number];

export interface TasksDeps {
  getProject(name: string): ProjectRef | undefined;
  /** proposeServerMission: raises the approval card. Returns the mission id, null when the project has no mission config. */
  propose(project: ProjectRef, msg: { content: string; sender_name: string; jid: string }, engine?: Engine): Promise<string | null>;
}

/** POST /tasks -- the self-chat `task` command from the phone. It only proposes; the owner approves. */
export function tasksRoutes(deps: TasksDeps): express.Router {
  const r = express.Router();
  r.post("/tasks", rateLimit({ max: 10, windowMs: 60_000 }), async (req, res) => {
    const { project, text, engine } = req.body ?? {};
    if (engine !== undefined && !(ENGINES as readonly unknown[]).includes(engine)) return res.status(400).json(errorBody("bad_request", `engine must be one of ${ENGINES.join(", ")}`));
    if (typeof project !== "string" || !PROJECT_NAME.test(project)) return res.status(400).json(errorBody("bad_request", "project is required"));
    if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT) return res.status(400).json(errorBody("bad_request", `text must be 1 to ${MAX_TEXT} characters`));
    const ref = deps.getProject(project);
    if (!ref) return res.status(404).json(errorBody("not_found", "No such project"));
    const missionId = await deps.propose(ref, { content: text, sender_name: TASK_SENDER, jid: "control-app" }, engine as Engine | undefined);
    if (!missionId) return res.status(404).json(errorBody("not_found", "No such project"));
    res.json({ status: "awaiting_approval", missionId, offerId: missionId, project: ref.name });
  });
  return r;
}
