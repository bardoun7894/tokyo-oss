import type { Database } from "better-sqlite3";
import { fsRepoReader } from "../finish-apps/summary";
import { TriageStore } from "../finish-apps/triage-store";
import { getProject } from "../project-registry";
import { laptopTaskOpenForRun } from "../laptop-open";
import { laptopHost, serverHost } from "../herdr-run";
import type { ControlDeps } from "./auth";
import { readFileSync } from "fs";
import os from "os";
import path from "path";
import { AgentScanner } from "./agent-scan";
import { Factory } from "./factory";
import { startFactoryApprovalsLoop } from "./factory-approvals";
import { liveFeed } from "./feed-live";
import { Godhome } from "./godhome";
import { GhClient } from "./gh/client";
import { ghKinds } from "./gh/index";
import { Monitor } from "./monitor";
import { OpsGodhome } from "./ops-godhome";
import { AllowlistCache, ALLOWLIST_PATH, realExec } from "./ops-restart";
import { OpsStore } from "./ops-store";
import { wirePush } from "./push/wire";
import { wireAgents } from "./agents/wire";
import { wireServices } from "./services/wire";
import { wireLife } from "./life/wire";
import { wireGh } from "./gh/wire";

type Runner = typeof import("../claude-runner");

/**
 * The live backends of the project, offer and write-spec routes. claude-runner is loaded on first use
 * (like the internal endpoints do), so mounting the router starts nothing.
 */
export function liveRouteDeps(db: Database, load: () => Runner = () => require("../claude-runner")): Pick<ControlDeps, "projects" | "offers" | "writeSpec" | "runs" | "tasks" | "monitor" | "feed" | "panel" | "factory" | "ops" | "push" | "agents" | "services" | "life" | "gh"> {
  const b = () => load().controlOfferBackends();
  const opsGodhome = new OpsGodhome({ url: process.env.GODHOME_URL ?? "http://127.0.0.1:8000/api/godhome", token: godhomeToken });
  const opsStore = new OpsStore(db);
  const feed = liveFeed();
  const restartAllowlist = allowlist();
  const ghClient = new GhClient({ url: process.env.GODHOME_URL ?? "http://127.0.0.1:8000/api/godhome", token: godhomeToken });
  startFactoryApprovalsLoop({ listOffers: () => b().listActions(), createOffer: (a) => b().createOffer(a) });
  const agents = wireAgents(db, opsStore, opsGodhome, ghClient, load, feed);
  const gh = wireGh(db, opsStore, ghClient, restartAllowlist, feed);
  return {
    projects: {
      triage: new TriageStore(db),
      readerFor: (p) => {
        const ref = getProject(p.name);
        return p.location === "server" && ref?.location === "server" ? fsRepoReader(ref.path) : null;
      },
      pendingOfferFor: (project) => b().pendingOfferFor(project),
    },
    offers: {
      now: () => Date.now(),
      listActions: () => b().listActions(),
      listDeploys: () => b().listDeploys(),
      answerAction: (id, button, channel, opts) => b().answerAction(id, button, channel, opts),
      answerDeploy: (id, answer, channel) => b().answerDeploy(id, answer, channel),
      listMissions: () => b().listMissions(),
      answerMission: (id, answer, channel) => b().answerMission(id, answer, channel),
    },
    tasks: {
      getProject: (name) => getProject(name),
      propose: (project, msg, engine) => b().proposeMission(project, msg, engine),
    },
    writeSpec: {
      getProject: (name) => getProject(name),
      pendingActionFor: (project) => b().pendingActionFor(project),
      createOffer: (a) => b().createOffer(a),
    },
    // The on-call monitor (dpi-real-be) over the tailnet, when both are set in .env.
    monitor: process.env.DPI_CONTROL_URL && process.env.DPI_CONTROL_TOKEN
      ? new Monitor({ url: process.env.DPI_CONTROL_URL, token: process.env.DPI_CONTROL_TOKEN })
      : undefined,
    feed: liveFeed(),
    // The software factory's board on the Mac, over ssh.
    factory: new Factory(),
    panel: {
      scanner: new AgentScanner({ mac: process.env.CONTROL_SCAN_MAC !== "0" }),
      godhome: new Godhome({ url: process.env.GODHOME_URL ?? "http://127.0.0.1:8000/api/godhome", token: godhomeToken }),
      taskProjects: () => b().missionProjects(),
    },
    ops: {
      godhome: opsGodhome,
      store: opsStore,
      deploys: { get: (id) => b().getDeploy(id), waiting: (runId) => laptopTaskOpenForRun(db, runId) },
      taskProjects: () => b().missionProjects(),
      // The owner's allowlist (empty when the file is missing or not root 0600); CONTROL_OPS_ALLOWLIST moves it for a smoke test.
      restart: { allowlist: restartAllowlist, exec: realExec, feed },
      // The kinds of fingerprint action the X16 confirm route dispatches to besides restart (spec 012).
      kinds: [...agents.kinds, ...ghKinds(gh)],
    },
    runs: {
      hostFor: (host) => (host === "mac" ? laptopHost(load().execArgv) : serverHost(load().execArgv)),
    },
    push: wirePush(db, { load, godhome: opsGodhome, ops: opsStore }),
    agents,
    services: wireServices(opsStore, restartAllowlist, realExec),
    life: wireLife(db),
    gh,
  };
}

function allowlist(): () => ReturnType<AllowlistCache["get"]> {
  const cache = new AllowlistCache(process.env.CONTROL_OPS_ALLOWLIST || ALLOWLIST_PATH);
  return () => cache.get();
}

/** GodHome's shared secret: GODHOME_TOKEN, else the token file GodHome writes on first run. Read on each use, never logged. */
function godhomeToken(): string | null {
  if (process.env.GODHOME_TOKEN) return process.env.GODHOME_TOKEN;
  const file = process.env.GODHOME_AUTH ?? path.join(os.homedir(), ".pi", "dashboard", "plugins", "godhome", "auth.json");
  try {
    const t = JSON.parse(readFileSync(file, "utf8"))?.token;
    return typeof t === "string" && t ? t : null;
  } catch {
    return null;
  }
}
