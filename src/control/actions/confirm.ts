import crypto from "crypto";
import express from "express";
import { errorBody } from "../contract";
import type { OpsStore } from "../ops-store";
import { clientAddress } from "../rate-limit";
import type { Cap, Device } from "../store";
import { ACTION_ID } from "./tokens";

const IDEM_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
type ActionToken = NonNullable<ReturnType<OpsStore["getActionToken"]>>;

/** Why a confirm does not run: answered with this status and code, audited, and the token is left unused. */
export interface Refusal {
  status: 403 | 404 | 409 | 429 | 503;
  code: "forbidden" | "not_found" | "conflict" | "rate_limited" | "unavailable";
  message: string;
  retryAfterSec?: number;
  /** Extra top-level fields of the error body (the duplicate guard of G2 adds the run id). */
  extra?: Record<string, unknown>;
}

export interface ConfirmCtx {
  device: Device;
  token: ActionToken;
  /** The payload stored at prepare (already checked against its hash and deleted), or null when the kind has none. */
  payload: any;
  /** Room for `check` to hand what it resolved (an agent name) to `run`, so GodHome is not asked twice. */
  scratch: Record<string, unknown>;
  now: () => number;
}

export interface ConfirmOutcome {
  /** Audit result: "ok", or "failed" for an action that ran and did not succeed. */
  ok: boolean;
  /** Audit `result` and `detail` columns. */
  result: string;
  detail: string;
  /** The reply, stored with the Idempotency-Key and replayed verbatim. */
  body: Record<string, unknown>;
  /** HTTP status of the reply (default 200). A status of 400 or more is not stored under the key: the token is spent either way. */
  status?: number;
  /** The audit `params` column (JSON, already redacted); default "{}". */
  params?: string;
  /** One info line for the owner's feed. */
  feed?: string;
}

/**
 * One kind of fingerprint action. `check` runs before the token is consumed (a refusal leaves it usable); when it is synchronous,
 * nothing awaits between it and the consume, so two concurrent confirms cannot both pass. `run` runs once, after the consume.
 */
export interface ActionKind {
  name: string;
  /** The cap a device needs to confirm a token of this kind. */
  cap: Cap;
  /** The audit action of the confirm row and the namespace of its Idempotency-Keys. */
  confirmAction: string;
  check(ctx: ConfirmCtx): Refusal | null | Promise<Refusal | null>;
  run(ctx: ConfirmCtx): Promise<ConfirmOutcome>;
  /** Called with one info line after a run; absent for kinds that write no feed line. */
  feed?: { add(e: { source: string; text: string; kind?: "info" }): unknown };
}

export interface ConfirmDeps {
  store: OpsStore;
  kinds: readonly ActionKind[];
  now: () => number;
}

const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

/**
 * X16: `POST /ops/actions/:actionId/confirm`, the one confirm route of every fingerprint action. It finds the token, dispatches on
 * its kind and checks that kind's cap. Order (003): replay of the Idempotency-Key, device binding, used, expired, the kind's own checks,
 * then the atomic consume, then the run. The reply and the audit row are stored under the key so a retry never acts twice.
 */
export function mountConfirm(r: express.Router, deps: ConfirmDeps, writeLimit: express.RequestHandler): void {
  const { store, kinds, now } = deps;
  const byName = new Map(kinds.map((k) => [k.name, k]));
  const caps = new Set(kinds.map((k) => k.cap));
  const forbidden = (res: express.Response, cap: Cap) => res.status(403).json(errorBody("forbidden", `Device lacks ${cap}`));

  // A device that can confirm nothing at all never gets as far as the token lookup.
  const anyCap: express.RequestHandler = (_req, res, next) => {
    const device = res.locals.device as Device | undefined;
    if (!device) return res.status(401).json(errorBody("unauthorized", "Unauthorized"));
    if (!device.caps.some((c) => caps.has(c))) return forbidden(res, kinds[0]!.cap);
    next();
  };

  r.post("/ops/actions/:actionId/confirm", anyCap, writeLimit, async (req, res) => {
    const started = performance.now();
    const device = res.locals.device as Device;
    const actionId = String(req.params.actionId);
    if (!ACTION_ID.test(actionId)) return res.status(400).json(errorBody("bad_request", `actionId must match ${ACTION_ID.source}`));
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !IDEM_KEY.test(key)) return res.status(400).json(errorBody("bad_request", `Idempotency-Key is required and must match ${IDEM_KEY.source}`));

    for (const k of kinds) {
      const prior = store.findIdem(k.confirmAction, key);
      if (!prior) continue;
      if (prior.deviceId !== device.id || prior.subject !== actionId || prior.response === null) {
        return res.status(409).json(errorBody("conflict", "Idempotency-Key was already used for another request"));
      }
      if (!device.caps.includes(k.cap)) return forbidden(res, k.cap);
      return res.json(JSON.parse(prior.response));
    }

    const token = store.getActionToken(actionId);
    // Until the token's kind is known only the audit of an unknown action is possible; it names the generic confirm.
    const kind = token ? byName.get(token.kind) : undefined;
    const audit = (action: string, result: string, detail: string, response?: unknown, params = "{}"): boolean => store.audit({
      at: now(), deviceId: device.id, deviceName: device.name, addr: clientAddress(req), action, subject: actionId,
      params, result, detail, durMs: Math.round(performance.now() - started),
      ...(response !== undefined ? { idemKey: key, response: JSON.stringify(response) } : {}),
    });
    const auditAction = kind?.confirmAction ?? "restart.confirm";
    const fail = (status: number, code: "not_found" | "conflict" | "rate_limited", message: string, retryAfterSec?: number, extra?: Record<string, unknown>) => {
      audit(auditAction, code, message);
      if (retryAfterSec !== undefined) res.setHeader("Retry-After", String(retryAfterSec));
      return res.status(status).json({ ...errorBody(code, message), ...extra });
    };

    if (!token || token.deviceId !== device.id) return fail(404, "not_found", "No such action");
    if (!kind) return fail(409, "conflict", "Unknown action kind");
    if (!device.caps.includes(kind.cap)) return forbidden(res, kind.cap);
    if (token.usedAt !== null) return fail(409, "conflict", "This action was already used");
    if (now() >= token.expiresAt) return fail(409, "conflict", "This action has expired");

    const ctx: ConfirmCtx = { device, token, payload: null, scratch: {}, now };
    // The payload is read (not yet deleted) so the kind's checks can see it; a refusal leaves it for the next try, the consume spends it.
    if (token.payloadHash !== null) {
      const raw = store.peekPayload(actionId);
      if (raw === null || sha256(raw) !== token.payloadHash) return fail(409, "conflict", "This action can no longer be confirmed");
      ctx.payload = JSON.parse(raw);
    }
    const checked = kind.check(ctx);
    const refusal = checked instanceof Promise ? await checked : checked;
    if (refusal) return fail(refusal.status, refusal.code as "not_found", refusal.message, refusal.retryAfterSec, refusal.extra);

    if (!store.consumeRestartToken(actionId, now())) {
      return fail(409, "conflict", store.getActionToken(actionId)?.usedAt === null ? "This action has expired" : "This action was already used");
    }
    store.takePayload(actionId);

    let out: ConfirmOutcome;
    try {
      out = await kind.run(ctx);
    } catch (e: any) {
      console.warn(`[control-api] ${kind.confirmAction} run: ${String(e?.name ?? "Error").slice(0, 40)}`);
      out = { ok: false, result: "failed", detail: "failed", body: { ok: false } };
    }
    const failedReply = out.status !== undefined && out.status >= 400;
    if (!audit(kind.confirmAction, out.result, out.detail, failedReply ? undefined : out.body, out.params) && !failedReply) {
      const won = store.findIdem(kind.confirmAction, key);
      if (won?.response) return res.json(JSON.parse(won.response));
    }
    if (out.feed) {
      try {
        kind.feed?.add({ source: "tokyo", kind: "info", text: out.feed });
      } catch (e: any) {
        console.warn(`[control-api] ${kind.confirmAction} feed: ${String(e?.name ?? "Error").slice(0, 40)}`);
      }
    }
    res.status(out.status ?? 200).json(out.body);
  });
}
