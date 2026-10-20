import test from 'node:test';
import assert from 'node:assert/strict';
import { shareExpiry } from '../src/sharing/expiry.js';

const reference = new Date('2026-10-18T12:00:00Z');

test('a link without a chosen expiry closes 48 hours after it is made', () => {
  for (const value of [undefined, null, '']) assert.equal(shareExpiry(value, reference), '2026-10-20T12:00:00.000Z');
});

test('an earlier expiry within 48 hours is stored as an ISO timestamp', () => {
  assert.equal(shareExpiry('2026-10-19T08:30:00Z', reference), '2026-10-19T08:30:00.000Z');
  assert.equal(shareExpiry('2026-10-20T12:00:00Z', reference), '2026-10-20T12:00:00.000Z');
});

test('an expiry later than 48 hours is refused', () => {
  assert.throws(() => shareExpiry('2026-10-20T12:00:00.001Z', reference), { status: 400, message: /48 hours/ });
  assert.throws(() => shareExpiry('2026-11-01', reference), { status: 400, message: /48 hours/ });
});

test('an unreadable or past expiry is a clear client error', () => {
  assert.throws(() => shareExpiry('next tuesday-ish', reference), { status: 400, message: /valid expiry/ });
  assert.throws(() => shareExpiry('2020-01-01', reference), { status: 400, message: /in the future/ });
});
