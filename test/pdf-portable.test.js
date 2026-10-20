import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractPortablePdfLayout, renderPortablePdfFigure } from '../src/dependencies/pdf-portable.js';
import { parseDrawingPage } from '../src/dependencies/drawing-extraction.js';

function pdf(pages, rotation = 0) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  pages.forEach((content, index) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate ${rotation} /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  });
  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(output));
    output += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

const plan = 'BT /F1 12 Tf 50 700 Td (OFFICE 180 SF) Tj 0 -30 Td (FLOOR PLAN) Tj ET';

test('bundled PDF engine extracts positioned printed measurements without native PDF tools', () => {
  const layout = extractPortablePdfLayout(pdf([plan]));
  assert.equal(layout.pageCount, 1);
  const result = parseDrawingPage(layout.pages[0]);
  assert.equal(result.annotations[0].numericValue, 180);
  assert.equal(result.annotations[0].label, 'OFFICE');
  assert.equal(result.annotations[0].units, 'ft²');
  assert.ok(result.annotations[0].bbox.y < 0.2);
  assert.equal(result.title, 'FLOOR PLAN');
});

test('bundled PDF text geometry respects rotated page bounds', () => {
  const layout = extractPortablePdfLayout(pdf([plan], 90));
  assert.equal(layout.pages[0].width, 792);
  assert.equal(layout.pages[0].height, 612);
  assert.equal(layout.pages[0].rotation, 90);
  for (const { bbox } of layout.pages[0].words) {
    assert.ok(bbox.x >= 0 && bbox.y >= 0);
    assert.ok(bbox.x + bbox.width <= 1.00001 && bbox.y + bbox.height <= 1.00001);
  }
});

test('bundled PDF renderer finds the cited figure on its actual page and returns PNG pixels', () => {
  const document = pdf([
    'BT /F1 12 Tf 50 700 Td (Introduction) Tj ET',
    '0.2 0.4 0.8 rg 50 200 300 200 re f BT /F1 12 Tf 50 650 Td (Figure 2. Results) Tj ET',
  ]);
  const result = renderPortablePdfFigure(document, '2');
  assert.equal(result.pageNumber, 2);
  assert.equal(result.located, true);
  assert.equal(result.matchedLabel, 'Figure 2.');
  assert.equal(result.image.subarray(1, 4).toString(), 'PNG');
  assert.ok(result.image.readUInt32BE(16) > 500);
  assert.ok(result.image.readUInt32BE(20) > 500);
});

test('bundled PDF processing refuses malformed data', () => {
  assert.throws(() => extractPortablePdfLayout(Buffer.from('not a PDF')), /valid PDF/);
  assert.throws(() => extractPortablePdfLayout(Buffer.from('%PDF-1.7\ninvalid')), /PDF/i);
});

test('bundled PDF engine extracts the independent NCSU plan measurement', {
  skip: !fs.existsSync(new URL('./fixtures/drawings/ncsu-office-kit.pdf', import.meta.url)),
}, () => {
  const layout = extractPortablePdfLayout(fs.readFileSync(new URL('./fixtures/drawings/ncsu-office-kit.pdf', import.meta.url)));
  const annotations = layout.pages.flatMap(page => parseDrawingPage(page).annotations);
  assert.ok(annotations.some(item => /small conference/i.test(item.label) && item.numericValue === 180 && item.pageNumber === 17));
});
