import type { Orchestrator } from "../orchestrator";
import productivityAgent from "./productivity/index";
import deenAgent from "./deen/index";
import financeAgent from "./finance/index";
import whatsappAgent from "./whatsapp/index";
import devopsAgent from "./devops/index";
import coachingAgent from "./coaching/index";
import researchAgent from "./research/index";
import { prayerOn } from "../profile";

const ALL_AGENTS = [
  productivityAgent,
  deenAgent,
  financeAgent,
  whatsappAgent,
  devopsAgent,
  coachingAgent,
  researchAgent,
];

/**
 * Load and register all agents with the orchestrator.
 */
export function loadAllAgents(orchestrator: Orchestrator): void {
  // The deen agent (prayer times, Quran, adhkar) loads only with the prayer switch on.
  const agents = prayerOn() ? ALL_AGENTS : ALL_AGENTS.filter((a) => a !== deenAgent);
  for (const agent of agents) {
    try {
      orchestrator.registerAgent(agent);
      console.log(`  [agent] ${agent.name} registered`);
    } catch (err) {
      console.error(`  [agent] ${agent.name} failed to load:`, err);
    }
  }

  const count = orchestrator.registry.getAll().length;
  console.log(`[agents] ${count} agents loaded.`);
}
