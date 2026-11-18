// The thumbnail must be servable by express.sendFile, which refuses any path
// with a dot-segment. That is how a 404 shipped once: the files existed, the
// route found them, and express dropped every one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thumbPath } from './thumbs';

test('no path segment starts with a dot (express.sendFile would 404)', () => {
  const p = thumbPath('/srv/whatsapp-media', 'wa_1_x.jpg', 320);
  const segments = p.split('/').filter(Boolean);
  assert.ok(segments.every((s) => !s.startsWith('.')), p);
});

test('the thumbnail sits under the media directory, one folder per width', () => {
  assert.equal(thumbPath('/srv/media', 'wa_1_x.jpg', 240), '/srv/media/thumbs/240/wa_1_x.jpg.webp');
});
