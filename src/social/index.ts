/**
 * Tokyo social publisher — one video, five platforms.
 *
 * Wire it up with a single call in src/index.ts:
 *
 *   import { registerSocialCommands } from "./social";
 *   registerSocialCommands(bot);
 *
 * It must be registered *before* the catch-all `bot.on("callback_query:data")`
 * handler, otherwise the panel buttons are swallowed.
 */

export { registerSocialCommands, publishJob, parseWhen, formatWhen } from "./commands";
export { startSocialAutomation, QUEUE_DIR } from "./automation";
export {
  registerNewsCommands,
  startNewsAutomation,
  buildDraft,
  postDraft,
  pickStory,
  writeDraft,
  recentNews,
  autopostOn,
  setAutopost,
} from "./news";
export { runJob, resolvePlatforms, presetWarnings } from "./publish";
export { ADAPTERS } from "./adapters";
export { initSocialTables, listSwitches, setSwitch, listRecentJobs } from "./store";
export * from "./types";
