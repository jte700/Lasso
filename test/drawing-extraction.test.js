import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractDrawingDocument, parseDrawingPage } from '../src/dependencies/drawing-extraction.js';

function word(text, x, y, width = text.length * 0.006, height = 0.015) {
  return { text, bbox: { x, y, width, height } };
}
function page(words) { return parseDrawingPage({ pageNumber: 1, width: 792, height: 612, words }); }

test('drawing parser preserves printed room area with page geometry and stable identity', () => {
  const layout = [word('BEDROOM', 0.1, 0.2), word('144', 0.1, 0.22), word('SF', 0.125, 0.22), word('FLOOR', 0.73, 0.85), word('PLAN', 0.77, 0.85), word('A-101', 0.9, 0.94)];
  const result = page(layout);
  assert.equal(result.isDrawing, true);
  assert.equal(result.sheetNumber, 'A-101');
  assert.equal(result.title, 'FLOOR PLAN');
  assert.equal(result.annotations.length, 1);
  const area = result.annotations[0];
  assert.equal(area.kind, 'room_area');
  assert.equal(area.label, 'BEDROOM');
  assert.equal(area.numericValue, 144);
  assert.equal(area.value, '144 ft²');
  assert.equal(area.units, 'ft²');
  assert.match(area.rawText, /BEDROOM\n144 SF/);
  assert.ok(area.bbox.x >= 0 && area.bbox.x + area.bbox.width <= 1);
  const revised = page(layout.map((item) => item.text === '144' ? { ...item, text: '150' } : item));
  assert.equal(revised.annotations[0].id, area.id);
  assert.equal(revised.annotations[0].numericValue, 150);
});

test('area below or above room label is local and may use metric units', () => {
  const result = page([word('18.6', 0.5, 0.5), word('m²', 0.53, 0.5), word('OFFICE', 0.5, 0.535)]);
  assert.equal(result.annotations[0].label, 'OFFICE');
  assert.equal(result.annotations[0].numericValue, 18.6);
  assert.equal(result.annotations[0].units, 'm²');
});

test('drawing parser rejects unlabeled, ambiguous, dimension-only and competing areas', () => {
  assert.equal(page([word('144', 0.1, 0.2), word('SF', 0.125, 0.2)]).annotations.length, 0);
  assert.equal(page([word('OFFICE', 0.1, 0.2), word('KITCHEN', 0.1, 0.24), word('144', 0.1, 0.22), word('SF', 0.125, 0.22)]).annotations.length, 0);
  assert.equal(page([word('OFFICE', 0.1, 0.2), word('12', 0.1, 0.22), word('x', 0.12, 0.22), word('12', 0.13, 0.22)]).annotations.length, 0);
  assert.equal(page([word('OFFICE 100 SF 120 SF', 0.1, 0.2, 0.2)]).annotations.length, 0);
});

test('explicit civil pipe callout extracts only printed measurements', () => {
  const result = page([word('150 LF 12" RCP @ 0.50%', 0.1, 0.2, 0.3), word('RIM = 123.45 FT', 0.1, 0.4, 0.2), word('INV = 119.20', 0.1, 0.5, 0.2)]);
  const kinds = Object.fromEntries(result.annotations.map((item) => [item.kind, item]));
  assert.equal(kinds.pipe_length.numericValue, 150);
  assert.equal(kinds.pipe_diameter.numericValue, 12);
  assert.equal(kinds.slope.numericValue, 0.5);
  assert.equal(result.annotations.find((item) => item.label === 'RIM').units, 'ft');
  assert.equal(result.annotations.find((item) => item.label === 'INV').units, null);
  assert.match(result.annotations.find((item) => item.label === 'INV').warning, /confirm/);
});

test('unpositioned PDF text is searchable without manufacturing measurement evidence', () => {
  const result = parseDrawingPage({ text: 'BEDROOM 144 SF', pageNumber: 3 });
  assert.equal(result.annotations.length, 0);
  assert.equal(result.pageNumber, 3);
});

test('non-PDF input is explicitly unsupported', () => {
  const result = extractDrawingDocument(Buffer.from('CAD data'));
  assert.equal(result.status, 'unsupported');
  assert.equal(result.pages.length, 0);
});

// Runs wherever a layout extractor is actually available: macOS through
// PDFKit, Windows through the published drawing helper. Both must find the
// same measurement on the same page of the same public sample.
const drawingSample = new URL('./fixtures/drawings/ncsu-office-kit.pdf', import.meta.url);
const windowsDrawingHelper = new URL('../scripts/extract-drawing-layout.exe', import.meta.url);
const layoutExtractorAvailable = process.platform === 'darwin'
  || (process.platform === 'win32' && fs.existsSync(windowsDrawingHelper));

test('public NCSU plan extracts Small Conference 180 square feet', { skip: !layoutExtractorAvailable || !fs.existsSync(drawingSample) }, () => {
  const buffer = fs.readFileSync(drawingSample);
  const result = extractDrawingDocument(buffer);
  assert.ok(['ready', 'partial'].includes(result.status), JSON.stringify(result.warnings));
  const conference = result.pages.flatMap((item) => item.annotations).find((item) => /small conference/i.test(item.label) && item.numericValue === 180 && item.pageNumber === 17);
  assert.ok(conference, 'Small Conference has an explicit 180 sf label in the public sample');
  assert.equal(conference.pageNumber, 17);
  assert.equal(conference.units, 'ft²');
  // Cache results are isolated from caller mutations.
  result.pages[0].text = 'modified';
  assert.notEqual(extractDrawingDocument(buffer).pages[0].text, 'modified');
});


test('ambiguous pipe sizes are not promoted as one diameter', () => {
  const result = page([word('CONNECT 12\" RCP TO 18\" RCP', 0.1, 0.2, 0.4)]);
  assert.equal(result.annotations.filter((item) => item.kind === 'pipe_diameter').length, 0);
});
