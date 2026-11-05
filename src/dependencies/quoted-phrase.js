// A phrase the writer has just closed in quotes ("concrete pour starts" or
// 'crane arrives at noon'), and where a transcript says those words. A
// quotation names what someone said, so it is looked for word for word in
// what was said, not by shared words.

const DOUBLE_OPENERS = new Set(['"', '“', '„']);
const DOUBLE_CLOSERS = new Set(['"', '”']);
const SINGLE_OPENERS = new Set(["'", '‘']);
const SINGLE_CLOSERS = new Set(["'", '’']);
// Characters a straight opening quote can follow: the start, a space, an opening bracket or a dash.
const BEFORE_OPENER = /[\s([{—–-]/;
// What may follow the closing quote before the caret: spaces and a closing mark or two.
const AFTER_CLOSER = /[\s,.;:!?)\]]*$/;
const MAX_PHRASE_LENGTH = 300;
// A phrase of a single short word ("a", "ok") names nothing to look for.
const NAMING_WORD = /[A-Za-z][A-Za-z0-9]{2,}/;

/**
 * The phrase closed in quotes just before the caret, if there is one.
 * An apostrophe inside a word ("contractor's") neither opens nor closes.
 * @param {string} text
 * @param {number} cursor
 * @returns {{ phrase: string, start: number, end: number, quote: 'double' | 'single' } | null}
 */
export function quotedPhraseAtCaret(text, cursor) {
  const before = String(text ?? '').slice(0, Math.max(0, cursor));
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
    if (!NAMING_WORD.test(phrase)) return null;
    return { phrase, start: index, end: closeAt + 1, quote: double ? 'double' : 'single' };
  }
  return null;
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
 * @returns {{ segmentIndex: number, time: number }[]}
 */
export function phraseMoments(wanted, segments) {
  if (!wanted.length) return [];
  const spoken = [];
  segments.forEach((segment, segmentIndex) => {
    const words = segment.words?.length ? segment.words : [{ text: segment.text, start: segment.start }];
    for (const word of words) {
      for (const token of phraseTokens(word.text)) spoken.push({ token, time: word.start, segmentIndex });
    }
  });
  const moments = [];
  for (let index = 0; index + wanted.length <= spoken.length; index += 1) {
    if (wanted.every((token, offset) => spoken[index + offset].token === token)) {
      moments.push({ segmentIndex: spoken[index].segmentIndex, time: spoken[index].time });
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
