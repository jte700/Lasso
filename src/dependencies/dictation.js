// Dictated words reach Lasso whole. Typing stops partway through a name
// ("Other rev") and Tab accepts it, so the words after it are asked about
// with the name already linked. Dictation writes the name in full and goes
// straight on ("Other revenue was"), with no moment to press Tab. These
// helpers find a source named in full among the words just said, so the
// rest of the clause can be answered as if it had been accepted.

// Names rarely end on these, so the words before them are not asked about.
const LEADING_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'from', 'with', 'into',
  'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'which', 'that', 'who', 'it', 'its', 'as',
  'came', 'come', 'comes', 'about', 'around', 'roughly', 'approximately', 'nearly', 'over', 'under',
]);

const WORD = /[\p{L}\p{N}][\p{L}\p{N}_'’-]*/gu;

/**
 * Where a name said before the last words may end, nearest first: after a
 * word that is followed by at least one more, no earlier than `from` and no
 * more than `maxWordsAfter` words before the cursor.
 */
export function dictatedNameEnds(text, from, cursor, { maxWordsAfter = 4 } = {}) {
  const value = String(text ?? '');
  const start = Math.max(0, Number.isInteger(from) ? from : 0);
  const end = Math.min(value.length, Number.isInteger(cursor) ? cursor : value.length);
  if (start >= end) return [];
  const words = [...value.slice(start, end).matchAll(WORD)]
    .map((match) => ({ word: match[0], end: start + match.index + match[0].length }));
  const ends = [];
  for (let index = words.length - 2; index >= 0 && words.length - 1 - index <= maxWordsAfter; index -= 1) {
    if (!LEADING_WORDS.has(words[index].word.toLowerCase())) ends.push(words[index].end);
  }
  return ends;
}

function plainWords(value) {
  return String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[_\-–—·/\\]+/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

/** Whether the words said are the source's whole name, as speech writes it ("L bracket" for l_bracket). */
export function namesInFull(words, label) {
  const said = plainWords(words);
  return said !== '' && said === plainWords(label);
}

/**
 * Dictation punctuates where the speaker pauses, often mid-phrase while they
 * look at the card ("The other revenue. Was"), and revises it back and forth.
 * The words said are one clause, so the sentence marks among the last few
 * words (one straight after a word, with spacing after it) are read as
 * spaces. Each stays one character, so every offset in the text still holds.
 * Null when there is none.
 */
export function softenDictatedPauses(text, cursor, { lastWords = 4 } = {}) {
  const value = String(text ?? '');
  const end = Math.min(value.length, Number.isInteger(cursor) ? cursor : value.length);
  const words = [...value.slice(0, end).matchAll(WORD)];
  if (words.length < 2) return null;
  const tailStart = words[Math.max(0, words.length - 1 - lastWords)].index;
  let changed = false;
  const softened = value.slice(0, tailStart) + value.slice(tailStart, end)
    .replace(/(?<=[\p{L}\p{N}])[.!?](?=[  ]+[\p{L}\p{N}])/gu, () => { changed = true; return ' '; })
    + value.slice(end);
  return changed ? softened : null;
}

/** Whether a workspace prediction offers anything at all. */
export function hasSuggestions(prediction) {
  return Boolean(prediction?.sourceCompletions?.length || prediction?.workspaceCompletions?.length
    || prediction?.completion || prediction?.claims?.some((claim) => claim.candidates?.length));
}
