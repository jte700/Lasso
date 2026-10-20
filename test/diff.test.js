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

test('binary changes do not decode either buffer as text', () => {
  const before = Buffer.from([1, 2]);
  const after = Buffer.from([1, 3]);
  before.toString = after.toString = () => { throw new Error('Binary data must not be decoded.'); };
  const diff = createStructuredDiff({
    fileType: 'pdf', filePath: 'source.pdf', beforeBuffer: before, afterBuffer: after, changeType: 'MODIFIED',
  });
  assert.equal(diff.format, 'binary');
});

test('LandXML and other XML changes compare line by line', () => {
  const before = '<LandXML>\n <Parcels><Parcel name="Lot" area="1850.5"/></Parcels>\n</LandXML>\n';
  const after = '<LandXML>\n <Parcels><Parcel name="Lot" area="1900"/></Parcels>\n</LandXML>\n';
  for (const [fileType, filePath] of [['drawing', 'Site.landxml'], ['xml', 'Civil-Export.xml']]) {
    const diff = createStructuredDiff({ fileType, filePath, beforeBuffer: Buffer.from(before),
      afterBuffer: Buffer.from(after), changeType: 'MODIFIED' });
    assert.equal(diff.format, 'code', filePath);
    assert.equal(diff.added, 1);
    assert.equal(diff.removed, 1);
    assert.match(diff.operations.find((operation) => operation.kind === 'add').text, /area="1900"/);
  }
  // Binary CAD formats that share the drawing type are still never explained.
  const dwg = createStructuredDiff({ fileType: 'drawing', filePath: 'Site.dwg', beforeBuffer: Buffer.from([1]),
    afterBuffer: Buffer.from([2]), changeType: 'MODIFIED' });
  assert.equal(dwg.format, 'binary');
});
