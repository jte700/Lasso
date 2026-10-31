// The sentence and clause being written: where it starts, what it says about its
// intent, and the name fragments that end at the caret.

import path from 'node:path';
import { normalizedVariable } from './tabular.js';
import { variableTokens } from './text-similarity.js';

// Where the last sentence before the cursor ended: terminal punctuation, with
// any closing quote or bracket, before a space or the cursor; or a line break.
// A dot inside a name ("Bracket.step") or a number ("4.8") ends nothing, nor
// does an abbreviation's ("e.g. gross") unless a capitalised word follows it.
function sentenceStartBefore(before) {
  const masked = withoutHonorificStops(before).replace(ABBREVIATIONS, (match, offset) =>
    /^(?:\s+\p{Lu}|\s*$)/u.test(before.slice(offset + match.length)) ? match : `${match.slice(0, -1)} `);
  let start = 0;
  for (const end of masked.matchAll(/[.!?]["'”’)\]]*(?=\s|$)|\n/g)) start = end.index + end[0].length;
  return start;
}

export function writingSourceContext(text, cursor, section = '') {
  const source = String(text ?? '');
  const before = source.slice(0, cursor);
  const sentenceStart = sentenceStartBefore(before);
  const sentence = before.slice(sentenceStart);
  const words = variableTokens(sentence);
  const literatureIntent = /\b(?:et\s+al|according\s+to|cited\s+by|paper|article|publication|authors?|researchers?|investigators?|prior\s+(?:work|studies)|previous\s+(?:work|studies)|(?:study|work|report)\s+(?:by|from))\b/i.test(sentence);
  const firstPerson = words.some((word) => ['we', 'our', 'ours', 'us'].includes(word));
  const studyNoun = words.some((word) => /^(?:study|analysis|dataset|data|result|results|cohort|experiment|samples?|model)$/.test(word));
  const reportingVerb = words.some((word) => /^(?:find|found|show|showed|observe|observed|detect|detected|identify|identified|report|reported|measure|measured|quantify|quantified|record|recorded|reveal|revealed|indicate|indicated|demonstrate|demonstrated|estimate|estimated|calculate|calculated|analyze|analysed|analyzed|assess|assessed|discover|discovered)$/.test(word));
  const selfStudy = /\b(?:this|current|present)\s+(?:study|analysis|dataset|data|cohort|experiment|work)\b/i.test(sentence);
  const resultsSection = /\b(?:results?|findings?|analysis|outcomes?)\b/i.test(section);
  return {
    sentence,
    sentenceStart,
    literatureIntent,
    projectIntent: !literatureIntent && (firstPerson || studyNoun || reportingVerb
      || selfStudy || resultsSection),
  };
}

// A fragment that begins with one of these is part of the sentence, not of a
// source name. Replacing it would delete the word ("cost of office sup"), and
// a lone function word ("is", "of") would match unrelated names.
const FRAGMENT_FUNCTION_WORDS = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'from', 'with',
  'as', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'and', 'or', 'but', 'if', 'so', 'than', 'then', 'that',
  'this', 'these', 'those', 'has', 'have', 'had', 'our', 'their', 'we', 'via', 'into', 'onto']);

// Sentence punctuation, optionally inside a closing quote or bracket, then a
// space; or a line break. A decimal point ("4.8") is not followed by a space,
// and common abbreviations ("vs.", "e.g.") are removed before testing.
const SENTENCE_BOUNDARY = /[.!?]["'”’)\]]*\s|\n/;
const ABBREVIATIONS = /\b(?:e\.g|i\.e|vs|etc|approx|cf|fig|figs|no|nos|eq|ref|al|ca)\./gi;
// A title before a name ("Dr. Lavalee") never ends a sentence, capital or not.
const HONORIFICS = /\b(?:Dr|Mr|Mrs|Ms|Mx|Prof|Rev|Hon|Capt|Sgt|Lt)\./gi;

function withoutHonorificStops(text) {
  return String(text ?? '').replace(HONORIFICS, (match) => `${match.slice(0, -1)} `);
}
export const CLAUSE_JOINER = /\b(?:and|or|but|while|whereas|versus|vs\.?)\s+/gi;

export function endsSentence(text) {
  return SENTENCE_BOUNDARY.test(withoutHonorificStops(text).replace(ABBREVIATIONS, (match) => match.slice(0, -1)));
}

/** Where the clause being written starts: after its sentence's last joining word, if any. */
export function currentClauseStart(text, cursor) {
  const { sentence, sentenceStart } = writingSourceContext(text, cursor);
  const joiner = [...sentence.matchAll(CLAUSE_JOINER)].at(-1);
  return sentenceStart + (joiner ? joiner.index + joiner[0].length : 0);
}

/**
 * Whether a value claim was written before the words at the caret ("rises
 * from 6% to"). The writer has moved past it, so it is not the value being
 * typed. Only spaces or punctuation after it leave it at the caret ("by 50%.").
 */
export function writtenBeforeCaret(claim, text, cursor) {
  return ['QUANTITATIVE', 'SAMPLE_SIZE'].includes(claim.type) && claim.end <= cursor
    && /[\p{L}\p{N}]/u.test(String(text ?? '').slice(claim.end, cursor));
}

/**
 * Whether a file named in the text is the file of a focus chosen with
 * fn+Right. That focus has no text of its own, so the accepted name it came
 * from ("Bracket.step", then fn+Left and back) names the focus, not a new
 * source to choose. Compared by file name, whichever directory holds it.
 */
export function namesFocusedFile(claim, dependency) {
  if (!dependency?.focused) return false;
  const fileName = (value) => path.posix.basename(String(value ?? '')).toLowerCase();
  const focusedFile = fileName(dependency.source.path);
  return Boolean(focusedFile) && (claim.candidates ?? [])
    .some((candidate) => candidate.fileReference && fileName(candidate.path) === focusedFile);
}

/** Name fragments ending at the cursor, longest first. None starts at or before
 * `after`, the end of a value already accepted ("100 mm" is not "mm"). */
export function progressiveVariableFragments(text, cursor, after = -1) {
  const source = String(text ?? '');
  if (cursor !== source.length) return [];
  const context = writingSourceContext(source, cursor);
  if (context.literatureIntent) return [];
  const matches = [...context.sentence.matchAll(/[A-Za-z][A-Za-z0-9_./+-]*/g)];
  if (!matches.length) return [];
  const output = [];
  const first = Math.max(0, matches.length - 6);
  for (let index = first; index < matches.length; index += 1) {
    const start = context.sentenceStart + matches[index].index;
    const raw = source.slice(start, cursor);
    const leading = raw.match(/^\s*/)?.[0].length ?? 0;
    const trailing = raw.match(/\s*$/)?.[0].length ?? 0;
    const fragment = raw.slice(leading, raw.length - trailing);
    const firstWord = fragment.match(/^[A-Za-z]+/)?.[0].toLowerCase();
    if (start + leading > after && normalizedVariable(fragment).length >= 2 && !FRAGMENT_FUNCTION_WORDS.has(firstWord)) {
      output.push({ text: fragment, start: start + leading, end: cursor - trailing });
    }
  }
  return output.sort((left, right) => right.text.length - left.text.length);
}
