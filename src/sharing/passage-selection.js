// What the passage picker highlights when it opens: the passage the
// suggestion cited, from the words the writer has typed when the passage has
// them, to the end of that sentence. Tab inserts it as it stands; the writer
// can highlight something else first.

import { typedWordKeys } from '../dependencies/direct-match.js';
import { phraseTokens } from '../dependencies/quoted-phrase.js';
import { writingSourceContext } from '../dependencies/writing-context.js';

// The most typed words looked for together in the passage.
const MAX_TYPED_WORDS = 8;
// A written word: letters and digits, joined by apostrophes and hyphens.
const WORD = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;
// Where a sentence ends inside a line: terminal punctuation, any closing mark, then a space or the end.
const SENTENCE_END = /[.!?]["'”’)\]]*(?=\s|$)/g;
// The most words of a passage used to find it in the document.
const MAX_NEEDLE_WORDS = 40;
// Endings a written word takes ("shipments", "stored", "storing"), and what each leaves behind.
const ENDINGS = [['ies', 'y'], ['ing', ''], ['ed', ''], ['es', ''], ['s', ''], ['d', '']];
// The shortest stem two forms of a word are matched by, so short words ("new", "news") stay apart.
const MIN_STEM = 4;

/** A word without its ending and a final "e": "shipments" and "shipment", "store", "stored" and "storing" share one. */
function stem(token) {
  let word = String(token).toLowerCase();
  for (const [ending, kept] of ENDINGS) {
    if (word.endsWith(ending) && word.length - ending.length + kept.length >= MIN_STEM) {
      word = word.slice(0, -ending.length) + kept;
      break;
    }
  }
  return word.length > MIN_STEM && word.endsWith('e') ? word.slice(0, -1) : word;
}

/** Whether a typed word is the passage's word, or another form of it. */
function sameWord(written, typed) {
  if (written === typed) return true;
  return written.length >= MIN_STEM && typed.length >= MIN_STEM && stem(written) === stem(typed);
}

/**
 * The range the picker opens highlighted, or null when the passage cannot be
 * found in the document (the writer then highlights it themselves).
 * @param {import('./passage-document.js').PassageDocument} document
 * @param {{ anchor?: object, metadata?: object, valueText?: string | null }} source
 * @param {string} typed the text before the caret, as far back as the host gave it
 * @returns {{ start: number, end: number, trigger?: { fromEnd: number, length: number, text: string } } | null}
 *   `trigger` is the typed words that brought the suggestion up, counted back
 *   from the caret, which a highlight the writer chooses instead takes the place of.
 */
export function passageSelection(document, source, typed = '') {
  if (!document?.text) return null;
  const passage = passageRange(document, source);
  if (!passage) return null;
  const tail = typedTail(typed);
  const words = contentWords(document, passage);
  const trigger = typedTrigger(typed, words, tail.partialLast);
  const answer = (range) => range && (trigger ? { ...range, trigger } : range);
  for (const suffix of tail.suffixes) {
    const match = matchIn(words, suffix.tokens, tail.partialLast);
    if (match) return answer(trimmed(document.text, { start: match.start, end: sentenceEnd(document, match.end, passage) }));
  }
  // A video's excerpt is several sentences; the first that has a typed word is the one meant.
  if (document.kind === 'video' && tail.keys.length) {
    const wanted = new Set(tail.keys);
    const shared = words.find((word) => typedWordKeys(word.text).some((key) => wanted.has(key)));
    if (shared) return answer(trimmed(document.text, lineContent(document, shared.start)));
  }
  return answer(trimmed(document.text, passage));
}

// Words that only point at the noun after them ("the fire"): they go with it when it is replaced.
const DETERMINERS = new Set(['the', 'a', 'an', 'this', 'these', 'those', 'our', 'my', 'your', 'its', 'their', 'his', 'her']);

/**
 * The typed words that brought the passage up: back from the caret, every
 * word the passage has (the last may be unfinished), and a "the" or "a" just
 * before them. "Reminder that the fire" gives "the fire" when the passage
 * says "fire". None when the word at the caret is not in the passage.
 */
function typedTrigger(typed, words, partialLast) {
  const before = String(typed ?? '');
  const { sentence, sentenceStart } = writingSourceContext(before, before.length);
  const typedWords = [...sentence.matchAll(WORD)].map((match) => ({ text: match[0], start: sentenceStart + match.index }));
  if (!typedWords.length || !/^[\p{L}\p{N}'’\-]*\s*$/u.test(before.slice(typedWords.at(-1).start))) return undefined;
  const said = new Set(words.map((word) => word.token));
  const inPassage = (word, last) => phraseTokens(word.text).every((token) => said.has(token)
    || [...said].some((known) => sameWord(known, token))
    || (last && partialLast && [...said].some((known) => known.startsWith(token))));
  let first = typedWords.length;
  while (first > 0 && inPassage(typedWords[first - 1], first === typedWords.length)) first -= 1;
  if (first === typedWords.length) return undefined;
  while (first > 0 && DETERMINERS.has(typedWords[first - 1].text.toLowerCase())) first -= 1;
  // Words that name nothing on their own ("the") are not what brought it up.
  const run = typedWords.slice(first);
  if (!typedWordKeys(run.map((word) => word.text).join(' ')).length) return undefined;
  const start = run[0].start, end = run.at(-1).start + run.at(-1).text.length;
  return { fromEnd: before.length - start, length: end - start, text: before.slice(start, end) };
}

/** Where the cited passage is in the document, read from its anchor and text. */
function passageRange(document, source) {
  const anchor = source?.anchor ?? {};
  const needle = String(source?.valueText ?? anchor.selectedText ?? '');
  const within = (places) => places.length
    ? { start: Math.min(...places.map((place) => place.start)), end: Math.max(...places.map((place) => place.end)) } : null;
  let region = null;
  if (document.kind === 'video') {
    const start = Number(anchor.start) || 0;
    const end = Number.isFinite(Number(anchor.end)) && Number(anchor.end) > start ? Number(anchor.end) : Infinity;
    return within(document.places.filter((place) => place.time >= start && place.time < end));
  }
  if (document.kind === 'slides') region = within(document.places.filter((place) => place.number === Number(anchor.slideNumber ?? source?.metadata?.slideNumber)));
  if (document.kind === 'pdf') region = within(document.places.filter((place) => place.number === Number(anchor.pageNumber ?? source?.metadata?.pageNumber)));
  if (document.kind === 'word' || document.kind === 'text') {
    const first = Number(anchor.lineStart);
    const last = Number(anchor.lineEnd ?? anchor.lineStart);
    if (Number.isInteger(first)) {
      region = within(document.places.filter((place) => {
        const line = place.line ?? place.number;
        return line >= first && line <= (Number.isInteger(last) ? last : first);
      }));
    }
  }
  const found = findText(document.text, needle, region) ?? (region ? null : findText(document.text, needle, null));
  return found ? throughMarks(document.text, found) : region;
}

/** A passage found by its words, carried on over the marks that close its line (a code span's backtick, a closing bracket). */
function throughMarks(text, range) {
  const rest = text.slice(range.end).match(/^[^\p{L}\p{N}\s]*(?=\n|$)/u)?.[0] ?? '';
  return rest.length <= 3 ? { start: range.start, end: range.end + rest.length } : range;
}

/** The needle's words in order in the text (or only in `region`), whatever the spacing and punctuation between them. */
function findText(text, needle, region) {
  const all = [...String(needle).matchAll(WORD)].map((match) => match[0]);
  if (!all.length) return null;
  const from = region?.start ?? 0;
  const limit = region?.end ?? text.length;
  const pattern = (words) => new RegExp(words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^\\p{L}\\p{N}]+'), 'iu');
  const found = text.slice(from, limit).match(pattern(all.slice(0, MAX_NEEDLE_WORDS)));
  if (!found) return null;
  let end = from + found.index + found[0].length;
  // A long passage is found by its first words and runs on to its last ones.
  if (all.length > MAX_NEEDLE_WORDS) {
    const start = from + found.index;
    const last = text.slice(start, limit).match(pattern(all.slice(-MAX_NEEDLE_WORDS)));
    if (last) end = Math.max(end, start + last.index + last[0].length);
  }
  // The passage's closing punctuation ("first.") is part of it when the document has it too.
  const closing = String(needle).trimEnd().match(/[^\p{L}\p{N}\s]*$/u)[0];
  return { start: from + found.index, end: closing && text.startsWith(closing, end) ? end + closing.length : end };
}

/** The words typed in the sentence at the caret, and each run of them ending at the caret that names something, longest first. */
function typedTail(typed) {
  const before = String(typed ?? '');
  const { sentence, sentenceStart } = writingSourceContext(before, before.length);
  const words = [...sentence.matchAll(WORD)].map((match) => ({ text: match[0], tokens: phraseTokens(match[0]), start: sentenceStart + match.index }))
    .filter((word) => word.tokens.length);
  const suffixes = [];
  for (let count = Math.min(words.length, MAX_TYPED_WORDS); count > 0; count -= 1) {
    const run = words.slice(-count);
    if (!typedWordKeys(run.map((word) => word.text).join(' ')).length) continue;
    const last = run.at(-1);
    suffixes.push({ tokens: run.flatMap((word) => word.tokens), start: run[0].start, end: last.start + last.text.length });
  }
  return { suffixes, keys: typedWordKeys(sentence), partialLast: /[\p{L}\p{N}]$/u.test(before) };
}

/** The passage's words, outside the document's labels, each with its tokens and where it is. */
function contentWords(document, range) {
  const labels = document.decorations ?? [];
  const words = [];
  for (const match of document.text.slice(range.start, range.end).matchAll(WORD)) {
    const start = range.start + match.index;
    if (labels.some((label) => label.start <= start && start < label.end)) continue;
    const end = start + match[0].length;
    for (const token of phraseTokens(match[0])) words.push({ text: match[0], token, start, end });
  }
  return words;
}

/** The first place the tokens are written in order; the last may be unfinished. */
function matchIn(words, tokens, partialLast) {
  for (let index = 0; index + tokens.length <= words.length; index += 1) {
    const matches = tokens.every((token, offset) => sameWord(words[index + offset].token, token)
      || (partialLast && offset === tokens.length - 1 && words[index + offset].token.startsWith(token)));
    if (matches) return { start: words[index].start, end: words[index + tokens.length - 1].end };
  }
  return null;
}

/** Where the sentence going on at `from` ends: at its punctuation, its line's end, or the passage's. */
function sentenceEnd(document, from, passage) {
  const { end: lineEnd } = lineContent(document, from);
  // A PDF's lines wrap its sentences, so a sentence there runs on to its page's end.
  const limit = document.kind === 'pdf' ? Math.max(passage.end, from) : lineEnd;
  SENTENCE_END.lastIndex = 0;
  const rest = document.text.slice(from, limit);
  const found = SENTENCE_END.exec(rest);
  return found ? from + found.index + found[0].length : limit;
}

/** The line around `at`, without the labels at its start. */
function lineContent(document, at) {
  const text = document.text;
  const start = text.lastIndexOf('\n', at - 1) + 1;
  const newline = text.indexOf('\n', at);
  const end = newline < 0 ? text.length : newline;
  const label = (document.decorations ?? []).filter((range) => range.start >= start && range.start < end && range.end <= end + 1)
    .reduce((reach, range) => (range.start <= reach ? Math.max(reach, Math.min(range.end, end)) : reach), start);
  return { start: label, end };
}

function trimmed(text, range) {
  let { start, end } = range;
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  return end > start ? { start, end } : null;
}
