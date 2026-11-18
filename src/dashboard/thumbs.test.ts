import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseThumbWidth, isThumbnailable, thumbPath, ensureThumb } from './thumbs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokyo-thumbs-'));

before(async () => {
  // A real 1200px photo, so the resize is measured rather than assumed.
  const sharp = require('sharp');
  await sharp({ create: { width: 1200, height: 900, channels: 3, background: { r: 200, g: 40, b: 60 } } })
    .jpeg().toFile(path.join(dir, 'wa_1_big.jpg'));
  fs.writeFileSync(path.join(dir, 'wa_2_note.ogg'), 'not an image');
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('only the allowed widths are accepted', () => {
  assert.equal(parseThumbWidth('320'), 320);
  assert.equal(parseThumbWidth(240), 240);
  assert.equal(parseThumbWidth('321'), null, 'an arbitrary width would let a caller fill the disk');
  assert.equal(parseThumbWidth('abc'), null);
  assert.equal(parseThumbWidth(undefined), null);
});

test('only images are thumbnailed', () => {
  assert.equal(isThumbnailable('wa_1_big.jpg'), true);
  assert.equal(isThumbnailable('wa_1_big.PNG'), true);
  assert.equal(isThumbnailable('wa_2_note.ogg'), false);
  assert.equal(isThumbnailable('wa_3_clip.mp4'), false);
});

test('a thumbnail is generated, cached, and much smaller than the original', async () => {
  const out = await ensureThumb(dir, 'wa_1_big.jpg', 320);
  assert.equal(out, thumbPath(dir, 'wa_1_big.jpg', 320));
  const original = fs.statSync(path.join(dir, 'wa_1_big.jpg')).size;
  const thumb = fs.statSync(out!).size;
  assert.ok(thumb < original / 2, `thumb ${thumb} vs original ${original}`);
  const meta = await require('sharp')(out!).metadata();
  assert.equal(meta.width, 320);

  // second call reuses the file rather than re-encoding
  const before = fs.statSync(out!).mtimeMs;
  assert.equal(await ensureThumb(dir, 'wa_1_big.jpg', 320), out);
  assert.equal(fs.statSync(out!).mtimeMs, before);
});

test('a non-image falls back to the original instead of failing', async () => {
  assert.equal(await ensureThumb(dir, 'wa_2_note.ogg', 320), null);
});

test('a missing file falls back too', async () => {
  assert.equal(await ensureThumb(dir, 'wa_9_gone.jpg', 320), null);
});
