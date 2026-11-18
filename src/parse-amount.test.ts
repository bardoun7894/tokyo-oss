import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount } from './parse-amount';

test('plain dirham amounts, however they are written', () => {
  assert.deepEqual(parseAmount('sift lik 1500 dh'), { amount: 1500, currency: 'DH' });
  assert.deepEqual(parseAmount('17 500 DH wsslou'), { amount: 17500, currency: 'DH' });
  assert.deepEqual(parseAmount('17,500dh'), { amount: 17500, currency: 'DH' });
  assert.deepEqual(parseAmount('17.500 درهم'), { amount: 17500, currency: 'DH' });
  assert.deepEqual(parseAmount('1500,50 dh'), { amount: 1500.5, currency: 'DH' });
});

test('other currencies are recognised', () => {
  assert.deepEqual(parseAmount('paid you $2000'), { amount: 2000, currency: 'USD' });
  assert.deepEqual(parseAmount('2000 usd sent'), { amount: 2000, currency: 'USD' });
  assert.deepEqual(parseAmount('450 euros'), { amount: 450, currency: 'EUR' });
});

test('a bare number defaults to dirhams', () => {
  assert.deepEqual(parseAmount('3000'), { amount: 3000, currency: 'DH' });
});

test('no amount means no amount — the caller must ask', () => {
  assert.equal(parseAmount('payment sent, check please'), null);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('شكرا'), null);
});

test('phone numbers, dates and times are not amounts', () => {
  assert.equal(parseAmount('call me 0612345678'), null);
  assert.equal(parseAmount('see you 18/09 at 15:45'), null);
});

test('several bare numbers are ambiguous and rejected', () => {
  assert.equal(parseAmount('3 items 200 each'), null, 'which one is the payment?');
});

test('several numbers with a currency take the largest', () => {
  assert.deepEqual(parseAmount('2 pieces, total 400 dh'), { amount: 400, currency: 'DH' });
});
