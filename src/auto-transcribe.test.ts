import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoTranscribe, isWorkContact } from './auto-transcribe';

test('dev work is transcribed by default: clients and project contacts', () => {
  assert.equal(shouldAutoTranscribe({ category: 'client' }), true);
  assert.equal(shouldAutoTranscribe({ category: 'Client' }), true, 'category match ignores case');
  assert.equal(shouldAutoTranscribe({ category: 'other', matchesProject: true }), true);
  assert.equal(shouldAutoTranscribe({ category: null, isShopGroup: true }), true, 'shop sales are read from its voice notes');
});

test('everyone else is not: shop contacts, family, personal, unknown', () => {
  for (const category of ['shop', 'Shop', 'family', 'personal', 'other', null, undefined]) {
    assert.equal(shouldAutoTranscribe({ category }), false, String(category));
  }
  assert.equal(shouldAutoTranscribe({ category: 'shop', matchesProject: true }), false,
    'a shop contact saved under a project-like name stays off');
});

test('the per-contact setting wins both ways', () => {
  assert.equal(shouldAutoTranscribe({ category: 'family', setting: 'on' }), true);
  assert.equal(shouldAutoTranscribe({ category: 'client', setting: 'off' }), false);
  assert.equal(shouldAutoTranscribe({ category: 'client', setting: 'default' }), true);
  assert.equal(shouldAutoTranscribe({ category: 'family', setting: null }), false);
});

test('family, personal or shop category beats a project-name match', () => {
  assert.equal(shouldAutoTranscribe({ category: 'family', matchesProject: true }), false);
  assert.equal(shouldAutoTranscribe({ category: 'personal', matchesProject: true }), false);
  assert.equal(shouldAutoTranscribe({ category: 'shop', matchesProject: true }), false);
  assert.equal(shouldAutoTranscribe({ category: 'family', isShopGroup: true }), true,
    'the shop group is the one exception, for the sales log');
});

test('isWorkContact ignores the setting', () => {
  assert.equal(isWorkContact({ category: 'client' }), true);
  assert.equal(isWorkContact({ category: 'personal' }), false);
  assert.equal(isWorkContact({ category: 'shop' }), false);
  assert.equal(isWorkContact({ category: 'shop', setting: 'on' } as any), false, 'the setting is applied by shouldAutoTranscribe');
});
