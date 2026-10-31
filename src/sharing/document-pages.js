// A document as pages to draw on: a PDF as it is, a Word document laid out
// on its paper, and a deck as one picture per slide, drawn by Quick Look.
// The share composer marks these pages up, and a marked copy is the same
// pages with the strokes drawn on, so both must come from here. The suggestion
// card and the share composer show a deck's slides one picture at a time, as
// they are scrolled to, and those are the pictures its pages are made of.
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
// A slide's picture is about 100 KB.
const slidePictures = renderCache({ entries: 600, bytes: 128 * 1024 * 1024 });
const MAX_SLIDES = 120;
// Quick Look draws a slide in about a third of a second, and several at once
// in little more, so slides are drawn in passes of this many.
const SLIDES_PER_PASS = 8;
// A slide asked for is drawn with the ones on either side, which are likely next.
const NEIGHBOURS = 1;
// Passes running at once, each its own Quick Look requests.
const PASSES_AT_ONCE = 2;
const SECONDS_PER_SLIDE = 4;
const DOCUMENT_TIMEOUT_MS = 60_000;
const decks = new WeakMap();
const decksByHash = new Map();
const KEPT_DECKS = 32;

const isWordPath = (filePath) => /\.docx$/i.test(String(filePath ?? ''));

/**
 * The document's pages as a PDF, or null for a file that has none.
 * @param {{path: string, content: Buffer, contentHash?: string}|null} file
 * @returns {Promise<Buffer|null>}
 */
export async function buildPagePdf(file) {
  if (!file || !Buffer.isBuffer(file.content)) return null;
  if (/\.pdf$/i.test(file.path)) return file.content;
  const deck = isPresentationPath(file.path);
  if (!deck && !isWordPath(file.path)) return null;
  const key = crypto.createHash('sha256').update(deck ? 'slides:' : 'docx:').update(file.content).digest('hex');
  return cached(key, () => (deck ? slidePages(file.content, file.contentHash) : wordPages(file.content)));
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

/**
 * A deck's slide count and the key its pictures are kept under, read once per
 * buffer, or once per `contentHash` when the caller knows the content's hash.
 */
function deckOf(content, contentHash = null) {
  let deck = contentHash ? decksByHash.get(contentHash) : decks.get(content);
  if (!deck) {
    const zip = readZip(content);
    deck = { key: contentHash ?? crypto.createHash('sha256').update('slide-pictures:').update(content).digest('hex'),
      count: zip ? slideParts(zip).length : 0 };
    decks.set(content, deck);
    if (contentHash) {
      decksByHash.set(contentHash, deck);
      if (decksByHash.size > KEPT_DECKS) decksByHash.delete(decksByHash.keys().next().value);
    }
  }
  return deck;
}

/** How many slides a deck has, as its pictures count them. */
export function slideCount(content, contentHash = null) {
  return Buffer.isBuffer(content) ? deckOf(content, contentHash).count : 0;
}

let running = 0;
const waiting = [];
async function onePassAtATime(work) {
  if (running >= PASSES_AT_ONCE) await new Promise((resolve) => waiting.push(resolve));
  running += 1;
  try { return await work(); } finally { running -= 1; waiting.shift()?.(); }
}

/**
 * Draws slides in one pass: each becomes a deck of its own, which Quick Look
 * draws as it draws the first slide of any deck. Resolves to each drawn
 * slide's JPEG by number; a slide that could not be drawn is missing.
 */
function drawSlides(content, numbers) {
  return onePassAtATime(() => withTemporary(async (temporary) => {
    const slides = [];
    for (const number of numbers) {
      const slide = singleSlidePresentation(content, number);
      if (!slide) continue;
      const file = path.join(temporary, `slide-${number}.pptx`);
      await fs.promises.writeFile(file, slide, { mode: 0o600 });
      slides.push(file);
    }
    const drawn = new Map();
    if (!slides.length) return drawn;
    await execute(await executable(), ['slide-images', temporary, ...slides],
      { timeout: Math.max(DOCUMENT_TIMEOUT_MS, slides.length * SECONDS_PER_SLIDE * 1000), maxBuffer: 1_000_000 });
    for (const number of numbers) {
      const picture = await fs.promises.readFile(path.join(temporary, `slide-${number}.jpg`)).catch(() => null);
      if (picture?.length) drawn.set(number, picture);
    }
    return drawn;
  }));
}

/** Starts drawing those of `numbers` not kept or drawing already, in passes, and keeps each as it is drawn. */
function drawUnkept(content, numbers, contentHash = null) {
  const { key } = deckOf(content, contentHash);
  const unkept = [...new Set(numbers)].filter((number) => !slidePictures.has(`${key}:${number}`));
  for (let first = 0; first < unkept.length; first += SLIDES_PER_PASS) {
    const pass = unkept.slice(first, first + SLIDES_PER_PASS);
    const drawing = drawSlides(content, pass);
    for (const number of pass) {
      slidePictures(`${key}:${number}`, async () => {
        const picture = (await drawing).get(number);
        if (!picture) throw new Error(`Slide ${number} couldn’t be drawn.`);
        return picture;
      }).catch(() => {});
    }
  }
}

/**
 * Slide `number` of a deck as the JPEG picture Quick Look draws of it: what
 * the card and the share composer show, and the page a marked copy draws on.
 * The slides on either side are drawn with it, so turning to them is quick.
 * @param {Buffer} content the deck
 * @param {number} number counted as PowerPoint shows them
 * @param {string|null} contentHash the deck's content hash, when known
 * @returns {Promise<Buffer>}
 */
export function slidePicture(content, number, contentHash = null) {
  const { key, count } = deckOf(content, contentHash);
  if (!Number.isInteger(number) || number < 1 || number > count) {
    return Promise.reject(new Error('The presentation has no such slide.'));
  }
  const around = Array.from({ length: NEIGHBOURS * 2 + 1 }, (_, index) => number - NEIGHBOURS + index)
    .filter((entry) => entry >= 1 && entry <= count);
  drawUnkept(content, [number, ...around], contentHash);
  return slidePictures(`${key}:${number}`, () => Promise.reject(new Error(`Slide ${number} couldn’t be drawn.`)));
}

/** Every slide as a page, made of the same pictures the card and composer show. */
function slidePages(content, contentHash = null) {
  const count = Math.min(deckOf(content, contentHash).count, MAX_SLIDES);
  if (!count) throw new Error('The presentation has no slides to show.');
  const numbers = Array.from({ length: count }, (_, index) => index + 1);
  drawUnkept(content, numbers, contentHash);
  return withTemporary(async (temporary) => {
    const pictures = await Promise.all(numbers.map((number) => slidePicture(content, number, contentHash).catch(() => null)));
    if (!pictures.some(Boolean)) throw new Error('Quick Look couldn’t draw the slides.');
    const slides = [];
    for (const [index, picture] of pictures.entries()) {
      // A slide that could not be drawn is still a page, drawn as unavailable.
      const file = path.join(temporary, `slide-${index + 1}.jpg`);
      await fs.promises.writeFile(file, picture ?? Buffer.alloc(0), { mode: 0o600 });
      slides.push(file);
    }
    const output = path.join(temporary, 'pages.pdf');
    await execute(await executable(), ['slides', output, ...slides], { timeout: DOCUMENT_TIMEOUT_MS, maxBuffer: 1_000_000 });
    return checkedPdf(await fs.promises.readFile(output));
  });
}
