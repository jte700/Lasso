import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMenuBarHome, renderSharePage, renderUnavailable } from '../src/sharing/share-page.js';

const sharedOn = '2026-11-08T12:00:00.000Z';

function resolved(accessScope = 'INDEXED', filename = 'Close.xlsx') {
  return { source: { label: 'Revenue · Actual', filename, snapshotVersion: 3 },
    share: { accessScope, redactions: [], createdAt: sharedOn } };
}

const tablePreview = { headers: ['Account', 'Actual'], columns: ['A', 'B'],
  rows: [{ rowNumber: 7, cells: [{ value: 'Revenue' }, { value: '485000', cited: true }] }] };

const between = (html, start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));

test('A share page says what is shared, its version and its date once, on one line under the title', () => {
  // Act
  const html = renderSharePage(resolved(), 'token', tablePreview);
  const facts = between(html, '<ul class="shared-facts">', '</ul>');

  // Assert
  assert.match(facts, /Cited part only/);
  assert.match(facts, /Version 3/);
  assert.match(facts, /Shared Nov 8, 2026/);
  assert.equal(html.match(/Version 3/g).length, 1, 'the version is not repeated elsewhere on the page');
  assert.ok(html.indexOf('<h1>') < html.indexOf('<ul class="shared-facts">'), 'the title comes first');
});

test('The downloads sit in the toolbar, where they stay in view however long the source is', () => {
  // Act
  const html = renderSharePage(resolved(), 'token', tablePreview);
  const toolbar = between(html, '<header class="shared-toolbar">', '</header>');

  // Assert
  assert.match(toolbar, /<a class="action primary" href="\/d\/token\/excerpt" download>/);
  assert.match(html, /\.shared-toolbar\{[^}]*position:sticky/);
});

test('A page with nothing to download has a toolbar with no download controls', () => {
  // Act
  const html = renderSharePage(resolved('INDEXED', 'Bracket.step'), 'token', null);

  // Assert
  assert.doesNotMatch(between(html, '<header class="shared-toolbar">', '</header>'), /class="actions"/);
});

test('A boxed source sits directly on the page, with no window drawn around it', () => {
  // Act
  const html = renderSharePage(resolved(), 'token', tablePreview);

  // Assert
  assert.doesNotMatch(html, /shared-provenance|shared-downloads/);
  const window = html.match(/\.shared-window\{([^}]*)\}/)[1];
  assert.doesNotMatch(window, /border|box-shadow|background/);
});

test('Tables and files keep the wide column, and prose is set in a narrower one to read', () => {
  // Act
  const table = renderSharePage(resolved(), 'token', tablePreview);
  const prose = renderSharePage({ source: { label: 'Closing note', filename: 'Close.md', valueText: 'The ledger agrees.', snapshotVersion: 1 },
    share: { accessScope: 'INDEXED', redactions: [], createdAt: sharedOn } }, 'token', null);

  // Assert
  assert.match(table, /<article class="shared-window">/);
  assert.match(prose, /<article class="shared-window" data-width="reading">/);
});

test('A recipient is told what a link does in plain words, not in the words of the source code', () => {
  // Act
  const pages = ['REVOKED', 'EXPIRED', 'SOURCE_MISSING', 'NOT_FOUND'].map((status) => renderUnavailable(status));

  // Assert
  for (const html of pages) assert.doesNotMatch(between(html, '<body', '</body>'), /dependency/i);
  assert.match(pages[0], /This link has been revoked/);
  assert.match(pages[1], /This link has expired/);
});

test('A link that no longer works and the server\'s own address share one calm message layout', () => {
  // Act
  const unavailable = renderUnavailable('REVOKED');
  const home = renderMenuBarHome();

  // Assert
  for (const html of [unavailable, home]) {
    assert.match(html, /<section class="shared-state">/);
    assert.match(html, /<span>Lasso<\/span>/);
  }
  assert.doesNotMatch(between(unavailable, '<body', '</body>'), /class="unavailable"/, 'it is not written in red');
});

test('Recipient pages carry the Lasso mark as their tab icon, inside what the page may load', () => {
  // Act
  const html = renderSharePage(resolved(), 'token', tablePreview);

  // Assert
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/);
});

test('On a phone the page keeps a 16px gutter and its downloads fill their own row', () => {
  // Act
  const html = renderSharePage(resolved(), 'token', tablePreview);
  const phone = html.slice(html.indexOf('@media(max-width:640px)'));

  // Assert
  assert.match(phone, /--gutter:16px/);
  assert.match(phone, /\.shared-recipient \.actions\{[^}]*width:100%/);
  assert.match(phone, /\.shared-toolbar\{[^}]*position:static/);
});

test('A whole document share leads with the original file, and its excerpt comes after', () => {
  // Act
  const html = renderSharePage(resolved('DOCUMENT'), 'token', tablePreview);
  const toolbar = between(html, '<header class="shared-toolbar">', '</header>');

  // Assert
  assert.match(toolbar, /<a class="action primary" href="\/d\/token\/download" download>/);
  assert.match(toolbar, /<a class="action" href="\/d\/token\/excerpt" download>/);
  assert.ok(toolbar.indexOf('/d/token/download') < toolbar.indexOf('/d/token/excerpt'));
});

test('A source with no excerpt says so without pointing at controls elsewhere on the page', () => {
  // Act
  const html = renderSharePage(resolved('INDEXED', 'Bracket.step'), 'token', null);

  // Assert
  assert.match(html, /An inline excerpt is unavailable for this source\./);
  assert.doesNotMatch(html, /options below|shown above/);
});

test('Cited headers stay readable on their wash, and a drawing does not repeat its own title', () => {
  // Act
  const html = renderSharePage(resolved(), 'token', tablePreview);

  // Assert
  assert.match(html, /\.shared-recipient \.shared-context-table \.selected-column\{color:color-mix\(in srgb,var\(--cited\) 62%,var\(--text\)\)/);
  assert.match(html, /\.shared-recipient \.shared-context-table \.row-number\.cited\{color:color-mix\(in srgb,var\(--cited\) 62%,var\(--text\)\)/);
  assert.match(html, /\.shared-recipient \.drawing-document \.model-plan-head\{display:none\}/);
});

test("The server's own address does not call itself a shared source", () => {
  // Act
  const home = renderMenuBarHome();
  const unavailable = renderUnavailable('EXPIRED');

  // Assert
  assert.doesNotMatch(between(home, '<body', '</body>'), /Shared source/);
  assert.match(between(unavailable, '<body', '</body>'), /Shared source/);
});

test('Scrollbars on a shared table are a quiet grey, not a dark bar', () => {
  // Act
  const html = renderSharePage(resolved(), 'token', tablePreview);

  // Assert
  assert.match(html, /\.shared-recipient :is\(\.document-table,\.shared-context-table\)::-webkit-scrollbar-thumb\{background:color-mix\(in srgb,var\(--text\) 28%,transparent\)/);
});
