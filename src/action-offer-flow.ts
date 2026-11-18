import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { ProjectRef } from "./project-registry";
import type { ActionOffer, ActionOffers, OfferButton } from "./action-offers";

// Incident cards: the answer is a Temporal signal to the on-call workflow (/root/oncall),
// not a prompt, so a yes never makes Tokyo deploy by itself.
export const INCIDENT_NAMESPACE = "oncall";
export const INCIDENT_BUTTONS: readonly OfferButton[] = [
  { id: "approve", label: "Deploy fix" },
  { id: "decline", label: "Not now" },
];
const INCIDENT_SIGNALS: Record<string, string> = { approve: "approve", decline: "decline" };
export const INCIDENT_RISKS = ["low", "medium", "high", "unknown"] as const;
export type IncidentRisk = (typeof INCIDENT_RISKS)[number];
const INCIDENT_ID = /^[A-Za-z0-9_-]{1,120}$/;
export const SIGNAL_RETRY_MS = 5000;

export interface IncidentArgs {
  incidentId: string;
  app: string;
  title: string;
  summary: string;
  risk: IncidentRisk;
  diffStat?: string;
  branch?: string;
  from?: string;
}

export interface SignalRequest {
  namespace: string;
  workflowId: string;
  signalName: string;
}

export type OfferIncidentResult =
  | { ok: true; id: string; existing: boolean }
  | { ok: false; kind: "invalid" | "unavailable"; error: string };

/** Validate and trim an untrusted incident body. */
export function parseIncidentArgs(raw: unknown): { ok: true; args: IncidentArgs } | { ok: false; error: string } {
  const b = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  if (typeof b.incidentId !== "string" || !INCIDENT_ID.test(b.incidentId)) return { ok: false, error: "incidentId must match [A-Za-z0-9_-]{1,120}" };
  const app = str(b.app);
  if (!app || app.length > 80) return { ok: false, error: "app is required (1 to 80 characters)" };
  const title = str(b.title);
  if (!title) return { ok: false, error: "title is required" };
  const summary = str(b.summary);
  if (!summary) return { ok: false, error: "summary is required" };
  if (!(INCIDENT_RISKS as readonly string[]).includes(b.risk as string)) return { ok: false, error: "risk must be low, medium, high or unknown" };
  const opt = (v: unknown, max: number) => (v == null || typeof v !== "string" || !v.trim() ? undefined : v.trim().slice(0, max));
  return {
    ok: true,
    args: {
      incidentId: b.incidentId, app, title: title.slice(0, 200), summary: summary.slice(0, 600), risk: b.risk as IncidentRisk,
      diffStat: opt(b.diffStat, 600), branch: opt(b.branch, 120), from: opt(b.from, 80),
    },
  };
}

function incidentBody(a: IncidentArgs): string {
  const lines = [a.summary, "", `Risk: ${a.risk}`];
  if (a.branch) lines.push(`Branch: ${a.branch}`);
  lines.push(`Incident: ${a.incidentId}`);
  if (a.diffStat) lines.push("", a.diffStat);
  return lines.join("\n");
}

// Glue between ActionOffers and the world: the Telegram card, the answer, and the
// run an answer may start. Everything outside is injected so it runs without
// Telegram. claude-runner.ts builds the live instance (wire-up only).

export interface ActionRun {
  project: ProjectRef;
  prompt: string;
  reason: string;
  chatId: number;
  /** The run must not end with a "Deploy it?" card (FR-A7). */
  noDeployOffer: true;
  /** Control API run id, when the answer came with one already recorded. */
  runId?: string;
}

export interface ActionOfferFlowDeps {
  offers: ActionOffers;
  getBot: () => Pick<Bot, "api"> | null;
  chatId: number;
  now: () => number;
  getProject: (name: string) => ProjectRef | undefined;
  startRun: (r: ActionRun) => Promise<void>;
  /** Sends the Temporal signal of a signal offer. Injected so tests need no Temporal. */
  sendSignal?: (s: SignalRequest) => Promise<void>;
  /** Delay before the one retry (default setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

export interface OfferActionArgs {
  project: string;
  title: string;
  body: string;
  buttons?: OfferButton[];
  from?: string;
}

export type OfferActionResult =
  | { ok: true; id: string; project: string }
  | { ok: false; kind: "unknown_project" | "invalid" | "unavailable"; error: string };

export type ActionAnswer =
  | { status: "applied"; offer: ActionOffer; reply: string }
  | { status: "already"; offer: ActionOffer }
  | { status: "badbutton"; offer: ActionOffer }
  | { status: "missing" };

export interface ActionOfferStatus {
  state: ActionOffer["state"];
  project: string;
  title: string;
  answeredButton?: string;
  channel?: string;
}

function cardText(o: Pick<ActionOffer, "title" | "body">): string {
  return o.body ? `${o.title}\n\n${o.body}` : o.title;
}

function keyboard(o: ActionOffer): InlineKeyboard {
  const kb = new InlineKeyboard();
  o.buttons.forEach((b, i) => {
    kb.text(b.label, `act:${o.id}:${b.id}`);
    if (i % 2 === 1 && i < o.buttons.length - 1) kb.row(); // no trailing empty row for an even count
  });
  return kb;
}

export function createActionOfferFlow(d: ActionOfferFlowDeps) {
  /** Replace a card's text and drop its buttons. Telegram failures never matter here. */
  async function retire(o: ActionOffer, text: string): Promise<void> {
    const bot = d.getBot();
    if (!bot || o.telegramMessageId === undefined) return;
    try {
      await bot.api.editMessageText(o.chatId, o.telegramMessageId, text, { reply_markup: { inline_keyboard: [] } });
    } catch {
      /* message gone or unchanged */
    }
  }

  async function offerActionFromSession(a: OfferActionArgs): Promise<OfferActionResult> {
    const bot = d.getBot();
    if (!bot || !d.chatId) return { ok: false, kind: "unavailable", error: "telegram bot not ready" };
    const project = d.getProject(a.project);
    if (!project) return { ok: false, kind: "unknown_project", error: `unknown project ${JSON.stringify(a.project)}` };
    return offerAction(project, a);
  }

  async function offerAction(project: ProjectRef, a: OfferActionArgs): Promise<OfferActionResult> {
    const bot = d.getBot();
    if (!bot) return { ok: false, kind: "unavailable", error: "telegram bot not ready" };
    let created;
    try {
      created = d.offers.create({
        project: project.name, chatId: d.chatId, title: a.title, body: a.body, buttons: a.buttons, from: a.from, now: d.now(),
      });
    } catch (e: any) {
      return { ok: false, kind: "invalid", error: e?.message || "invalid offer" };
    }
    for (const old of created.superseded) await retire(old, `${cardText(old)}\n\n(superseded by a newer card)`);
    try {
      const m = await bot.api.sendMessage(d.chatId, cardText(created.offer), { reply_markup: keyboard(created.offer) });
      d.offers.setTelegramMessageId(created.offer.id, m.message_id);
    } catch {
      /* the card can still be answered from the terminal or the app */
    }
    return { ok: true, id: created.offer.id, project: project.name };
  }

  const background = new Set<Promise<void>>();
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /** Send the offer's signal. The first try is awaited, one retry runs in the background. The offer stays answered either way. */
  async function deliverSignal(offer: ActionOffer, button: OfferButton): Promise<string> {
    const sig = offer.signal!;
    const signalName = sig.map[button.id];
    if (!signalName) return `${button.label}: noted, nothing sent.`;
    const req: SignalRequest = { namespace: sig.namespace, workflowId: sig.workflowId, signalName };
    const attempt = async () => {
      if (!d.sendSignal) throw new Error("no signaller configured");
      await d.sendSignal(req);
    };
    try {
      await attempt();
      return `${button.label}: signal ${signalName} sent to ${sig.workflowId}.`;
    } catch (err: any) {
      console.error(`[incident-offer] signal ${signalName} to ${sig.workflowId} failed, retrying in ${SIGNAL_RETRY_MS} ms:`, err?.message || err);
    }
    const retry = sleep(SIGNAL_RETRY_MS)
      .then(attempt)
      .catch(async (err: any) => {
        console.error(`[incident-offer] signal ${signalName} to ${sig.workflowId} failed twice:`, err?.message || err);
        try {
          await d.getBot()?.api.sendMessage(offer.chatId, `Incident ${sig.workflowId}: signal failed, answer with: oncall approve|decline ${sig.workflowId}`);
        } catch {
          /* nothing more to try */
        }
      })
      .finally(() => { background.delete(retry); });
    background.add(retry);
    return `${button.label}: signal failed once, retrying in ${SIGNAL_RETRY_MS / 1000} s.`;
  }

  /** Resolves when no signal retry is pending (tests, graceful shutdown). */
  async function settled(): Promise<void> {
    while (background.size) await Promise.all([...background]);
  }

  /** Incident card from the on-call system. Idempotent per incident id. */
  async function offerIncident(raw: unknown): Promise<OfferIncidentResult> {
    const p = parseIncidentArgs(raw);
    if (!p.ok) return { ok: false, kind: "invalid", error: p.error };
    const a = p.args;
    const existing = d.offers.findBySignal(INCIDENT_NAMESPACE, a.incidentId, d.now());
    if (existing) return { ok: true, id: existing.id, existing: true };
    const bot = d.getBot();
    if (!bot || !d.chatId) return { ok: false, kind: "unavailable", error: "telegram bot not ready" };
    let created;
    try {
      created = d.offers.create({
        project: a.app, chatId: d.chatId, title: a.title, body: incidentBody(a), from: a.from, now: d.now(),
        buttons: INCIDENT_BUTTONS.map((b) => ({ ...b })),
        signal: { namespace: INCIDENT_NAMESPACE, workflowId: a.incidentId, map: { ...INCIDENT_SIGNALS } },
      });
    } catch (e: any) {
      return { ok: false, kind: "invalid", error: e?.message || "invalid offer" };
    }
    try {
      const m = await bot.api.sendMessage(d.chatId, cardText(created.offer), { reply_markup: keyboard(created.offer) });
      d.offers.setTelegramMessageId(created.offer.id, m.message_id);
    } catch {
      /* the card can still be answered from the terminal or the app */
    }
    return { ok: true, id: created.offer.id, existing: false };
  }

  /** State of an incident offer; null for any other offer. */
  function incidentOfferStatus(id: string): { state: ActionOffer["state"]; answeredButton?: string; channel?: string } | null {
    const o = d.offers.get(id, d.now());
    if (!o?.signal) return null;
    const s: { state: ActionOffer["state"]; answeredButton?: string; channel?: string } = { state: o.state };
    if (o.answeredButton) s.answeredButton = o.answeredButton;
    if (o.channel) s.channel = o.channel;
    return s;
  }

  /** The one place an action offer is answered, from any channel. take() runs before the first await. */
  async function answerActionOfferDetailed(id: string, buttonId: string, channel: string, opts: { runId?: string } = {}): Promise<ActionAnswer> {
    const r = d.offers.take(id, buttonId, channel, d.now());
    if (r.status !== "applied") return r;
    const { offer, button } = r;
    await retire(offer, `${cardText(offer)}\n\nAnswered on ${channel}: ${button.label}`);
    if (offer.signal) return { status: "applied", offer, reply: await deliverSignal(offer, button) };
    if (!button.prompt) return { status: "applied", offer, reply: `${button.label}: noted, nothing ran.` };
    const project = d.getProject(offer.project);
    if (!project) return { status: "applied", offer, reply: `${button.label}: project ${offer.project} is no longer registered, nothing ran.` };
    d.startRun({
      project, prompt: button.prompt, reason: `${button.label} (${offer.title}) on ${channel}`,
      chatId: offer.chatId, noDeployOffer: true, ...(opts.runId ? { runId: opts.runId } : {}),
    }).catch((err) => {
      d.getBot()?.api.sendMessage(offer.chatId, `Action run errored: ${err?.message || err}`).catch(() => {});
    });
    return { status: "applied", offer, reply: `Running: ${button.label} in ${project.name}…` };
  }

  /** Same answer as a sentence, for Telegram and the terminal. */
  async function answerActionOffer(id: string, buttonId: string, channel: string): Promise<string> {
    const r = await answerActionOfferDetailed(id, buttonId, channel);
    if (r.status === "missing") return `No open offer ${id} (expired or unknown).`;
    if (r.status === "badbutton") return `Offer ${id} has no button "${buttonId}".`;
    if (r.status === "already") {
      const o = r.offer;
      if (o.state === "superseded") return `Offer ${id} was superseded by a newer card.`;
      const label = o.buttons.find((b) => b.id === o.answeredButton)?.label ?? o.answeredButton;
      return `Offer ${id} was already answered on ${o.channel}: ${label}.`;
    }
    return r.reply;
  }

  function actionOfferStatus(id: string): ActionOfferStatus | null {
    const o = d.offers.get(id, d.now());
    if (!o) return null;
    const s: ActionOfferStatus = { state: o.state, project: o.project, title: o.title };
    if (o.answeredButton) s.answeredButton = o.answeredButton;
    if (o.channel) s.channel = o.channel;
    return s;
  }

  return { offerAction, offerActionFromSession, offerIncident, incidentOfferStatus, settled, answerActionOffer, answerActionOfferDetailed, actionOfferStatus };
}
