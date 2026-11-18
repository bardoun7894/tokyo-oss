// Telegram is a single-user surface: the chat drives shell commands, Claude runs and
// deploys. Only the owner's own updates may reach any handler. Before this guard the
// free-text handler had no owner check at all (only 9 of ~60 commands did), so anyone
// who found the bot's username could talk to the agent that runs commands as root.

export function isOwnerUpdate(fromId: number | string | undefined, ownerId: string | undefined): boolean {
  if (!ownerId) return false; // no owner configured: refuse everyone, never allow all
  if (fromId === undefined || fromId === null) return false;
  return String(fromId) === String(ownerId).trim();
}
