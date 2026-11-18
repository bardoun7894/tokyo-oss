/**
 * Pure, framework-free logic for the Products Catalog page.
 * No React, no fetch — kept separate so it can be unit-tested with a plain
 * script (this dashboard package has no test runner installed yet; see
 * products.test.ts, run via `tsx`).
 */

// ── Types (mirror CONTRACT.md exactly) ──────────────────────────────────────

export type PriceSource = "none" | "auto" | "caption" | "manual";
export type Confidence = "high" | "low";
export type ProductStatus = "new" | "kept" | "hidden";
export type SortOrder = "price_asc" | "price_desc" | "name_asc" | "name_desc" | "date_desc" | "date_asc";

export interface Product {
  id: number;
  messageId: number;
  file: string;
  thumb: string;
  full: string;
  title: string;
  brand: string | null;
  price: number | null;
  currency: string;
  priceSource: PriceSource;
  confidence: Confidence;
  batchId: string | null;
  status: ProductStatus;
  timestamp: number;
  caption: string;
}

export interface ProductsResponse {
  items: Product[];
  total: number;
}

export interface ProductsStats {
  total: number;
  priced: number;
  unpriced: number;
  lowConfidence: number;
  minPrice: number | null;
  maxPrice: number | null;
  batches: number;
}

export interface BatchSummary {
  batchId: string;
  date: string;
  imageCount: number;
  priceCount: number;
  unpriced: number;
  confidence: Confidence;
}

export interface BatchDetail {
  batchId: string;
  images: Product[];
  prices: { messageId: number; value: number; assignedTo: number | null }[];
}

export interface ForwardTarget {
  jid: string;
  name: string;
  isGroup: boolean;
  lastActive: number;
}

export interface ForwardPreview {
  count: number;
  target: string;
  captions: string[];
}

// ── Constants ────────────────────────────────────────────────────────────

/**
 * Real WhatsApp sends are paced at 1.2s each (server-side). A selection of
 * thousands of ids is never a real intent to forward all of them one by one
 * -- it means the filter was too broad. Cap what the UI will ever submit to
 * /api/products/forward and tell the user plainly when it truncated.
 */
export const MAX_FORWARD_SELECTION = 300;

export const DEFAULT_PAGE_SIZE = 60;

// ── Pure helpers ─────────────────────────────────────────────────────────

/** Percent markup on a price, rounded to the nearest whole DH (prices in this catalog are always whole numbers). */
export function applyMarkup(price: number, markupPct?: number): number {
  if (!markupPct) return price;
  return Math.round(price * (1 + markupPct / 100));
}

/**
 * Mirrors the backend's caption format exactly:
 * `${title}\n${finalPrice} DH` plus `\n${note}` -- only when withPrice is
 * true AND the item actually has a price. An unpriced item never gets a
 * "null DH" line; it just sends the title (plus note, if any).
 */
export function buildForwardCaption(
  title: string,
  price: number | null,
  markupPct: number | undefined,
  note: string | undefined,
  withPrice: boolean,
): string {
  const lines = [title];
  if (withPrice && price !== null) {
    lines.push(`${applyMarkup(price, markupPct)} DH`);
  }
  if (note) lines.push(note);
  return lines.join("\n");
}

/**
 * Bounds what gets sent to /api/products/forward. "Select all filtered" must
 * never mean "hold 9,500 objects in state and POST 9,500 ids" -- cap it and
 * say so.
 */
export function capSelection(ids: number[], max: number = MAX_FORWARD_SELECTION): { ids: number[]; truncated: boolean } {
  if (ids.length <= max) return { ids, truncated: false };
  return { ids: ids.slice(0, max), truncated: true };
}

/**
 * The stats line has to read as an expected state (98% of the catalog is
 * unpriced on day one), not as 9,000 broken rows. Grouped thousands, plain
 * English, no alarming color implied by the copy itself.
 */
export function formatStatsLine(total: number, priced: number, unpriced: number): string {
  const g = (n: number) => n.toLocaleString("en-US");
  return `${g(total)} products · ${g(priced)} priced · ${g(unpriced)} no price yet`;
}

/**
 * The batch-review "shift alignment by one" control. Given the image run and
 * the price run in chat order, and an integer shift, returns the resulting
 * product->price pairing.
 *
 * shift 0  : positional, image[i] <-> price[i]
 * shift +1 : image[0] gets no price; image[i] <-> price[i-1] (fixes an extra
 *            leading image in the burst)
 * shift -1 : price[0] is dropped; image[i] <-> price[i+1] (fixes an extra
 *            leading price)
 */
export function shiftAssignments(
  imageIds: number[],
  priceMessageIds: number[],
  shift: number,
): Array<{ productId: number; priceMessageId: number | null }> {
  return imageIds.map((productId, i) => {
    const priceIdx = i - shift;
    const priceMessageId =
      priceIdx >= 0 && priceIdx < priceMessageIds.length ? priceMessageIds[priceIdx] : null;
    return { productId, priceMessageId };
  });
}
