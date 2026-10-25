// A document as pages to draw on: a PDF as it is, a Word document laid out
// on its paper, and a deck as one picture per slide, drawn by Quick Look.
// The share composer marks these pages up, and a marked copy is the same
// pages with the strokes drawn on, so both must come from here.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readZip } from '../dependencies/zip-archive.js';
import { isPresentationPath, slideParts } from '../dependencies/presentation-extraction.js';
import { singleSlidePresentation } from './slide-export.js';
import { checkedPdf } from './pdf-share.js';
import { execute, renderCache, swiftHelper } from './swift-helper.js';

const executable = swiftHelper('render-document-pages', ['AppKit', 'PDFKit', 'QuickLookThumbnailing'],
  'Marking up Word documents and presentations requires a Mac.');
const cached = renderCache({ entries: 8, bytes: 96 * 1024 * 1024 });
const MAX_SLIDES = 120;
// Quick Look draws a slide in about half a second; a long deck takes a while.
const SECONDS_PER_SLIDE = 4;
const DOCUMENT_TIMEOUT_MS = 60_000;

const isWordPath = (filePath) => /\.docx$/i.test(String(filePath ?? ''));

/**
 * The document's pages as a PDF, or null for a file that has none.
 * @param {{path: string, content: Buffer}|null} file
 * @returns {Promise<Buffer|null>}
 */
export async function buildPagePdf(file) {
  if (!file || !Buffer.isBuffer(file.content)) return null;
  if (/\.pdf$/i.test(file.path)) return file.content;
  const deck = isPresentationPath(file.path);
  if (!deck && !isWordPath(file.path)) return null;
  const key = crypto.createHash('sha256').update(deck ? 'slides:' : 'docx:').update(file.content).digest('hex');
  return cached(key, () => (deck ? slidePages(file.content) : wordPages(file.content)));
}

async function withTemporary(work) {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lasso-pages-'));
  try { return await work(temporary); } finally { await fs.promises.rm(temporary, { recursive: true, force: true }); }
}

function wordPages(content) {
  return withTemporary(async (temporary) => {
    const input = path.join(temporary, 'document.docx'), output = path.join(temporary, 'pages.pdf');
    await fs.promises.writeFile(input, content, { mode: 0o600 });
    await execute(await executable(), ['docx', input, output], { timeout: DOCUMENT_TIMEOUT_MS, maxBuffer: 1_000_000 });
    return checkedPdf(await fs.promises.readFile(output));
  });
}

/** Each slide becomes a deck of its own, which Quick Look draws as it draws the first slide of any deck. */
function slidePages(content) {
  const zip = readZip(content);
  const count = zip ? Math.min(slideParts(zip).length, MAX_SLIDES) : 0;
  if (!count) throw new Error('The presentation has no slides to show.');
  return withTemporary(async (temporary) => {
    const slides = [];
    for (let number = 1; number <= count; number += 1) {
      const slide = singleSlidePresentation(content, number);
      const file = path.join(temporary, `slide-${number}.pptx`);
      // A slide that cannot be copied out is still a page, drawn as unavailable.
      await fs.promises.writeFile(file, slide ?? Buffer.alloc(0), { mode: 0o600 });
      slides.push(file);
    }
    const output = path.join(temporary, 'pages.pdf');
    await execute(await executable(), ['slides', output, ...slides],
      { timeout: Math.max(DOCUMENT_TIMEOUT_MS, count * SECONDS_PER_SLIDE * 1000), maxBuffer: 1_000_000 });
    return checkedPdf(await fs.promises.readFile(output));
  });
}
