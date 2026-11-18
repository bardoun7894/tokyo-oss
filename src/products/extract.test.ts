import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTitle, resolveCaption } from './extract';

test('brand in quotes plus garment and colour keywords', () => {
  const content = '[Image] [Transcription: This is a product photo showing "Aya mode" velvet kaftan in taupe color]';
  const { title, brand } = extractTitle(content);
  assert.equal(brand, 'Aya mode');
  assert.match(title, /^Aya mode — /);
  assert.match(title, /kaftan/i);
  assert.match(title, /taupe/i);
});

test('arabic brand name in quotes', () => {
  const content = '[Image] [Transcription: منتج جميل من "أزياء شمس" جلابية سوداء]';
  const { title, brand } = extractTitle(content);
  assert.equal(brand, 'أزياء شمس');
  assert.match(title, /^أزياء شمس — /);
});

test('no brand quoted falls back to garment + colour without a leading dash', () => {
  const content = '[Image] [Transcription: nice grey dress for sale]';
  const { title, brand } = extractTitle(content);
  assert.equal(brand, null);
  assert.equal(title.startsWith('—'), false);
  assert.match(title, /dress/i);
  assert.match(title, /grey/i);
});

test('no garment or colour keyword falls back to first 80 chars of first sentence', () => {
  const content = '[Image] [Transcription: "Bendriss 2026" new arrival just landed today from our workshop straight to you with love. More coming soon.]';
  const { title, brand } = extractTitle(content);
  assert.equal(brand, 'Bendriss 2026');
  assert.ok(title.length <= 'Bendriss 2026 — '.length + 80);
  assert.match(title, /new arrival/);
  assert.doesNotMatch(title, /More coming soon/);
});

test('empty content falls back to a generic product title, using messageId when given', () => {
  assert.equal(extractTitle('').title, 'Product');
  assert.equal(extractTitle('', 77063).title, 'Product #77063');
});

test('content without the [Image] [Transcription: ...] wrapper is still parsed', () => {
  const { title, brand } = extractTitle('"Ghita Style" burnout robe, black');
  assert.equal(brand, 'Ghita Style');
  assert.match(title, /burnout/i);
  assert.match(title, /black/i);
});

// The real 2026 transcription pipeline emphasizes brand names with **bold**
// markdown at least as often as with quotes (real msg ids from the live
// catalog jid 182012157624438@lid, see specs/products-catalog/CONTRACT.md).
test('bold-markdown brand is picked up when no quotes are present (real msg 62399)', () => {
  const content = '[Image] [Transcription: **Aya Mode** fashion advertisement featuring a **مريا زقلي (Maria Zaqli)** — a pink and gold metallic/brocade midi dress with long sleeves and embroidered chest detail, displayed on a mannequin. A fabric swatch insert in the bottom right shows the dress available in multiple colors (purple, green, gray, pink, blue).]';
  const { title, brand } = extractTitle(content);
  assert.equal(brand, 'Aya Mode');
  assert.match(title, /^Aya Mode — /);
});

test('bold-markdown Arabic brand starting with أزياء is picked up (real msg 44155 shape)', () => {
  const content = '[Image] [Transcription: This is a product photo from **أزياء ياقوت** (Yaqout Fashion) featuring a long printed maxi dress/kaftan with pink lace neckline detail.]';
  const { brand } = extractTitle(content);
  assert.equal(brand, 'أزياء ياقوت');
});

test('a bold garment/style description is not mistaken for a brand (real msg 16191 — no company in this caption)', () => {
  const content = '[Image] [Transcription: Five **traditional Arabic/Algerian dresses (قمصان/ستاني)** displayed on mannequins in different colors (pink, beige, blue, purple, and green).\n\n**Text:** ثمن 1500 ستاني | XL, XXL, XXXL\n*(Price: 1500, Satin nightgowns, sizes XL-XXXL)*]';
  const { brand } = extractTitle(content);
  assert.equal(brand, null, 'garment-keyword bold text and a digit-bearing "Text:" label must not become the brand');
});

test('a lowercase descriptive bold phrase is not mistaken for a brand (regression: was misread as brand "cream/off-white jacquard fabric garment")', () => {
  const content = '[Image] [Transcription: A close-up of a **cream/off-white jacquard fabric garment** displayed on a mannequin, featuring an intricate woven pattern.]';
  const { brand } = extractTitle(content);
  assert.equal(brand, null, 'sentence-case descriptive phrases are not proper-noun brand names');
});

test('a bold Arabic fabric/style name without the أزياء prefix is not mistaken for a brand (regression: "ريب جكار" and "منية ريب XXL")', () => {
  const noBrand1 = '[Image] [Transcription: A cream-colored midi dress with dark red/maroon small print patterns. Text reads **3XL, 4XL** and **ريب جكار** (Rib Jacquard).]';
  const noBrand2 = '[Image] [Transcription: A white women\'s nightgown/house dress displayed on a mannequin. The label reads **منية ريب XXL** (Monia Rib, size XXL).]';
  assert.equal(extractTitle(noBrand1).brand, null);
  assert.equal(extractTitle(noBrand2).brand, null);
});

test('quoted brand still wins over an earlier non-brand bold phrase (real msg shape: "Product photo" bold + quoted brand)', () => {
  const content = '[Image] [Transcription: **Product photo** from **"Asian Style"** store featuring long patterned robes/kaftans.]';
  const { brand } = extractTitle(content);
  assert.equal(brand, 'Asian Style');
});

test('resolveCaption prefers content when it carries the transcription wrapper', () => {
  const content = '[Image] [Transcription: kaftan noir]';
  assert.equal(resolveCaption(content, 'fallback transcription'), content);
});

test('resolveCaption falls back to the transcription column when content has no wrapper', () => {
  assert.equal(resolveCaption('[Image]', 'jalabiya beige from the transcription column'), 'jalabiya beige from the transcription column');
  assert.equal(resolveCaption(null, 'jalabiya beige'), 'jalabiya beige');
});

test('resolveCaption handles both sources being null', () => {
  assert.equal(resolveCaption(null, null), '');
});
