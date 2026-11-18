import crypto from "crypto";
import type { OpsStore } from "../ops-store";
import { TOKEN_TTL_MS } from "../ops-restart";

export { TOKEN_TTL_MS };
/** Prepare tokens for every fingerprint action (spec 012 D9): one id shape, one 120 s lifetime, single use, bound to the device. */
export const ACTION_ID = /^act_[0-9a-f]{12}$/;

export interface PrepareArgs {
  /** The action kind; the confirm route dispatches on it and checks its cap. */
  kind: string;
  deviceId: string;
  /** What the action is about (an incident id, a project, an opaque agent id); shown nowhere, used for audit and replay checks. */
  subject: string;
  /** The allowlist id, project or other key the kind re-checks at confirm time. */
  targetId: string;
  incidentId?: string;
  /** Anything the confirm needs and the phone must not resend (a prompt). Stored apart, deleted on use, pruned at expiry. */
  payload?: unknown;
  now: number;
}

export function prepareToken(store: OpsStore, a: PrepareArgs): { actionId: string; expiresAt: number } {
  const actionId = `act_${crypto.randomBytes(6).toString("hex")}`;
  const expiresAt = a.now + TOKEN_TTL_MS;
  store.createActionToken({
    actionId, kind: a.kind, deviceId: a.deviceId, subject: a.subject, targetId: a.targetId, incidentId: a.incidentId, expiresAt,
    ...(a.payload !== undefined ? { payload: JSON.stringify(a.payload) } : {}),
  }, a.now);
  return { actionId, expiresAt };
}
