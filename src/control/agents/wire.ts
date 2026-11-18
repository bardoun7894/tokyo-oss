import type { Database } from "better-sqlite3";
import { PROJECTS } from "../../project-registry";
import { TriageStore } from "../../finish-apps/triage-store";
import type { ActionKind } from "../actions/confirm";
import { realExec } from "../ops-restart";
import type { OpsStore } from "../ops-store";
import { isCustomer } from "../projects";
import { ControlStore } from "../store";
import type { GhClient } from "../gh/client";
import { GhIds } from "../gh/ids";
import type { OpsGodhome, OpsResult } from "../ops-godhome";
import { agentPromptKind } from "./kinds/agent_prompt";
import { agentRunKind, type AgentRunKindDeps } from "./kinds/agent_run";
import type { AgentsDeps } from "./routes";
import { startRunVia, type StartRun } from "./start";
import { macReach, type TargetProject } from "./targets";

type Runner = typeof import("../../claude-runner");

export interface AgentsBuild {
  ops: OpsStore;
  runs: AgentRunKindDeps["runs"];
  projects(): readonly TargetProject[];
  isReportOnly(name: string): boolean;
  macOnline(): Promise<boolean>;
  startRun: StartRun;
  ids: GhIds;
  /** GodHome's herdr agents; `fresh` skips the cache (the confirm of a prompt). */
  herdrAgents(fresh?: boolean): Promise<OpsResult>;
  client: Pick<GhClient, "postAgentPrompt">;
  newRunId?: () => string;
  now?: () => number;
  feed?: AgentRunKindDeps["feed"];
}

/** The agents area from injected parts; the live wiring and the tests build it the same way. */
export function buildAgents(b: AgentsBuild): AgentsDeps {
  const targets = { projects: b.projects, isReportOnly: b.isReportOnly, macOnline: b.macOnline };
  const kinds: ActionKind[] = [
    agentRunKind({ ops: b.ops, targets, runs: b.runs, startRun: b.startRun, newRunId: b.newRunId, feed: b.feed }),
    agentPromptKind({ ops: b.ops, ids: b.ids, listAgents: b.herdrAgents, client: b.client, feed: b.feed }),
  ];
  return { targets, ops: b.ops, runs: b.runs, kinds, live: { ids: b.ids, herdrAgents: b.herdrAgents }, now: b.now };
}

/**
 * The live agents area. `startRun` reaches claude-runner's offer backends on first use (like the other routes), so mounting
 * starts nothing. Report-only means the triage snapshot flags the project as a customer's or does not list it. The Mac probe is the one
 * claude-runner uses (`ssh mac echo ok`), cached for 30 s.
 */
export function wireAgents(db: Database, ops: OpsStore, godhome: Pick<OpsGodhome, "herdrAgents">, client: Pick<GhClient, "postAgentPrompt">, load: () => Runner, feed?: AgentRunKindDeps["feed"]): AgentsDeps {
  const triage = new TriageStore(db);
  // Fail closed (as write-spec): a project the snapshot does not list is not startable, and a snapshot that cannot be read
  // throws, which G1/G2 answer 503 and the X16 check refuses with 503.
  const reportOnly = (name: string): boolean => {
    const entry = triage.latest().projects.find((p) => p.name === name);
    return entry ? isCustomer(entry as unknown as Record<string, unknown>) : true;
  };
  return buildAgents({
    ops,
    runs: new ControlStore(db),
    projects: () => PROJECTS.map((p) => ({ name: p.name, location: p.location })),
    isReportOnly: reportOnly,
    macOnline: macReach(realExec),
    ids: new GhIds(db),
    herdrAgents: (fresh) => godhome.herdrAgents(fresh),
    client,
    startRun: (a) => {
      const b = load().controlOfferBackends();
      return startRunVia({ createOffer: b.createOffer, answerAction: b.answerAction })(a);
    },
    feed,
  });
}
