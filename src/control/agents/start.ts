import crypto from "crypto";
import type { ActionAnswer } from "../../action-offer-flow";
import type { OfferActionArgs, OfferActionResult } from "../../action-offer-flow";
import type { ControlRun } from "../store";
import { redact } from "../redact";
import type { Variant } from "./targets";

export const MAX_PROMPT = 4000;
const AUDIT_PREVIEW = 60;
const RUN_PREVIEW = 200;
const RUN_BUTTON = "run";

/** What the audit may keep of a prompt: its length, its sha256 and a short redacted one-line preview. Never the text. */
export function promptAudit(prompt: string): { len: number; sha256: string; preview: string } {
  return {
    len: prompt.length,
    sha256: crypto.createHash("sha256").update(prompt).digest("hex"),
    // Redact the whole prompt, then cut: a secret that straddles the cut must not survive as a fragment.
    preview: redact(prompt).replace(/\s+/g, " ").trim().slice(0, AUDIT_PREVIEW),
  };
}

/** The `promptPreview` of a run row and the duplicate guard's key: the first 200 characters, redacted. */
export const previewOf = (prompt: string): string => redact(prompt.slice(0, RUN_PREVIEW));

/** A queued or running run of the same project with the same preview (write-spec's rule), or undefined. */
export function findDuplicate(runs: { listRuns(f: { project: string; status: string; limit: number }): ControlRun[] }, project: string, prompt: string): ControlRun | undefined {
  const preview = previewOf(prompt);
  for (const status of ["queued", "running"]) {
    const dup = runs.listRuns({ project, status, limit: 100 }).find((r) => r.promptPreview === preview);
    if (dup) return dup;
  }
  return undefined;
}

export interface StartRunArgs { project: string; prompt: string; variant: Variant; runId: string }
export type StartResult = { ok: true } | { ok: false; kind: "not_found" | "conflict" | "unavailable"; message: string };
export type StartRun = (a: StartRunArgs) => Promise<StartResult>;

export interface StartRunBackends {
  createOffer(a: OfferActionArgs): Promise<OfferActionResult>;
  answerAction(id: string, button: string, channel: string, opts?: { runId?: string }): Promise<ActionAnswer>;
}

/**
 * The write-spec path (research section 4 C): a one-button action card carrying the prompt, answered at once with the run id, so
 * claude-runner takes it from there. The caller has already inserted the queued run row. The card text names the project only;
 * the prompt travels in the button and nowhere else. Errors are mapped to a kind and a fixed message, never the thrown text.
 */
export function startRunVia(b: StartRunBackends): StartRun {
  return async (a) => {
    try {
      const made = await b.createOffer({
        project: a.project, title: `Agent run: ${a.project}`, body: "Started from the Control app.",
        buttons: [{ id: RUN_BUTTON, label: "Run", prompt: a.prompt }], from: "control-app",
      });
      if (!made.ok) return made.kind === "unknown_project" ? { ok: false, kind: "not_found", message: "No such project" } : { ok: false, kind: "unavailable", message: "The runner is not available" };
      const out = await b.answerAction(made.id, RUN_BUTTON, "app", { runId: a.runId });
      if (out.status === "applied") return { ok: true };
      return out.status === "already" ? { ok: false, kind: "conflict", message: "This run was already answered" } : { ok: false, kind: "unavailable", message: "The runner is not available" };
    } catch (e: any) {
      console.warn(`[control-api] agent start: ${String(e?.name ?? "Error").slice(0, 40)}`);
      return { ok: false, kind: "unavailable", message: "The runner is not available" };
    }
  };
}
