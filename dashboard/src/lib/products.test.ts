import assert from "node:assert/strict";
import {
  applyMarkup,
  buildForwardCaption,
  capSelection,
  formatStatsLine,
  shiftAssignments,
  MAX_FORWARD_SELECTION,
} from "./products.ts";

// applyMarkup ----------------------------------------------------------
assert.equal(applyMarkup(58), 58, "no markup returns original price");
assert.equal(applyMarkup(58, 10), 64, "10% markup rounds to nearest DH (58*1.1=63.8 -> 64)");
assert.equal(applyMarkup(100, 0), 100, "0% markup is a no-op");

// buildForwardCaption ----------------------------------------------------
assert.equal(
  buildForwardCaption("Aya mode — velvet kaftan, taupe", 58, 10, "dispo hhad l'semana", true),
  "Aya mode — velvet kaftan, taupe\n64 DH\ndispo hhad l'semana",
  "caption includes marked-up price line and note",
);
assert.equal(
  buildForwardCaption("Aya mode — velvet kaftan, taupe", null, undefined, undefined, true),
  "Aya mode — velvet kaftan, taupe",
  "unpriced item sends title only, even with withPrice true",
);
assert.equal(
  buildForwardCaption("Aya mode — velvet kaftan, taupe", 58, undefined, undefined, false),
  "Aya mode — velvet kaftan, taupe",
  "withPrice false omits the price line",
);
assert.equal(
  buildForwardCaption("Ghita Style — dress", 58, undefined, "dispo", true),
  "Ghita Style — dress\n58 DH\ndispo",
  "note appended with no markup",
);

// capSelection -----------------------------------------------------------
{
  const many = Array.from({ length: 12000 }, (_, i) => i + 1);
  const { ids, truncated } = capSelection(many, 500);
  assert.equal(ids.length, 500, "caps to the max");
  assert.equal(truncated, true, "flags truncation");
  assert.deepEqual(ids, many.slice(0, 500), "keeps the first N ids");
}
{
  const few = [1, 2, 3];
  const { ids, truncated } = capSelection(few, 500);
  assert.deepEqual(ids, few, "leaves a small selection untouched");
  assert.equal(truncated, false);
}
assert.equal(typeof MAX_FORWARD_SELECTION, "number", "exposes a real cap constant");
assert.ok(MAX_FORWARD_SELECTION > 0 && MAX_FORWARD_SELECTION < 5000, "cap is sane, not 9500");

// formatStatsLine ----------------------------------------------------------
assert.equal(
  formatStatsLine(9519, 130, 9389),
  "9,519 products · 130 priced · 9,389 no price yet",
  "reads as a state, not an error, per the contract's 98%-unpriced guidance",
);
assert.equal(
  formatStatsLine(0, 0, 0),
  "0 products · 0 priced · 0 no price yet",
);

// shiftAssignments — the batch review "shift alignment by one" control ---
{
  const images = [1, 2, 3, 4, 5];
  const prices = [101, 102, 103];

  assert.deepEqual(
    shiftAssignments(images, prices, 0),
    [
      { productId: 1, priceMessageId: 101 },
      { productId: 2, priceMessageId: 102 },
      { productId: 3, priceMessageId: 103 },
      { productId: 4, priceMessageId: null },
      { productId: 5, priceMessageId: null },
    ],
    "shift 0 is plain positional pairing",
  );

  assert.deepEqual(
    shiftAssignments(images, prices, 1),
    [
      { productId: 1, priceMessageId: null },
      { productId: 2, priceMessageId: 101 },
      { productId: 3, priceMessageId: 102 },
      { productId: 4, priceMessageId: 103 },
      { productId: 5, priceMessageId: null },
    ],
    "shift +1 drops the first image and slides prices one later (extra leading image)",
  );

  assert.deepEqual(
    shiftAssignments(images, prices, -1),
    [
      { productId: 1, priceMessageId: 102 },
      { productId: 2, priceMessageId: 103 },
      { productId: 3, priceMessageId: null },
      { productId: 4, priceMessageId: null },
      { productId: 5, priceMessageId: null },
    ],
    "shift -1 drops the first price (extra leading price)",
  );
}
{
  // 127 vs 90 mismatch mentioned in the packet — must not throw, must produce
  // exactly 127 entries.
  const images = Array.from({ length: 127 }, (_, i) => i + 1);
  const prices = Array.from({ length: 90 }, (_, i) => 900 + i);
  const out = shiftAssignments(images, prices, 3);
  assert.equal(out.length, 127);
  assert.equal(out[0].priceMessageId, null);
  assert.equal(out[3].priceMessageId, 900);
}

console.log("products.test.ts: all assertions passed");
