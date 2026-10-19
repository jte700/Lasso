import test from 'node:test';
import assert from 'node:assert/strict';
import { passiveInlineType } from '../src/http/passive-types.js';

test('documents and images open inline', () => {
  assert.equal(passiveInlineType('plans/Level-2.PDF'), 'application/pdf');
  assert.equal(passiveInlineType('figures/chart.png'), 'image/png');
});

test('formats that can run script are downloaded instead of opened', () => {
  for (const file of ['figures/chart.svg', 'notes/page.html', 'notes/page.htm', 'data/report.xml', 'no-extension']) {
    assert.equal(passiveInlineType(file), null, file);
  }
});
