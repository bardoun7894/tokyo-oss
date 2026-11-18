// Approving a mission from WhatsApp: a reply in my own "message yourself" chat.
// The parser is strict on purpose — the whole message must be the verb and the
// id, so a sentence that merely contains "yes 4f2a9c1b" approves nothing.

const APPROVE = ["yes", "y", "ok", "okay", "approve", "run", "نعم", "اه", "موافق"];
const DECLINE = ["no", "n", "cancel", "decline", "stop", "لا", "الغاء", "إلغاء"];
// Owner override for a HELD mission (dirty live dir, no tests, unconfirmed target).
const DEPLOY = ["deploy", "ship", "انشر"];

export function parseApprovalReply(text: string): { answer: "approve" | "decline" | "deploy"; id: string } | null {
  const m = text.trim().match(/^(\S+?)[\s,:#]+#?([0-9a-fA-F]{8})$/u);
  if (!m) return null;
  const verb = m[1].toLowerCase().replace(/[,:]+$/, "");
  const id = m[2].toLowerCase();
  if (APPROVE.includes(verb)) return { answer: "approve", id };
  if (DECLINE.includes(verb)) return { answer: "decline", id };
  if (DEPLOY.includes(verb)) return { answer: "deploy", id };
  return null;
}

/** Owner starts a mission from self-chat: "task <project> <what to do>". Still goes through the approval card. */
export function parseTaskCommand(text: string): { engine?: "claude" | "dsh"; project: string; task: string } | null {
  const m = text.trim().match(/^(task|mission|مهمة)\s+(?:(claude|dsh)\s+)?([A-Za-z0-9_-]+)\s+([\s\S]+)$/iu);
  if (!m) return null;
  const task = m[4].trim();
  if (!task) return null;
  const out: { engine?: "claude" | "dsh"; project: string; task: string } = { project: m[3].toLowerCase(), task };
  if (m[2]) out.engine = m[2].toLowerCase() as "claude" | "dsh";
  return out;
}

/** "212611223344:17@s.whatsapp.net" → "212611223344@s.whatsapp.net" (drops the device part). */
function bare(jid: string): string {
  const [user, domain] = jid.split("@");
  return `${user.split(":")[0]}@${domain}`;
}

/**
 * True only for a message I sent into my own chat. Baileys reports my identity
 * with a device suffix, and newer chats can be addressed by LID instead of phone
 * number, so both forms are compared.
 */
export function isOwnSelfChat(chatJid: string, myJid: string, fromMe: boolean, myLid?: string): boolean {
  if (!fromMe || !chatJid || chatJid.endsWith("@g.us")) return false;
  const chat = bare(chatJid);
  return chat === bare(myJid) || (!!myLid && chat === bare(myLid));
}

export interface CardInput {
  id: string;
  project: string;
  sender: string;
  prompt: string;
  branch: string;
  tests: string[];
  deploy: string[];
  autoDeploy: boolean;
  confirmed: boolean;
  liveDirtyFiles: number;
  engine?: "claude" | "dsh";
}

/** Plain text, identical on Telegram and WhatsApp. */
export function approvalCardText(c: CardInput): string {
  const preview = c.prompt.length > 500 ? c.prompt.slice(0, 500) + "…" : c.prompt;
  const deployLine = !c.confirmed
    ? "Deploy: will ASK — deploy target not confirmed for this project"
    : c.liveDirtyFiles > 0
      ? `Deploy: will ASK — live checkout has ${c.liveDirtyFiles} uncommitted files`
      : c.autoDeploy ? "Deploy: automatic if tests pass" : "Deploy: will ask";
  return [
    `Mission ${c.id} — ${c.project}`,
    `From: ${c.sender}`,
    `"${preview}"`,
    "",
    `Engine: ${c.engine === "dsh" ? "DeepSeek Harness (dsh)" : "Claude Code in herdr"}`,
    `Branch: ${c.branch} (separate clone, live checkout untouched)`,
    `Tests: ${c.tests.length ? c.tests.join(" && ") : "none — result will be unverified"}`,
    `Deploy command: ${c.deploy.join(" && ")}`,
    deployLine,
    "",
    `Reply "yes ${c.id}" to run, "no ${c.id}" to cancel. Expires in 30 min.`,
  ].join("\n");
}
