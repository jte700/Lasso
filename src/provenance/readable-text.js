// The text whose characters AI authorship is kept over: a text or code file's
// own text, and a Word file's, PDF's or deck's words a paragraph (or line, or
// slide piece) a line, as the review and `lasso diff` read them. Sheets are
// cells, not running text, and are left to the per-value record.

import { detectFileType } from '../history/file-types.js';
import { extractDocxFullText, extractPdfFullText } from '../dependencies/document-extraction.js';
import { readPresentation } from '../dependencies/presentation-extraction.js';

const TEXT = new Set(['markdown', 'text', 'code', 'json', 'yaml', 'xml', 'notebook']);
const DOCUMENTS = new Set(['document', 'pdf', 'presentation']);
/** Larger files are not followed character by character. */
export const LONGEST_READABLE = 4 * 1024 * 1024;

/** 'text', 'document' or null: how a file's authorship is kept. */
export function readableKind(filePath) {
  const type = detectFileType(filePath);
  if (TEXT.has(type)) return 'text';
  if (DOCUMENTS.has(type)) return 'document';
  return null;
}

function deckText(buffer) {
  const deck = readPresentation(buffer);
  return (deck.slides ?? []).flatMap((slide) => (slide.blocks ?? []).map((block) => (block.type === 'table'
    ? (block.rows ?? []).map((row) => row.join(' · ')).join('\n') : String(block.text ?? '')))).join('\n');
}

/** A version's readable text, or null when it cannot be read. */
export function readableText(buffer, filePath) {
  if (!buffer || buffer.length > LONGEST_READABLE) return null;
  const kind = readableKind(filePath);
  if (kind === 'text') return buffer.toString('utf8');
  if (kind !== 'document') return null;
  const type = detectFileType(filePath);
  let text;
  try {
    text = type === 'document' ? extractDocxFullText(buffer) : type === 'pdf' ? extractPdfFullText(buffer) : deckText(buffer);
  } catch {
    return null;
  }
  return String(text ?? '').split(/\n+/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}
