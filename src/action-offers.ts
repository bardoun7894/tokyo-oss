import { randomUUID } from "crypto";

// Generic action cards: 1 to 8 buttons, optional prompt per button. Modelled on
// DeployOffers (deploy-offers.ts), which stays untouched. However the answer
// arrives (Telegram button, internal endpoint, Control app) it goes through
// take(), so an offer is answered exactly once.

export const ACTION_OFFER_TTL_MS = 24 * 60 * 60 * 1000;

export interface OfferButton {
  id: string;
  label: string;
  prompt?: string;
}

/** Answering the offer sends a Temporal signal instead of running a prompt. */
export interface OfferSignal {
  namespace: string;
  workflowId: string;
  /** button id -> signal name */
  map: Record<string, string>;
}

export interface ActionOffer {
  id: string;
  project: string;
  chatId: number;
  title: string;
  body: string;
  buttons: OfferButton[];
  from?: string;
  state: "pending" | "answered" | "superseded" | "expired";
  answeredButton?: string;
  channel?: string;
  createdAt: number;
  answeredAt?: number;
  telegramMessageId?: number;
  signal?: OfferSignal;
}

export type ActionTakeResult =
  | { status: "applied"; offer: ActionOffer; button: OfferButton }
  | { status: "already"; offer: ActionOffer }
  | { status: "badbutton"; offer: ActionOffer }
  | { status: "missing" };

export const DEFAULT_BUTTONS: readonly OfferButton[] = [
  {
    id: "run",
    label: "Run next step",
    prompt:
      "Do the next step for this project as described in the card that offered it. Follow the repo's own process " +
      "(specs, tests first). Do not deploy. Report what changed.",
  },
  {
    id: "report",
    label: "Report only",
    prompt:
      "Write a short status report for this project: what is done, what is missing, what you would do next. " +
      "Change no files, commit nothing, deploy nothing.",
  },
  { id: "skip", label: "Skip" },
];

const BUTTON_ID = /^[a-z0-9_-]{1,16}$/;

export function validateButtons(buttons: OfferButton[]): OfferButton[] {
  if (!Array.isArray(buttons) || buttons.length < 1 || buttons.length > 8) throw new Error("need 1 to 8 buttons");
  const seen = new Set<string>();
  return buttons.map((b) => {
    if (!b || typeof b.id !== "string" || !BUTTON_ID.test(b.id)) throw new Error(`bad button id ${JSON.stringify(b?.id)}`);
    if (seen.has(b.id)) throw new Error(`duplicate button id ${b.id}`);
    seen.add(b.id);
    if (typeof b.label !== "string" || b.label.length < 1 || b.label.length > 32) throw new Error(`bad label for button ${b.id} (1 to 32 chars)`);
    if (b.prompt != null && (typeof b.prompt !== "string" || b.prompt.length > 8000)) throw new Error(`bad prompt for button ${b.id} (max 8000 chars)`);
    return b.prompt ? { id: b.id, label: b.label, prompt: b.prompt } : { id: b.id, label: b.label };
  });
}

const SIGNAL_PART = /^[A-Za-z0-9_.-]{1,120}$/;
const SIGNAL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function validateSignal(sig: OfferSignal, buttonIds: string[]): OfferSignal {
  if (!sig || typeof sig !== "object") throw new Error("bad signal");
  if (typeof sig.namespace !== "string" || !SIGNAL_PART.test(sig.namespace)) throw new Error("bad signal namespace");
  if (typeof sig.workflowId !== "string" || !SIGNAL_PART.test(sig.workflowId)) throw new Error("bad signal workflowId");
  const entries = Object.entries(sig.map ?? {});
  if (entries.length < 1) throw new Error("signal map needs at least one button");
  const map: Record<string, string> = {};
  for (const [button, name] of entries) {
    if (!buttonIds.includes(button)) throw new Error(`signal map names unknown button ${JSON.stringify(button)}`);
    if (typeof name !== "string" || !SIGNAL_NAME.test(name)) throw new Error(`bad signal name for button ${button}`);
    map[button] = name;
  }
  return { namespace: sig.namespace, workflowId: sig.workflowId, map };
}

/** Optional durable backing (action-offers-store.ts). */
export interface ActionOfferBacking {
  save(o: ActionOffer): void;
  loadAll(since: number): ActionOffer[];
  prune(now: number): void;
}

export interface ActionOffersOpts {
  newId?: () => string;
  store?: ActionOfferBacking;
  /** "Now" for the initial load from the store (default Date.now()). */
  loadNow?: number;
}

export class ActionOffers {
  private offers = new Map<string, ActionOffer>();
  private newId: () => string;
  private store?: ActionOfferBacking;

  constructor(opts: ActionOffersOpts = {}) {
    this.newId = opts.newId ?? (() => randomUUID().slice(0, 8));
    this.store = opts.store;
    if (this.store) {
      const now = opts.loadNow ?? Date.now();
      for (const o of this.store.loadAll(now - ACTION_OFFER_TTL_MS)) this.offers.set(o.id, o);
    }
  }

  /** Remember the Telegram message of a card so it can be edited later. */
  setTelegramMessageId(id: string, messageId: number): void {
    const o = this.offers.get(id);
    if (!o) return;
    o.telegramMessageId = messageId;
    this.store?.save(o);
  }

  /** Create a card. Older pending cards of the same project are marked superseded and returned. */
  create(o: {
    project: string; chatId: number; title: string; body: string; now: number;
    buttons?: OfferButton[]; from?: string; signal?: OfferSignal;
  }): { offer: ActionOffer; superseded: ActionOffer[] } {
    const buttons = validateButtons(o.buttons ?? DEFAULT_BUTTONS.map((b) => ({ ...b })));
    const signal = o.signal ? validateSignal(o.signal, buttons.map((b) => b.id)) : undefined;
    this.prune(o.now);
    const superseded: ActionOffer[] = [];
    // A signal offer waits on a workflow, so it never supersedes and is never superseded.
    for (const old of signal ? [] : this.offers.values()) {
      if (old.project === o.project && old.state === "pending" && !old.signal) {
        old.state = "superseded";
        superseded.push(old);
        this.store?.save(old);
      }
    }
    const offer: ActionOffer = {
      id: this.newId(),
      project: o.project,
      chatId: o.chatId,
      title: o.title,
      body: o.body,
      buttons,
      from: o.from?.trim() || undefined,
      state: "pending",
      createdAt: o.now,
      ...(signal ? { signal } : {}),
    };
    this.offers.set(offer.id, offer);
    this.store?.save(offer);
    return { offer, superseded };
  }

  get(id: string, now: number): ActionOffer | undefined {
    this.prune(now);
    return this.offers.get(id);
  }

  /** Answer an offer once. A second answer from another channel reports the first. */
  take(id: string, buttonId: string, channel: string, now: number): ActionTakeResult {
    const offer = this.get(id, now);
    if (!offer) return { status: "missing" };
    if (offer.state !== "pending") return { status: "already", offer };
    const button = offer.buttons.find((b) => b.id === buttonId);
    if (!button) return { status: "badbutton", offer };
    offer.state = "answered";
    offer.answeredButton = button.id;
    offer.channel = channel;
    offer.answeredAt = now;
    this.store?.save(offer);
    return { status: "applied", offer, button };
  }

  /** The offer (any state) that signals this workflow, if still held. */
  findBySignal(namespace: string, workflowId: string, now: number): ActionOffer | undefined {
    return this.list(now).find((o) => o.signal?.namespace === namespace && o.signal.workflowId === workflowId);
  }

  /** Open offers for one chat, newest first. */
  pendingFor(chatId: number, now: number): ActionOffer[] {
    return this.listPending(now).filter((o) => o.chatId === chatId);
  }

  /** Every offer still held (any state), newest first. */
  list(now: number): ActionOffer[] {
    this.prune(now);
    return [...this.offers.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Open project cards, newest first: signal (incident) cards belong to a workflow, not to the project. */
  listPendingCards(now: number): ActionOffer[] {
    return this.listPending(now).filter((o) => !o.signal);
  }

  /** All open offers, newest first. */
  listPending(now: number): ActionOffer[] {
    return this.list(now).filter((o) => o.state === "pending");
  }

  prune(now: number): void {
    for (const [k, o] of this.offers) if (now - o.createdAt > ACTION_OFFER_TTL_MS) this.offers.delete(k);
    this.store?.prune(now);
  }
}
