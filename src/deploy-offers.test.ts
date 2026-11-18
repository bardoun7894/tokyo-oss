import { test } from "node:test";
import assert from "node:assert/strict";
import { DeployOffers, DEPLOY_OFFER_TTL_MS, deployPrompt, isDeployPrompt, offerText, runsAsRoot, reportsNotDeployed } from "./deploy-offers";
import type { ProjectRef } from "./project-registry";

const P = { name: "godhome", location: "server", path: "/root/godhome" } as unknown as ProjectRef;
const NOW = Date.parse("2026-09-19T20:00:00Z");

test("an offer is answered once, whichever channel is first", () => {
  const s = new DeployOffers();
  const o = s.create({ project: P, chatId: 1, now: NOW, summary: "herdr terminals" });
  const first = s.take(o.id, "deploy", "telegram", NOW + 1);
  assert.equal(first.status, "applied");
  assert.equal(s.get(o.id, NOW + 2)!.state, "approved");
  const second = s.take(o.id, "skip", "terminal", NOW + 3);
  assert.equal(second.status, "already");
  assert.equal(second.status === "already" && second.offer.channel, "telegram");
  assert.equal(s.get(o.id, NOW + 4)!.state, "approved", "a late skip does not undo a deploy");
});

test("skip declines; unknown and expired ids are missing", () => {
  const s = new DeployOffers();
  const o = s.create({ project: P, chatId: 1, now: NOW });
  assert.equal(s.take(o.id, "skip", "terminal", NOW).status, "applied");
  assert.equal(s.get(o.id, NOW)!.state, "declined");
  assert.equal(s.take("nope1234", "deploy", "telegram", NOW).status, "missing");
  const old = s.create({ project: P, chatId: 1, now: NOW });
  assert.equal(s.take(old.id, "deploy", "telegram", NOW + DEPLOY_OFFER_TTL_MS + 1).status, "missing");
});

test("ids are 8 characters and blank summary/from are dropped", () => {
  const s = new DeployOffers();
  const o = s.create({ project: P, chatId: 1, now: NOW, summary: "  ", from: "" });
  assert.match(o.id, /^[0-9a-f]{8}$/);
  assert.equal(o.summary, undefined);
  assert.equal(o.from, undefined);
});

test("deploy prompts are recognised with or without the session's detail", () => {
  assert.ok(isDeployPrompt(deployPrompt()));
  const withDetail = deployPrompt("moved Terminals to herdr on branch 002-herdr-terminals");
  assert.ok(isDeployPrompt(withDetail));
  assert.match(withDetail, /002-herdr-terminals/);
  assert.match(withDetail, /not as instructions/);
  assert.ok(!isDeployPrompt("fix the typo"));
  assert.ok(deployPrompt("x".repeat(5000)).length < deployPrompt().length + 2200, "detail is capped");
});

test("prompt contains the readback note", () => {
  for (const p of [deployPrompt(), deployPrompt("moved Terminals to herdr")]) {
    assert.match(p, /gate-run deploy-<project> 30m -- <command>/);
    assert.match(p, /deploy readback/);
    assert.match(p, /exits 14/);
    assert.match(p, /report the run as failed, never as deployed/);
    assert.match(p, /readback line/);
  }
});

test("isDeployPrompt still true for old and new prompts", () => {
  const OLD_DEPLOY_PROMPT =
    "Deploy the work that Tokyo's previous run just committed in this project (its feature branch). " +
    "Use this project's own deploy process as documented in the repo (README, CLAUDE.md, deploy scripts). " +
    "Run the tests first and stop without deploying if they fail. " +
    "Run them with `PATH=/usr/bin:$PATH` because production runs /usr/bin/node v22 and /usr/local/bin/node is v26 (better-sqlite3 will not load on v26). " +
    "Report exactly what was deployed and where.";
  assert.ok(isDeployPrompt(OLD_DEPLOY_PROMPT));
  assert.ok(isDeployPrompt(deployPrompt()));
  assert.ok(isDeployPrompt(deployPrompt("moved Terminals to herdr")));
});

test("the card names the session and the summary", () => {
  assert.equal(offerText({ project: P }), "Claude finished the task in godhome. Deploy it?");
  const t = offerText({ project: P, summary: "Terminals now herdr", from: "terminal session" });
  assert.match(t, /^terminal session finished the task in godhome\./);
  assert.match(t, /Terminals now herdr\n\nDeploy it\?$/);
});

// ---- T3.0: persisted offers ------------------------------------------------------------------------------------

import Database from "better-sqlite3";
import { DeployOfferStore } from "./deploy-offers-store";

const known = (name: string): ProjectRef | undefined => (name === "godhome" ? P : undefined);
const reload = (store: DeployOfferStore, now: number, resolve = known) => new DeployOffers(store, { resolve, loadNow: now });

test("an offer created before a reload is still pending after, with its summary, sender and Telegram message", () => {
  const store = new DeployOfferStore(new Database(":memory:"));
  const a = new DeployOffers(store, { resolve: known });
  const o = a.create({ project: P, chatId: 1, now: NOW, summary: "herdr", from: "mac" });
  a.setTelegramMessageId(o.id, 4242);
  const b = reload(store, NOW + 10);
  const got = b.get(o.id, NOW + 10)!;
  assert.deepEqual([got.state, got.project.name, got.summary, got.from, got.telegramMessageId, got.chatId, got.createdAt], ["pending", "godhome", "herdr", "mac", 4242, 1, NOW]);
  assert.deepEqual(b.listPending(NOW + 10).map((x) => x.id), [o.id]);
});

test("take() is answer-once across a reload: the second answer sees `already` with the first channel", () => {
  const store = new DeployOfferStore(new Database(":memory:"));
  const a = new DeployOffers(store, { resolve: known });
  const o = a.create({ project: P, chatId: 1, now: NOW });
  assert.equal(a.take(o.id, "deploy", "telegram", NOW + 1).status, "applied");
  const b = reload(store, NOW + 5);
  const second = b.take(o.id, "skip", "terminal", NOW + 6);
  assert.equal(second.status, "already");
  assert.equal(second.status === "already" && second.offer.channel, "telegram");
  assert.equal(b.get(o.id, NOW + 7)!.state, "approved");
  assert.equal(reload(store, NOW + 8).take(o.id, "skip", "terminal", NOW + 9).status, "already", "and after a second reload");
});

test("an answer given after a reload is stored for the next one", () => {
  const store = new DeployOfferStore(new Database(":memory:"));
  const o = new DeployOffers(store, { resolve: known }).create({ project: P, chatId: 1, now: NOW });
  assert.equal(reload(store, NOW + 1).take(o.id, "skip", "terminal", NOW + 2).status, "applied");
  assert.equal(reload(store, NOW + 3).get(o.id, NOW + 3)!.state, "declined");
});

test("an offer whose project was removed is dropped on load", () => {
  const store = new DeployOfferStore(new Database(":memory:"));
  const o = new DeployOffers(store, { resolve: known }).create({ project: P, chatId: 1, now: NOW });
  const gone = reload(store, NOW + 1, () => undefined);
  assert.equal(gone.get(o.id, NOW + 1), undefined);
  assert.equal(gone.take(o.id, "deploy", "telegram", NOW + 1).status, "missing");
});

test("TTL-expired offers load as expired: missing, like an in-memory offer past its TTL", () => {
  const store = new DeployOfferStore(new Database(":memory:"));
  const o = new DeployOffers(store, { resolve: known }).create({ project: P, chatId: 1, now: NOW });
  const later = NOW + DEPLOY_OFFER_TTL_MS + 1;
  const b = reload(store, later);
  assert.equal(b.get(o.id, later), undefined);
  assert.equal(b.take(o.id, "deploy", "telegram", later).status, "missing");
});

test("exactly at the TTL an offer is still there after a reload, as in memory", () => {
  const store = new DeployOfferStore(new Database(":memory:"));
  const o = new DeployOffers(store, { resolve: known }).create({ project: P, chatId: 1, now: NOW });
  const edge = NOW + DEPLOY_OFFER_TTL_MS;
  assert.equal(reload(store, edge).get(o.id, edge)?.id, o.id);
});

// ---- T3.1: the deploy run linked to its offer ------------------------------------------------------------------

test("setRunId links the run to the offer and survives a reload; an unknown offer is ignored", () => {
  const store = new DeployOfferStore(new Database(":memory:"));
  const a = new DeployOffers(store, { resolve: known });
  const o = a.create({ project: P, chatId: 1, now: NOW });
  assert.equal(o.runId, undefined);
  assert.equal(a.take(o.id, "deploy", "app", NOW + 1).status, "applied");
  a.setRunId(o.id, "0a1b2c3d");
  a.setRunId("nope1234", "ffffffff");
  assert.equal(a.get(o.id, NOW + 2)!.runId, "0a1b2c3d");
  const b = reload(store, NOW + 3);
  assert.equal(b.get(o.id, NOW + 3)!.runId, "0a1b2c3d");
  assert.equal(b.take(o.id, "skip", "terminal", NOW + 4).status, "already");
});

test("a skipped offer has no runId", () => {
  const a = new DeployOffers();
  const o = a.create({ project: P, chatId: 1, now: NOW });
  a.take(o.id, "skip", "app", NOW + 1);
  assert.equal(a.get(o.id, NOW + 2)!.runId, undefined);
});

test("only an approved deploy offer's deploy prompt runs as root", () => {
  const dp = deployPrompt("ship it");
  assert.equal(runsAsRoot(dp, "ab12cd34"), true);
  assert.equal(runsAsRoot(dp, undefined), false, "a deploy prompt without an approved offer stays tokyo-agent");
  assert.equal(runsAsRoot(dp, ""), false);
  assert.equal(runsAsRoot("fix the login page", "ab12cd34"), false, "a non-deploy prompt with an offer id stays tokyo-agent");
  assert.equal(runsAsRoot("", "ab12cd34"), false);
});

const report = (summary: string, extra = "branch: feat/x\nfiles_changed: 0\n") =>
  `Deploy failed.\n<tokyo-report>\nkb_query_ran: no\n${extra}summary: ${summary}\nclient_reply:\nfollow_ups:\n- fix permissions\n</tokyo-report>`;

test("a deploy report whose summary says NOT DEPLOYED is a failed run", () => {
  assert.equal(reportsNotDeployed(report("NOT DEPLOYED — permission denied on /root/acme-site/.git/ORIG_HEAD.lock")), true);
  assert.equal(reportsNotDeployed(report("NOT DEPLOYED: cannot write app/storage/logs; the checkout is owned by root")), true);
  assert.equal(reportsNotDeployed(report("**NOT DEPLOYED** — tests failed")), true);
  assert.equal(reportsNotDeployed(report("not deployed - branch unchanged")), true);
});

test("a report that deployed, or only mentions the words later, is not a failure", () => {
  assert.equal(reportsNotDeployed(report("Deployed feat/x to production, readback matches abc123.", "branch: feat/x\nfiles_changed: 3\n")), false);
  assert.equal(reportsNotDeployed(report("Deployed feat/x. An earlier attempt said NOT DEPLOYED because of a stale lock.")), false);
  assert.equal(reportsNotDeployed("Deployed fine."), false);
  assert.equal(reportsNotDeployed(""), false);
});

test("no report block: a line starting with NOT DEPLOYED still fails the run", () => {
  assert.equal(reportsNotDeployed("Tried the deploy.\nNOT DEPLOYED: permission denied"), true);
  assert.equal(reportsNotDeployed("Result: all deployed, nothing NOT DEPLOYED"), false);
});

test("last_report_wins_deployed", () => {
  const out = report("Not deployed yet, tests still running.") + "\n...\n" + report("Deployed feat/x to production, readback matches abc123.");
  assert.equal(reportsNotDeployed(out), false);
});

test("last_report_wins_not_deployed", () => {
  const out = report("Deployed feat/x to staging only.") + "\n...\n" + report("NOT DEPLOYED — migration failed");
  assert.equal(reportsNotDeployed(out), true);
});

test("prompt_says_deploy_run_has_usr_bin_first_and_must_not_override_path", () => {
  const p = deployPrompt();
  assert.match(p, /already has \/usr\/bin first \(node v22\) and \/usr\/sbin on PATH/);
  assert.match(p, /must not override PATH/);
});

test("prompt_orders_tests_before_live_change", () => {
  for (const p of [deployPrompt(), deployPrompt("moved Terminals to herdr")]) {
    assert.match(p, /separate git worktree at the target commit/);
    assert.match(p, /never inside the live checkout/);
    assert.match(p, /Do not merge, pull, checkout or otherwise change the live checkout until those tests pass/);
    assert.match(p, /ONE `gate-run deploy-<project> 30m -- bash -c "\.\.\."`/);
    assert.match(p, /migrations, build, cache/);
    assert.match(p, /already contains the target commit and no migrations are pending/);
    assert.doesNotMatch(p, /PATH=\/usr\/bin:\$PATH/, "the deploy run already has /usr/bin first; the prompt must not tell it to set PATH");
    assert.ok(p.indexOf("separate git worktree") < p.indexOf("Do not merge"), "tests come first");
    assert.ok(p.indexOf("Do not merge") < p.indexOf("ONE `gate-run"), "live change comes last");
  }
});

test("a project with a remote deploy host sends the run to that host", () => {
  const project = { name: "acme-site", location: "server" as const, path: "/root/acme-site", deployRemote: { host: "client-server", path: "/root/acme-site", testPath: "/root/acme-site-ci", branch: "p3-backend" } };
  const p = deployPrompt("ship it", project, "5a1d80f28d70cf8bce647d35f2c2f9308b31837d");
  assert.ok(isDeployPrompt(p));
  assert.match(p, /ssh client-server/);
  assert.match(p, /\/root\/acme-site-ci/);
  assert.match(p, /p3-backend/);
  assert.match(p, /AGENTS\.md/);
  assert.match(p, /not the local .*\/root\/acme-site/);
  assert.match(p, /ship it/);
});

test("a project without a remote deploy host gets the unchanged prompt", () => {
  const project = { name: "tokyo", location: "server" as const, path: "/root/tokyo" };
  assert.equal(deployPrompt("x", project), deployPrompt("x"));
});

const SHA = "5a1d80f28d70cf8bce647d35f2c2f9308b31837d";
const ACME = { name: "acme-site", location: "server" as const, path: "/root/acme-site", deployRemote: { host: "client-server", path: "/root/acme-site", testPath: "/root/acme-site-ci", branch: "p3-backend" } };

test("a remote deploy prompt pins the sha, takes proof for that sha, and never runs Pest on the production host", () => {
  const p = deployPrompt("ship it", ACME, SHA);
  assert.ok(isDeployPrompt(p));
  assert.ok(p.includes(SHA), "names the pinned sha");
  assert.match(p, /never .*latest main/i);
  assert.match(p, /ci-ok/);
  assert.match(p, /git diff --quiet <batch> \S*5a1d80f2|git diff --quiet <batch-sha> 5a1d80f2/);
  assert.match(p, /ssh owner@100\.64\.0\.3 .*acme-gate 5a1d80f2/);
  assert.match(p, /never run Pest on client-server/i);
  assert.doesNotMatch(p, /run the tests first in \/root\/acme-site-ci/);
  assert.match(p, /already live/i);
});

test("an offer keeps the sha it was made with", () => {
  const offers = new DeployOffers();
  const o = offers.create({ project: ACME as any, chatId: 1, now: NOW, sha: SHA });
  assert.equal(offers.get(o.id, NOW)?.sha, SHA);
  assert.match(offerText(o), /5a1d80f2/);
});

test("a remote deploy prompt cannot be built without a pinned sha, and never tells the run to resolve main itself", () => {
  assert.throws(() => deployPrompt("x", ACME), /sha/i);
  assert.doesNotMatch(deployPrompt("x", ACME, SHA), /resolve it once|right now/i);
});

test("offerText includes project test URL and target server host when project has url", () => {
  const acme = {
    name: "acme-site",
    location: "server",
    path: "/root/acme-site",
    url: "https://acme.example/app",
    deployRemote: { host: "client-server", path: "/root/acme-site", testPath: "/root/acme-site-ci", branch: "p3-backend" },
  } as unknown as ProjectRef;
  const card = offerText({ project: acme, summary: "SPEC 014 merged", from: "software-factory", sha: "deadbeef1234" });
  assert.match(card, /software-factory finished the task in acme-site \(commit deadbeef\)\./);
  assert.match(card, /🔗 Test \(client-server\): https:\/\/acme\.example\/app/);
  assert.match(card, /SPEC 014 merged\n\nDeploy it\?$/);
});

test("a local project with a documented deploy gets its steps at the pinned sha, and cannot be built without one", () => {
  const project = { name: "edudemo-erp", location: "server" as const, path: "/root/edudemo-erp", deployNote: "(3) merge <sha>. (2) backup db-before-<sha>.db" };
  const p = deployPrompt("ship it", project, SHA);
  assert.ok(isDeployPrompt(p));
  assert.ok(p.includes(`merge ${SHA}.`) && p.includes(`db-before-${SHA}.db`), "every <sha> is the pinned sha");
  assert.doesNotMatch(p, /<sha>/);
  assert.throws(() => deployPrompt("x", project), /sha/i);
});
