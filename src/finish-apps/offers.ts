import { summarize, summaryLines, type RepoReader, type Recommendation, type TriageEntry } from "./summary";
import type { OfferButton } from "../action-offers";

// Pure decision table of the daily sweep: triage + recommendations -> action cards.
// The CLI (cli.ts) posts what this returns.

export const MAX_CARDS = 5;
export const SKIP_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_BODY = 1500;

export interface OfferSpec {
  project: string;
  title: string;
  body: string;
  buttons: OfferButton[];
  from: string;
}

export interface RecEntry {
  name: string;
  skipped?: string;
  recommendations?: Recommendation[];
}

export interface OfferCtx {
  /** YYYY-MM-DD of the sweep. */
  date: string;
  now: number;
  getProject(name: string): { name: string; location: "server" | "laptop"; path: string } | undefined;
  /** Registry entries, for matching an active.sh project by path. */
  listProjects?(): { name: string; location: "server" | "laptop"; path: string }[];
  /** Skip answers for the project within the cooldown window. */
  recentSkips(project: string, sinceMs: number): number;
  readerFor(project: { name: string; location: "server" | "laptop"; path: string }): RepoReader | null;
  log(msg: string): void;
}

type Resolved = NonNullable<ReturnType<OfferCtx["getProject"]>>;

// active.sh project -> run directory. Rule 1: registry entry whose path is the active path or one of its also_at
// server paths; rule 2: server project at its active path under its own name; rule 3: Mac-only (report-only card).
// Without a path (older triage files) the registry is looked up by name.
function resolveProject(e: TriageEntry, ctx: OfferCtx): Resolved | undefined {
  if (!e.path) return ctx.getProject(e.name);
  const isServer = e.host === "server";
  const alts = (e.also_at ?? []).filter((a) => a.startsWith("server:")).map((a) => a.slice("server:".length));
  const paths = isServer ? [e.path, ...alts] : [e.path];
  const reg = (ctx.listProjects?.() ?? []).find((p) => paths.includes(p.path));
  if (reg) {
    ctx.log(`${e.name}: rule 1, registry ${reg.name} (${reg.path})${isServer ? `, runs in ${e.path}` : ""}`);
    return isServer ? { name: reg.name, location: "server", path: e.path } : reg;
  }
  if (isServer) {
    ctx.log(`${e.name}: rule 2, ad-hoc server project at ${e.path}`);
    return { name: e.name, location: "server", path: e.path };
  }
  ctx.log(`${e.name}: rule 3, Mac-only, report-only card`);
  return { name: e.name, location: "laptop", path: e.path };
}

const STOP = "Do not implement anything in this run.";

function implementCard(project: string, date: string): string {
  return (
    `Write ~/projects/_finish-apps/${date}/FINISH-APPS-${date}.md, then run ` +
    `tokyo-offer ask ${project} "Implement approved specs?" --from finish-apps-${date} ` +
    `--button implement=Implement='Implement the approved specs of ${project} from the FINISH-APPS-${date}.md report, ` +
    `tests first, one commit per task. Do not deploy.' --button skip=Skip ` +
    `and STOP. ${STOP}`
  );
}

function runPrompt(e: TriageEntry, path: string, date: string): string {
  const p = e.name;
  const audit = `readiness-audit ${p} --defects phases 0 to 4 (inventory, defects, write or complete specs, report)`;
  let body: string;
  switch (e.next_action) {
    case "research-features":
      body = `Run market-swot project ${path}, then ${audit}. No code changes outside specs/.`;
      break;
    case "implement-open-tasks":
      body = `Run ${audit}, then list the open tasks and what would be implemented. No code changes.`;
      break;
    default:
      body = `Run ${audit}. No code changes outside specs/.`;
  }
  return `${body}\n${implementCard(p, date)}`;
}

function reportPrompt(project: string, date: string): string {
  return (
    `Run readiness-audit ${project} --defects --report-only: no spec edits, no commits, no deploy. ` +
    `Write only ~/projects/_finish-apps/${date}/FINISH-APPS-${date}.md. ${STOP}`
  );
}

function writeSpecPrompt(project: string, r: Recommendation, date: string): string {
  return [
    `Write the spec for ONE recommendation of ${project}, nothing else.`,
    `${r.code}: ${r.title} (${r.kind}, size ${r.size})`,
    `Why: ${r.why}`,
    r.evidence.length ? `Evidence: ${r.evidence.join("; ")}` : "",
    `Run kb-spec pre, then speckit.specify for this recommendation only. Produce spec.md only: no plan, no tasks, no code, ` +
      `and do not touch any other recommendation. Do not deploy.`,
    `Finish by running: tokyo-offer ask ${project} "Plan and implement spec ${r.code}?" --from finish-apps-${date} ` +
      `--button approve='Approve implementation'='Plan and implement the spec just written for ${r.code} (${r.title.replace(/'/g, "")}) in ${project}: ` +
      `kb-spec plan, tasks, then implement tests first. Do not deploy.' --button skip=Skip and STOP.`,
  ]
    .filter(Boolean)
    .join("\n");
}

const recLine = (r: Recommendation) => `${r.code} ${r.title} (${r.size}${r.impact == null ? "" : `, impact ${r.impact}`})`;

export function buildOffers(triage: TriageEntry[], recs: RecEntry[], ctx: OfferCtx): OfferSpec[] {
  const from = `finish-apps-${ctx.date}`;
  const recMap = new Map<string, Recommendation[]>();
  for (const r of Array.isArray(recs) ? recs : []) {
    if (r && typeof r.name === "string" && !r.skipped && Array.isArray(r.recommendations)) recMap.set(r.name, r.recommendations);
  }

  const eligible: { e: TriageEntry; proj: Resolved }[] = [];
  for (const e of triage) {
    if (e.next_action === "verdict" && e.completeness === 4) continue;
    const proj = resolveProject(e, ctx);
    if (!proj) {
      ctx.log(`${e.name}: not in the registry, skipped`);
      continue;
    }
    if (ctx.recentSkips(proj.name, ctx.now - SKIP_COOLDOWN_MS) > 0) {
      ctx.log(`${e.name}: skipped by the owner within 3 days, not offered`);
      continue;
    }
    eligible.push({ e, proj });
  }
  eligible.sort((a, b) => (a.e.completeness ?? -1) - (b.e.completeness ?? -1));

  const cards = eligible.slice(0, MAX_CARDS).map(({ e, proj }): OfferSpec => {
    const customer = !!(e.customer || e.report_only || proj.location === "laptop");
    const top = customer ? [] : (recMap.get(e.name) ?? []).slice(0, 3);
    const s = summarize(proj, e, ctx.readerFor(proj), top);
    const buttons: OfferButton[] = [];
    if (!customer && e.next_action !== "needs-llm") {
      buttons.push({ id: "run", label: "Run next step", prompt: runPrompt({ ...e, name: proj.name }, proj.path, ctx.date) });
      top.forEach((r, i) => buttons.push({ id: `spec${i + 1}`, label: `Write spec ${r.code}`, prompt: writeSpecPrompt(proj.name, r, ctx.date) }));
    }
    buttons.push({ id: "report", label: "Report only", prompt: reportPrompt(proj.name, ctx.date) });
    buttons.push({ id: "skip", label: "Skip" });
    const body = [...summaryLines(s), ...top.map(recLine)].join("\n").slice(0, MAX_BODY);
    return { project: proj.name, title: `${e.name} is ${e.completeness ?? "?"}/4: ${e.next_action}`, body, buttons, from };
  });

  const rest = eligible.slice(MAX_CARDS);
  if (rest.length) {
    cards.push({
      project: rest[0].proj.name,
      title: `${rest.length} more apps need attention`,
      body: rest.map(({ e }) => `${e.name} (${e.completeness ?? "?"}/4, ${e.next_action})`).join("\n").slice(0, MAX_BODY),
      buttons: [{ id: "skip", label: "Skip" }],
      from: `${from}-more`,
    });
  }
  return cards;
}
