// Text and layout from a PDF through pdf.js: lines with their page, position,
// font size and font, in reading order. Running headers and footers (lines
// that repeat on most pages, numbers aside) are removed.

import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let pdfjsPromise = null;
const pdfjs = () => (pdfjsPromise ??= import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href));
const STANDARD_FONTS = `${path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/`;

export async function extractLines(buffer) {
  const { getDocument } = await pdfjs();
  const document = await getDocument({ data: new Uint8Array(buffer), standardFontDataUrl: STANDARD_FONTS, isEvalSupported: false, verbosity: 0 }).promise;
  const lines = [];
  for (let number = 1; number <= document.numPages; number += 1) {
    const page = await document.getPage(number);
    const { height } = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items.filter((item) => item.str && item.str.trim()).map((item) => ({
      text: item.str, x: item.transform[4], y: item.transform[5], size: Math.round(Math.hypot(item.transform[2], item.transform[3]) * 100) / 100,
      width: item.width, font: item.fontName,
    }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    let current = null;
    for (const item of items) {
      if (current && Math.abs(current.y - item.y) <= 2) current.items.push(item);
      else { current = { page: number, y: item.y, pageHeight: height, items: [item] }; lines.push(current); }
    }
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.x = line.items[0].x;
    line.size = Math.max(...line.items.map((item) => item.size));
    line.font = line.items[0].font;
    // Cells: items separated by a wide gap. A table row has several.
    const cells = [];
    for (const item of line.items) {
      const previous = cells.at(-1);
      if (previous && item.x - (previous.x + previous.width) < 12) {
        previous.text += (item.x - (previous.x + previous.width) > 1.5 ? ' ' : '') + item.text;
        previous.width = item.x + item.width - previous.x;
      } else cells.push({ text: item.text, x: item.x, width: item.width });
    }
    line.cells = cells.map((cell) => ({ ...cell, text: cell.text.trim() }));
    line.text = line.cells.map((cell) => cell.text).join(' ').replace(/\s+/g, ' ').trim();
  }
  // Running headers and footers: near the page edge and repeating (digits aside) on at least half the pages.
  const pages = document.numPages;
  const shapeCount = new Map();
  const shape = (line) => line.text.replace(/\d+/g, '#');
  for (const line of lines) {
    if (line.y < 60 || line.y > line.pageHeight - 50) shapeCount.set(shape(line), (shapeCount.get(shape(line)) ?? 0) + 1);
  }
  const running = new Set([...shapeCount].filter(([, count]) => pages >= 3 && count >= pages / 2).map(([text]) => text));
  // A page-number line at the page edge is a running footer even in a one- or two-page file, where repetition cannot show it.
  const pageNumber = (line) => /\bpage\s+\d+(?:\s+of\s+\d+)?\b/i.test(line.text) && line.text.length < 120;
  const edge = (line) => line.y < 60 || line.y > line.pageHeight - 50;
  return { pages, lines: lines.filter((line) => !(edge(line) && (running.has(shape(line)) || pageNumber(line)))), runningRemoved: running.size };
}
