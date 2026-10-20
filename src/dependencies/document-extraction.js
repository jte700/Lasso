import { inflateRawSync, inflateSync } from 'node:zlib';
import path from 'node:path';
import { extractDrawingDocument } from './drawing-extraction.js';
import { builtInNumberFormat, displaySpreadsheetNumber, formatSpreadsheetNumber } from './spreadsheet-number-format.js';

const MAX_PDF_METADATA_BYTES = 32_000_000;
const MAX_PDF_BODY_BYTES = 3_000_000;
const MAX_TEXT_EXCERPT = 20_000;
const MAX_FULL_DOCUMENT_TEXT = 5_000_000;

function decodeXml(value = '') {
  return String(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function cleanText(value, limit = MAX_TEXT_EXCERPT) {
  return decodeXml(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, limit);
}

function readablePdfText(value) {
  const text = String(value ?? '');
  if (text.length < 2 || text.length > 700) return false;
  const ascii = [...text].filter((character) => /[\x20-\x7e]/.test(character)).length / text.length;
  const letters = [...text].filter((character) => /[A-Za-z]/.test(character)).length / text.length;
  return ascii >= 0.9 && letters >= 0.2 && (text.length < 45 || /\s/.test(text));
}

function usefulPdfExcerpt(value) {
  const tokens = String(value ?? '').match(/[A-Za-z]+/g) ?? [];
  if (tokens.length < 4) return false;
  return tokens.filter((token) => token.length >= 3).length / tokens.length >= 0.45;
}

function decodePdfBytes(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const output = [];
    for (let index = 2; index + 1 < bytes.length; index += 2) output.push(String.fromCharCode((bytes[index] << 8) | bytes[index + 1]));
    return output.join('');
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return Buffer.from(bytes.slice(2)).toString('utf16le');
  return Buffer.from(bytes).toString('latin1');
}

function pdfLiteralAt(source, start) {
  if (source[start] !== '(') return null;
  const bytes = [];
  let depth = 1;
  let index = start + 1;
  for (; index < source.length && depth > 0; index += 1) {
    const character = source[index];
    if (character === '\\') {
      const next = source[++index];
      if (next == null) break;
      if (next === '\n') continue;
      if (next === '\r') { if (source[index + 1] === '\n') index += 1; continue; }
      const escaped = { n: 10, r: 13, t: 9, b: 8, f: 12 }[next];
      if (escaped != null) { bytes.push(escaped); continue; }
      if (/[0-7]/.test(next)) {
        let octal = next;
        while (octal.length < 3 && /[0-7]/.test(source[index + 1] ?? '')) octal += source[++index];
        bytes.push(Number.parseInt(octal, 8));
        continue;
      }
      bytes.push(next.charCodeAt(0) & 0xff);
      continue;
    }
    if (character === '(') { depth += 1; bytes.push(40); continue; }
    if (character === ')') {
      depth -= 1;
      if (depth > 0) bytes.push(41);
      continue;
    }
    bytes.push(character.charCodeAt(0) & 0xff);
  }
  return depth === 0 ? { value: cleanText(decodePdfBytes(bytes)), bytes, end: index } : null;
}

function pdfHexAt(source, start) {
  if (source[start] !== '<' || source[start + 1] === '<') return null;
  const end = source.indexOf('>', start + 1);
  if (end < 0) return null;
  let hex = source.slice(start + 1, end).replace(/\s+/g, '');
  if (!/^[0-9a-f]*$/i.test(hex)) return null;
  if (hex.length % 2) hex += '0';
  return { value: cleanText(decodePdfBytes([...Buffer.from(hex, 'hex')])), end: end + 1 };
}

function pdfProperty(source, name) {
  const pattern = new RegExp(`/${name}\\b`, 'gi');
  let match;
  let value = null;
  while ((match = pattern.exec(source))) {
    let index = pattern.lastIndex;
    while (/\s/.test(source[index] ?? '')) index += 1;
    const parsed = pdfLiteralAt(source, index) ?? pdfHexAt(source, index);
    if (parsed?.value) value = parsed.value;
  }
  return value;
}

function xmlBlock(source, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i'))?.[1] ?? '';
}

function xmlItems(source, tag) {
  const block = xmlBlock(source, tag);
  const items = [...block.matchAll(/<rdf:li\b[^>]*>([\s\S]*?)<\/rdf:li>/gi)]
    .map((match) => cleanText(match[1])).filter(Boolean);
  if (items.length) return items;
  const direct = cleanText(block);
  return direct ? [direct] : [];
}

function unicodeFromHex(value) {
  const bytes = Buffer.from(String(value).replace(/\s+/g, ''), 'hex');
  if (!bytes.length) return '';
  if (bytes.length % 2) return cleanText(bytes.toString('latin1'));
  const characters = [];
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    characters.push(String.fromCharCode((bytes[index] << 8) | bytes[index + 1]));
  }
  return characters.join('');
}

function pdfUnicodeMap(content) {
  if (!/beginbf(?:char|range)/.test(content)) return null;
  const map = new Map();
  for (const block of content.matchAll(/beginbfchar([\s\S]*?)endbfchar/gi)) {
    for (const match of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi)) {
      map.set(match[1].toUpperCase(), unicodeFromHex(match[2]));
    }
  }
  for (const block of content.matchAll(/beginbfrange([\s\S]*?)endbfrange/gi)) {
    for (const match of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi)) {
      const start = Number.parseInt(match[1], 16);
      const end = Number.parseInt(match[2], 16);
      const unicodeStart = Number.parseInt(match[3], 16);
      const width = match[1].length;
      if (unicodeStart > 0x10ffff) continue;
      for (let code = start; code <= end && code - start < 2048; code += 1) {
        const unicode = unicodeStart + code - start;
        if (unicode > 0x10ffff) break;
        map.set(code.toString(16).toUpperCase().padStart(width, '0'), String.fromCodePoint(unicode));
      }
    }
    for (const match of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*\[([^\]]+)]/gi)) {
      const start = Number.parseInt(match[1], 16);
      const end = Number.parseInt(match[2], 16);
      const width = match[1].length;
      const values = [...match[3].matchAll(/<([0-9a-f]+)>/gi)].map((item) => unicodeFromHex(item[1]));
      for (let code = start; code <= end && code - start < values.length; code += 1) {
        map.set(code.toString(16).toUpperCase().padStart(width, '0'), values[code - start]);
      }
    }
  }
  const keyLengths = [...new Set([...map.keys()].map((key) => key.length))].sort((left, right) => right - left);
  return map.size ? { map, keyLengths } : null;
}

function decodePdfHexText(hex, unicodeMaps) {
  const source = String(hex).replace(/\s+/g, '').toUpperCase();
  let best = null;
  for (const unicodeMap of unicodeMaps) {
    let output = '';
    let mapped = 0;
    let position = 0;
    while (position < source.length) {
      let value = null;
      let consumed = 0;
      for (const length of unicodeMap.keyLengths) {
        const key = source.slice(position, position + length);
        if (key.length === length && unicodeMap.map.has(key)) {
          value = unicodeMap.map.get(key);
          consumed = length;
          break;
        }
      }
      if (!consumed) { position += 2; continue; }
      output += value;
      mapped += consumed;
      position += consumed;
    }
    const letters = output.match(/[A-Za-z]/g)?.length ?? 0;
    const score = mapped / Math.max(1, source.length) + letters / Math.max(1, output.length);
    if (output && (!best || score > best.score)) best = { output, score };
  }
  if (best?.score >= 0.55) return cleanText(best.output, 2000);
  const direct = decodePdfBytes([...Buffer.from(source, 'hex')]);
  return readablePdfText(direct) ? cleanText(direct, 2000) : '';
}

function pdfObjects(buffer) {
  const scan = buffer.subarray(0, Math.min(buffer.length, MAX_PDF_BODY_BYTES));
  const source = scan.toString('latin1');
  const starts = [...source.matchAll(/(?:^|[\r\n])\s*(\d+)\s+\d+\s+obj\b/g)];
  const objects = new Map();
  for (const [index, match] of starts.entries()) {
    const start = match.index + match[0].length;
    const boundary = index + 1 < starts.length ? starts[index + 1].index : source.length;
    const end = source.lastIndexOf('endobj', boundary);
    if (end < start) continue;
    const body = source.slice(start, end);
    const marker = body.indexOf('stream');
    let decoded = null;
    if (marker >= 0) {
      const absoluteMarker = start + marker;
      const streamStart = source[absoluteMarker + 6] === '\r' && source[absoluteMarker + 7] === '\n'
        ? absoluteMarker + 8 : absoluteMarker + 7;
      const streamEnd = source.indexOf('endstream', streamStart);
      if (streamEnd > streamStart) {
        decoded = scan.subarray(streamStart, streamEnd);
        try {
          if (/\/FlateDecode\b/.test(body.slice(0, marker))) {
            try { decoded = inflateSync(decoded, { maxOutputLength: 2_000_000 }); }
            catch { decoded = inflateRawSync(decoded, { maxOutputLength: 2_000_000 }); }
          } else if (/\/Filter\b/.test(body.slice(0, marker))) decoded = null;
        } catch { decoded = null; }
      }
    }
    objects.set(match[1], { body, stream: decoded?.subarray(0, 1_000_000).toString('latin1') ?? null });
  }
  return objects;
}

function fontReferences(resourceBody, objects) {
  let fontBody = resourceBody.match(/\/Font\s*<<([\s\S]*?)>>/)?.[1] ?? '';
  const indirect = resourceBody.match(/\/Font\s+(\d+)\s+0\s+R/);
  if (!fontBody && indirect) fontBody = objects.get(indirect[1])?.body ?? '';
  return new Map([...fontBody.matchAll(/\/([^\s/<>()\[\]]+)\s+(\d+)\s+0\s+R/g)]
    .map((match) => [match[1], match[2]]));
}

function pageFonts(pageId, objects, visited = new Set()) {
  if (!pageId || visited.has(pageId)) return new Map();
  visited.add(pageId);
  const body = objects.get(pageId)?.body ?? '';
  const resourceReference = body.match(/\/Resources\s+(\d+)\s+0\s+R/)?.[1];
  const resources = resourceReference ? objects.get(resourceReference)?.body ?? '' : body;
  const fonts = fontReferences(resources, objects);
  if (fonts.size) return fonts;
  return pageFonts(body.match(/\/Parent\s+(\d+)\s+0\s+R/)?.[1], objects, visited);
}

function contentReferences(pageBody) {
  const block = pageBody.match(/\/Contents\s*\[([^\]]+)]/)?.[1];
  if (block) return [...block.matchAll(/(\d+)\s+0\s+R/g)].map((match) => match[1]);
  const single = pageBody.match(/\/Contents\s+(\d+)\s+0\s+R/);
  return single ? [single[1]] : [];
}

function decodePdfOperand(operand, unicodeMap) {
  const maps = unicodeMap ? [unicodeMap] : [];
  if (operand.startsWith('<')) return decodePdfHexText(operand.slice(1, -1), maps);
  if (operand.startsWith('(')) {
    const parsed = pdfLiteralAt(operand, 0);
    return unicodeMap && parsed?.bytes
      ? decodePdfHexText(Buffer.from(parsed.bytes).toString('hex'), maps)
      : parsed?.value ?? '';
  }
  if (!operand.startsWith('[')) return '';
  const output = [];
  for (let index = 1; index < operand.length - 1;) {
    while (/\s/.test(operand[index] ?? '')) index += 1;
    if (operand[index] === '(') {
      const parsed = pdfLiteralAt(operand, index);
      if (!parsed) { index += 1; continue; }
      output.push(unicodeMap && parsed.bytes
        ? decodePdfHexText(Buffer.from(parsed.bytes).toString('hex'), maps)
        : parsed.value);
      index = parsed.end;
    } else if (operand[index] === '<') {
      const parsed = pdfHexAt(operand, index);
      if (!parsed) { index += 1; continue; }
      output.push(decodePdfHexText(operand.slice(index + 1, parsed.end - 1), maps));
      index = parsed.end;
    } else {
      const number = operand.slice(index).match(/^-?\d+(?:\.\d+)?/)?.[0];
      if (!number) { index += 1; continue; }
      if (Number(number) <= -150) output.push(' ');
      index += number.length;
    }
  }
  return cleanText(output.join(''), 4000);
}

function textFromPdfContent(content, fonts, unicodeByFont) {
  const output = [];
  let currentFont = null;
  const token = /\/([^\s/]+)\s+[-+]?\d+(?:\.\d+)?\s+Tf|(\((?:\\[\s\S]|[^\\)])*\)|<[0-9a-f\s]+>|\[(?:[^\]]|\](?!\s*TJ))*\])\s*(?:Tj|TJ)/gi;
  for (const match of content.matchAll(token)) {
    if (match[1]) { currentFont = match[1]; continue; }
    const unicodeMap = unicodeByFont.get(fonts.get(currentFont));
    const decoded = decodePdfOperand(match[2], unicodeMap);
    if (decoded) output.push(decoded);
  }
  return output.join(' ');
}

function structuredPdfPages(buffer) {
  const objects = pdfObjects(buffer);
  const unicodeByObject = new Map();
  for (const [objectId, object] of objects) {
    const unicodeReference = object.body.match(/\/ToUnicode\s+(\d+)\s+0\s+R/)?.[1];
    if (!unicodeReference) continue;
    const unicodeMap = pdfUnicodeMap(objects.get(unicodeReference)?.stream ?? '');
    if (unicodeMap) unicodeByObject.set(objectId, unicodeMap);
  }
  const pages = [];
  for (const [pageId, page] of objects) {
    if (!/\/Type\s*\/Page\b/.test(page.body)) continue;
    const fonts = pageFonts(pageId, objects);
    const output = [];
    for (const contentId of contentReferences(page.body)) {
      const content = objects.get(contentId)?.stream;
      if (!content) continue;
      const text = textFromPdfContent(content, fonts, unicodeByObject);
      if (text) output.push(text);
    }
    pages.push({ pageNumber: pages.length + 1, text: output.join(' '), words: [] });
  }
  return pages;
}

function structuredPdfText(buffer, limit = MAX_TEXT_EXCERPT) {
  return cleanText(structuredPdfPages(buffer).map(page => page.text).join(' '), limit);
}

function pdfTextFromStreams(buffer, acceptAny = false, limit = MAX_TEXT_EXCERPT) {
  const structured = structuredPdfText(buffer, limit);
  if (usefulPdfExcerpt(structured)) return structured;
  const scan = buffer.subarray(0, Math.min(buffer.length, MAX_PDF_BODY_BYTES));
  const source = scan.toString('latin1');
  const decodedStreams = [];
  const output = [];
  let position = 0;
  let streamCount = 0;
  let outputLength = 0;
  while (position < source.length && streamCount < 240) {
    const marker = source.indexOf('stream', position);
    if (marker < 0) break;
    const lineEnd = source[marker + 6] === '\r' && source[marker + 7] === '\n' ? marker + 8
      : source[marker + 6] === '\n' || source[marker + 6] === '\r' ? marker + 7 : -1;
    if (lineEnd < 0) { position = marker + 6; continue; }
    const end = source.indexOf('endstream', lineEnd);
    if (end < 0) break;
    const dictionary = source.slice(Math.max(0, marker - 1500), marker);
    let decoded = scan.subarray(lineEnd, end);
    try {
      if (/\/FlateDecode\b/.test(dictionary)) {
        try { decoded = inflateSync(decoded, { maxOutputLength: 2_000_000 }); }
        catch { decoded = inflateRawSync(decoded, { maxOutputLength: 2_000_000 }); }
      } else if (/\/Filter\b/.test(dictionary)) {
        position = end + 9;
        continue;
      }
    } catch { position = end + 9; continue; }
    decodedStreams.push(decoded.subarray(0, 1_000_000).toString('latin1'));
    streamCount += 1;
    position = end + 9;
  }
  const unicodeMaps = decodedStreams.map(pdfUnicodeMap).filter(Boolean);
  for (const content of decodedStreams) {
    if (!/\b(?:BT|Tj|TJ)\b/.test(content)) continue;
    for (let index = 0; index < content.length && outputLength < limit; index += 1) {
      if (content[index] !== '(') continue;
      const parsed = pdfLiteralAt(content, index);
      if (!parsed) continue;
      index = parsed.end - 1;
      if (readablePdfText(parsed.value)) { output.push(parsed.value); outputLength += parsed.value.length + 1; }
    }
    for (const match of content.matchAll(/<([0-9a-f\s]{4,})>/gi)) {
      if (outputLength >= limit) break;
      const decoded = decodePdfHexText(match[1], unicodeMaps);
      if (!decoded) continue;
      output.push(decoded);
      outputLength += decoded.length + 1;
    }
  }
  const result = cleanText(output.join(' '), limit);
  return acceptAny || usefulPdfExcerpt(result) ? result : '';
}

export function extractPdfFullText(buffer) {
  // The local PDF engine understands compressed object streams and font
  // encodings that cannot be decoded reliably by scanning PDF syntax.
  const layout = extractDrawingDocument(buffer);
  const text = layout.pages.map(page => page.text).filter(Boolean).join('\n\n');
  const fallback = pdfTextFromStreams(buffer, true, MAX_FULL_DOCUMENT_TEXT);
  // Some PDFs place selectable text outside the crop box. Keep that text when
  // the syntax decoder can read it, rather than silently dropping sentences.
  if (usefulPdfExcerpt(fallback) && fallback.length > text.length * 1.3) return fallback;
  return text.trim() ? text.slice(0, MAX_FULL_DOCUMENT_TEXT) : fallback;
}

/** Selectable PDF passages retain the page on which their source text occurs. */
export function extractPdfPassages(buffer) {
  const layout = extractDrawingDocument(buffer);
  const fallback = structuredPdfPages(buffer);
  const pages = layout.pages.some(page => page.text?.trim()) ? layout.pages.map(page => {
    const syntax = fallback.find(entry => entry.pageNumber === page.pageNumber);
    return syntax?.text.length > String(page.text ?? '').length * 1.3 ? { ...page, text: syntax.text } : page;
  }) : fallback;
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  const passages = [];
  const maximum = 2000;
  for (const page of pages) {
    const text = String(page.text ?? '').replace(/\r\n/g, '\n');
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) continue;
    const wordLocations = [];
    let wordCursor = 0;
    for (const word of page.words ?? []) {
      const value = String(word.text ?? '').replace(/\s+/g, ' ').trim();
      const start = value ? normalized.indexOf(value, wordCursor) : -1;
      if (start < 0) continue;
      wordLocations.push({ start, end: start + value.length, bbox: word.bbox });
      wordCursor = start + value.length;
    }
    const add = (value, excerptType, start) => {
      const selectedText = value.replace(/\s+/g, ' ').trim();
      if (selectedText.length < 18 || selectedText.length > 1600 || (selectedText.match(/\p{L}+/gu)?.length ?? 0) < 4) return;
      const end = start + selectedText.length;
      const boxes = wordLocations.filter(word => word.start < end && word.end > start).map(word => word.bbox).filter(Boolean);
      const x = boxes.length ? Math.min(...boxes.map(box => box.x)) : 0;
      const y = boxes.length ? Math.min(...boxes.map(box => box.y)) : 0;
      const bbox = boxes.length ? { x, y,
        width: Math.max(...boxes.map(box => box.x + box.width)) - x,
        height: Math.max(...boxes.map(box => box.y + box.height)) - y } : null;
      passages.push({ excerptType, pageNumber: page.pageNumber, selectedText, start, end, bbox });
    };
    // Blank lines are hard paragraph boundaries. Short standalone headings
    // also start a new block, while lowercase wrapped continuations stay joined.
    const blocks = [];
    let current = [];
    const flush = () => { if (current.length) blocks.push(current.join(' ')); current = []; };
    const lines = text.split('\n').map(line => line.trim());
    let lineCursor = 0;
    let previousBox = null;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) { flush(); continue; }
      const lineStart = normalized.indexOf(line, lineCursor);
      const lineEnd = lineStart + line.length;
      const boxes = wordLocations.filter(word => word.start < lineEnd && word.end > lineStart).map(word => word.bbox).filter(Boolean);
      const lineBox = boxes.length ? { x: Math.min(...boxes.map(box => box.x)), y: Math.min(...boxes.map(box => box.y)),
        bottom: Math.max(...boxes.map(box => box.y + box.height)), height: Math.max(...boxes.map(box => box.height)) } : null;
      if (lineStart >= 0) lineCursor = lineEnd;
      if (previousBox && lineBox && (lineBox.y - previousBox.bottom > Math.max(previousBox.height, lineBox.height) * 0.75
        || lineBox.y < previousBox.y - previousBox.height * 0.5)) flush();
      previousBox = lineBox;
      const next = lines[index + 1] ?? '';
      const shortHeading = !/[.!?:;]$/.test(line) && !/\b(?:a|an|and|as|at|by|for|from|in|is|of|on|or|the|to|with)$/i.test(line)
        && (line.split(/\s+/).length <= 5 || /^[^a-z]+$/.test(line)) && /^[A-Z]/.test(next);
      if (shortHeading) { flush(); blocks.push(line); }
      else current.push(line);
    }
    flush();
    let blockCursor = 0;
    for (const block of blocks) {
      const blockStart = normalized.indexOf(block, blockCursor);
      if (blockStart < 0) continue;
      blockCursor = blockStart + block.length;
      const sentences = [...segmenter.segment(block)].map(part => ({ text: part.segment.trim(), start: blockStart + part.index
        + (part.segment.match(/^\s*/)?.[0].length ?? 0) }));
      let paragraph = '';
      let paragraphStart = blockStart;
      for (const sentence of sentences) {
        if (sentence.text.length <= 420) add(sentence.text, 'sentence', sentence.start);
        if (paragraph && paragraph.length + sentence.text.length > 1400) {
          add(paragraph, 'paragraph', paragraphStart); paragraph = '';
        }
        if (!paragraph) paragraphStart = sentence.start;
        paragraph += `${paragraph ? ' ' : ''}${sentence.text}`;
      }
      // One-sentence paragraphs already have a precise sentence object.
      if (paragraph && (sentences.length > 1 || paragraph.length > 420)) add(paragraph, 'paragraph', paragraphStart);
      if (passages.length >= maximum) return passages.slice(0, maximum);
    }
  }
  return passages;
}

function pdfScanSource(buffer) {
  if (buffer.length <= MAX_PDF_METADATA_BYTES) return buffer.toString('latin1');
  return Buffer.concat([
    buffer.subarray(0, 8_000_000), Buffer.from('\n'), buffer.subarray(buffer.length - 12_000_000),
  ]).toString('latin1');
}

function publicationYear(...values) {
  for (const value of values) {
    const year = String(value ?? '').match(/\b(?:19|20)\d{2}\b/)?.[0];
    if (year) return year;
  }
  return null;
}

function doiFrom(...values) {
  for (const value of values) {
    const doi = String(value ?? '').match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i)?.[0]
      ?.replace(/[.,;:)]+$/, '');
    if (doi) return doi;
  }
  return null;
}

export function extractPdfDocument(buffer) {
  const source = pdfScanSource(buffer);
  const xmpAuthors = xmlItems(source, 'dc:creator');
  const informationAuthor = pdfProperty(source, 'Author');
  const authors = xmpAuthors.length ? xmpAuthors
    : String(informationAuthor ?? '').split(/\s*(?:;|\band\b)\s*/i).map((item) => cleanText(item)).filter(Boolean);
  const title = xmlItems(source, 'dc:title')[0] ?? pdfProperty(source, 'Title');
  const subject = xmlItems(source, 'dc:description')[0] ?? pdfProperty(source, 'Subject');
  const keywords = pdfProperty(source, 'Keywords');
  const bodyText = extractPdfFullText(buffer);
  const creationDate = pdfProperty(source, 'CreationDate');
  const doi = pdfProperty(source, 'doi') ?? doiFrom(subject, keywords, source.slice(-200_000), bodyText);
  return {
    authors,
    author: authors.join(' and ') || informationAuthor || null,
    title: title || null,
    subject: subject || null,
    year: publicationYear(subject, title, bodyText, creationDate),
    doi,
    keywords: keywords || null,
    textExcerpt: cleanText([title, subject, keywords, bodyText].filter(Boolean).join(' ')),
    extraction: bodyText ? 'PDF_METADATA_AND_TEXT' : 'PDF_METADATA',
  };
}

function zipEntry(buffer, requestedName) {
  const minimum = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let index = buffer.length - 22; index >= minimum; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) return null;
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let entry = 0; entry < count && offset + 46 <= buffer.length; entry += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) return null;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');
    if (name === requestedName && localOffset + 30 <= buffer.length && buffer.readUInt32LE(localOffset) === 0x04034b50) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.subarray(start, start + compressedSize);
      if (method === 0) return compressed;
      if (method === 8) return inflateRawSync(compressed, { maxOutputLength: 5_000_000 });
      return null;
    }
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return null;
}

function coreProperty(source, name) {
  const block = xmlBlock(source, name);
  return cleanText(block) || null;
}

export function extractDocxDocument(buffer) {
  try {
    const documentXml = zipEntry(buffer, 'word/document.xml')?.toString('utf8') ?? '';
    // A password-protected or damaged .docx has no readable document part.
    if (!documentXml) throw new Error('The document part is missing.');
    const coreXml = zipEntry(buffer, 'docProps/core.xml')?.toString('utf8') ?? '';
    const structured = documentXml.replace(/<w:tab\b[^>]*\/>/gi, '\t')
      .replace(/<w:br\b[^>]*\/>/gi, '\n').replace(/<\/w:p>/gi, '\n');
    const text = [...structured.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi)]
      .map((match) => decodeXml(match[1])).join(' ').replace(/\s+\n/g, '\n');
    const title = coreProperty(coreXml, 'dc:title') || cleanText(text.split('\n').find(Boolean) ?? '', 300);
    const author = coreProperty(coreXml, 'dc:creator');
    const subject = coreProperty(coreXml, 'dc:subject');
    const keywords = coreProperty(coreXml, 'cp:keywords');
    const created = coreProperty(coreXml, 'dcterms:created');
    return {
      authors: author ? [author] : [], author, title: title || null, subject,
      year: publicationYear(subject, title, text, created),
      doi: doiFrom(subject, keywords, text), keywords,
      textExcerpt: cleanText(text), extraction: 'DOCX_OOXML',
    };
  } catch {
    return { authors: [], author: null, title: null, subject: null, year: null, doi: null, keywords: null, textExcerpt: '', extraction: 'DOCX_UNREADABLE' };
  }
}

export function extractDocxFullText(buffer) {
  try {
    const documentXml = zipEntry(buffer, 'word/document.xml')?.toString('utf8') ?? '';
    const structured = documentXml.replace(/<w:tab\b[^>]*\/>/gi, '\t')
      .replace(/<w:br\b[^>]*\/>/gi, '\n').replace(/<\/w:p>/gi, '\n');
    const text = [...structured.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi)]
      .map((match) => decodeXml(match[1])).join(' ').replace(/\s+\n/g, '\n');
    return cleanText(text, MAX_FULL_DOCUMENT_TEXT);
  } catch {
    return '';
  }
}

function spreadsheetColumnIndex(reference = '') {
  const letters = String(reference).match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? '';
  let value = 0;
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
  return Math.max(0, value - 1);
}

// SpreadsheetML allows a default namespace or any explicit namespace prefix.
// Match the qualified closing tag and consume empty elements independently, so
// a styled <c/> cannot steal the value from the next populated cell.
function spreadsheetElements(source, name) {
  const pattern = new RegExp(`<((?:[A-Za-z_][\\w.-]*:)?${name})(?=[\\s/>])((?:[^"'<>]|"[^"]*"|'[^']*')*?)(?:/\\s*>|>([\\s\\S]*?)<\\/\\1\\s*>)`, 'gi');
  return [...String(source).matchAll(pattern)].map(match => ({ attributes: match[2], content: match[3] ?? '' }));
}

function spreadsheetAttribute(xml, name) {
  const qualified = name.includes(':') ? `(?:[A-Za-z_][\\w.-]*:)?${name.split(':').pop()}` : name;
  return decodeXml(String(xml).match(new RegExp(`(?:^|\\s)${qualified}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'))?.[2] ?? '');
}

function spreadsheetStrings(source = '') {
  return spreadsheetElements(source, 'si').map(item => spreadsheetElements(item.content, 't')
    .map(part => decodeXml(part.content)).join(''));
}

/** Each cell style's number format, and whether dates count from 1904. */
function spreadsheetNumberFormats(stylesXml = '', workbookXml = '') {
  const custom = new Map(spreadsheetElements(stylesXml, 'numFmt').map(({ attributes }) =>
    [Number(spreadsheetAttribute(attributes, 'numFmtId')), spreadsheetAttribute(attributes, 'formatCode')]));
  // Cell styles are the <xf> entries of <cellXfs>, not of <cellStyleXfs>.
  const cellXfs = String(stylesXml).match(/<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/i)?.[1] ?? '';
  const styles = spreadsheetElements(cellXfs, 'xf').map(({ attributes }) => {
    const id = Number(spreadsheetAttribute(attributes, 'numFmtId') || 0);
    return custom.get(id) ?? builtInNumberFormat(id);
  });
  const date1904 = /<(?:\w+:)?workbookPr\b[^>]*\bdate1904\s*=\s*["'](?:1|true)["']/i.test(workbookXml);
  return { styles, date1904 };
}

/** How the sheet shows a number or boolean cell, when that differs from its value. */
function spreadsheetCellDisplay(type, raw, format, formats, value) {
  if (type === 'b') return raw.trim() === '1' ? 'TRUE' : raw.trim() === '0' ? 'FALSE' : null;
  if ((type && type !== 'n') || !formats) return null;
  const shown = displaySpreadsheetNumber(raw, format);
  return shown != null && shown !== value ? shown : null;
}

/**
 * Reads a worksheet's non-empty rows. `displayRows`, when given, receives the
 * text each number cell shows in the sheet (such as $129,950) for previews;
 * the returned values stay the stored numbers that Lasso indexes and inserts.
 */
function spreadsheetRows(source = '', sharedStrings = [], rowNumbers = null, formats = null, displayRows = null) {
  const rows = [];
  let fallbackRow = 1;
  for (const rowElement of spreadsheetElements(source, 'row')) {
    const row = [];
    const shownRow = [];
    const rowNumber = Number(spreadsheetAttribute(rowElement.attributes, 'r') || fallbackRow);
    fallbackRow = rowNumber + 1;
    let fallbackColumn = 0;
    for (const cell of spreadsheetElements(rowElement.content, 'c')) {
      const reference = spreadsheetAttribute(cell.attributes, 'r');
      const column = reference ? spreadsheetColumnIndex(reference) : fallbackColumn;
      const type = spreadsheetAttribute(cell.attributes, 't');
      const raw = decodeXml(spreadsheetElements(cell.content, 'v')[0]?.content ?? '');
      const inline = spreadsheetElements(cell.content, 't').map(part => decodeXml(part.content)).join('');
      const numeric = !type || type === 'n';
      const format = formats?.styles[Number(spreadsheetAttribute(cell.attributes, 's') || 0)] ?? null;
      const formatted = numeric && formats ? formatSpreadsheetNumber(raw, format, formats) : null;
      const value = type === 's' && raw.trim() ? sharedStrings[Number(raw)] ?? raw
        : type === 'inlineStr' || inline ? inline : formatted ?? raw;
      row[column] = cleanText(value, 2_000);
      if (displayRows && !inline) {
        const shown = spreadsheetCellDisplay(type, raw, format, formats, row[column]);
        if (shown != null) shownRow[column] = shown;
      }
      fallbackColumn = column + 1;
    }
    if (row.some((value) => String(value ?? '').trim())) {
      rowNumbers?.push(rowNumber);
      rows.push(row);
      displayRows?.push(shownRow);
    }
  }
  return rows;
}

const COMPOUND_SIGNATURE = Buffer.from('d0cf11e0a1b11ae1', 'hex');
const COMPOUND_END_OF_CHAIN = 0xfffffffe;
const COMPOUND_FREE_SECTOR = 0xffffffff;

function compoundWorkbookStream(buffer) {
  if (buffer.length < 512 || !buffer.subarray(0, 8).equals(COMPOUND_SIGNATURE)) return null;
  const sectorSize = 2 ** buffer.readUInt16LE(30);
  const miniSectorSize = 2 ** buffer.readUInt16LE(32);
  if (![512, 4096].includes(sectorSize) || miniSectorSize !== 64) return null;
  const fatSectorCount = buffer.readUInt32LE(44);
  const firstDirectorySector = buffer.readUInt32LE(48);
  const miniStreamCutoff = buffer.readUInt32LE(56);
  const firstMiniFatSector = buffer.readUInt32LE(60);
  const miniFatSectorCount = buffer.readUInt32LE(64);
  const firstDifatSector = buffer.readUInt32LE(68);
  const difatSectorCount = buffer.readUInt32LE(72);
  const sector = (index) => {
    const start = (index + 1) * sectorSize;
    return start >= sectorSize && start + sectorSize <= buffer.length
      ? buffer.subarray(start, start + sectorSize) : null;
  };
  const fatSectorIds = [];
  for (let index = 0; index < 109; index += 1) {
    const value = buffer.readUInt32LE(76 + index * 4);
    if (value !== COMPOUND_FREE_SECTOR) fatSectorIds.push(value);
  }
  let difatSector = firstDifatSector;
  for (let chainIndex = 0; chainIndex < difatSectorCount && difatSector < 0xfffffffa; chainIndex += 1) {
    const data = sector(difatSector);
    if (!data) break;
    for (let index = 0; index < sectorSize / 4 - 1; index += 1) {
      const value = data.readUInt32LE(index * 4);
      if (value !== COMPOUND_FREE_SECTOR) fatSectorIds.push(value);
    }
    difatSector = data.readUInt32LE(sectorSize - 4);
  }
  const fat = [];
  for (const fatSectorId of fatSectorIds.slice(0, fatSectorCount)) {
    const data = sector(fatSectorId);
    if (!data) continue;
    for (let offset = 0; offset < data.length; offset += 4) fat.push(data.readUInt32LE(offset));
  }
  const readChain = (startSector, expectedSize = null, allocationTable = fat, readAllocatedSector = sector) => {
    const parts = [];
    const visited = new Set();
    let current = startSector;
    while (current < 0xfffffffa && current < allocationTable.length && !visited.has(current)) {
      visited.add(current);
      const data = readAllocatedSector(current);
      if (!data) break;
      parts.push(data);
      current = allocationTable[current];
      if (parts.length > 1_000_000) break;
    }
    const output = Buffer.concat(parts);
    return expectedSize == null ? output : output.subarray(0, expectedSize);
  };
  const directory = readChain(firstDirectorySector);
  const entries = [];
  for (let offset = 0; offset + 128 <= directory.length; offset += 128) {
    const nameLength = directory.readUInt16LE(offset + 64);
    if (nameLength < 2 || nameLength > 64) continue;
    const name = directory.subarray(offset, offset + nameLength - 2).toString('utf16le');
    const type = directory[offset + 66];
    const startSector = directory.readUInt32LE(offset + 116);
    const size = Number(directory.readBigUInt64LE(offset + 120));
    entries.push({ name, type, startSector, size });
  }
  const workbook = entries.find((entry) => entry.type === 2 && /^(?:Workbook|Book)$/i.test(entry.name));
  if (!workbook) return null;
  if (workbook.size >= miniStreamCutoff) return readChain(workbook.startSector, workbook.size);
  const root = entries.find((entry) => entry.type === 5);
  if (!root) return null;
  const miniStream = readChain(root.startSector, root.size);
  const miniFatBuffer = firstMiniFatSector === COMPOUND_END_OF_CHAIN
    ? Buffer.alloc(0) : readChain(firstMiniFatSector, miniFatSectorCount * sectorSize);
  const miniFat = [];
  for (let offset = 0; offset + 4 <= miniFatBuffer.length; offset += 4) miniFat.push(miniFatBuffer.readUInt32LE(offset));
  const miniSector = (index) => {
    const start = index * miniSectorSize;
    return start + miniSectorSize <= miniStream.length ? miniStream.subarray(start, start + miniSectorSize) : null;
  };
  return readChain(workbook.startSector, workbook.size, miniFat, miniSector);
}

function biffRecords(stream, start = 0, end = stream.length) {
  const records = [];
  let offset = start;
  while (offset + 4 <= end) {
    const id = stream.readUInt16LE(offset);
    const length = stream.readUInt16LE(offset + 2);
    if (offset + 4 + length > end) break;
    records.push({ id, offset, data: stream.subarray(offset + 4, offset + 4 + length) });
    offset += 4 + length;
  }
  return records;
}

class BiffSegmentReader {
  constructor(segments) { this.segments = segments; this.segment = 0; this.offset = 0; }
  advanceSegment() {
    this.segment += 1;
    this.offset = 0;
    return this.segment < this.segments.length;
  }
  byte() {
    while (this.segment < this.segments.length && this.offset >= this.segments[this.segment].length) {
      if (!this.advanceSegment()) return null;
    }
    return this.segments[this.segment]?.[this.offset++] ?? null;
  }
  unsigned(length) {
    let value = 0;
    for (let index = 0; index < length; index += 1) {
      const next = this.byte();
      if (next == null) return null;
      value += next * 2 ** (index * 8);
    }
    return value;
  }
  skip(length) { for (let index = 0; index < length; index += 1) if (this.byte() == null) break; }
  characters(count, highByte) {
    let unicode = highByte;
    let remaining = count;
    let output = '';
    while (remaining > 0 && this.segment < this.segments.length) {
      if (this.offset >= this.segments[this.segment].length) {
        if (!this.advanceSegment()) break;
        const continuationOptions = this.byte();
        if (continuationOptions == null) break;
        unicode = Boolean(continuationOptions & 0x01);
      }
      const width = unicode ? 2 : 1;
      const available = Math.floor((this.segments[this.segment].length - this.offset) / width);
      const take = Math.min(remaining, available);
      if (!take) {
        this.offset = this.segments[this.segment].length;
        continue;
      }
      const start = this.offset;
      const end = start + take * width;
      output += this.segments[this.segment].subarray(start, end).toString(unicode ? 'utf16le' : 'latin1');
      this.offset = end;
      remaining -= take;
    }
    return output;
  }
}

function biffSharedStrings(records) {
  const sstIndex = records.findIndex((record) => record.id === 0x00fc);
  if (sstIndex < 0) return [];
  const segments = [records[sstIndex].data.subarray(8)];
  for (let index = sstIndex + 1; records[index]?.id === 0x003c; index += 1) segments.push(records[index].data);
  const reader = new BiffSegmentReader(segments);
  const uniqueCount = records[sstIndex].data.length >= 8 ? records[sstIndex].data.readUInt32LE(4) : 0;
  const strings = [];
  for (let index = 0; index < uniqueCount && index < 100_000; index += 1) {
    const length = reader.unsigned(2);
    const options = reader.unsigned(1);
    if (length == null || options == null) break;
    const richRuns = options & 0x08 ? reader.unsigned(2) ?? 0 : 0;
    const extensionSize = options & 0x04 ? reader.unsigned(4) ?? 0 : 0;
    strings.push(cleanText(reader.characters(length, Boolean(options & 0x01)), 2_000));
    reader.skip(richRuns * 4 + extensionSize);
  }
  return strings;
}

function biffShortString(data, offset, length) {
  if (offset >= data.length) return '';
  const options = data[offset];
  const width = options & 0x01 ? 2 : 1;
  return cleanText(data.subarray(offset + 1, offset + 1 + length * width).toString(width === 2 ? 'utf16le' : 'latin1'), 2_000);
}

function biffRkNumber(raw) {
  const divided = Boolean(raw & 0x01);
  let value;
  if (raw & 0x02) value = raw >> 2;
  else {
    const encoded = Buffer.alloc(8);
    encoded.writeUInt32LE((raw & 0xfffffffc) >>> 0, 4);
    value = encoded.readDoubleLE(0);
  }
  return divided ? value / 100 : value;
}

function biffCellValue(record, sharedStrings) {
  const data = record.data;
  if (data.length < 6) return null;
  if (record.id === 0x00fd && data.length >= 10) return sharedStrings[data.readUInt32LE(6)] ?? '';
  if (record.id === 0x0203 && data.length >= 14) return data.readDoubleLE(6);
  if (record.id === 0x027e && data.length >= 10) return biffRkNumber(data.readUInt32LE(6));
  if (record.id === 0x0202 && data.length >= 8) return data.readUInt16LE(6);
  if (record.id === 0x0205 && data.length >= 8) return data[7] ? `#ERROR:${data[6]}` : Boolean(data[6]);
  if (record.id === 0x0006 && data.length >= 14) {
    if (data.readUInt16LE(12) === 0xffff) return null;
    return data.readDoubleLE(6);
  }
  if ((record.id === 0x0204 || record.id === 0x00d6) && data.length >= 9) {
    const length = data.readUInt16LE(6);
    return biffShortString(data, 8, length);
  }
  return null;
}

function extractBiffWorkbookStream(stream) {
  const records = biffRecords(stream);
  const sharedStrings = biffSharedStrings(records);
  const sheets = records.filter((record) => record.id === 0x0085 && record.data.length >= 8).map((record, index) => ({
    offset: record.data.readUInt32LE(0),
    name: biffShortString(record.data, 7, record.data[6]) || `Sheet ${index + 1}`,
  }));
  const output = [];
  for (const [sheetIndex, sheet] of sheets.entries()) {
    const end = sheets[sheetIndex + 1]?.offset ?? stream.length;
    const rows = new Map();
    const merges = [];
    for (const record of biffRecords(stream, sheet.offset, end)) {
      if (record.id === 0x00e5 && record.data.length >= 2) {
        for (let i = 0; i < record.data.readUInt16LE(0) && 2 + (i + 1) * 8 <= record.data.length; i++) {
          const offset = 2 + i * 8;
          merges.push({firstRow:record.data.readUInt16LE(offset)+1,lastRow:record.data.readUInt16LE(offset+2)+1,firstColumn:record.data.readUInt16LE(offset+4),lastColumn:record.data.readUInt16LE(offset+6)});
        }
      }
      if (record.id === 0x00bd && record.data.length >= 12) {
        const rowIndex = record.data.readUInt16LE(0);
        const firstColumn = record.data.readUInt16LE(2);
        const count = Math.floor((record.data.length - 6) / 6);
        for (let index = 0; index < count; index += 1) {
          const value = biffRkNumber(record.data.readUInt32LE(6 + index * 6));
          if (!rows.has(rowIndex)) rows.set(rowIndex, []);
          rows.get(rowIndex)[firstColumn + index] = String(value);
        }
        continue;
      }
      const value = biffCellValue(record, sharedStrings);
      if (value == null || value === '') continue;
      const rowIndex = record.data.readUInt16LE(0);
      const columnIndex = record.data.readUInt16LE(2);
      if (!rows.has(rowIndex)) rows.set(rowIndex, []);
      rows.get(rowIndex)[columnIndex] = String(value);
    }
    const values = [...rows.entries()].sort((left, right) => left[0] - right[0]).map((entry) => entry[1]);
    if (values.length) output.push({ name: sheet.name, rows: values, rowNumbers: [...rows.keys()].sort((a,b)=>a-b).map(row=>row+1), merges });
  }
  return output;
}

function extractBiffSpreadsheetTables(buffer) {
  const stream = compoundWorkbookStream(buffer);
  return stream ? extractBiffWorkbookStream(stream) : [];
}

function spreadsheetRange(reference) {
  const match = String(reference).match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i);
  if (!match) return null;
  return {firstRow:Number(match[2]),lastRow:Number(match[4] ?? match[2]),firstColumn:spreadsheetColumnIndex(match[1]),lastColumn:spreadsheetColumnIndex(match[3] ?? match[1])};
}

function spreadsheetSheet(buffer, descriptor, shared, relationships, formats) {
  const attribute = spreadsheetAttribute;
  const source = zipEntry(buffer, descriptor.entry)?.toString('utf8');
  if (!source) return null;
  const rowNumbers = [];
  const displayRows = [];
  const rows = spreadsheetRows(source, shared, rowNumbers, formats, displayRows);
  const merges = spreadsheetElements(source, 'mergeCell')
    .map(({ attributes }) => spreadsheetRange(attribute(attributes, 'ref'))).filter(Boolean);
  const directory = path.posix.dirname(descriptor.entry);
  const rels = relationships(zipEntry(buffer, `${directory}/_rels/${path.posix.basename(descriptor.entry)}.rels`)?.toString('utf8') ?? '');
  const tables = spreadsheetElements(source, 'tablePart').flatMap(({ attributes }) => {
    const target = rels.find(r => r.id === attribute(attributes, 'r:id'))?.target;
    if (!target) return [];
    const entry = path.posix.normalize(target.startsWith('/') ? target.slice(1) : `${directory}/${target}`);
    const xml = zipEntry(buffer, entry)?.toString('utf8') ?? '';
    const tag = spreadsheetElements(xml, 'table')[0]?.attributes ?? '';
    const range = spreadsheetRange(attribute(tag, 'ref'));
    if (!range) return [];
    return [{...range, headerRowCount:Number(attribute(tag, 'headerRowCount') || 1), headers:spreadsheetElements(xml, 'tableColumn').map(c => attribute(c.attributes, 'name'))}];
  });
  if (!rows.length) return null;
  // Presentation only, like `skipped`: kept out of the sheet's data and JSON.
  return Object.defineProperty({ name:descriptor.name, rows, rowNumbers, merges, tables }, 'displayRows', { value: displayRows });
}

export function extractSpreadsheetTables(buffer) {
  try {
    if (buffer.subarray(0, 8).equals(COMPOUND_SIGNATURE)) return extractBiffSpreadsheetTables(buffer);
    const workbook = zipEntry(buffer, 'xl/workbook.xml')?.toString('utf8') ?? '';
    // Without a workbook part this is not a readable .xlsx. The result then
    // carries no `skipped` list, which tells the indexer it failed.
    if (!workbook) return [];
    const attribute = spreadsheetAttribute;
    const relationships = (xml) => spreadsheetElements(xml, 'Relationship')
      .map(({ attributes }) => ({ id: attribute(attributes, 'Id'), target: attribute(attributes, 'Target') }));
    const workbookRels = relationships(zipEntry(buffer, 'xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '');
    const descriptors = spreadsheetElements(workbook, 'sheet').map(({ attributes }, index) => {
      const target = workbookRels.find(r => r.id === attribute(attributes, 'r:id'))?.target;
      return { name: attribute(attributes, 'name') || `Sheet ${index+1}`, entry: target ? path.posix.normalize(target.startsWith('/') ? target.slice(1) : `xl/${target}`) : `xl/worksheets/sheet${index+1}.xml` };
    });
    const shared = spreadsheetStrings(zipEntry(buffer, 'xl/sharedStrings.xml')?.toString('utf8') ?? '');
    let formats = null;
    try {
      formats = spreadsheetNumberFormats(zipEntry(buffer, 'xl/styles.xml')?.toString('utf8') ?? '', workbook);
    } catch { /* unreadable styles leave stored numbers as they are */ }
    const sheets = [];
    // One sheet that is too large or damaged is skipped on its own, so the
    // workbook's other sheets stay searchable. Skipped names are reported.
    const skipped = [];
    for (const descriptor of descriptors.slice(0, 40)) {
      try {
        const sheet = spreadsheetSheet(buffer, descriptor, shared, relationships, formats);
        if (sheet) sheets.push(sheet);
      } catch {
        skipped.push(descriptor.name);
      }
    }
    Object.defineProperty(sheets, 'skipped', { value: skipped });
    return sheets;
  } catch {
    return [];
  }
}

export function extractTaggedReferences(text) {
  const source = String(text ?? '').replace(/\r\n/g, '\n');
  if (/^TY\s+-/m.test(source)) {
    return source.split(/^ER\s+-.*$/m).map((entry, index) => {
      const values = (tag) => [...entry.matchAll(new RegExp(`^${tag}\\s+-\\s*(.+)$`, 'gm'))].map((match) => cleanText(match[1]));
      const authors = [...values('AU'), ...values('A1')];
      const title = values('TI')[0] ?? values('T1')[0] ?? null;
      if (!authors.length && !title) return null;
      const year = publicationYear(values('PY')[0], values('Y1')[0]);
      const doi = values('DO')[0] ?? doiFrom(entry);
      return { key: `ris:${index + 1}`, authors, author: authors.join(' and '), title, year, doi, textExcerpt: cleanText(entry), extraction: 'RIS' };
    }).filter(Boolean);
  }
  if (/^%[A-Z0-9]\s+/m.test(source)) {
    return source.split(/(?=^%0\s+)/m).map((entry, index) => {
      const values = (tag) => [...entry.matchAll(new RegExp(`^%${tag}\\s+(.+)$`, 'gm'))].map((match) => cleanText(match[1]));
      const authors = values('A');
      const title = values('T')[0] ?? null;
      if (!authors.length && !title) return null;
      return { key: `enw:${index + 1}`, authors, author: authors.join(' and '), title, year: publicationYear(values('D')[0]), doi: doiFrom(entry), textExcerpt: cleanText(entry), extraction: 'ENDNOTE' };
    }).filter(Boolean);
  }
  if (/^(?:PMID|FAU|TI)\s*-/m.test(source)) {
    const values = (tag) => [...source.matchAll(new RegExp(`^${tag}\\s*-\\s*(.+)$`, 'gm'))].map((match) => cleanText(match[1]));
    const authors = values('FAU');
    const title = values('TI').join(' ');
    if (authors.length || title) return [{ key: `nbib:${values('PMID')[0] ?? '1'}`, authors, author: authors.join(' and '), title: title || null, year: publicationYear(values('DP')[0]), doi: doiFrom(...values('LID'), source), pmid: values('PMID')[0] ?? null, textExcerpt: cleanText(source), extraction: 'NBIB' }];
  }
  return [];
}

export const documentExtractionInternals = {
  zipEntry, pdfLiteralAt, pdfProperty, cleanText, pdfTextFromStreams, pdfUnicodeMap, decodePdfHexText,
  pdfObjects, structuredPdfText, spreadsheetColumnIndex, spreadsheetStrings, spreadsheetRows,
  compoundWorkbookStream, biffRecords, biffSharedStrings, extractBiffWorkbookStream, extractBiffSpreadsheetTables,
};
