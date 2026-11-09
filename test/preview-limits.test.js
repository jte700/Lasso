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

test('a text viewport keeps its few lines of context unless a scrolling surface asks for more', async () => {
  // Arrange
  const { buildTextPreview } = await import('../src/sharing/share-preview.js');
  const code = Array.from({ length: 1_000 }, (_, index) => `const value${index} = ${index};`).join('\n');
  const notes = Array.from({ length: 300 }, (_, index) => `Paragraph ${index}.`).join('\n\n');
  const wide = { context: { lines: 400, blocksBefore: 200, blocksAfter: 400 } };

  // Act
  const narrow = buildTextPreview('app.js', code, { lineStart: 500 });
  const scrolling = buildTextPreview('app.js', code, { lineStart: 500 }, {}, '', '', wide);
  const markdown = buildTextPreview('notes.md', notes, { lineStart: 301 }, {}, '', '', wide);

  // Assert
  assert.deepEqual([narrow.lines[0].lineNumber, narrow.lines.at(-1).lineNumber], [492, 515]);
  assert.deepEqual([scrolling.lines[0].lineNumber, scrolling.lines.at(-1).lineNumber], [100, 900]);
  assert.deepEqual(scrolling.lines.filter((line) => line.cited).map((line) => line.lineNumber), [500]);
  assert.equal(markdown.firstBlock, 0, 'every block before the cited one fits in the wider context');
  assert.equal(markdown.blocks.length, 300);
});
