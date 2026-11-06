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
  assert.match(ruleBody(html, '.shared-recipient .shared-context-table .selected-column'), /color:var\(--cited\)/);
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
