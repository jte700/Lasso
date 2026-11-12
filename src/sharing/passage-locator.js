// Finds a sentence's words in the source text it was read from: the same words
// in order, with up to 12 marks, spaces or line breaks between them, compared
// without case. The first word may end a longer word of the source and the last
// may begin one, as when a link's target is dropped from its readable form.
//
// The source is split into words once, so a lookup costs only the words it
// passes over, and a sentence of any length can be located. (A pattern built per
// sentence cost about a millisecond each to compile and failed outright on a
// sentence of a few thousand words.)

const WORD = /[\p{L}\p{N}]+/gu;
const MAX_GAP = 12;
const fold = (value) => value.toLowerCase();

/** The words of `text` with their offsets, for repeated lookups. */
export function sourceWords(text) {
  const starts = [];
  const ends = [];
  const folded = [];
  for (const match of String(text).matchAll(WORD)) {
    starts.push(match.index);
    ends.push(match.index + match[0].length);
    folded.push(fold(match[0]));
  }
  return { text: String(text), starts, ends, folded };
}

function firstEndingAfter(ends, offset) {
  let low = 0;
  let high = ends.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (ends[middle] > offset) high = middle; else low = middle + 1;
  }
  return low;
}

// Whether the source reads `wanted` (already folded, `length` units long) at `at`.
function readsAt(source, index, at, wanted, length) {
  const folded = source.folded[index];
  if (folded.length === source.ends[index] - source.starts[index]) return folded.startsWith(wanted, at - source.starts[index]);
  return fold(source.text.slice(at, at + length)) === wanted;
}

function gapFits(source, before, after) {
  const width = source.starts[after] - source.ends[before];
  if (width <= MAX_GAP) return true;
  // The limit counts characters, and some marks take two code units.
  return width <= MAX_GAP * 2 && [...source.text.slice(source.ends[before], source.starts[after])].length <= MAX_GAP;
}

function withinWord(source, index, word, wanted, from) {
  const start = source.starts[index];
  for (let at = Math.max(start, from); at + word.length <= source.ends[index]; at += 1) {
    if (readsAt(source, index, at, wanted, word.length)) return { start: at, end: at + word.length };
  }
  return null;
}

function runAt(source, index, words, wanted, from) {
  const last = words.length - 1;
  if (index + last >= source.starts.length) return null;
  const start = source.ends[index] - words[0].length;
  if (start < Math.max(from, source.starts[index]) || !readsAt(source, index, start, wanted[0], words[0].length)) return null;
  for (let offset = 1; offset <= last; offset += 1) {
    const at = index + offset;
    if (!gapFits(source, at - 1, at)) return null;
    if (offset < last && source.folded[at] !== wanted[offset]) return null;
  }
  const end = index + last;
  if (source.ends[end] - source.starts[end] < words[last].length
    || !readsAt(source, end, source.starts[end], wanted[last], words[last].length)) return null;
  return { start, end: source.starts[end] + words[last].length };
}

/**
 * First place at or after `from` where `words` are read in order, or null when
 * there is none or it would end past `limit`.
 */
export function locateWords(source, words, from, limit = source.text.length) {
  if (!words.length) return null;
  const wanted = words.map(fold);
  for (let index = firstEndingAfter(source.ends, from); index < source.starts.length && source.starts[index] < limit; index += 1) {
    const found = words.length === 1
      ? withinWord(source, index, words[0], wanted[0], from)
      : runAt(source, index, words, wanted, from);
    if (found) return found.end <= limit ? found : null;
  }
  return null;
}
