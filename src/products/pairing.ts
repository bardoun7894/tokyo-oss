/**
 * Pairing of supplier images with their prices — pure function, no I/O. See
 * specs/products-catalog/CONTRACT.md for background.
 *
 * Radwan replies to each photo individually using WhatsApp's quote/reply
 * feature — he does NOT reply with a bare-number burst in send order. The
 * quoted message id (WhatsApp's `contextInfo.stanzaId`, captured at ingest
 * into `whatsapp_messages.quoted_msg_id` — see `extractQuotedMsgId` in
 * `src/whatsapp.ts`) is exact ground truth for which image a price belongs
 * to. It is the ONLY source of truth for a bare-number price.
 *
 * There is deliberately NO positional fallback. A prior version of this
 * file paired the Nth image with the Nth bare-number price in send order;
 * that was proven wrong against real data (product 76960, a blue velvet
 * nightgown, was priced from a reply that actually quoted a completely
 * different mauve lace dress) and produces plausible-looking bad data,
 * which is worse than an honest `price: null`. An image with no quoted
 * price and no caption price stays unpriced.
 *
 * NOTE ON `type`: the DB column is `message_type`; callers must map it to
 * `type` at the query boundary (`SELECT message_type AS type ...`). This
 * interface keeps the field named `type` on purpose — it's part of the
 * contract's function signature.
 */

export interface RawMsg {
  id: number;
  fromMe: boolean;
  type: string;
  content: string | null;
  mediaPath: string | null;
  timestamp: number;
  /** WhatsApp's own message id for this message (`wa_msg_id`). Used to
   *  resolve an incoming reply's `quotedMsgId` back to the image it quotes. */
  waMsgId?: string | null;
  /** `contextInfo.stanzaId` of the message this one quotes/replies to, or
   *  null/undefined when this message isn't a reply. */
  quotedMsgId?: string | null;
}

export interface Pairing {
  messageId: number;
  price: number | null;
  priceMessageId: number | null;
  batchId: string;
  confidence: "high" | "low";
  source: "quote" | "caption" | "none";
}

// Still used to group images into batches (for batch_id / the review UI) —
// pricing no longer depends on it at all.
const GAP_SECONDS = 10 * 60; // 10 minutes
const MIN_PRICE = 1;
const MAX_PRICE = 100000;

const BARE_NUMBER_RE = /^\d{1,5}([.,]\d{1,2})?$/;

const CAPTION_PRICE_RE = /(?:الثمن|ثمن|prix|price)\s*[:\-]?\s*(\d{1,5}(?:[.,]\d{1,2})?)|(\d{1,5}(?:[.,]\d{1,2})?)\s*dh\b/i;

function parseNum(raw: string): number | null {
  const n = Number(raw.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function inPriceBand(n: number): boolean {
  return n >= MIN_PRICE && n <= MAX_PRICE;
}

function parseBarePrice(content: string | null): number | null {
  if (!content) return null;
  const trimmed = content.trim();
  if (!BARE_NUMBER_RE.test(trimmed)) return null;
  const n = parseNum(trimmed);
  return n !== null && inPriceBand(n) ? n : null;
}

/** Caption price wins: `الثمن 58`, `ثمن 58`, `58 dh`, `58 DH`, `prix 58`, `price: 58`. */
function extractCaptionPrice(content: string | null): number | null {
  if (!content) return null;
  const m = content.match(CAPTION_PRICE_RE);
  if (!m) return null;
  const raw = m[1] ?? m[2];
  const n = raw ? parseNum(raw) : null;
  return n !== null && inPriceBand(n) ? n : null;
}

/**
 * Build maximal runs of consecutive "member" messages (per `isMember`),
 * where a run continues across outgoing (`fromMe`) messages of any kind,
 * but is broken by an *incoming* non-member message, and also breaks when
 * the timestamp gap to the previous member exceeds GAP_SECONDS. Used only
 * to group images into batches (`batch_id`) now — price pairing no longer
 * depends on run membership.
 */
function buildRuns(msgs: RawMsg[], isMember: (m: RawMsg) => boolean): RawMsg[][] {
  const runs: RawMsg[][] = [];
  let current: RawMsg[] = [];
  let brokenSinceLastMember = false;

  for (const m of msgs) {
    if (isMember(m)) {
      const last = current[current.length - 1];
      const gapOk = !last || m.timestamp - last.timestamp <= GAP_SECONDS;
      if (current.length > 0 && gapOk && !brokenSinceLastMember) {
        current.push(m);
      } else {
        if (current.length > 0) runs.push(current);
        current = [m];
      }
      brokenSinceLastMember = false;
    } else if (!m.fromMe) {
      if (current.length > 0) brokenSinceLastMember = true;
    }
    // outgoing, non-member: ignored — doesn't break, doesn't extend
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

function batchIdFor(firstImageTs: number): string {
  const d = new Date(firstImageTs * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `b_${yyyy}${mm}${dd}_${hh}${min}`;
}

export interface BatchDetail {
  batchId: string;
  prices: { messageId: number; value: number; assignedTo: number | null }[];
}

interface ComputeResult {
  pairings: Pairing[];
  batches: BatchDetail[];
}

function computeAll(msgs: RawMsg[]): ComputeResult {
  const sorted = [...msgs].sort((a, b) => (a.timestamp - b.timestamp) || (a.id - b.id));

  const imageRuns = buildRuns(sorted, (m) => !m.fromMe && m.type === "image");

  // buildRuns partitions every member message into exactly one run, so this
  // map covers every incoming image regardless of which run it landed in.
  const imageByWaId = new Map<string, RawMsg>();
  for (const run of imageRuns) {
    for (const img of run) {
      if (img.waMsgId) imageByWaId.set(img.waMsgId, img);
    }
  }

  // Quote-based price assignment: a bare-number incoming text message whose
  // quotedMsgId matches an image's own wa_msg_id is exact ground truth for
  // that image's price — this is the primary (and only) pairing rule.
  // First match wins (chronological order) if an image is somehow quoted
  // by more than one price reply.
  const quotedPriceByImageId = new Map<number, { value: number; priceMsg: RawMsg }>();
  for (const m of sorted) {
    if (m.fromMe || m.type !== "text" || !m.quotedMsgId) continue;
    const value = parseBarePrice(m.content);
    if (value === null) continue;
    const img = imageByWaId.get(m.quotedMsgId);
    if (!img || quotedPriceByImageId.has(img.id)) continue;
    quotedPriceByImageId.set(img.id, { value, priceMsg: m });
  }

  const pairings: Pairing[] = [];
  const batches: BatchDetail[] = [];

  for (const imageRun of imageRuns) {
    const batchId = batchIdFor(imageRun[0].timestamp);
    const batchPrices: BatchDetail["prices"] = [];

    for (const img of imageRun) {
      const captionPrice = extractCaptionPrice(img.content);
      if (captionPrice !== null) {
        pairings.push({
          messageId: img.id,
          price: captionPrice,
          priceMessageId: null,
          batchId,
          confidence: "high",
          source: "caption",
        });
        continue;
      }

      const quoted = quotedPriceByImageId.get(img.id);
      if (quoted) {
        pairings.push({
          messageId: img.id,
          price: quoted.value,
          priceMessageId: quoted.priceMsg.id,
          batchId,
          confidence: "high",
          source: "quote",
        });
        batchPrices.push({ messageId: quoted.priceMsg.id, value: quoted.value, assignedTo: img.id });
        continue;
      }

      pairings.push({
        messageId: img.id,
        price: null,
        priceMessageId: null,
        batchId,
        confidence: "low",
        source: "none",
      });
    }

    batches.push({ batchId, prices: batchPrices });
  }

  return { pairings, batches };
}

export function pairPrices(msgs: RawMsg[]): Pairing[] {
  return computeAll(msgs).pairings;
}

/** Per-batch view of the quote-assigned prices for that image run. Only
 *  prices that matched an image via `quotedMsgId` appear here — there is no
 *  positional leftover concept anymore. */
export function pairingBatchDetails(msgs: RawMsg[]): BatchDetail[] {
  return computeAll(msgs).batches;
}
