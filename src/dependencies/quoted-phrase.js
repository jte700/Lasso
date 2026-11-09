// A phrase the writer has closed in quotes ("concrete pour starts" or
// 'crane arrives at noon') or is still typing after an opening quote, and
// where a transcript says those words. A
// quotation names what someone said, so it is looked for word for word in
// what was said, not by shared words.

import { typedWordKeys } from './direct-match.js';

const DOUBLE_OPENERS = new Set(['"', '“', '„']);
const DOUBLE_CLOSERS = new Set(['"', '”']);
const SINGLE_OPENERS = new Set(["'", '‘']);
const SINGLE_CLOSERS = new Set(["'", '’']);
// Characters a straight opening quote can follow: the start, a space, an opening bracket or a dash.
const BEFORE_OPENER = /[\s([{\u2014\u2013-]/;
// What may follow the closing quote before the caret: spaces and a closing mark or two.
const AFTER_CLOSER = /[\s,.;:!?)\]]*$/;
const MAX_PHRASE_LENGTH = 300;

/**
 * The phrase in quotes at the caret: one just closed ("concrete pour
 * starts"), or one still being typed after its opening quote ("concrete
 * pour sta), whose last word may be unfinished. An apostrophe inside a word
 * ("contractor's") neither opens nor closes. A phrase of only words that name
 * nothing ("the") is none.
 * @param {string} text
 * @param {number} cursor
 * @returns {{ phrase: string, start: number, end: number, quote: 'double' | 'single',
 *   open: boolean, partialLast: boolean } | null}
 */
export function quotedPhraseAtCaret(text, cursor) {
  const before = String(text ?? '').slice(0, Math.max(0, cursor));
  const quoted = closedPhrase(before) ?? openPhrase(before);
  return quoted && typedWordKeys(quoted.phrase).length ? quoted : null;
}

function closedPhrase(before) {
  const trailing = before.match(AFTER_CLOSER)?.[0] ?? '';
  const closeAt = before.length - trailing.length - 1;
  if (closeAt < 1) return null;
  const closer = before[closeAt];
  const double = DOUBLE_CLOSERS.has(closer);
  if (!double && !SINGLE_CLOSERS.has(closer)) return null;
  if (/\s/.test(before[closeAt - 1])) return null;
  const openers = double ? DOUBLE_OPENERS : SINGLE_OPENERS;
  const earliest = Math.max(0, closeAt - MAX_PHRASE_LENGTH);
  for (let index = closeAt - 1; index >= earliest; index -= 1) {
    const character = before[index];
    if (character === '\n') return null;
    if (!openers.has(character) || !isOpener(before, index)) continue;
    const phrase = before.slice(index + 1, closeAt).trim();
    return phrase ? { phrase, start: index, end: closeAt + 1, quote: double ? 'double' : 'single', open: false, partialLast: false } : null;
  }
  return null;
}

/** The phrase after the last opening quote on the caret's line that nothing has closed yet. */
function openPhrase(before) {
  const lineStart = Math.max(before.lastIndexOf('\n') + 1, before.length - MAX_PHRASE_LENGTH);
  let opened = null;
  for (let index = lineStart; index < before.length; index += 1) {
    const character = before[index];
    if (opened && closes(before, index, opened.quote)) opened = null;
    else if (!opened && DOUBLE_OPENERS.has(character) && isOpener(before, index)) opened = { index, quote: 'double' };
    else if (!opened && SINGLE_OPENERS.has(character) && isOpener(before, index)) opened = { index, quote: 'single' };
  }
  if (!opened) return null;
  const typed = before.slice(opened.index + 1);
  const phrase = typed.trim();
  return phrase ? { phrase, start: opened.index, end: before.length, quote: opened.quote, open: true,
    partialLast: !/\s$/.test(typed) } : null;
}

/** Whether the mark at `index` closes a quote of this kind: a double quote always, a single one only outside a word. */
function closes(text, index, quote) {
  const character = text[index];
  if (quote === 'double') return DOUBLE_CLOSERS.has(character) || DOUBLE_OPENERS.has(character);
  if (!SINGLE_CLOSERS.has(character)) return false;
  return !/[\p{L}\p{N}]/u.test(text[index + 1] ?? '');
}

function isOpener(text, index) {
  const character = text[index];
  const next = text[index + 1];
  if (!next || /\s/.test(next)) return false;
  // Curly opening quotes only ever open; straight ones open after a space or bracket.
  if (character === '“' || character === '„' || character === '‘') return true;
  return index === 0 || BEFORE_OPENER.test(text[index - 1]);
}

/**
 * The words of a phrase as they are compared: lower case, curly apostrophes
 * made straight, and punctuation and hyphens dropped, so "Visit." and "visit"
 * and "north-east" and "north east" are the same words.
 * @param {string} text
 * @returns {string[]}
 */
export function phraseTokens(text) {
  return String(text ?? '').toLowerCase().replace(/[‘’ʼ]/g, "'")
    .split(/[^a-z0-9']+/).map((token) => token.replace(/^'+|'+$/g, '')).filter(Boolean);
}

/**
 * Where a transcript says the phrase's words in order: the segment and the
 * time its first word starts. A segment without word times stands for its
 * words at its own start.
 * @param {string[]} wanted the phrase's tokens
 * @param {{ start: number, text: string, words?: { text: string, start: number }[] }[]} segments
 * @param {{ partialLast?: boolean }} [options] the last word may be one still being typed
 * @returns {{ segmentIndex: number, time: number, lastWord: string, endSegmentIndex: number, endWordIndex: number }[]}
 */
export function phraseMoments(wanted, segments, { partialLast = false } = {}) {
  if (!wanted.length) return [];
  const spoken = [];
  segments.forEach((segment, segmentIndex) => {
    const words = segment.words?.length ? segment.words : [{ text: segment.text, start: segment.start }];
    words.forEach((word, wordIndex) => {
      for (const token of phraseTokens(word.text)) spoken.push({ token, time: word.start, segmentIndex, wordIndex });
    });
  });
  const moments = [];
  for (let index = 0; index + wanted.length <= spoken.length; index += 1) {
    const last = wanted.length - 1;
    if (wanted.every((token, offset) => spoken[index + offset].token === token
      || (partialLast && offset === last && spoken[index + offset].token.startsWith(token)))) {
      const end = spoken[index + last];
      moments.push({ segmentIndex: spoken[index].segmentIndex, time: spoken[index].time, lastWord: end.token,
        endSegmentIndex: end.segmentIndex, endWordIndex: end.wordIndex });
    }
  }
  return moments;
}

/**
 * A time as a viewer reads it on a player: 0:02, 12:40, 1:02:03.
 * @param {number} seconds
 * @returns {string}
 */
export function videoTimestamp(seconds) {
  const whole = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}
