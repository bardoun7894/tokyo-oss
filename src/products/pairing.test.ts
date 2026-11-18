import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairPrices, pairingBatchDetails, type RawMsg } from './pairing';

const BASE_TS = 1789920000; // 2026-09-20 15:59:60ish UTC, arbitrary anchor

function img(id: number, ts: number, waMsgId?: string): RawMsg {
  return {
    id, fromMe: false, type: 'image', content: `[Image] [Transcription: item ${id}]`,
    mediaPath: `wa_${id}.jpg`, timestamp: ts, waMsgId: waMsgId ?? `wa_${id}`,
  };
}
function priceMsg(id: number, ts: number, value: number | string, quotedMsgId: string | null = null): RawMsg {
  return { id, fromMe: false, type: 'text', content: String(value), mediaPath: null, timestamp: ts, quotedMsgId };
}
function outMsg(id: number, ts: number, content: string): RawMsg {
  return { id, fromMe: true, type: 'text', content, mediaPath: null, timestamp: ts };
}
function inText(id: number, ts: number, content: string): RawMsg {
  return { id, fromMe: false, type: 'text', content, mediaPath: null, timestamp: ts };
}

// ---------------------------------------------------------------------------
// Quote-based pairing — the primary (and only) rule.
// ---------------------------------------------------------------------------

test('quoted price matches its image exactly, even when replies arrive out of send order (the 76960/76961 regression)', () => {
  // Real bug, confirmed visually against the images: product 76960 is a
  // blue velvet nightgown, 76961 an Aline Style mauve nightgown, sent in
  // that order. Radwan replied out of order — quoting 76961 first with 65,
  // then 76960 with 58 — which positional pairing got backwards: it pinned
  // the first-arriving reply (58) to the first-sent image (76960), when
  // that reply's quote actually pointed at a completely different photo.
  const msgs: RawMsg[] = [
    img(76960, BASE_TS, 'wa_76960'),
    img(76961, BASE_TS + 5, 'wa_76961'),
    priceMsg(1, BASE_TS + 200, 65, 'wa_76961'), // arrives first, quotes 76961
    priceMsg(2, BASE_TS + 210, 58, 'wa_76960'), // arrives second, quotes 76960
  ];
  const result = pairPrices(msgs);
  const p76960 = result.find((r) => r.messageId === 76960)!;
  const p76961 = result.find((r) => r.messageId === 76961)!;

  assert.equal(p76960.price, 58, '76960 must get the reply that actually quoted it, not the first-arriving reply');
  assert.equal(p76960.source, 'quote');
  assert.equal(p76960.confidence, 'high');
  assert.equal(p76960.priceMessageId, 2);

  assert.equal(p76961.price, 65);
  assert.equal(p76961.source, 'quote');
  assert.equal(p76961.priceMessageId, 1);
});

test('regression: replies are matched by quote, never by send/arrival position (positional pairing must not return)', () => {
  // 3 images sent in order; 3 replies arrive in the REVERSE order, each
  // explicitly quoting its own photo. A positional algorithm would assign
  // the first-arriving reply (30) to the first-sent image (1) — wrong.
  const msgs: RawMsg[] = [
    img(1, BASE_TS, 'wa_1'),
    img(2, BASE_TS + 5, 'wa_2'),
    img(3, BASE_TS + 10, 'wa_3'),
    priceMsg(10, BASE_TS + 200, 30, 'wa_3'), // arrives first, quotes image 3
    priceMsg(11, BASE_TS + 210, 20, 'wa_2'), // quotes image 2
    priceMsg(12, BASE_TS + 220, 10, 'wa_1'), // arrives last, quotes image 1
  ];
  const result = pairPrices(msgs);
  assert.equal(result.find((r) => r.messageId === 1)!.price, 10);
  assert.equal(result.find((r) => r.messageId === 2)!.price, 20);
  assert.equal(result.find((r) => r.messageId === 3)!.price, 30);
});

test('an image with no quoted price and no caption price stays NULL, even with other prices present in the same chat', () => {
  const msgs: RawMsg[] = [
    img(1, BASE_TS, 'wa_1'),
    img(2, BASE_TS + 5, 'wa_2'),
    priceMsg(3, BASE_TS + 200, 58, 'wa_1'), // only image 1 gets a quoted reply
  ];
  const result = pairPrices(msgs);
  const p1 = result.find((r) => r.messageId === 1)!;
  const p2 = result.find((r) => r.messageId === 2)!;
  assert.equal(p1.price, 58);
  assert.equal(p2.price, null);
  assert.equal(p2.source, 'none');
  assert.equal(p2.confidence, 'low');
});

test('a bare-number reply with no quotedMsgId at all pairs nothing (no positional fallback)', () => {
  const msgs: RawMsg[] = [
    img(1, BASE_TS, 'wa_1'),
    img(2, BASE_TS + 5, 'wa_2'),
    img(3, BASE_TS + 10, 'wa_3'),
    priceMsg(4, BASE_TS + 300, 58), // bare number, not a reply to anything
    priceMsg(5, BASE_TS + 310, 65),
    priceMsg(6, BASE_TS + 320, 68),
  ];
  const result = pairPrices(msgs);
  assert.ok(result.every((r) => r.price === null && r.source === 'none'));
});

test('image run with no quoted price and no caption leaves every image unpriced', () => {
  const msgs: RawMsg[] = [img(1, BASE_TS, 'wa_1'), img(2, BASE_TS + 5, 'wa_2'), img(3, BASE_TS + 10, 'wa_3')];
  const result = pairPrices(msgs);
  assert.equal(result.length, 3);
  assert.ok(result.every((r) => r.price === null && r.source === 'none' && r.confidence === 'low'));
});

test('a quoted price 6+ hours after its image still attaches (no time-window limit for exact quotes)', () => {
  const msgs: RawMsg[] = [
    img(1, BASE_TS, 'wa_1'),
    priceMsg(2, BASE_TS + 7 * 3600, 58, 'wa_1'),
  ];
  const result = pairPrices(msgs);
  assert.equal(result[0].price, 58);
  assert.equal(result[0].source, 'quote');
});

test('absurd quoted prices outside 1..100000 are rejected as not-a-price', () => {
  const msgs: RawMsg[] = [
    img(1, BASE_TS, 'wa_1'),
    img(2, BASE_TS + 5, 'wa_2'),
    priceMsg(3, BASE_TS + 200, 0, 'wa_1'),
    priceMsg(4, BASE_TS + 210, 200000, 'wa_2'),
  ];
  const result = pairPrices(msgs);
  assert.ok(result.every((r) => r.price === null));
});

test('a quoted price of 7 (single digit, inside 1..100000) counts as a valid price', () => {
  const msgs: RawMsg[] = [img(1, BASE_TS, 'wa_1'), priceMsg(2, BASE_TS + 200, 7, 'wa_1')];
  const result = pairPrices(msgs);
  assert.equal(result[0].price, 7);
});

test('decimal quoted prices with comma or dot are parsed', () => {
  const msgs: RawMsg[] = [
    img(1, BASE_TS, 'wa_1'), img(2, BASE_TS + 5, 'wa_2'),
    priceMsg(3, BASE_TS + 200, '58.5', 'wa_1'),
    priceMsg(4, BASE_TS + 210, '65,50', 'wa_2'),
  ];
  const result = pairPrices(msgs);
  assert.deepEqual(result.map((r) => r.price).sort((a, b) => (a! - b!)), [58.5, 65.5]);
});

// ---------------------------------------------------------------------------
// Caption prices — untouched by this change, still checked first.
// ---------------------------------------------------------------------------

test('a caption price wins even when the same image is also quoted by a price reply', () => {
  const msgs: RawMsg[] = [
    { id: 1, fromMe: false, type: 'image', content: '[Image] [Transcription: kaftan, prix 120]', mediaPath: 'a.jpg', timestamp: BASE_TS, waMsgId: 'wa_1' },
    priceMsg(2, BASE_TS + 200, 58, 'wa_1'),
  ];
  const result = pairPrices(msgs);
  assert.equal(result[0].price, 120);
  assert.equal(result[0].source, 'caption');
  assert.equal(result[0].confidence, 'high');
  assert.equal(result[0].priceMessageId, null);
});

test('various caption price phrasings are recognised (DH, dh, ar, fr)', () => {
  const phrasings = ['الثمن 58', 'ثمن 58', '58 dh', '58 DH', 'prix 58', 'price: 58'];
  for (const phrase of phrasings) {
    const msgs: RawMsg[] = [{ id: 1, fromMe: false, type: 'image', content: `[Image] [Transcription: ${phrase}]`, mediaPath: 'a.jpg', timestamp: BASE_TS, waMsgId: 'wa_1' }];
    const result = pairPrices(msgs);
    assert.equal(result[0].price, 58, `failed for phrasing: ${phrase}`);
    assert.equal(result[0].source, 'caption');
  }
});

// ---------------------------------------------------------------------------
// Image-run / batch grouping — unrelated to pricing, still used for batch_id.
// ---------------------------------------------------------------------------

test('an incoming non-image text interleaved between two images splits the image run in two', () => {
  // BASE_TS lands on a minute boundary; +70s crosses into the next minute so
  // the two runs' batchIds (which are minute-granularity) can't collide —
  // the split here is caused by the interleaved text, not by a time gap.
  const msgs: RawMsg[] = [
    img(1, BASE_TS), img(2, BASE_TS + 5),
    inText(3, BASE_TS + 8, 'hello there'), // incoming, not an image -> breaks the run
    img(4, BASE_TS + 70), img(5, BASE_TS + 75),
  ];
  const result = pairPrices(msgs);
  assert.equal(result.length, 4);
  const batchIds = new Set(result.map((r) => r.batchId));
  assert.equal(batchIds.size, 2, 'two separate image runs => two batch ids');
});

test('outgoing messages interleaved between images do not break the run', () => {
  const msgs: RawMsg[] = [
    img(1, BASE_TS), outMsg(2, BASE_TS + 3, 'nice'), img(3, BASE_TS + 6), outMsg(4, BASE_TS + 8, 'ok'), img(5, BASE_TS + 11),
  ];
  const result = pairPrices(msgs);
  assert.equal(result.length, 3);
  const batchIds = new Set(result.map((r) => r.batchId));
  assert.equal(batchIds.size, 1);
});

test('a gap over 10 minutes splits an image run in two, even with no interleaved text', () => {
  const msgs: RawMsg[] = [
    img(1, BASE_TS), img(2, BASE_TS + 5),
    img(3, BASE_TS + 5 + 601), img(4, BASE_TS + 5 + 610),
  ];
  const result = pairPrices(msgs);
  const batchIds = new Set(result.map((r) => r.batchId));
  assert.equal(batchIds.size, 2);
});

test('two separate batches: quoted prices attach to the correct image regardless of which batch it is in', () => {
  const msgs: RawMsg[] = [
    img(1, BASE_TS, 'wa_1'), img(2, BASE_TS + 5, 'wa_2'), img(3, BASE_TS + 10, 'wa_3'),
    priceMsg(4, BASE_TS + 200, 10, 'wa_1'), priceMsg(5, BASE_TS + 210, 20, 'wa_2'), priceMsg(6, BASE_TS + 220, 30, 'wa_3'),

    img(7, BASE_TS + 10000, 'wa_7'), img(8, BASE_TS + 10005, 'wa_8'), img(9, BASE_TS + 10010, 'wa_9'),
    priceMsg(10, BASE_TS + 10200, 40, 'wa_7'), priceMsg(11, BASE_TS + 10210, 50, 'wa_8'), priceMsg(12, BASE_TS + 10220, 60, 'wa_9'),
  ];
  const result = pairPrices(msgs);
  assert.equal(result.length, 6);
  const firstBatch = result.filter((r) => r.messageId <= 3);
  const secondBatch = result.filter((r) => r.messageId >= 7);
  assert.deepEqual(firstBatch.map((r) => r.price).sort((a, b) => a! - b!), [10, 20, 30]);
  assert.deepEqual(secondBatch.map((r) => r.price).sort((a, b) => a! - b!), [40, 50, 60]);
  assert.notEqual(firstBatch[0].batchId, secondBatch[0].batchId);
});

// ---------------------------------------------------------------------------
// pairingBatchDetails
// ---------------------------------------------------------------------------

test('pairingBatchDetails exposes only the quote-assigned prices for the batch', () => {
  const msgs: RawMsg[] = [
    img(100, BASE_TS, 'wa_100'), img(101, BASE_TS + 1, 'wa_101'), img(102, BASE_TS + 2, 'wa_102'),
    priceMsg(200, BASE_TS + 300, 40, 'wa_100'),
    priceMsg(201, BASE_TS + 310, 41, 'wa_101'),
  ];
  const details = pairingBatchDetails(msgs);
  assert.equal(details.length, 1);
  assert.equal(details[0].prices.length, 2, 'only the 2 quote-matched prices show up; image 102 got no reply');
  const assigned = details[0].prices.map((p) => p.assignedTo).sort();
  assert.deepEqual(assigned, [100, 101]);
});

test('pairingBatchDetails: an image run with no quoted prices has an empty prices list', () => {
  const images: RawMsg[] = [img(1, BASE_TS, 'wa_1'), img(2, BASE_TS + 5, 'wa_2'), img(3, BASE_TS + 10, 'wa_3')];
  const details = pairingBatchDetails(images);
  assert.equal(details.length, 1);
  assert.deepEqual(details[0].prices, []);
});
