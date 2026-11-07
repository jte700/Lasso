import test from 'node:test';
import assert from 'node:assert/strict';
import { renderInspectorPanel, renderSharePage } from '../src/sharing/share-page.js';
import { MARKDOWN_STYLE } from '../src/sharing/markdown.js';

// The CSS body of the first rule whose selector list is exactly `selector`.
function ruleBody(html, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`(?:^|[}\\s])${escaped}\\{([^}]*)\\}`));
  assert.ok(match, `the page styles ${selector}`);
  return match[1];
}

const inspector = () => renderInspectorPanel({ source: { label: 'Total', filename: 'budget.xlsx' } }, 'reference', null);
const recipientPage = () => renderSharePage({ source: { label: 'Inventory', filename: 'General-Ledger.csv' },
  share: { accessScope: 'INDEXED', redactions: [] } }, 'token', null);

test("The inspector's close button and actions are grey like the suggestion card, not the folder colour", () => {
  const html = inspector();

  const chrome = ['.close-inspector', '.close-inspector:hover', '.inspector-toolbar button',
    '.inspector-toolbar button:hover', '.inspector-toolbar kbd'];

  for (const selector of chrome) {
    assert.doesNotMatch(ruleBody(html, selector), /accent|cited/, `${selector} is not drawn in the source's colour`);
  }
  assert.match(ruleBody(html, '.close-inspector'), /color:var\(--text2\)/, 'the close X is secondary grey');
  assert.match(ruleBody(html, '.inspector-toolbar button'), /color:var\(--text\)/, 'action titles read as plain labels');
});

test("The inspector marks a cited cell as the suggestion card does, in the colour the Mac app passes", () => {
  const html = inspector();

  const cell = ruleBody(html, 'td.cited');
  const line = ruleBody(html, '.source-line.cited');

  assert.match(cell, /background:color-mix\(in srgb,var\(--cited\) 2\.5%,var\(--paper\)\)/, 'a faint wash of the colour');
  assert.match(cell, /box-shadow:inset 0 0 0 \.8px color-mix\(in srgb,var\(--cited\) 65%,transparent\)/,
    'a 0.8 point outline, as thin as the card\'s');
  assert.match(cell, /font-weight:500/, 'medium weight, as the card');
  assert.match(line, /var\(--cited\) 14%/, 'a cited line is tinted as the card tints it');
  assert.match(line, /inset 2\.5px 0 0 var\(--cited\)/, 'with the card\'s 2.5 point bar');
  assert.match(html, /setProperty\('--cited', sourceHighlight\)/, 'the ?accent= colour from the Mac app becomes the highlight');
  assert.match(ruleBody(html, ':is(.inspector-preview,.shared-recipient .shared-context-table) .row-number.cited'),
    /color:var\(--cited\)/, 'the cited row\'s number takes the colour, as on the card');

  const table = renderInspectorPanel({ source: { label: 'Inventory', filename: 'General-Ledger.csv' } }, 'reference',
    { kind: 'table', columns: ['D'], rows: [{ rowNumber: 6, cells: [{ value: 'Inventory', cited: true }] }] });
  assert.match(table, /<th class="row-number cited" scope="row">6<\/th>/);
});

test("The inspector washes the way into a cited cell, from its row number and column letter up to the cell and no further", () => {
  // Arrange: E5 cited in a sheet that runs on past it to the right and below
  const cell = (value, cited = false) => ({ value, ...(cited ? { cited } : {}) });
  const preview = { kind: 'table', columns: ['D', 'E', 'F'], rows: [
    { rowNumber: 4, cells: [cell('North Ridge Technology'), cell('35000'), cell('Not yet due')] },
    { rowNumber: 5, cells: [cell('Cedar Packaging'), cell('17250', true), cell('Not yet due')] },
    { rowNumber: 6, cells: [cell('Pine Facilities Supply'), cell('32500'), cell('Not yet due')] },
  ] };

  // Act
  const html = renderInspectorPanel({ source: { label: 'Cedar Packaging', filename: 'Accounts-Payable.csv' } }, 'reference', preview);
  const rowNumber = ruleBody(html, ':is(.inspector-preview,.shared-recipient .shared-context-table) .row-number.cited');
  const letter = ruleBody(html, '.inspector-preview thead th.cited');
  const way = ruleBody(html, ':is(.inspector-preview,.shared-recipient .shared-context-table) td.on-path');
  const classOf = (value) => html.match(new RegExp(`<td class="([^"]*)"[^>]*>${value}</td>`))?.[1];

  // Assert
  assert.match(html, /<th scope="col">D<\/th><th scope="col" class="cited">E<\/th><th scope="col">F<\/th>/);
  assert.match(html, /<th class="row-number cited" scope="row">5<\/th>/);
  assert.equal(classOf('Cedar Packaging'), 'on-path', 'the row is washed from its number to the cell');
  assert.equal(classOf('35000'), 'on-path', 'the column is washed from its letter to the cell');
  assert.equal(classOf('17250'), 'cited');
  assert.equal(classOf('Pine Facilities Supply'), '', 'nothing below the cell');
  assert.equal(classOf('32500'), '', 'nothing below the cell in its column');
  assert.ok(!/class="on-path"[^>]*>Not yet due/.test(html), 'nothing past the cell to its right');
  for (const [name, rule] of [['row number', rowNumber], ['column letter', letter], ['way in', way]]) {
    assert.match(rule, /background:color-mix\(in srgb,var\(--cited\) 14%,var\(--paper\)\)/, `the ${name} is one wash`);
    assert.doesNotMatch(rule, /box-shadow/, `the ${name} has no bar breaking it off`);
  }
  assert.match(rowNumber, /color:var\(--cited\);/);
  assert.match(letter, /color:var\(--cited\);/);
  assert.match(html, /querySelector\('\.cited:not\(th\)'\)/, 'the preview scrolls to the cell, not its marked headers');
});

test('A citation of a whole row or column has no single way in, so only its headers are marked', () => {
  // Arrange
  const preview = { kind: 'table', columns: ['A', 'B'], rows: [
    { rowNumber: 1, cells: [{ value: 'Supplier' }, { value: 'Outstanding CAD', cited: true }] },
    { rowNumber: 2, cells: [{ value: 'Maple Paper' }, { value: '22000', cited: true }] },
  ] };

  // Act
  const html = renderInspectorPanel({ source: { label: 'Outstanding CAD', filename: 'Accounts-Payable.csv' } }, 'reference', preview);

  // Assert
  assert.doesNotMatch(html, /<td class="on-path"/);
  assert.match(html, /<th scope="col" class="cited">B<\/th>/);
});

test('Cited Markdown blocks take the highlight colour with the card\'s 2.5 point bar', () => {
  const cited = ruleBody(MARKDOWN_STYLE, '.markdown-document .cited');

  assert.match(cited, /color-mix\(in srgb,var\(--cited,var\(--accent\)\) 14%,transparent\)/);
  assert.match(cited, /box-shadow:inset 2\.5px 0 0 var\(--cited,var\(--accent\)\)/);
});

test("A share link's recipient sees every highlight in green, never the sharer's folder colour", () => {
  const html = recipientPage();
  const table = renderSharePage({ source: { label: 'Inventory', filename: 'General-Ledger.csv' },
    share: { accessScope: 'INDEXED', redactions: [] } }, 'token',
  { headers: ['Account'], columns: ['D'], rows: [{ rowNumber: 6, cells: [{ value: 'Inventory', cited: true }] }] });

  assert.match(html, /:root\s*\{[^}]*--cited:#34c759/, 'green in light mode');
  assert.match(table, /<th class="row-number cited" scope="row">6<\/th>/, 'the cited row\'s number is marked, as on the card');
  assert.match(html, /prefers-color-scheme:dark\)\{:root\{[^}]*--cited:#30d158/, 'and in dark mode');
  assert.doesNotMatch(html, /get\('accent'\)/, 'the page takes no colour from its address');
  assert.match(ruleBody(html, '.shared-recipient td.cited'), /\.8px color-mix\(in srgb,var\(--cited\) 65%/);
  const column = ruleBody(html, '.shared-recipient .shared-context-table .selected-column');
  assert.match(column, /color:var\(--cited\)/);
  assert.match(column, /background:color-mix\(in srgb,var\(--cited\) 14%,var\(--surface\)\)/, 'the cited column\'s heading is washed in green');
  assert.doesNotMatch(column, /box-shadow/, 'with no bar breaking it off');
  const lone = renderSharePage({ source: { label: 'Inventory', filename: 'General-Ledger.csv' },
    share: { accessScope: 'INDEXED', redactions: [] } }, 'token',
  { headers: ['Account', 'Debit'], columns: ['A', 'B'], rows: [
    { rowNumber: 5, cells: [{ value: 'Cash' }, { value: '900' }] },
    { rowNumber: 6, cells: [{ value: 'Inventory' }, { value: '400', cited: true }] },
  ] });
  assert.match(lone, /<td class="on-path">Inventory<\/td>/, 'the row is washed up to the shared cell');
  assert.match(lone, /<td class="on-path">900<\/td>/, 'and the column down to it');
  assert.match(ruleBody(html, '.shared-selection-key i'), /var\(--cited\)/);
});

test("A share link's download and copy buttons are grey like the suggestion card's, not blue", () => {
  const html = recipientPage();

  const buttons = ['a.action', 'a.action:hover', '.shared-recipient a.action.primary'];

  for (const selector of buttons) {
    assert.doesNotMatch(ruleBody(html, selector), /accent|#fff\b/, `${selector} is not blue or white-on-colour`);
  }
  assert.match(ruleBody(html, 'a.action'), /color:var\(--text\)/, 'a button title reads as a plain label');
  assert.match(ruleBody(html, '.shared-recipient a.action.primary'), /color:var\(--text\)/,
    'the main download is told apart by weight, not colour');
});
