import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSharedExcerpt } from '../src/sharing/share-preview.js';

// What "Cited part only" publishes from a table: exactly what the sentence
// cites, with only what it takes to read it.
const file = {
  path: 'Finance/Income-Statement.csv',
  content: Buffer.from('Account,Current Period,Prior Period\nOffice Supplies,400,384\nPayroll taxes,225,218\nRent,1800,1800\n'),
};
const values = (excerpt) => excerpt.rows.map((row) => row.cells.map((cell) => cell.value));
const cited = (excerpt) => excerpt.rows.flatMap((row) => row.cells.filter((cell) => cell.cited).map((cell) => cell.value));

test('a cited cell is shared with its row label and column heading, and nothing else', () => {
  // Arrange
  const anchor = { kind: 'table-cell', rowKey: 'Payroll taxes', rowIndex: 2, column: 'Current Period', columnIndex: 1 };

  // Act
  const excerpt = buildSharedExcerpt(file, anchor, {});

  // Assert
  assert.deepEqual(excerpt.headers, ['Account', 'Current Period']);
  assert.deepEqual(values(excerpt), [['Payroll taxes', '225']]);
  assert.deepEqual(cited(excerpt), ['225']);
});

test('a cited row is shared as that row under its headings', () => {
  // Arrange
  const anchor = { kind: 'table-row', rowKey: 'Payroll taxes', rowIndex: 2 };

  // Act
  const excerpt = buildSharedExcerpt(file, anchor, {});

  // Assert
  assert.deepEqual(excerpt.headers, ['Account', 'Current Period', 'Prior Period']);
  assert.deepEqual(values(excerpt), [['Payroll taxes', '225', '218']]);
});

test('a cited column is shared alone, from its heading down', () => {
  // Arrange
  const anchor = { kind: 'table-column', column: 'Prior Period', columnIndex: 2 };

  // Act
  const excerpt = buildSharedExcerpt(file, anchor, {});

  // Assert
  assert.deepEqual(excerpt.headers, ['Prior Period']);
  assert.deepEqual(values(excerpt), [['384'], ['218'], ['1800']]);
});

test('nearby rows are shared only when the sharer asks for them', () => {
  // Arrange
  const anchor = { kind: 'table-cell', rowKey: 'Payroll taxes', rowIndex: 2, column: 'Current Period', columnIndex: 1 };

  // Act
  const excerpt = buildSharedExcerpt(file, anchor, {}, { nearbyRows: true });

  // Assert
  assert.deepEqual(excerpt.headers, ['Account', 'Current Period', 'Prior Period']);
  assert.ok(values(excerpt).some((row) => row[0] === 'Office Supplies'), 'the rows around the cell come with it');
  assert.deepEqual(cited(excerpt), ['225'], 'and the cited cell is still the only one marked');
});

test('a cited sentence is shared inside its paragraph, with the sentence marked', async () => {
  // Arrange
  const { buildSharedPassage } = await import('../src/sharing/share-preview.js');
  const { renderSharePage } = await import('../src/sharing/share-page.js');
  const notes = { path: 'Notes/Close.md', content: Buffer.from(
    '# Month-end close\n\nCash was reconciled on Friday. The ledger agrees with the bank. Accruals follow next week.\n\nA later paragraph that is not shared.\n') };
  const sentence = 'The ledger agrees with the bank.';

  // Act
  const passage = buildSharedPassage(notes, { kind: 'text-span', selectedText: sentence }, { rawText: sentence }, sentence, 'CLAIM');
  const html = renderSharePage({ source: { label: sentence, valueText: sentence, filename: 'Close.md' },
    share: { accessScope: 'INDEXED', redactions: [] } }, 'token', passage);

  // Assert
  assert.equal(passage.kind, 'passage');
  assert.match(passage.paragraph, /^Cash was reconciled on Friday\. The ledger agrees with the bank\. Accruals follow next week\.$/);
  assert.match(html, /Cash was reconciled on Friday\. <mark class="shared-cited">The ledger agrees with the bank\.<\/mark> Accruals/);
  assert.ok(!html.includes('A later paragraph'), 'nothing past the paragraph is shared');
});
