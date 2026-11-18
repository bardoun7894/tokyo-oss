import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import childProcess from "child_process";
import { mock } from "node:test";
import Database from "better-sqlite3";
import { ActionOffers, type ActionOffer, type ActionOfferBacking } from "../action-offers";
import { createActionOfferFlow } from "../action-offer-flow";
import type { ProjectRef } from "../project-registry";
import { createFactoryApprovals, startFactoryApprovalsLoop, syncFactoryApprovals, type Exec, type FactoryApprovalsDeps } from "./factory-approvals";
import { listPendingApprovals } from "./factory-registry";

// Verbatim from control/migrations/002_approvals.sql (software-factory).
const APPROVALS = `
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('repair','sync','protected-path','low-grade','reviewer-unavailable')),
  project TEXT NOT NULL, job_id TEXT, run_id TEXT, repo_path TEXT, branch TEXT NOT NULL, head_sha TEXT NOT NULL, title TEXT, detail TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','stale')),
  answered_by TEXT, answered_at TEXT, created_at TEXT NOT NULL, landed_run TEXT
);
`;

interface Seed { id: string; kind?: string; project: string; status?: string; detail?: string }

function registry(rows: Seed[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-approvals-"));
  const file = path.join(dir, "registry.db");
  const db = new Database(file);
  db.exec(APPROVALS);
  const ins = db.prepare("INSERT INTO approvals (id, kind, project, branch, head_sha, title, detail, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)");
  rows.forEach((r, i) => ins.run(r.id, r.kind ?? "repair", r.project, `repair/r${i}`, "0123456789abcdef", `title ${i}`, r.detail ?? null, r.status ?? "pending", `2026-10-24T10:00:0${i}Z`));
  db.close();
  process.env.FACTORY_REGISTRY_DB = file;
  return file;
}

/** In-memory durable backing, shared by two ActionOffers to model a Tokyo restart. */
function backing(): ActionOfferBacking {
  const rows = new Map<string, ActionOffer>();
  return {
    save: (o) => { rows.set(o.id, structuredClone(o)); },
    loadAll: (since) => [...rows.values()].filter((o) => o.createdAt >= since).map((o) => structuredClone(o)),
    prune: () => {},
  };
}

function world(store: ActionOfferBacking = backing()) {
  const t = { now: 1_000_000 };
  const sent: { text: string; keyboard: unknown }[] = [];
  const offers = new ActionOffers({ store, loadNow: t.now });
  const flow = createActionOfferFlow({
    offers,
    getBot: () => ({ api: { sendMessage: async (_c: number, text: string, o: unknown) => { sent.push({ text, keyboard: o }); return { message_id: sent.length }; }, editMessageText: async () => true } }) as any,
    chatId: 1,
    now: () => t.now,
    getProject: (name): ProjectRef | undefined => (name === "ghost" ? undefined : { name, location: "server", path: `/tmp/${name}` }),
    startRun: async () => { throw new Error("a factory offer never starts a run"); },
  });
  const calls: string[][] = [];
  const lands: string[][] = [];
  const exec: Exec = async (_bin, args) => { calls.push(args); return { code: 0, output: "" }; };
  const deps: FactoryApprovalsDeps = { listOffers: () => offers.list(t.now), createOffer: (a) => flow.offerActionFromSession(a), exec, spawnDetached: (_bin, args) => { lands.push(args); }, now: () => t.now, log: () => {} };
  return { t, offers, flow, calls, lands, sent, deps, store };
}

const factoryOffers = (o: ActionOffers, now: number) => o.list(now).filter((x) => x.from?.startsWith("factory:"));

test("creates one offer per approval id", async () => {
  registry([{ id: "repair:alpha:b:111", project: "alpha" }, { id: "protected-path:beta:b:222", kind: "protected-path", project: "beta" }, { id: "x:gone:b:3", project: "gone", status: "approved" }]);
  const w = world();
  assert.equal(await syncFactoryApprovals(w.deps), 2);
  assert.equal(await syncFactoryApprovals(w.deps), 0);
  const made = factoryOffers(w.offers, w.t.now);
  assert.equal(made.length, 2);
  assert.equal(w.sent.length, 2, "one Telegram card per offer");
  const repair = made.find((o) => o.from === "factory:repair:alpha:b:111")!;
  assert.deepEqual(repair.buttons.map((b) => [b.id, b.label]), [["approve", "Approve"], ["reject", "Reject"], ["halt", "Halt project"]]);
  assert.equal(repair.project, "alpha");
  assert.ok(repair.title.startsWith("Factory repair:"));
  assert.ok(repair.body.includes("Approval: repair:alpha:b:111"));
  const prot = made.find((o) => o.from === "factory:protected-path:beta:b:222")!;
  assert.deepEqual(prot.buttons.map((b) => b.label), ["Allow this head", "Reject"]);
  assert.ok(prot.buttons.every((b) => !b.prompt), "no prompt: an answer never starts a run");
});

test("restart creates only missing offers", async () => {
  const file = registry([{ id: "repair:alpha:b:1", project: "alpha" }, { id: "sync:beta:b:2", kind: "sync", project: "beta" }]);
  const first = world();
  assert.equal(await syncFactoryApprovals(first.deps), 2);
  // New process: fresh ActionOffers over the same durable store, plus a third approval that has no offer yet.
  const db = new Database(file);
  db.prepare("INSERT INTO approvals (id, kind, project, branch, head_sha, title, status, created_at) VALUES ('repair:gamma:b:3','repair','gamma','br','abcdef0123456789','t','pending','2026-10-24T11:00:00Z')").run();
  db.close();
  const second = world(first.store);
  assert.equal(second.offers.list(second.t.now).length, 2, "offers survive the restart");
  assert.equal(await syncFactoryApprovals(second.deps), 1);
  assert.deepEqual(factoryOffers(second.offers, second.t.now).map((o) => o.from).sort(), ["factory:repair:alpha:b:1", "factory:repair:gamma:b:3", "factory:sync:beta:b:2"]);
});

test("a second approval of one project waits for the first card to be answered", async () => {
  registry([{ id: "repair:alpha:b:1", project: "alpha" }, { id: "sync:alpha:b:2", kind: "sync", project: "alpha" }]);
  const w = world();
  const a = createFactoryApprovals(w.deps);
  assert.equal(await a.sync(), 1);
  assert.equal(factoryOffers(w.offers, w.t.now).filter((o) => o.state === "pending").length, 1);
  assert.equal(await a.sync(), 0);
  const first = factoryOffers(w.offers, w.t.now)[0];
  await w.flow.answerActionOfferDetailed(first.id, "reject", "telegram");
  assert.equal(await a.sync(), 1);
  assert.equal(factoryOffers(w.offers, w.t.now).length, 2);
});

test("answer calls factoryctl once", async () => {
  process.env.FACTORYCTL_BIN = "/stub/factoryctl";
  registry([{ id: "repair:alpha:b:1", project: "alpha" }, { id: "sync:beta:b:2", kind: "sync", project: "beta" }]);
  const w = world();
  const a = createFactoryApprovals(w.deps);
  await a.sync();
  const [alpha, beta] = ["alpha", "beta"].map((p) => factoryOffers(w.offers, w.t.now).find((o) => o.project === p)!);
  assert.equal(await a.processAnswers(), 0, "nothing answered yet");
  await w.flow.answerActionOfferDetailed(alpha.id, "approve", "telegram");
  await w.flow.answerActionOfferDetailed(beta.id, "halt", "app");
  const bins: string[] = [];
  const spy = createFactoryApprovals({ ...w.deps, exec: async (bin, args) => { bins.push(bin); return w.deps.exec!(bin, args); } });
  // Both ticks racing: the effect still runs once per offer.
  await Promise.all([spy.processAnswers(), spy.processAnswers()]);
  await spy.processAnswers();
  assert.deepEqual(w.calls, [["approve", "repair:alpha:b:1", "--by", "control", "--no-land"], ["halt", "beta"]]);
  assert.deepEqual(w.lands, [["land", "repair:alpha:b:1"]]);
  assert.deepEqual(bins, ["/stub/factoryctl", "/stub/factoryctl"]);
});

test("second answer is a no-op", async () => {
  registry([{ id: "repair:alpha:b:1", project: "alpha" }]);
  const w = world();
  const a = createFactoryApprovals(w.deps);
  await a.sync();
  const offer = factoryOffers(w.offers, w.t.now)[0];
  assert.equal((await w.flow.answerActionOfferDetailed(offer.id, "reject", "telegram")).status, "applied");
  assert.equal((await w.flow.answerActionOfferDetailed(offer.id, "approve", "app")).status, "already");
  await a.processAnswers();
  await a.processAnswers();
  assert.deepEqual(w.calls, [["reject", "repair:alpha:b:1", "--by", "control"]]);
  assert.deepEqual(w.lands, [], "a reject never lands");
});

test("a stale halt answer is not replayed after a restart", async () => {
  registry([{ id: "repair:alpha:b:1", project: "alpha" }]);
  const w = world();
  const a = createFactoryApprovals(w.deps);
  await a.sync();
  const offer = factoryOffers(w.offers, w.t.now)[0];
  await w.flow.answerActionOfferDetailed(offer.id, "halt", "telegram");
  w.t.now += 10 * 60_000;
  assert.equal(await createFactoryApprovals(w.deps).processAnswers(), 0);
  assert.deepEqual(w.calls, []);
});

test("registry unavailable creates nothing", async () => {
  process.env.FACTORY_REGISTRY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "factory-approvals-")), "absent.db");
  assert.deepEqual(listPendingApprovals(), []);
  const w = world();
  let created = 0;
  assert.equal(await syncFactoryApprovals({ ...w.deps, createOffer: async (a) => { created++; return w.deps.createOffer(a); } }), 0);
  assert.equal(created, 0);
  assert.equal(w.offers.list(w.t.now).length, 0);
  // A registry from before 002 (no approvals table) is the same.
  const old = path.join(path.dirname(process.env.FACTORY_REGISTRY_DB), "old.db");
  const db = new Database(old);
  db.exec("CREATE TABLE jobs (id TEXT)");
  db.close();
  process.env.FACTORY_REGISTRY_DB = old;
  assert.deepEqual(listPendingApprovals(), []);
});

test("an approval of a project Tokyo does not know gets no offer and is logged once", async () => {
  registry([{ id: "repair:ghost:b:1", project: "ghost" }]);
  const w = world();
  const logs: string[] = [];
  const a = createFactoryApprovals({ ...w.deps, log: (m) => logs.push(m) });
  assert.equal(await a.sync(), 0);
  assert.equal(await a.sync(), 0);
  assert.equal(logs.length, 1);
  assert.equal(w.offers.list(w.t.now).length, 0);
});

test("pending approvals are read with redacted free text and no extra columns", () => {
  const file = registry([{ id: "repair:alpha:b:1", project: "alpha", detail: "failed, API_TOKEN=abc123 rejected" }]);
  const db = new Database(file);
  db.exec("ALTER TABLE approvals ADD COLUMN secret_note TEXT DEFAULT 'LEAKED-VALUE'");
  db.close();
  const rows = listPendingApprovals();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detail, "failed, API_TOKEN=[redacted] rejected");
  assert.ok(!JSON.stringify(rows).includes("LEAKED-VALUE"));
});

test("the default executor runs FACTORYCTL_BIN with a fixed argv", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-approvals-bin-"));
  const out = path.join(dir, "argv.txt");
  const bin = path.join(dir, "factoryctl");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${out}'\n`, { mode: 0o755 });
  process.env.FACTORYCTL_BIN = bin;
  registry([{ id: "repair:alpha:b:1", project: "alpha" }]);
  const w = world();
  const a = createFactoryApprovals({ ...w.deps, exec: undefined, spawnDetached: () => {} });
  await a.sync();
  await w.flow.answerActionOfferDetailed(factoryOffers(w.offers, w.t.now)[0].id, "approve", "telegram");
  assert.equal(await a.processAnswers(), 1);
  assert.deepEqual(fs.readFileSync(out, "utf8").trim().split("\n"), ["approve", "repair:alpha:b:1", "--by", "control", "--no-land"]);
});

test("the loop starts nothing at mount, and stop() ends it", async () => {
  registry([{ id: "repair:alpha:b:1", project: "alpha" }]);
  const w = world();
  const stop = startFactoryApprovalsLoop(w.deps, 20);
  assert.equal(w.offers.list(w.t.now).length, 0, "no tick at mount");
  await new Promise((r) => setTimeout(r, 120));
  stop();
  assert.equal(factoryOffers(w.offers, w.t.now).length, 1);
  const n = w.sent.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(w.sent.length, n, "stopped");
});

test("approve uses --no-land then a detached land", async () => {
  registry([{ id: "repair:alpha:b:1", project: "alpha" }]);
  const w = world();
  const order: string[] = [];
  const a = createFactoryApprovals({
    ...w.deps,
    exec: async (_b, args) => { order.push(`exec ${args.join(" ")}`); return { code: 0, output: "" }; },
    spawnDetached: (_b, args) => { order.push(`spawn ${args.join(" ")}`); },
  });
  await a.sync();
  await w.flow.answerActionOfferDetailed(factoryOffers(w.offers, w.t.now)[0].id, "approve", "telegram");
  assert.equal(await a.processAnswers(), 1);
  assert.deepEqual(order, ["exec approve repair:alpha:b:1 --by control --no-land", "spawn land repair:alpha:b:1"]);
});

test("a timeout of approve never kills a land", async () => {
  process.env.FACTORYCTL_BIN = "/stub/factoryctl";
  registry([{ id: "repair:alpha:b:1", project: "alpha" }, { id: "repair:beta:b:2", project: "beta" }]);
  const w = world();
  // approve that times out (execFile reports a killed child as a non-numeric code, mapped to -1): nothing is landed.
  let code = -1;
  const a = createFactoryApprovals({ ...w.deps, exec: async () => ({ code, output: "" }), spawnDetached: undefined });
  await a.sync();
  const mockedSpawn = (spawned: any[]) => mock.method(childProcess, "spawn", ((bin: string, args: string[], opts: any) => {
    const rec = { bin, args, opts, unref: false, handlers: [] as string[] };
    spawned.push(rec);
    return { unref: () => { rec.unref = true; }, on: (ev: string) => { rec.handlers.push(ev); } };
  }) as any);
  const none: any[] = [];
  const noneMock = mockedSpawn(none);
  try {
    await w.flow.answerActionOfferDetailed(factoryOffers(w.offers, w.t.now).find((o) => o.project === "alpha")!.id, "approve", "telegram");
    await a.processAnswers();
  } finally {
    noneMock.mock.restore();
  }
  assert.deepEqual(none, [], "a timed-out approve starts no land");
  // The default detached start: own process group, no shell, no timeout, ignored stdio, unref'd, never awaited.
  const spawned: { bin: string; args: string[]; opts: any; unref: boolean; handlers: string[] }[] = [];
  const spawnMock = mockedSpawn(spawned);
  try {
    code = 0;
    await w.flow.answerActionOfferDetailed(factoryOffers(w.offers, w.t.now).find((o) => o.project === "beta")!.id, "approve", "telegram");
    await a.processAnswers();
  } finally {
    spawnMock.mock.restore();
  }
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].bin, "/stub/factoryctl");
  assert.deepEqual(spawned[0].args, ["land", "repair:beta:b:2"]);
  assert.deepEqual(spawned[0].opts, { detached: true, stdio: "ignore" }, "no timeout, no shell");
  assert.ok(spawned[0].unref);
  assert.ok(spawned[0].handlers.includes("error"), "a missing binary cannot crash Tokyo");
});

test("superseded offer for a pending approval is re-offered", async () => {
  registry([{ id: "repair:alpha:b:1", project: "alpha" }]);
  const w = world();
  const a = createFactoryApprovals(w.deps);
  assert.equal(await a.sync(), 1);
  // Another card of the same project supersedes the factory card.
  const other = await w.flow.offerActionFromSession({ project: "alpha", title: "Other", body: "b", buttons: [{ id: "ok", label: "Ok" }] });
  assert.ok(other.ok);
  assert.equal(factoryOffers(w.offers, w.t.now)[0].state, "superseded");
  assert.equal(await a.sync(), 1, "the approval is still pending, so it gets a new card");
  const mine = factoryOffers(w.offers, w.t.now);
  assert.equal(mine.length, 2);
  assert.deepEqual(mine.map((o) => o.state).sort(), ["pending", "superseded"]);
  assert.notEqual(mine[0].from, mine[1].from, "key = approval id + attempt number");
  assert.equal(await a.sync(), 0, "one pending card is enough");
  // The new card still maps to the approval id: its answer runs the effect for that id.
  await w.flow.answerActionOfferDetailed(mine.find((o) => o.state === "pending")!.id, "reject", "telegram");
  await a.processAnswers();
  assert.deepEqual(w.calls, [["reject", "repair:alpha:b:1", "--by", "control"]]);
});

test("an expired or exit-3 offer for a still pending approval is re-offered", async () => {
  registry([{ id: "repair:alpha:b:1", project: "alpha" }, { id: "repair:beta:b:2", project: "beta" }]);
  const w = world();
  let code = 3;
  const a = createFactoryApprovals({ ...w.deps, exec: async (_b, args) => { w.calls.push(args); return { code, output: "head moved" }; } });
  assert.equal(await a.sync(), 2);
  await w.flow.answerActionOfferDetailed(factoryOffers(w.offers, w.t.now).find((o) => o.project === "alpha")!.id, "approve", "telegram");
  assert.equal(await a.sync(), 0, "answered, effect not run yet: no second card");
  await a.processAnswers();
  assert.equal(w.lands.length, 0, "exit 3 lands nothing");
  assert.equal(await a.sync(), 1, "exit 3 left the approval pending: new card");
  w.t.now += 25 * 60 * 60_000;
  code = 0;
  assert.equal(await a.sync(), 2, "both cards expired after 24h, both approvals still pending");
});

test("answered approval is not re-offered", async () => {
  registry([{ id: "repair:alpha:b:1", project: "alpha" }]);
  const w = world();
  const a = createFactoryApprovals(w.deps);
  assert.equal(await a.sync(), 1);
  await w.flow.answerActionOfferDetailed(factoryOffers(w.offers, w.t.now)[0].id, "reject", "telegram");
  await a.processAnswers();
  // The registry row is still pending (the ctl call has not written yet, or a restart replays): an answered offer is final.
  assert.equal(await a.sync(), 0);
  // And once the approval is no longer pending, nothing is offered either.
  const db = new Database(process.env.FACTORY_REGISTRY_DB!);
  db.prepare("UPDATE approvals SET status='rejected'").run();
  db.close();
  assert.equal(await a.sync(), 0);
  assert.equal(factoryOffers(w.offers, w.t.now).length, 1);
});
