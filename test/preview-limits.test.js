import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPreview } from '../src/history/preview.js';

const snapshot = { id: 'snapshot-1', version: 3 };
const file = (filePath, fileType) => ({ path: filePath, fileType, contentHash: 'hash', size: 0, metadata: {} });

test('a very large table previews its first rows and says how many there are', () => {
  // Arrange
  const csv = `Account,Amount\n${Array.from({ length: 12_000 }, (_, index) => `A${index},${index}`).join('\n')}\n`;

  // Act
  const preview = buildPreview(snapshot, file('Ledger.csv', 'table'), Buffer.from(csv));

  // Assert
  assert.equal(preview.rows.length, 2000);
  assert.equal(preview.totalRows, 12_000);
  assert.equal(preview.rows[0].cells[0].value, 'A0');
});

test('a very large log previews its first lines and says how many there are', () => {
  const log = Array.from({ length: 20_000 }, (_, index) => `line ${index}`).join('\n');
  const preview = buildPreview(snapshot, file('server.txt', 'text'), Buffer.from(log));
  assert.equal(preview.items.length, 5000);
  assert.equal(preview.totalItems, 20_000);
});

test('ordinary files are previewed in full', () => {
  const preview = buildPreview(snapshot, file('Fees.csv', 'table'), Buffer.from('Item,Amount\nAudit,1200\n'));
  assert.equal(preview.rows.length, 1);
  assert.equal(preview.totalRows, 1);
});
