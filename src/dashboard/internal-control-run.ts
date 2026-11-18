/**
 * Loopback-only run registration for tools Tokyo does not run itself (`jdelegate`, `server-agent.sh`),
 * so their runs show up in the Control app. Same gate position as the other internal endpoints.
 *
 *   POST /api/internal/control-run {action:"start", source, project, host?, model?, harness?, worker?, tier?, prompt?} -> {id}
 *   POST /api/internal/control-run {action:"finish", id, exitCode}                                                     -> {ok}
 *
 * Everything stored here is shown to the phone, so each field is a short label: no paths, no secrets.
 */

import crypto from "crypto";
import type { Express, Request, Response } from "express";
import { HARNESSES, TIERS, normHost } from "../control/contract";
import { PROJECT_NAME } from "../control/paging";
import { redact } from "../control/redact";
import { recordRunFinished } from "../control/runs";
import type { ControlStore } from "../control/store";
import { loopbackOnly } from "./loopback";

const SOURCES = ["jdelegate", "server-agent"] as const;
const LABEL = /^[A-Za-z0-9._:-]{1,64}$/;
const MODEL = /^[A-Za-z0-9._-]{1,64}$/;
const ID = /^[0-9a-f]{8}$/;
const PROMPT_MAX = 200;
const PATH_LIKE = /(^|[\s"'=(])[\/~]\S/;

export interface ControlRunOpts { now?: () => number; newId?: () => string }

const isOneOf = <T extends string>(set: readonly T[], v: unknown): v is T => typeof v === "string" && (set as readonly string[]).includes(v);
// A value that redact() would change carries a secret or an agent path.
const clean = (v: string) => redact(v) === v;

export function registerInternalControlRun(app: Express, store: () => ControlStore, opts: ControlRunOpts = {}): void {
  const now = opts.now ?? Date.now;
  const newId = opts.newId ?? (() => crypto.randomBytes(4).toString("hex"));

  app.post("/api/internal/control-run", (req: Request, res: Response) => {
    if (!loopbackOnly(req, res)) return;
    const b = req.body ?? {};
    const bad = (m: string) => res.status(400).json({ error: m });

    if (b.action === "finish") {
      if (typeof b.id !== "string" || !ID.test(b.id)) return bad("id must be an 8-hex run id");
      if (!Number.isInteger(b.exitCode)) return bad("exitCode must be an integer");
      const s = store();
      if (!s.getRun(b.id)) return res.status(404).json({ error: "no such run" });
      recordRunFinished(s, b.id, { ok: b.exitCode === 0, exitCode: b.exitCode, now: now() });
      return void res.json({ ok: true });
    }
    if (b.action !== "start") return bad("action must be start or finish");

    if (!isOneOf(SOURCES, b.source)) return bad("source must be jdelegate or server-agent");
    if (typeof b.project !== "string" || !PROJECT_NAME.test(b.project)) return bad("invalid project name");
    const host = b.host === undefined ? "server" : normHost(b.host);
    if (!host) return bad("host must be mac, laptop or server");
    if (b.harness != null && !isOneOf(HARNESSES, b.harness)) return bad("unknown harness");
    if (b.tier != null && !isOneOf(TIERS, b.tier)) return bad("unknown tier");
    if (b.model != null && !(typeof b.model === "string" && MODEL.test(b.model) && clean(b.model))) return bad("model must be a plain model name");
    if (b.worker != null && !(typeof b.worker === "string" && LABEL.test(b.worker) && clean(b.worker))) return bad("worker must be a short label");
    if (b.prompt != null && !(typeof b.prompt === "string" && b.prompt.length <= PROMPT_MAX && clean(b.prompt) && !PATH_LIKE.test(b.prompt))) {
      return bad("prompt must be at most 200 characters without paths or secrets");
    }

    const id = newId();
    store().insertRun({
      id, project: b.project, source: b.source, status: "running", model: b.model ?? null, harness: b.harness ?? null,
      worker: b.worker ?? null, tier: b.tier ?? null, promptPreview: b.prompt ?? "", startedAt: now(), endedAt: null,
      exitCode: null, host, offerId: null, workspace: null,
    });
    res.json({ id });
  });
}
