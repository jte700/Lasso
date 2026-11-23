// Who wrote each character of a file's text, carried from one version to the
// next. Owners are kept as one number per character: a mark's index when an
// AI wrote it, NOBODY otherwise. A save is compared line by line, then word
// by word inside the lines it changed, so characters that stayed keep their
// owner and only those the save wrote take the owner it was written by.

import { sequenceOperations } from '../history/sequence-diff.js';

/** Written by a person, or before Lasso knew who wrote it. */
export const NOBODY = -1;
/** Written in this save by a person, until a mark of copied or typed words claims it. */
export const FRESH = -2;

const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;
const WORD = /^[\p{L}\p{N}_]+$/u;
/** Words in a row a copied answer must match before its words are claimed. */
const SHORTEST_RUN = 3;
/** Fresh text this close together is read as one paste, broken only where a common word lined up with old text. */
const PASTE_GAP = 40;

/** Words, runs of space and single other characters, each with where it starts; together they cover the text. */
export function tokens(text, from = 0, to = text.length) {
  const found = [];
  TOKEN.lastIndex = 0;
  const slice = text.slice(from, to);
  for (const match of slice.matchAll(TOKEN)) found.push({ text: match[0], start: from + match.index });
  return found;
}

/** The text's lines, each with its newline, as { text, start, end }. */
export function linesOf(text) {
  const lines = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline + 1;
    lines.push({ text: text.slice(start, end), start, end });
    start = end;
  }
  return lines;
}

/**
 * The owners of `after`'s characters, given the owners of `before`'s:
 * characters the edit kept keep their owner, and those it wrote take
 * `written` (a mark's index, NOBODY or FRESH). `owners` may be null when no
 * character of `before` had an owner.
 */
export function carryForward(before, after, owners, written) {
  const result = new Int32Array(after.length).fill(NOBODY);
  const ownerAt = (index) => (owners ? owners[index] : NOBODY);
  if (before === after) {
    if (owners) result.set(owners.subarray(0, after.length));
    return result;
  }
  const beforeLines = linesOf(before);
  const afterLines = linesOf(after);
  const copy = (fromStart, toStart, length) => {
    if (!owners) return;
    for (let offset = 0; offset < length; offset += 1) result[toStart + offset] = ownerAt(fromStart + offset);
  };
  let removed = [];
  let added = [];
  const flush = () => {
    if (added.length) {
      const to = { start: afterLines[added[0]].start, end: afterLines[added.at(-1)].end };
      if (!removed.length) result.fill(written, to.start, to.end);
      else {
        const from = { start: beforeLines[removed[0]].start, end: beforeLines[removed.at(-1)].end };
        carryWords(before, after, from, to, copy, (start, end) => result.fill(written, start, end));
      }
    }
    removed = [];
    added = [];
  };
  for (const operation of sequenceOperations(beforeLines.map((line) => line.text), afterLines.map((line) => line.text))) {
    if (operation.kind === 'remove') removed.push(operation.beforeLine - 1);
    else if (operation.kind === 'add') added.push(operation.afterLine - 1);
    else {
      flush();
      const from = beforeLines[operation.beforeLine - 1];
      const to = afterLines[operation.afterLine - 1];
      copy(from.start, to.start, to.end - to.start);
    }
  }
  flush();
  return result;
}

/** Inside lines a save changed: words it kept are copied, words it wrote are filled. */
function carryWords(before, after, from, to, copy, fill) {
  const beforeTokens = tokens(before, from.start, from.end);
  const afterTokens = tokens(after, to.start, to.end);
  for (const operation of sequenceOperations(beforeTokens.map((token) => token.text), afterTokens.map((token) => token.text))) {
    if (operation.kind === 'equal') {
      const kept = beforeTokens[operation.beforeLine - 1];
      const now = afterTokens[operation.afterLine - 1];
      copy(kept.start, now.start, now.text.length);
    } else if (operation.kind === 'add') {
      const now = afterTokens[operation.afterLine - 1];
      fill(now.start, now.start + now.text.length);
    }
  }
}

const comparable = (word) => word.toLowerCase();

/**
 * Gives `mark` the characters of `after` that were written fresh in this
 * save and read as `text` (an answer copied or typed in), word for word in
 * runs of at least three. Words the person changed after pasting stay
 * theirs. Returns how many characters it claimed.
 */
export function claimText(after, owners, text, mark) {
  const wanted = tokens(text).filter((token) => WORD.test(token.text)).map((token) => comparable(token.text));
  if (!wanted.length) return 0;
  const shortest = Math.min(SHORTEST_RUN, wanted.length);
  let claimed = 0;
  for (const region of freshRegions(owners)) {
    const words = tokens(after, region.start, region.end).filter((token) => WORD.test(token.text));
    if (!words.length) continue;
    const fresh = (word) => {
      for (let index = word.start; index < word.start + word.text.length; index += 1) if (owners[index] !== FRESH) return false;
      return true;
    };
    const runs = [];
    let run = null;
    const end = () => { if (run) runs.push(run); run = null; };
    for (const operation of sequenceOperations(wanted, words.map((token) => comparable(token.text)))) {
      if (operation.kind === 'equal') {
        const word = words[operation.afterLine - 1];
        // Words that were in the file before this save are never claimed, and they end a run.
        if (!fresh(word)) { end(); continue; }
        if (run && run.last === operation.afterLine - 2) { run.end = word.start + word.text.length; run.count += 1; run.last += 1; }
        else { end(); run = { start: word.start, end: word.start + word.text.length, count: 1, last: operation.afterLine - 1 }; }
      } else if (operation.kind === 'add') end();
    }
    end();
    const kept = runs.filter((candidate) => candidate.count >= shortest);
    const matched = kept.reduce((sum, candidate) => sum + candidate.count, 0);
    // A few common words in a row are not a paste: most of a short answer, or a good stretch of a long one, must be there.
    if (!matched || (matched < 8 && matched / wanted.length < 0.3)) continue;
    for (const candidate of kept) {
      // Punctuation written with the words (a closing full stop, an opening quote) goes with them.
      let start = candidate.start;
      while (start > 0 && owners[start - 1] === FRESH && PUNCTUATION.test(after[start - 1])) start -= 1;
      let stop = candidate.end;
      while (stop < after.length && owners[stop] === FRESH && PUNCTUATION.test(after[stop])) stop += 1;
      for (let index = start; index < stop; index += 1) {
        if (owners[index] !== FRESH) continue;
        owners[index] = mark;
        claimed += 1;
      }
    }
  }
  return claimed;
}

const PUNCTUATION = /^[^\p{L}\p{N}_\s]$/u;

/** Stretches of characters written fresh in this save, joined across short gaps. */
function freshRegions(owners) {
  const regions = [];
  let index = 0;
  while (index < owners.length) {
    if (owners[index] !== FRESH) { index += 1; continue; }
    let end = index;
    while (end < owners.length && owners[end] === FRESH) end += 1;
    const last = regions.at(-1);
    if (last && index - last.end <= PASTE_GAP) last.end = end;
    else regions.push({ start: index, end });
    index = end;
  }
  return regions;
}

/** FRESH characters no mark claimed were written by a person. */
export function settle(owners) {
  for (let index = 0; index < owners.length; index += 1) if (owners[index] === FRESH) owners[index] = NOBODY;
  return owners;
}

const isSpace = (code) => code === 32 || code === 9 || code === 10 || code === 13 || code === 160;

/**
 * The runs of `text` each mark wrote, as [{ s, e, m }] with `m` from
 * `markOf(index)`: trimmed of surrounding space, and joined across space a
 * person left between two runs of the same mark.
 */
export function spansOf(owners, text, markOf) {
  const spans = [];
  let index = 0;
  while (index < owners.length) {
    const owner = owners[index];
    if (owner < 0) { index += 1; continue; }
    let end = index;
    while (end < owners.length && owners[end] === owner) end += 1;
    let start = index;
    while (start < end && isSpace(text.charCodeAt(start))) start += 1;
    let stop = end;
    while (stop > start && isSpace(text.charCodeAt(stop - 1))) stop -= 1;
    if (start < stop) {
      const last = spans.at(-1);
      const between = last ? text.slice(last.e, start) : null;
      if (last && last.owner === owner && /^[ \t ]*$/.test(between)) last.e = stop;
      else spans.push({ s: start, e: stop, owner });
    }
    index = end;
  }
  return spans.map((span) => ({ s: span.s, e: span.e, m: markOf(span.owner) }));
}

/** Owners from stored spans, for a text of `length` characters; `indexOf(markId)` numbers each mark. */
export function ownersOf(spans, length, indexOf) {
  const owners = new Int32Array(length).fill(NOBODY);
  for (const span of spans ?? []) {
    const start = Math.max(0, Math.min(length, span.s));
    const end = Math.max(start, Math.min(length, span.e));
    owners.fill(indexOf(span.m), start, end);
  }
  return owners;
}
