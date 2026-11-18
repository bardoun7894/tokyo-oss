import { execFile, spawn } from "child_process";
import type { ActionOffer, OfferButton } from "../action-offers";
import type { OfferActionArgs, OfferActionResult } from "../action-offer-flow";
import { listPendingApprovals, type PendingApproval } from "./factory-registry";
import { PROJECT_NAME } from "./paging";

/**
 * Pending factory approvals (spec 001, CF5) become generic action offers. An offer is keyed by the approval id in its `from`
 * field (the offer id itself is random, fixed in claude-runner), so a restart or a second pass never makes a second card.
 * The flow's answer path (Telegram, Control app) only marks the offer answered; the effect, a `factoryctl` call, runs here on the
 * next tick, once per offer. If a card stops being pending while its approval still is (superseded by another card, expired, or an
 * answer that factoryctl refused with exit 3), the next sync makes a new card keyed `factory:<id>#<attempt>` (attempt 2, 3, ...).
 */
export const FROM_PREFIX = "factory:";
export const SYNC_INTERVAL_MS = 60_000;
/** A halt is replayed by nothing: after a restart only an answer this fresh still halts (the owner may have unhalted since). */
export const HALT_FRESH_MS = 5 * 60_000;
const EXEC_TIMEOUT_MS = 10_000;
const ANSWER_CHANNEL = "control";

/** `factoryctl approve` exits 3 when it cannot approve (head moved, or the checkout cannot be resolved): the offer's answer failed. */
const EXIT_NOT_APPROVED = 3;

export type Exec = (bin: string, args: string[]) => Promise<{ code: number; output: string }>;
/** Starts a process that outlives Tokyo and this call: no shell, no timeout, never awaited. */
export type SpawnDetached = (bin: string, args: string[]) => void;

export interface FactoryApprovalsDeps {
  /** Every action offer held, any state. */
  listOffers(): ActionOffer[];
  /** The generic card flow: creates the offer and the Telegram card. */
  createOffer(a: OfferActionArgs): Promise<OfferActionResult>;
  /** Pending approvals (default: the read-only registry reader). */
  listApprovals?: () => PendingApproval[];
  exec?: Exec;
  /** Starts `factoryctl land` (default: a detached child with ignored stdio). */
  spawnDetached?: SpawnDetached;
  now?: () => number;
  log?: (msg: string) => void;
}

const BUTTONS: Record<string, { approve: string; reject: string; halt: boolean }> = {
  repair: { approve: "Approve", reject: "Reject", halt: true },
  sync: { approve: "Approve", reject: "Reject", halt: true },
  "protected-path": { approve: "Allow this head", reject: "Reject", halt: false },
  "low-grade": { approve: "Merge anyway", reject: "Hold", halt: false },
  "reviewer-unavailable": { approve: "Merge docs-only", reject: "Hold", halt: false },
};

function buttonsFor(kind: string): OfferButton[] {
  const l = BUTTONS[kind] ?? { approve: "Approve", reject: "Reject", halt: false };
  return [{ id: "approve", label: l.approve }, { id: "reject", label: l.reject }, ...(l.halt ? [{ id: "halt", label: "Halt project" }] : [])];
}

function cardFor(a: PendingApproval, attempt = 1): OfferActionArgs {
  const title = `Factory ${a.kind}: ${a.title || a.branch}`.slice(0, 200);
  const lines = [`Project: ${a.project}`, `Branch: ${a.branch} @ ${a.headSha.slice(0, 12)}`];
  if (a.detail) lines.push("", a.detail.slice(0, 600));
  lines.push("", `Approval: ${a.id}`);
  return { project: a.project, title, body: lines.join("\n"), buttons: buttonsFor(a.kind), from: FROM_PREFIX + a.id + (attempt > 1 ? `#${attempt}` : "") };
}

const liveExec: Exec = (bin, args) => {
  // Under the node test runner the live factoryctl is never called (it would write the live registry); tests inject an exec or FACTORYCTL_BIN.
  if (!process.env.FACTORYCTL_BIN && process.env.NODE_TEST_CONTEXT) return Promise.resolve({ code: -1, output: "factoryctl not called under the test runner" });
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : -1) : 0;
      resolve({ code, output: `${stdout}${stderr}`.trim().slice(0, 300) });
    });
  });
};

const liveSpawnDetached: SpawnDetached = (bin, args) => {
  if (!process.env.FACTORYCTL_BIN && process.env.NODE_TEST_CONTEXT) return;
  // A landing is a merge under gate-run: it must survive a Tokyo restart and the approve timeout, so it is never tied to a pipe or a timer.
  const child = spawn(bin, args, { detached: true, stdio: "ignore" });
  child.on("error", (e) => console.error(`[factory-approvals] ${args.join(" ")} not started: ${e.message}`));
  child.unref();
};

/** The approval id (and card attempt, 1 for the first card) an offer was made for, or null for any other offer. */
function approvalKeyOf(o: ActionOffer): { id: string; attempt: number } | null {
  if (!o.from?.startsWith(FROM_PREFIX)) return null;
  const rest = o.from.slice(FROM_PREFIX.length);
  const m = /^(.+)#(\d+)$/.exec(rest);
  return m && Number(m[2]) >= 2 ? { id: m[1], attempt: Number(m[2]) } : { id: rest, attempt: 1 };
}

const approvalIdOf = (o: ActionOffer): string | null => approvalKeyOf(o)?.id ?? null;

export function createFactoryApprovals(deps: FactoryApprovalsDeps) {
  const listApprovals = deps.listApprovals ?? listPendingApprovals;
  const exec = deps.exec ?? liveExec;
  const spawnDetached = deps.spawnDetached ?? liveSpawnDetached;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.error(`[factory-approvals] ${m}`));
  const bin = () => process.env.FACTORYCTL_BIN || "/usr/local/bin/factoryctl";
  /** Offers whose effect was started. Marked before the first await, so a tick racing another runs nothing twice. */
  const handled = new Set<string>();
  /** Approvals that could not be offered (project unknown to Tokyo): logged once. */
  const refused = new Set<string>();
  /** Answered offers whose approve/reject factoryctl refused (exit 3), so their approval can be offered again. */
  const failed = new Set<string>();
  let syncing = false;

  /** One offer per pending approval id. Registry unavailable (no rows) creates nothing. */
  async function sync(): Promise<number> {
    if (syncing) return 0;
    syncing = true;
    try {
      const approvals = listApprovals();
      if (!approvals.length) return 0;
      const offers = deps.listOffers();
      // Per approval: the highest card attempt so far, and whether a card still stands (pending, or answered without a refusal).
      const attempts = new Map<string, number>();
      const standing = new Set<string>();
      // A new card supersedes the older pending cards of its project, so a project gets its next approval card only once the previous one is answered.
      const open = new Set<string>();
      const pendingIds = new Set(approvals.map((a) => a.id));
      for (const o of offers) {
        const k = approvalKeyOf(o);
        if (!k) continue;
        attempts.set(k.id, Math.max(attempts.get(k.id) ?? 0, k.attempt));
        if (o.state === "pending" || (o.state === "answered" && !failed.has(o.id))) standing.add(k.id);
        if (o.state === "pending" && pendingIds.has(k.id)) open.add(o.project);
      }
      let created = 0;
      for (const a of approvals) {
        if (standing.has(a.id) || open.has(a.project)) continue;
        const attempt = (attempts.get(a.id) ?? 0) + 1;
        const r = await deps.createOffer(cardFor(a, attempt));
        if (r.ok) {
          created++;
          standing.add(a.id);
          open.add(a.project);
        } else if (r.kind === "unknown_project" || r.kind === "invalid") {
          if (!refused.has(a.id)) { refused.add(a.id); log(`approval ${a.id} not offered: ${r.error}`); }
        }
      }
      return created;
    } finally {
      syncing = false;
    }
  }

  /** Run the effect of every answered factory offer that has not run yet. Returns how many ran. */
  async function processAnswers(): Promise<number> {
    const todo: { offer: ActionOffer; id: string; argv: string[] }[] = [];
    for (const offer of deps.listOffers()) {
      const id = approvalIdOf(offer);
      if (!id || offer.state !== "answered" || handled.has(offer.id)) continue;
      let argv: string[] | null = null;
      if ((offer.answeredButton === "approve" || offer.answeredButton === "reject") && !id.startsWith("-")) {
        argv = [offer.answeredButton, id, "--by", ANSWER_CHANNEL];
        // The landing is a separate, detached call (below): approve only records the answer, so its 10 s timeout cannot kill a merge.
        if (offer.answeredButton === "approve") argv.push("--no-land");
      } else if (offer.answeredButton === "halt" && PROJECT_NAME.test(offer.project) && now() - (offer.answeredAt ?? 0) <= HALT_FRESH_MS) {
        argv = ["halt", offer.project];
      }
      handled.add(offer.id);
      if (argv) todo.push({ offer, id, argv });
    }
    for (const t of todo) {
      const r = await exec(bin(), t.argv);
      if (r.code !== 0) {
        log(`factoryctl ${t.argv[0]} ${t.id} exited ${r.code}: ${r.output}`);
        if (r.code === EXIT_NOT_APPROVED && (t.argv[0] === "approve" || t.argv[0] === "reject")) failed.add(t.offer.id);
      } else if (t.argv[0] === "approve") {
        spawnDetached(bin(), ["land", t.id]);
      }
    }
    return todo.length;
  }

  /** Answers first (so an Approve is not delayed behind a slow sync), then new cards. */
  async function tick(): Promise<void> {
    try {
      await processAnswers();
      await sync();
    } catch (e: any) {
      log(`tick failed: ${e?.message || e}`);
    }
  }

  return { sync, processAnswers, tick };
}

/** One pass of cards for the pending approvals (the loop also runs the answers). */
export function syncFactoryApprovals(deps: FactoryApprovalsDeps): Promise<number> {
  return createFactoryApprovals(deps).sync();
}

/** Runs a tick every 60 s (first one after 60 s, so mounting the router starts nothing). Returns stop(). */
export function startFactoryApprovalsLoop(deps: FactoryApprovalsDeps, intervalMs = SYNC_INTERVAL_MS): () => void {
  // Under the node test runner a loop only runs with an injected exec: a tick loads claude-runner and may call the live factoryctl.
  if (process.env.NODE_TEST_CONTEXT && !deps.exec && !process.env.FACTORYCTL_BIN) return () => {};
  const approvals = createFactoryApprovals(deps);
  const timer = setInterval(() => { void approvals.tick(); }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
