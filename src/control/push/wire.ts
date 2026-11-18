import type { Database } from "better-sqlite3";
import { laptopTaskOpenForRun } from "../../laptop-open";
import type { OpsGodhome } from "../ops-godhome";
import type { OpsStore } from "../ops-store";
import { ControlStore } from "../store";
import { DISPATCH_INTERVAL_MS, Dispatcher } from "./dispatcher";
import { NTFY_CONFIG_PATH, ntfyConfig, Publisher } from "./publisher";
import { reminderSink, setReminderSink } from "./reminders";
import type { PushDeps } from "./routes";
import { deploysSource, incidentsSource, offersSource, runsSource, StopLog, type PushSource } from "./sources";
import { PushStore } from "./store";

type Runner = typeof import("../../claude-runner");
const DAY_MS = 24 * 60 * 60 * 1000;

let live: Dispatcher | null = null;

/** Stops the 20 s timer of the live dispatcher (tests that wire push call this). */
export function stopPush(): void {
  live?.stop();
  live = null;
  setReminderSink(null);
}

/**
 * The live push deps. Always returns the deps, so the routes are mounted even while `/etc/tokyo/ntfy.json` is missing: the
 * config getter then answers null, the publisher and dispatcher do nothing, P1 and P5 answer 503 and P6 says not registered.
 * The 20 s timer starts here, unref'd, except under the node test runner. claude-runner is loaded on the first tick, not here.
 */
export function wirePush(db: Database, ctx: { load: () => Runner; godhome: Pick<OpsGodhome, "summary">; ops: OpsStore }): PushDeps {
  stopPush();
  const store = new PushStore(db);
  const control = new ControlStore(db);
  const config = ntfyConfig({ path: process.env.CONTROL_NTFY_CONFIG || NTFY_CONFIG_PATH });
  const publisher = new Publisher({ store, config });
  const stops = new StopLog();
  const b = () => ctx.load().controlOfferBackends();
  const offerDeps = {
    offers: { now: () => Date.now(), listActions: () => b().listActions(), listDeploys: () => b().listDeploys(), listMissions: () => b().listMissions() },
    getRun: (id: string) => control.getRun(id),
    waiting: (runId: string) => laptopTaskOpenForRun(db, runId),
  };
  const sources: PushSource[] = [
    offersSource(offerDeps),
    deploysSource(offerDeps),
    runsSource({ listRuns: () => control.listRuns({ since: Date.now() - DAY_MS, limit: 101 }), stoppedBy: (id) => stops.who(id) }),
    incidentsSource({ godhome: ctx.godhome, ops: ctx.ops, now: () => Date.now() }),
  ];
  const format = () => config()?.format ?? "up";
  const dispatcher = new Dispatcher({ store, publisher, sources, now: () => Date.now(), format });
  setReminderSink(reminderSink({ store, enabled: () => publisher.enabled, format, now: () => Date.now() }));
  live = dispatcher;
  if (!process.env.NODE_TEST_CONTEXT) dispatcher.start(DISPATCH_INTERVAL_MS);
  return {
    store, audit: ctx.ops, baseUrl: () => config()?.baseUrl ?? null, format, flush: () => dispatcher.tick(), stops,
  };
}
