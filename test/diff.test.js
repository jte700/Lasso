import test from 'node:test';
import assert from 'node:assert/strict';
import { createStructuredDiff } from '../src/history/diff.js';

test('code diffs are deterministic line operations', () => {
  const diff = createStructuredDiff({
    fileType: 'code',
    filePath: 'analysis.py',
    beforeBuffer: Buffer.from('model = "outcome ~ treatment"\n'),
    afterBuffer: Buffer.from('model = "outcome ~ treatment + batch"\n'),
    changeType: 'MODIFIED',
  });
  assert.equal(diff.format, 'code');
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.deepEqual(diff.operations.filter((item) => item.kind !== 'equal').map((item) => item.text), [
    'model = "outcome ~ treatment"',
    'model = "outcome ~ treatment + batch"',
  ]);
});

test('table diffs report row and cell changes', () => {
  const diff = createStructuredDiff({
    fileType: 'table',
    filePath: 'samples.csv',
    beforeBuffer: Buffer.from('patient,age\npatient_041,62\npatient_042,31\n'),
    afterBuffer: Buffer.from('patient,age\npatient_041,63\npatient_043,44\n'),
    changeType: 'MODIFIED',
  });
  assert.deepEqual(diff.summary, { rowsAdded: 1, rowsRemoved: 1, cellsChanged: 1 });
  assert.deepEqual(diff.cellsChanged[0], { rowKey: 'patient_041', column: 'age', before: '62', after: '63' });
});

test('binary changes never fabricate a structured explanation', () => {
  const diff = createStructuredDiff({
    fileType: 'document',
    filePath: 'results.docx',
    beforeBuffer: Buffer.from([1, 2]),
    afterBuffer: Buffer.from([1, 3]),
    changeType: 'MODIFIED',
  });
  assert.deepEqual(diff, { format: 'binary', message: 'File changed. Structured comparison unavailable.' });
});
