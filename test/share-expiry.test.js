import test from 'node:test';
import assert from 'node:assert/strict';
import { shareExpiry } from '../src/sharing/expiry.js';

const reference = new Date('2026-10-18T12:00:00Z');

test('a link without an expiry stays open', () => {
  for (const value of [undefined, null, '']) assert.equal(shareExpiry(value, reference), null);
});

test('a future expiry is stored as an ISO timestamp', () => {
  assert.equal(shareExpiry('2026-11-01', reference), '2026-11-01T00:00:00.000Z');
});

test('an unreadable or past expiry is a clear client error', () => {
  assert.throws(() => shareExpiry('next tuesday-ish', reference), { status: 400, message: /valid expiry/ });
  assert.throws(() => shareExpiry('2020-01-01', reference), { status: 400, message: /in the future/ });
});
