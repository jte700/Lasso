// A separate process bounds expensive/untrusted PDFs and releases native raster
// memory after each request. All font, CMap and WASM resources are local assets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';

const MAX_PAGES = 80;
const MAX_TEXT = 1_500_000;
const packageRoot = path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
// pdf.js requires a trailing "/"; Node's fs also accepts "/" in Windows paths.
const asset = name => `${path.join(packageRoot, name).split(path.sep).join('/')}/`;
const round = value => Math.round(value * 1e6) / 1e6;

function textBox(item, style, viewport) {
  const matrix = Util.transform(viewport.transform, item.transform);
  let angle = Math.atan2(matrix[1], matrix[0]);
  if (style.vertical) angle += Math.PI / 2;
  const height = Math.hypot(matrix[2], matrix[3]);
  const width = Math.abs((style.vertical ? item.height : item.width) * viewport.scale);
  const ascent = (Number.isFinite(style.ascent) ? style.ascent
    : Number.isFinite(style.descent) ? 1 + style.descent : 0.8) * height;
  const direction = [Math.cos(angle), Math.sin(angle)];
  const down = [-direction[1], direction[0]];
  const origin = [matrix[4] - down[0] * ascent, matrix[5] - down[1] * ascent];
  const corners = [[0, 0], [width, 0], [width, height], [0, height]]
    .map(([x, y]) => [origin[0] + x * direction[0] + y * down[0], origin[1] + x * direction[1] + y * down[1]]);
  const left = Math.max(0, Math.min(...corners.map(point => point[0])));
  const top = Math.max(0, Math.min(...corners.map(point => point[1])));
  const right = Math.min(viewport.width, Math.max(...corners.map(point => point[0])));
  const bottom = Math.min(viewport.height, Math.max(...corners.map(point => point[1])));
  if (!(right > left && bottom > top)) return null;
  return { x: round(left / viewport.width), y: round(top / viewport.height),
    width: round((right - left) / viewport.width), height: round((bottom - top) / viewport.height) };
}

async function extractLayout(document) {
  const pages = [], warnings = [];
  let remaining = MAX_TEXT;
  for (let index = 1; index <= Math.min(document.numPages, MAX_PAGES); index++) {
    const page = await document.getPage(index);
    try {
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const words = [], fragments = [];
      let characters = 0;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        if (characters + item.str.length > Math.min(150_000, remaining) || words.length >= 25_000) {
          warnings.push(`Text on page ${index} exceeded the extraction limit.`);
          break;
        }
        characters += item.str.length;
        fragments.push(item.str, item.hasEOL ? '\n' : ' ');
        const bbox = textBox(item, content.styles[item.fontName] ?? {}, viewport);
        // Preserve each positioned PDF text run. Splitting its width evenly
        // would invent per-word positions in proportional fonts.
        if (item.str.trim() && bbox) words.push({ text: item.str, bbox });
      }
      remaining -= characters;
      pages.push({ pageNumber: index, width: viewport.width, height: viewport.height,
        rotation: viewport.rotation, text: fragments.join('').trim(), words });
      if (remaining <= 0) { warnings.push('Document text exceeded the extraction limit.'); break; }
    } finally { page.cleanup(); }
  }
  if (document.numPages > MAX_PAGES) warnings.push(`Only the first ${MAX_PAGES} of ${document.numPages} pages were indexed.`);
  return { pageCount: document.numPages, pages, warnings };
}

async function renderFigure(document, identifier) {
  const number = String(identifier).trim();
  const queries = [`Figure ${number}.`, `Fig. ${number}.`, `Figure ${number}:`, `Fig. ${number}:`, `Figure ${number}`, `Fig. ${number}`];
  const matches = new Map();
  let remaining = MAX_TEXT;
  for (let index = 1; index <= Math.min(document.numPages, MAX_PAGES) && remaining > 0; index++) {
    const page = await document.getPage(index);
    try {
      const content = await page.getTextContent();
      const text = content.items.map(item => item.str ?? '').join(' ').replace(/\s+/g, ' ').slice(0, Math.min(150_000, remaining)).toLowerCase();
      remaining -= text.length;
      for (const query of queries) if (!matches.has(query) && text.includes(query.toLowerCase())) matches.set(query, index);
      if (matches.has(queries[0])) break;
    } finally { page.cleanup(); }
  }
  const matchedLabel = queries.find(query => matches.has(query)) ?? '';
  const pageNumber = matches.get(matchedLabel) ?? 1;
  const page = await document.getPage(pageNumber);
  try {
    const original = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 2048 / Math.max(original.width, original.height));
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return { pageNumber, located: Boolean(matchedLabel), matchedLabel,
      image: canvas.toBuffer('image/png').toString('base64') };
  } finally { page.cleanup(); }
}

let loadingTask;
try {
  const data = new Uint8Array(fs.readFileSync(0));
  if (!data.length || data.length > 80_000_000) throw new Error('PDF processing requires a nonempty file under 80 MB.');
  loadingTask = getDocument({ data, verbosity: 0, isEvalSupported: false,
    cMapUrl: asset('cmaps'), cMapPacked: true, standardFontDataUrl: asset('standard_fonts'),
    wasmUrl: asset('wasm'), useSystemFonts: false, maxImageSize: 16_000_000 });
  const document = await loadingTask.promise;
  const operation = process.argv[2];
  const output = operation === 'layout' ? await extractLayout(document)
    : operation === 'figure' ? await renderFigure(document, process.argv[3])
      : (() => { throw new Error('Unknown PDF operation.'); })();
  process.stdout.write(JSON.stringify(output));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error?.message ?? 'The PDF could not be processed.' }));
  process.exitCode = 1;
} finally { await loadingTask?.destroy(); }
