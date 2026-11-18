import express from "express";
import { factoryAudit, repoExists, type FactoryRunPayload } from "../actions/kinds/gh_factory_run";
import { prepareToken } from "../actions/tokens";
import { ADWS, FACTORY_STAGES, plainName } from "./client";
import { clean, fromWrite, isOutcome, iso, pick, readRoute, refuse, resolveOpaque, rows, writeRoute, type GhArea } from "./common";
import { GH_ID } from "./ids";

// K25..K30 (research-gh field allowlist): the software factory's board, runs, launches and cards. Run output, plans, reviews, diffs,
// file and column names, repo paths and launch output never leave; card, column and launch ids are opaque. A new card is not offered.

const CARD = "card";
const COLUMN = "column";
const LAUNCH = "launch";
const MAX_TICKET = 2000;
const MAX_CARDS = 200;
const MAX_RUNS = 30;

const strings = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max).map((x) => clean(x, 40)) : []);

export function factoryRoutes(d: GhArea): express.Router {
  const r = express.Router();
  const now = d.now ?? Date.now;
  const c = d.client;

  // K25: repos, workflows and stages, recent runs, launches and the kanban cards. `columns` lists the opaque column ids in board order.
  readRoute(r, d, "/ops/gh/factory", () => [c.read("factory"), c.read("factoryRuns"), c.read("factoryLaunches")], ([f, runs, launches]) => {
    const columns: { id: string; count: number }[] = [];
    const cards: { id: string; column: string; title: string }[] = [];
    for (const [col, list] of Object.entries((f?.kanban && typeof f.kanban === "object" ? f.kanban : {}) as Record<string, unknown>)) {
      const colId = d.ids.opaque(COLUMN, col, now());
      const items = rows(list);
      columns.push({ id: colId, count: items.length });
      for (const card of items) {
        if (cards.length >= MAX_CARDS || typeof card.file !== "string") continue;
        cards.push({ id: d.ids.opaque(CARD, JSON.stringify([col, card.file]), now()), column: colId, title: clean(card.title, 120) });
      }
    }
    return {
      repos: rows(f?.repos).filter((x) => typeof x.name === "string").map((x) => ({ name: clean(x.name, 60) })),
      adws: strings(f?.adws, 10),
      stages: strings(f?.stages, 12),
      runs: rows(runs?.runs, MAX_RUNS).map((x) => ({ ...pick(x, ["id", "ok", "running", "verdictPass", "at"], 80), stages: strings(x.stages, 12), ...pick(x, ["ticket"], 160) })),
      launches: rows(launches?.launches).filter((l) => typeof l.key === "string").map((l) => ({ id: d.ids.opaque(LAUNCH, l.key as string, now()), ...pick(l, ["runId", "started", "exited", "adopted"], 80) })),
      columns,
      cards,
    };
  });

  // K26: one run's status and phases. No output, plan, review, diff, baseline, findings, file names or write globs.
  readRoute(r, d, "/ops/gh/factory/runs/:id", (req) => [c.read("factoryRun", { name: plainName("run id", req.params.id) })], ([b]) => ({
    ...pick(b, ["id", "running", "verdictPass"], 80), ...pick(b, ["ticket"], 160),
    stageStates: rows(b?.stageStates, 30).map((s) => ({ ...pick(s, ["stage", "kind", "state", "ok", "passed", "ms"], 80), ...pick(s, ["summary"], 160) })),
    roster: rows(b?.roster, 30).map((a) => pick(a, ["name", "model"], 80)),
    timeline: rows(b?.envelopeTimeline, 30).map((t) => ({ ...pick(t, ["phase", "status", "approved", "passed"], 80), ...pick(t, ["summary"], 160) })),
  }), { notFound404: true });

  // K27: stop a launch.
  writeRoute(r, d, {
    code: "K27", method: "post", path: "/ops/gh/factory/launches/:id/stop", cap: "ops:write",
    run: async (req) => {
      const id = String(req.params.id);
      const got = resolveOpaque(d.ids, LAUNCH, id);
      if (isOutcome(got)) return got;
      return fromWrite(await c.write("launchStop", { seg: [got.source] }), { subject: id, gone: (j) => j?.ok === false });
    },
  });

  // K28: move a card to another column. Both ids are opaque; the names are resolved here.
  writeRoute(r, d, {
    code: "K28", method: "post", path: "/ops/gh/factory/cards/:id/move", cap: "ops:write",
    run: async (req) => {
      const id = String(req.params.id);
      const to = (req.body ?? {}).to;
      if (typeof to !== "string" || !GH_ID.test(to)) return refuse(400, "bad_request", `to must be a column id (${GH_ID.source})`, { subject: id.slice(0, 40) });
      const card = resolveOpaque(d.ids, CARD, id);
      if (isOutcome(card)) return card;
      const col = resolveOpaque(d.ids, COLUMN, to);
      if (isOutcome(col)) return col;
      const [from, file] = JSON.parse(card.source) as [string, string];
      return fromWrite(await c.write("cardMove", { seg: [from, file], body: { to: col.source } }), { subject: id, gone: (j) => j?.ok === false });
    },
  });

  // K29: delete a card.
  writeRoute(r, d, {
    code: "K29", method: "delete", path: "/ops/gh/factory/cards/:id", cap: "ops:write",
    run: async (req) => {
      const id = String(req.params.id);
      const card = resolveOpaque(d.ids, CARD, id);
      if (isOutcome(card)) return card;
      const [from, file] = JSON.parse(card.source) as [string, string];
      return fromWrite(await c.write("cardDelete", { seg: [from, file] }), { subject: id, gone: (j) => j?.ok === false });
    },
  });

  // K30: prepare a factory run. Only `ticket`, `repo`, `stages` and `adw` are read from the request (the T0.5 allowlist); anything else,
  // `merge` included, is dropped. The confirm (X16, kind gh_factory_run) is what reaches GodHome.
  writeRoute(r, d, {
    code: "K30", method: "post", path: "/ops/gh/factory/run", cap: "ops:run",
    run: async (req, device) => {
      const { ticket, repo, stages, adw } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof ticket !== "string" || ticket.trim().length === 0 || ticket.length > MAX_TICKET) return refuse(400, "bad_request", `ticket must be 1 to ${MAX_TICKET} characters`);
      if (typeof repo !== "string" || repo.length < 1 || repo.length > 200) return refuse(400, "bad_request", "repo must be a repo name from the factory");
      if (stages !== undefined && (typeof stages !== "string" || stages.length > 120 || !stages.split(",").every((s) => (FACTORY_STAGES as readonly string[]).includes(s)))) {
        return refuse(400, "bad_request", `stages must be a comma list of ${FACTORY_STAGES.join(", ")}`);
      }
      if (adw !== undefined && !(ADWS as readonly unknown[]).includes(adw)) return refuse(400, "bad_request", `adw must be one of ${ADWS.join(", ")}`);
      const payload: FactoryRunPayload = { ticket, repo, ...(stages !== undefined ? { stages: stages as string } : {}), ...(adw !== undefined ? { adw: adw as string } : {}) };
      const params = factoryAudit(payload);
      const has = await repoExists({ client: c }, repo, false);
      if (has === "down") return refuse(503, "unavailable", "GodHome is not reachable", { params, subject: clean(repo, 60) });
      if (has === "no") return refuse(404, "not_found", "No such repo", { params, subject: clean(repo, 60) });
      const { actionId, expiresAt } = prepareToken(d.ops, { kind: "gh_factory_run", deviceId: device.id, subject: repo, targetId: repo, payload, now: now() });
      return { status: 200, body: { actionId, kind: "gh_factory_run", label: clean(repo, 60), expiresAt: iso(expiresAt) }, result: "ok", params, subject: clean(repo, 60) };
    },
  });

  return r;
}
