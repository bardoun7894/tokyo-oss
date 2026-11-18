import type { ActionKind, Refusal } from "../../actions/confirm";
import type { GhClient } from "../../gh/client";
import type { GhIds } from "../../gh/ids";
import type { OpsResult } from "../../ops-godhome";
import type { OpsStore } from "../../ops-store";
import { AGENT_KIND, mapLiveAgents } from "../live";
import { promptAudit } from "../start";

export const PROMPTS = 10;
export const PROMPT_WINDOW_MS = 10 * 60 * 1000;

export interface AgentPromptKindDeps {
  ops: OpsStore;
  ids: GhIds;
  /** GodHome's herdr agent list; `true` asks for a read that is not served from the cache. */
  listAgents(fresh: boolean): Promise<OpsResult>;
  client: Pick<GhClient, "postAgentPrompt">;
  feed?: { add(e: { source: string; text: string; kind?: "info" }): unknown };
}

/**
 * The live agent behind an opaque id, from a GodHome list: the name is mapped back server-side, never taken from the phone.
 * Gone is 404, the same name twice is 409 (the prompt would be ambiguous), GodHome down is 503.
 */
export async function resolveLiveAgent(d: Pick<AgentPromptKindDeps, "ids" | "listAgents">, id: string, fresh: boolean, now: number): Promise<{ name: string; label: string } | Refusal> {
  const name = d.ids.resolve(AGENT_KIND, id);
  if (name === null) return { status: 404, code: "not_found", message: "No such agent" };
  let got: OpsResult | null = null;
  try {
    got = await d.listAgents(fresh);
  } catch (e: any) {
    console.warn(`[control-api] agents resolve: ${String(e?.name ?? "Error").slice(0, 40)}`);
  }
  const agents = (got?.data as { agents?: unknown } | null | undefined)?.agents;
  if (!got || !got.reachable || !Array.isArray(agents)) return { status: 503, code: "unavailable", message: "GodHome is not reachable" };
  const same = agents.filter((a) => typeof a === "object" && a !== null && (a as any).name === name);
  if (same.length === 0) return { status: 404, code: "not_found", message: "That agent is gone" };
  if (same.length > 1) return { status: 409, code: "conflict", message: "More than one agent has that name" };
  const label = mapLiveAgents({ agents: same }, d.ids, now)[0]?.label ?? "agent";
  return { name, label };
}

const isRefusal = (v: { name: string; label: string } | Refusal): v is Refusal => "status" in v;

/**
 * G4 confirm: sends the prepared text to one live agent through GodHome `POST /herdr/agents/:name/prompt`. The agent is looked
 * up again in an uncached list when the token is confirmed, at 10 prompts per 10 minutes per device.
 */
export function agentPromptKind(d: AgentPromptKindDeps): ActionKind {
  return {
    name: "agent_prompt",
    cap: "agents:start",
    confirmAction: "agent.prompt.confirm",
    feed: d.feed,
    check: async (ctx) => {
      const mine = d.ops.kindUses("agent_prompt", ctx.now() - PROMPT_WINDOW_MS, ctx.device.id);
      if (mine.length >= PROMPTS) {
        return { status: 429, code: "rate_limited", message: "Too many prompts from this device; try again later", retryAfterSec: Math.max(1, Math.ceil((mine[0]! + PROMPT_WINDOW_MS - ctx.now()) / 1000)) };
      }
      const found = await resolveLiveAgent(d, ctx.token.targetId, true, ctx.now());
      if (isRefusal(found)) return found;
      ctx.scratch.agent = found;
      return null;
    },
    run: async (ctx) => {
      const { name, label } = ctx.scratch.agent as { name: string; label: string };
      const text = (ctx.payload as { text: string }).text;
      const params = JSON.stringify(promptAudit(text));
      let sent: Awaited<ReturnType<GhClient["postAgentPrompt"]>> = { status: "unreachable" };
      try {
        sent = await d.client.postAgentPrompt(name, text);
      } catch (e: any) {
        console.warn(`[control-api] agent prompt: ${String(e?.name ?? "Error").slice(0, 40)}`);
      }
      if (sent.status === "ok") return { ok: true, result: "ok", detail: "", params, body: { ok: true }, feed: `Prompted live agent ${label} from device ${ctx.device.name}` };
      const gone = sent.status === "not_found";
      return {
        ok: false, result: gone ? "not_found" : "unavailable", detail: gone ? "agent gone" : "GodHome is not reachable", params, status: gone ? 404 : 503,
        body: { error: { code: gone ? "not_found" : "unavailable", message: gone ? "That agent is gone" : "GodHome is not reachable" } },
      };
    },
  };
}
