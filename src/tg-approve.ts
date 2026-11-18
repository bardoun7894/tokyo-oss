import { parseApproval, mostRecent } from "./tg-approval";
import { latestPendingRun, latestDeployOffer, answerPendingRun, answerDeployOffer } from "./claude-runner";
import { latestMissionPending, answerMissionByKind } from "./mission-wiring";

/**
 * A typed "yes" / "no" in the Telegram chat answers the newest open card — a ✅ run,
 * a "Deploy it?", or a mission. Returns the reply to send, or null when the text is
 * not an answer or nothing is waiting (then it is an ordinary message for the AI).
 */
export async function handleApprovalText(chatId: number, text: string): Promise<string | null> {
  const answer = parseApproval(text);
  if (!answer) return null;

  const item = mostRecent([latestDeployOffer(chatId), latestPendingRun(chatId), latestMissionPending()]);
  if (!item) return null;
  const yes = answer === "yes";

  if (item.kind === "run") return answerPendingRun(item.id, yes);
  if (item.kind === "deploy") return answerDeployOffer(item.id, yes ? "deploy" : "skip", "telegram");
  return answerMissionByKind(item.id, item.kind, yes, "telegram");
}
