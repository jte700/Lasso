import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractPortablePdfLayout } from './pdf-portable.js';

const MAX_BYTES = 80_000_000;
const MAX_PAGES = 80;
const MAX_OUTPUT = 24_000_000;
const MAX_CACHE_BYTES = 24_000_000;
const helper = fileURLToPath(new URL('../../scripts/extract-drawing-layout.swift', import.meta.url));
const cache = new Map();
let cacheBytes = 0;
let nativeExecutable;
let nativeBuildDirectory;
const bundledHelper = fileURLToPath(new URL('../../scripts/extract-drawing-layout', import.meta.url));
const NUMBER = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
const AREA = new RegExp(String.raw`\b(${NUMBER})\s*(SF\b|S\.?\s*F\.?\b|SQ\.?\s*(?:FT\.?|FEET)\b|SQUARE\s+FEET\b|FT\s*(?:²|\^2|2\b)|M\s*(?:²|\^2|2\b)|SQ\.?\s*M(?:ET(?:ER|RE)S?)?\.?\b)`, 'gi');
const ROOM = /\b(?:bed\s*room|bedroom|living|dining|kitchen|office|room|bath(?:room)?|restroom|washroom|toilet|WC|closet|storage|store|garage|lobby|vestibule|entry|entrance|corridor|hall(?:way)?|lounge|reception|conference|meeting|classroom|laboratory|lab|utility|laundry|pantry|mechanical|electrical|workshop|studio|suite|den|foyer|porch|deck|patio|balcony|nook|break|janitor|stair(?:s|well)?)\b/i;
const DRAWING_TITLE = /\b(?:floor|site|grading|drainage|utility|foundation|roof|landscape|demolition|framing|plumbing|electrical|civil|architectural|stormwater|servicing)\s+plan\b|\b(?:plan\s*(?:&|and)\s*profile|room\s+(?:area\s+)?schedule|architectural\s+drawings?|civil\s+engineering)\b/i;
const SHEET = /^(?:[ACSLMEPFGT]\s*[-.]?\s*\d{1,3}(?:[.-]\d{1,2})?|[ACSLMEPFGT]{2}[-.]?\d{1,3})$/i;

function clean(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function number(value) { return Number(String(value).replace(/,/g, '')); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function validBox(box) {
  return box && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(box[key]))
    && box.width > 0 && box.height > 0 && box.x >= 0 && box.y >= 0
    && box.x + box.width <= 1.00001 && box.y + box.height <= 1.00001;
}
function union(boxes) {
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  return { x, y, width: Math.max(...boxes.map((box) => box.x + box.width)) - x,
    height: Math.max(...boxes.map((box) => box.y + box.height)) - y };
}

function spatialLines(words, pageWidth, pageHeight) {
  const rows = [];
  for (const word of words.slice(0, 25_000).filter((item) => clean(item.text) && validBox(item.bbox))
    .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)) {
    const cy = word.bbox.y + word.bbox.height / 2;
    const row = rows.slice(-30).find((item) => Math.abs(item.cy - cy) <= Math.min(item.height, word.bbox.height) * 0.4);
    if (row) row.words.push(word);
    else rows.push({ cy, height: word.bbox.height, words: [word] });
  }
  const lines = [];
  for (const row of rows) {
    const sorted = row.words.sort((a, b) => a.bbox.x - b.bbox.x);
    let group = [];
    const finish = () => {
      if (group.length) lines.push({ text: clean(group.map((word) => word.text).join(' ')),
        bbox: union(group.map((word) => word.bbox)), words: group });
      group = [];
    };
    for (const word of sorted) {
      const previous = group.at(-1);
      // Keep independent room labels apart even when they share a text baseline.
      const maxGap = Math.max(0.006, Math.min(word.bbox.height, previous?.bbox.height ?? word.bbox.height) * pageHeight / pageWidth * 2.5);
      if (previous && word.bbox.x - (previous.bbox.x + previous.bbox.width) > maxGap) finish();
      group.push(word);
    }
    finish();
  }
  return lines.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
}

function suitableLabel(value) {
  const text = clean(value).replace(/^[\s:;|,\-]+|[\s:;|,\-]+$/g, '');
  if (text.length < 2 || text.length > 80 || !/[a-z]/i.test(text)
    || /(?:\b(?:scale|total|proposed|existing|maximum|minimum|occupancy|allowable|building|lot|site|gross|net)\b|[=%<>])/.test(text.toLowerCase())) return null;
  return ROOM.test(text) ? text : null;
}

function areaLabel(line, match, lines) {
  const before = line.text.slice(0, match.index).replace(/\b(?:area|approx\.?|approximately)\s*[:=]?\s*$/i, '').trim();
  const after = line.text.slice(match.index + match[0].length).trim();
  const inline = suitableLabel(before) || suitableLabel(after);
  if (inline) return { label: inline, kind: 'room_area', bbox: line.bbox, rawText: line.text, anchor: line.words[0]?.bbox ?? line.bbox, confidence: 0.98 };
  // Multiple values in a line are usually a schedule row with competing columns.
  // A schedule parser must understand those columns before promoting a measurement.
  if ([...line.text.matchAll(new RegExp(AREA))].length !== 1) return null;
  const candidates = lines.filter((other) => {
    if (other === line || !suitableLabel(other.text)) return false;
    const gap = other.bbox.y >= line.bbox.y
      ? other.bbox.y - (line.bbox.y + line.bbox.height)
      : line.bbox.y - (other.bbox.y + other.bbox.height);
    const center = line.bbox.x + line.bbox.width / 2;
    const otherCenter = other.bbox.x + other.bbox.width / 2;
    const aligned = Math.abs(center - otherCenter) <= Math.max(line.bbox.width, other.bbox.width) * 0.6;
    return gap >= -line.bbox.height * 0.2 && gap <= Math.max(line.bbox.height, other.bbox.height) * 2.5 && aligned;
  });
  if (candidates.length === 1) {
    const label = candidates[0];
    return { label: suitableLabel(label.text), kind: 'room_area', bbox: union([label.bbox, line.bbox]),
      rawText: `${label.text}\n${line.text}`, anchor: label.words[0]?.bbox ?? label.bbox, confidence: 0.9 };
  }
  // Explicit general area labels are useful without pretending they describe a room.
  if (!candidates.length && /\barea\b/i.test(before || line.text.slice(0, match.index))) {
    const label = clean(line.text.slice(0, match.index)).replace(/[:=\s]+$/, '');
    if (label.length >= 4 && label.length <= 80) return { label, kind: 'area', bbox: line.bbox,
      rawText: line.text, anchor: line.words[0]?.bbox ?? line.bbox, confidence: 0.98 };
  }
  return null;
}

/** Parse existing page text with normalized top-left word bounding boxes.
 * All promoted measurements have explicit printed units or an explicit elevation
 * marker. No length, area, or label is inferred from a drawing's graphical scale.
 */
export function parseDrawingPage(page = {}) {
  const pageNumber = Number.isInteger(page.pageNumber) && page.pageNumber > 0 ? page.pageNumber : 1;
  const width = Number(page.width) > 0 ? Number(page.width) : 1;
  const height = Number(page.height) > 0 ? Number(page.height) : 1;
  const words = Array.isArray(page.words) ? page.words.filter((word) => validBox(word.bbox)).slice(0, 25_000) : [];
  const lines = spatialLines(words, width, height);
  const text = String(page.text ?? lines.map((line) => line.text).join('\n')).slice(0, 150_000);
  const titleCandidates = lines.filter((line) => DRAWING_TITLE.test(line.text) && line.text.length <= 100);
  const title = titleCandidates.sort((a, b) => (b.bbox.x + b.bbox.y) - (a.bbox.x + a.bbox.y))[0]?.text ?? null;
  const sheetCandidates = words.filter((word) => SHEET.test(clean(word.text)) && (word.bbox.x > 0.7 || word.bbox.y > 0.8));
  const sheetNumber = sheetCandidates.sort((a, b) => (b.bbox.x + b.bbox.y) - (a.bbox.x + a.bbox.y))[0]?.text ?? null;
  const annotations = [];
  const used = new Set();
  const add = (entry, anchor) => {
    const numericValue = Number(entry.numericValue);
    if (!Number.isFinite(numericValue)) return;
    const key = `${pageNumber}|${entry.kind}|${entry.label.toLowerCase()}|${Math.round(anchor.x * 1000)}|${Math.round(anchor.y * 1000)}`;
    const id = `drawing-${hash(key).slice(0, 20)}`;
    if (used.has(id)) return;
    used.add(id);
    annotations.push({ id, pageNumber, sheetNumber, ...entry, numericValue, extractionMethod: 'explicit_text_layout' });
  };
  for (const line of lines) {
    const areas = [...line.text.matchAll(new RegExp(AREA))];
    if (areas.length === 1) for (const match of areas) {
      const label = areaLabel(line, match, lines);
      if (!label) continue;
      const { anchor, ...details } = label;
      const units = /^(?:M|SQ\.?\s*M)/i.test(match[2]) ? 'm²' : 'ft²';
      add({ ...details, value: `${match[1]} ${units}`, numericValue: number(match[1]), units }, anchor);
    }
    const pipeContext = /\b(?:pipe|RCP|PVC|HDPE|DIP|CMP|sewer|culvert|watermain|storm|sanitary)\b/i.test(line.text);
    if (pipeContext) {
      const material = line.text.match(/\b(?:RCP|PVC|HDPE|DIP|CMP)\b/i)?.[0]?.toUpperCase();
      const diameters = [...line.text.matchAll(new RegExp(String.raw`(${NUMBER})\s*(?:["″]|\bIN(?:CH(?:ES)?)?\b|\bMM\b)(?:\s*(?:Ø|DIA(?:METER)?\.?))?`, 'gi'))];
      if (diameters.length === 1) for (const match of diameters) {
        add({ label: `${material ?? 'Pipe'} diameter`, kind: 'pipe_diameter', value: clean(match[0]), numericValue: number(match[1]), units: /\bmm\b/i.test(match[0]) ? 'mm' : 'in', rawText: line.text, bbox: line.bbox, confidence: 0.92 }, line.words[0]?.bbox ?? line.bbox);
      }
      const lengths = [...line.text.matchAll(new RegExp(String.raw`(${NUMBER})\s*(LF\b|L\.?\s*F\.?\b|FT\b|FEET\b|[′']|M\b)(?!\s*(?:²|2\b|\^2))`, 'gi'))];
      if (lengths.length === 1) for (const match of lengths) {
        add({ label: `${material ?? 'Pipe'} length`, kind: 'pipe_length', value: clean(match[0]), numericValue: number(match[1]), units: /^m$/i.test(match[2]) ? 'm' : 'ft', rawText: line.text, bbox: line.bbox, confidence: 0.92 }, line.words[0]?.bbox ?? line.bbox);
      }
    }
    for (const match of line.text.matchAll(new RegExp(String.raw`(?:\b(SLOPE|GRADE|S)\s*[:=]?\s*|(@)\s*)(${NUMBER})\s*%`, 'gi'))) {
      if (!match[1] && !pipeContext) continue;
      add({ label: pipeContext ? 'Pipe slope' : 'Slope', kind: 'slope', value: `${match[3]}%`, numericValue: number(match[3]), units: '%', rawText: line.text, bbox: line.bbox, confidence: 0.96 }, line.words[0]?.bbox ?? line.bbox);
    }
    for (const match of line.text.matchAll(new RegExp(String.raw`\b(ELEV(?:ATION)?\.?|EL\.?|FFE|F\.?F\.?E\.?|INV(?:ERT)?\.?|RIM|T\.?O\.?P\.?)\s*(?:[:=]|\.\s)?\s*(-?${NUMBER})\s*(FT\b|FEET\b|M\b|[′'])?`, 'gi'))) {
      const printedUnit = match[3];
      add({ label: clean(match[1]).replace(/\.$/, '').toUpperCase(), kind: 'elevation', value: clean(match[0]), numericValue: number(match[2]), units: printedUnit ? (/^m$/i.test(printedUnit) ? 'm' : 'ft') : null, rawText: line.text, bbox: line.bbox, confidence: printedUnit ? 0.98 : 0.9, ...(printedUnit ? {} : { warning: 'Elevation units are not printed beside this value; confirm the sheet units.' }) }, line.words[0]?.bbox ?? line.bbox);
    }
  }
  return { pageNumber, width, height, rotation: page.rotation ?? 0, sheetNumber, title, text, words,
    annotations, isDrawing: Boolean(title || annotations.length),
    warnings: text.trim().length < 8 ? ['No usable selectable text; this page may require OCR.'] : [] };
}

function nativeBinary() {
  if (nativeExecutable) return nativeExecutable;
  // Desktop builds ship the executable so indexing never requires a compiler.
  if (fs.existsSync(bundledHelper)) {
    try { fs.accessSync(bundledHelper, fs.constants.X_OK); nativeExecutable = bundledHelper; return nativeExecutable; } catch { /* source fallback */ }
  }
  nativeBuildDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-drawing-helper-'));
  const executable = path.join(nativeBuildDirectory, 'extract-drawing-layout');
  const compiled = spawnSync('/usr/bin/swiftc', ['-O', '-module-cache-path', path.join(nativeBuildDirectory, 'module-cache'), helper, '-o', executable],
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 1_000_000 });
  if (compiled.error || compiled.status !== 0) {
    const error = compiled.error?.message || clean(compiled.stderr).slice(0, 500) || 'PDFKit layout helper could not be compiled.';
    fs.rmSync(nativeBuildDirectory, { recursive: true, force: true });
    throw new Error(error);
  }
  const directory = nativeBuildDirectory;
  process.once('exit', () => { try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* process cleanup */ } });
  nativeExecutable = executable;
  return executable;
}

function decodeXml(value) {
  return value.replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function popplerLayout(input) {
  const result = spawnSync('pdftotext', ['-f', '1', '-l', String(MAX_PAGES), '-bbox-layout', '-cropbox', input, '-'],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: MAX_OUTPUT });
  if (result.error?.code === 'ENOENT') return { unavailable: true };
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? clean(result.stderr).slice(0, 500));
  const pages = [];
  const attr = (source, key) => Number(source.match(new RegExp(`\\b${key}="([^"<>]+)"`))?.[1]);
  for (const match of result.stdout.matchAll(/<page\b([^>]*)>([\s\S]*?)<\/page>/g)) {
    const width = attr(match[1], 'width');
    const height = attr(match[1], 'height');
    if (!(width > 0 && height > 0)) continue;
    const words = [];
    for (const word of match[2].matchAll(/<word\b([^>]*)>([\s\S]*?)<\/word>/g)) {
      const x = attr(word[1], 'xMin') / width;
      const y = attr(word[1], 'yMin') / height;
      words.push({ text: decodeXml(word[2]), bbox: { x, y, width: attr(word[1], 'xMax') / width - x, height: attr(word[1], 'yMax') / height - y } });
    }
    pages.push({ pageNumber: pages.length + 1, width, height, words });
  }
  return { pages, warnings: pages.length >= MAX_PAGES ? [`Only the first ${MAX_PAGES} pages were inspected; this PDF may contain additional sheets.`] : [] };
}

function remember(key, result) {
  // Avoid letting a large plan set hold an unbounded amount of process memory.
  const size = Buffer.byteLength(JSON.stringify(result));
  if (['ready', 'partial', 'ocr_required'].includes(result.status) && size <= MAX_CACHE_BYTES) {
    while (cache.size && (cache.size >= 8 || cacheBytes + size > MAX_CACHE_BYTES)) {
      const oldest = cache.keys().next().value;
      cacheBytes -= cache.get(oldest).size;
      cache.delete(oldest);
    }
    cache.set(key, { result, size });
    cacheBytes += size;
  }
  return structuredClone(result);
}

/** Local deterministic extraction. filePath is informational only: bytes supplied
 * by the caller are always the bytes parsed and hashed for the extraction cache.
 */
export function extractDrawingDocument(buffer, { filePath: _filePath } = {}) {
  const base = { status: 'unsupported', method: null, warnings: [], pages: [], isDrawing: false };
  if (!Buffer.isBuffer(buffer) || !buffer.length || !buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
    return { ...base, warnings: ['Drawing extraction requires a valid PDF file.'] };
  }
  if (buffer.length > MAX_BYTES) return { ...base, warnings: ['PDF exceeds the 80 MB drawing extraction limit.'] };
  const key = hash(buffer);
  if (cache.has(key)) return structuredClone(cache.get(key).result);
  let directory;
  let method;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-drawing-'));
    const input = path.join(directory, 'source.pdf');
    fs.writeFileSync(input, buffer, { flag: 'wx' });
    let layout;
    const runtimeWarnings = [];
    if (process.platform === 'darwin') {
      try {
        const result = spawnSync(nativeBinary(), [input, String(MAX_PAGES)], { encoding: 'utf8', timeout: 30_000, maxBuffer: MAX_OUTPUT });
        if (result.error) throw result.error;
        try { layout = JSON.parse(result.stdout); } catch { throw new Error('PDFKit returned invalid layout data.'); }
        if (result.status !== 0 || layout.error) throw new Error(layout.error ?? 'PDFKit could not extract this PDF.');
        method = 'pdfkit-layout';
      } catch (error) {
        runtimeWarnings.push(`PDFKit: ${error.message}`);
      }
    }
    if (!layout?.pages) {
      try {
        layout = extractPortablePdfLayout(buffer);
        method = 'pdfjs-layout';
      } catch (error) {
        runtimeWarnings.push(`PDF.js: ${error.message}`);
        layout = popplerLayout(input);
        if (layout.unavailable) return remember(key, { ...base, status: 'error', warnings: runtimeWarnings });
        method = 'poppler-layout';
      }
    }
    const pages = layout.pages.map(parseDrawingPage);
    if (!pages.length) return remember(key, { ...base, method, status: 'error', warnings: [...runtimeWarnings, 'No readable PDF pages were found.'] });
    const warnings = [...runtimeWarnings, ...(layout.warnings ?? [])];
    const emptyPages = pages.filter((page) => !page.words.length || page.text.trim().length < 8);
    if (emptyPages.length) warnings.push(`Pages ${emptyPages.map((page) => page.pageNumber).join(', ')} have no usable selectable text and may require OCR.`);
    return remember(key, { status: emptyPages.length === pages.length ? 'ocr_required' : warnings.length ? 'partial' : 'ready',
      method, warnings, pageCount: layout.pageCount ?? pages.length, pages, isDrawing: pages.some((page) => page.isDrawing) });
  } catch (error) {
    return remember(key, { ...base, method: method ?? null, status: 'error', warnings: [`Drawing extraction failed: ${error.message}`] });
  } finally {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
}
