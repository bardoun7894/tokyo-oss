import fs from "fs";
import { buildOffers, type OfferCtx, type RecEntry } from "./offers";
import { fsRepoReader, summarize, type Gap, type TriageEntry } from "./summary";

// Entry point of the daily sweep after triage.sh and recommend.sh:
//   tsx src/finish-apps/cli.ts <triage.json> [--recs <recs.json>] [--date YYYY-MM-DD] [--dry-run]
// Stores the snapshot (best effort), then posts one action-offer card per project.

export interface PostResult { ok: boolean; status: number; json: any }

export interface CliDeps {
  readFile(path: string): string | null;
  writeFile(path: string, data: string): void;
  post(path: string, body: unknown): Promise<PostResult>;
  now(): number;
  ctx: Pick<OfferCtx, "getProject" | "listProjects" | "recentSkips" | "readerFor">;
  out(line: string): void;
  err(line: string): void;
}

function parseJson(text: string | null): unknown {
  if (text == null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function runCli(argv: string[], d: CliDeps): Promise<number> {
  let triagePath = "";
  let recsPath = "";
  let date = new Date(d.now()).toISOString().slice(0, 10);
  let dry = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dry = true;
    else if (a === "--recs") recsPath = argv[++i] ?? "";
    else if (a === "--date") date = argv[++i] ?? "";
    else if (!a.startsWith("-") && !triagePath) triagePath = a;
    else {
      d.err(`finish-apps: bad argument ${JSON.stringify(a)}`);
      return 2;
    }
  }
  if (!triagePath || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    d.err("usage: cli.ts <triage.json> [--recs recs.json] [--date YYYY-MM-DD] [--dry-run]");
    return 2;
  }
  const triage = parseJson(d.readFile(triagePath));
  if (!Array.isArray(triage)) {
    d.err(`finish-apps: ${triagePath} is missing or not a JSON array`);
    return 2;
  }
  const rawRecs = recsPath ? parseJson(d.readFile(recsPath)) : undefined;
  const recs: RecEntry[] = Array.isArray(rawRecs) ? rawRecs : [];
  if (recsPath && !Array.isArray(rawRecs)) d.err("finish-apps: no usable recommendations file, sending cards without them");

  const entries = triage as TriageEntry[];
  const offers = buildOffers(entries, recs, { ...d.ctx, date, now: d.now(), log: (m) => d.err(`finish-apps: ${m}`) });

  if (dry) {
    for (const o of offers) {
      const prompts = o.buttons.map((b) => (b.prompt ? `${b.id}: ${b.prompt.replace(/\s+/g, " ").slice(0, 80)}` : b.id));
      d.out(`${o.project} | ${o.title} | ${prompts.join(" | ")}`);
    }
    return 0;
  }

  // Snapshot for history and the Control app; a failure here never stops the cards (FR-B6).
  const gaps: Record<string, Gap[]> = {};
  for (const e of entries) {
    const p = d.ctx.getProject(e.name);
    if (p) gaps[e.name] = summarize(p, e, d.ctx.readerFor(p), []).missing.gaps;
  }
  const t = await d.post("/api/internal/triage", { date, projects: entries, recommendations: recs, gaps }).catch((e) => ({
    ok: false, status: 0, json: { error: String(e?.message ?? e) },
  }));
  if (!t.ok) d.err(`finish-apps: triage POST failed (${t.status}): ${t.json?.error ?? "?"}`);

  // Same-day idempotence: the offers already created for this date are remembered beside the triage file.
  const sentPath = triagePath.replace(/\.json$/, "") + ".sent.json";
  const sentRaw = parseJson(d.readFile(sentPath));
  const sent: Record<string, string> = sentRaw && typeof sentRaw === "object" && !Array.isArray(sentRaw) ? (sentRaw as any) : {};
  let failed = 0;
  for (const o of offers) {
    const key = `${o.from}:${o.project}`;
    if (sent[key]) {
      d.err(`finish-apps: ${o.project} already has today's card (${sent[key]})`);
      continue;
    }
    const r = await d
      .post("/api/internal/action-offer", { project: o.project, title: o.title, body: o.body, buttons: o.buttons, from: o.from })
      .catch((e) => ({ ok: false, status: 0, json: { error: String(e?.message ?? e) } }));
    if (r.ok && r.json?.id) {
      sent[key] = String(r.json.id);
      d.writeFile(sentPath, JSON.stringify(sent));
      d.out(`offer ${r.json.id} (${o.project})`);
    } else {
      failed++;
      d.err(`finish-apps: ${o.project}: card not sent (${r.status}): ${r.json?.error ?? "?"}`);
    }
  }
  return failed ? 1 : 0;
}

async function realDeps(): Promise<CliDeps> {
  const base = process.env.TOKYO_API || "http://127.0.0.1:3030";
  const { getProject } = require("../project-registry");
  let store: { recentSkips(p: string, since: number): number } | undefined;
  return {
    readFile: (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null),
    writeFile: (p, s) => fs.writeFileSync(p, s),
    post: async (path, body) => {
      const res = await fetch(base + path, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
      });
      return { ok: res.ok, status: res.status, json: await res.json().catch(() => null) };
    },
    now: () => Date.now(),
    ctx: {
      getProject: (name) => getProject(name),
      listProjects: () => require("../project-registry").PROJECTS,
      recentSkips: (project, since) => {
        try {
          store ??= require("../action-offers-store").defaultActionOfferStore();
          return store!.recentSkips(project, since);
        } catch {
          return 0;
        }
      },
      readerFor: (p) => (p.location === "server" ? fsRepoReader(p.path) : null),
    },
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  };
}

if (require.main === module) {
  realDeps()
    .then((d) => runCli(process.argv.slice(2), d))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`finish-apps: ${e?.message ?? e}`);
      process.exit(1);
    });
}
