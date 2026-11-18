// Temporal activities for the wa-chat workflow. Activities are the only place
// with I/O — this one is thin: resolve the burst's message ids back to rows
// and hand the latest one to the existing (non-Temporal) message handler.
//
// This module runs inside the same Node process as the live bot (the worker
// is embedded — see ./worker.ts), so it can import db.ts and whatsapp-ai.ts
// directly instead of crossing a process boundary.
import * as db from '../db';
import { processIncomingMessage, type WAMessageData } from '../whatsapp-ai';

export interface WARow {
  id: number;
  jid: string;
  sender: string;
  sender_name: string;
  content: string;
  message_type: string;
  from_me: number | boolean;
  is_group: number | boolean;
  timestamp: number;
}

/**
 * Runs the existing processIncomingMessage logic for one debounced burst.
 * Idempotency: re-running (Temporal retry) just re-processes the same latest
 * message through the same code path as a normal live message would — the
 * downstream handlers (auto-reply, auto-dispatch, burst logging) are already
 * expected to tolerate being called once per burst, exactly as they are
 * today when a single live message triggers them.
 */
export async function processChatBurst(jid: string, msgIds: number[]): Promise<{ processed: number; latestId: number | null }> {
  if (msgIds.length === 0) return { processed: 0, latestId: null };

  const rows = msgIds
    .map((id) => db.getWAMessageById(id) as WARow | undefined)
    .filter((r): r is WARow => !!r);

  if (rows.length === 0) return { processed: 0, latestId: null };

  // Ids are an autoincrement PK, so the highest id is the latest message —
  // that's the one whose content drives the reply, matching what would have
  // happened on the direct (non-Temporal) path for the last message in a burst.
  const latest = rows.reduce((a, b) => (b.id > a.id ? b : a));

  const msg: WAMessageData = {
    id: latest.id,
    jid: latest.jid,
    sender: latest.sender,
    sender_name: latest.sender_name,
    content: latest.content,
    message_type: latest.message_type,
    from_me: !!latest.from_me,
    is_group: !!latest.is_group,
    timestamp: latest.timestamp,
  };

  await processIncomingMessage(msg, { skipCooldown: true });
  return { processed: rows.length, latestId: latest.id };
}
