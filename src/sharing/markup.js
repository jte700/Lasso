// Pen, marker and highlighter strokes drawn on a shared copy of a PDF, Word
// document or presentation. A stroke's points are normalized to its page's
// crop box from the top left, as PDF redaction regions are, so they land in
// the same place however large the page is drawn.
import { HttpError } from '../history/errors.js';

export const MARK_TOOLS = new Set(['PEN', 'MARKER', 'HIGHLIGHTER']);
const MAX_STROKES = 400;
const MAX_POINTS_PER_STROKE = 2000;
// Every share's strokes are read back whenever it opens, so all of them together are bounded too.
const MAX_POINTS = 120_000;
const MAX_PAGE = 1000;
const COLOR = /^#[0-9A-F]{6}$/;
// Four decimal places is a tenth of a point on a letter page.
const PRECISION = 10_000;

/** PDFs, Word documents and decks are shown as pages to draw on. */
export function isMarkablePath(filePath) {
  return /\.(?:pdf|docx|pptx)$/i.test(String(filePath ?? ''));
}

const isUnit = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

function normalizeStroke(entry) {
  const tool = String(entry?.tool ?? '').toUpperCase();
  const color = String(entry?.color ?? '').toUpperCase();
  const page = Number(entry?.page);
  const points = entry?.points;
  if (!MARK_TOOLS.has(tool) || !COLOR.test(color) || !Number.isInteger(page) || page < 1 || page > MAX_PAGE
      || !Array.isArray(points) || points.length < 2 || points.length % 2 !== 0
      || points.length > MAX_POINTS_PER_STROKE * 2 || !points.every(isUnit)) {
    throw new HttpError(400, 'Invalid marking.');
  }
  return { kind: 'MARK', tool, color, page, points: points.map((value) => Math.round(value * PRECISION) / PRECISION) };
}

/**
 * The strokes of a marked copy, checked; none for any other scope.
 * @param {unknown} value the strokes as sent
 * @param {string} scope the share's access scope
 * @returns {{kind: 'MARK', tool: string, color: string, page: number, points: number[]}[]}
 */
export function normalizeMarkup(value, scope) {
  if (scope !== 'MARKED') return [];
  if (!Array.isArray(value)) throw new HttpError(400, 'Markings must be a list.');
  if (value.length > MAX_STROKES) throw new HttpError(400, `Draw no more than ${MAX_STROKES} marks.`);
  const strokes = value.map(normalizeStroke);
  if (!strokes.length) throw new HttpError(400, 'Draw on the document before sharing a marked copy.');
  if (strokes.reduce((total, stroke) => total + stroke.points.length / 2, 0) > MAX_POINTS) {
    throw new HttpError(400, 'These marks are too detailed to share. Erase some and try again.');
  }
  return strokes;
}
