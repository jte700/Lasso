// The text a workspace object completes to, the category it is listed under,
// and the part of the sentence that completion replaces.

import { humanVariable } from './tabular.js';
import { STOP_WORDS } from './text-similarity.js';

// The values of a focus chosen on the words being typed replace those words
// and anything typed after them ("brac" → "100 mm"). Trailing spaces stay,
// including the no-break space browser editors leave at the caret.
export function replacingFocusWords(completions, dependency, text, cursor) {
  if (!dependency?.replacesText) return completions;
  const { start } = dependency.anchor;
  const claimEnd = start + text.slice(start, cursor).replace(/[^\S\r\n]+$/, '').length;
  return completions.map((completion) => ({ ...completion, claimStart: start, claimEnd }));
}

// One document: a file, or one sheet of a workbook.
export function sameDocument(left, right) {
  const sheet = (object) => object.metadata?.sheet ?? object.anchor?.sheet ?? '';
  return left.path === right.path && sheet(left) === sheet(right);
}

// Each ranked name followed by the same name in other documents, in its
// place and ranking, so they stay together and crowd out no other name.
export function withSameNamed(candidates) {
  return candidates.flatMap(({ sameNamed = [], ...candidate }) => [candidate,
    ...sameNamed.map((other) => ({ ...other, ranking: candidate.ranking }))]);
}

const CONTEXTUAL_INSERTION_CUES = new Set([
  ...STOP_WORDS,
  'a', 'an', 'as', 'at', 'be', 'been', 'being', 'by', 'can', 'could', 'did', 'do', 'does',
  'had', 'in', 'is', 'it', 'may', 'might', 'must', 'of', 'on', 'or', 'should', 'to',
  'will', 'would', 'than', 'through', 'under', 'during', 'across', 'around', 'approximately',
  'roughly', 'we', 'us', 'ours', 'study', 'analysis', 'dataset', 'data', 'result', 'results',
  'cohort', 'experiment', 'sample', 'samples', 'model', 'find', 'found', 'show', 'showed',
  'shows', 'observe', 'observed', 'observes', 'detect', 'detected', 'identify', 'identified',
  'report', 'reported', 'measure', 'measured', 'reveal', 'revealed', 'indicate', 'indicated',
  'indicates', 'demonstrate', 'demonstrated', 'estimate', 'estimated', 'include', 'included',
  'includes', 'increased', 'decreased',
]);

export function normalizedCompletionPhrase(value) {
  return String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Contextual matches still complete the word being typed, even when that word
 * did not produce the match. Finished cues and explicit table selectors instead
 * introduce the value that follows them. All positions stay in UTF-16 space. */
export function contextualCompletionRange(text, cursor, replacementText, options = {}) {
  const source = String(text ?? '');
  const floor = Math.max(0, options.floor ?? 0);
  const before = source.slice(floor, cursor);
  const insertion = { claimStart: cursor, claimEnd: cursor };
  const tokenPattern = /[+\-−]?[\p{L}\p{N}\p{M}]+(?:['’_.\/+\-−][\p{L}\p{N}\p{M}]+)*%?/gu;
  const tokens = [...before.matchAll(tokenPattern)];
  const last = tokens.at(-1);
  // A trailing space, closing quote, or other punctuation ends the typed word.
  // A decimal point after a number is still a partial numeric value.
  const decimalTail = last && /^[-+−]?\d/.test(last[0])
    && last.index + last[0].length === before.length - 1 && before.endsWith('.');
  if (!last || (last.index + last[0].length !== before.length && !decimalTail)) return insertion;

  const suffixes = tokens.slice(-6).map((token) => ({
    start: floor + token.index,
    text: before.slice(token.index),
  }));
  const preserved = new Set((options.preserveSuffixes ?? [])
    .map((value) => normalizedCompletionPhrase(value).replaceAll(' ', '')).filter(Boolean));
  if (suffixes.some((suffix) => preserved.has(normalizedCompletionPhrase(suffix.text).replaceAll(' ', '')))) {
    return insertion;
  }
  const completion = normalizedCompletionPhrase(replacementText);
  // Prefer an entire matching phrase over just its final partial word.
  for (const suffix of suffixes.slice(0, -1)) {
    const phrase = normalizedCompletionPhrase(suffix.text);
    if (phrase && completion.startsWith(phrase)) return { claimStart: suffix.start, claimEnd: cursor };
  }
  if (CONTEXTUAL_INSERTION_CUES.has(last[0].toLowerCase())) return insertion;
  return { claimStart: floor + last.index, claimEnd: cursor };
}

// Sentence and paragraph objects indexed from a source's own prose: PDF pages,
// and Markdown or plain-text files. Each one cites exactly its passage.
const EXCERPT_COMPONENTS = new Set(['PDF_EXCERPT', 'TEXT_EXCERPT']);

export function isPassageExcerpt(object) {
  return EXCERPT_COMPONENTS.has(object?.metadata?.componentType);
}

export function workspaceCompletionText(object) {
  const variable = String(object.metadata.variable ?? object.metadata.column ?? '').trim();
  const value = String(object.valueText ?? '').trim();
  if (isPassageExcerpt(object)) return value;
  if (object.objectType === 'DRAWING_ANNOTATION') return `${object.label} is ${value}`;
  if (object.metadata.metric === 'row-count' && value) {
    const dataset = String(object.metadata.dataset ?? object.label).replace(/\s*·\s*included rows$/i, '');
    const sheet = object.metadata.sheet ? ` (${object.metadata.sheet})` : '';
    const count = object.metadata.rows ?? value.replace(/^n\s*=\s*/i, '');
    return `${dataset}${sheet} included ${count} observations`;
  }
  if (object.objectType === 'DATASET_ROW') return object.label;
  if (object.objectType === 'VARIABLE') return variable || object.label;
  if (['RESULT', 'VALUE', 'DATASET_VALUE'].includes(object.objectType) && variable && value) {
    const unit = object.metadata.units ? ` ${object.metadata.units}` : '';
    return `${humanVariable(variable)} was ${value}${unit}`;
  }
  if (['METHOD', 'PARAMETER', 'PROTOCOL'].includes(object.objectType)) return value || object.label;
  return object.label || value;
}

const SLIDE_TEXT_CATEGORIES = Object.freeze({ title: 'Slide title', row: 'Slide table row', line: 'Slide text' });

export function workspaceSuggestionCategory(object) {
  if (isPassageExcerpt(object)) {
    if (object.metadata.excerptType === 'note') return 'Sheet note';
    if (object.metadata.format === 'PPTX' && SLIDE_TEXT_CATEGORIES[object.metadata.excerptType]) {
      return SLIDE_TEXT_CATEGORIES[object.metadata.excerptType];
    }
    const format = object.metadata.componentType === 'PDF_EXCERPT' ? 'PDF'
      : { MARKDOWN: 'Markdown', PPTX: 'Slide' }[object.metadata.format] ?? 'Text';
    return `${format} ${object.metadata.excerptType === 'paragraph' ? 'paragraph' : 'sentence'}`;
  }
  if (object.objectType === 'DRAWING_ANNOTATION') return 'Drawing measurement';
  if (object.objectType === 'DATASET_ROW') return 'Row';
  if (object.objectType === 'VARIABLE') return 'Variable';
  if (['RESULT', 'VALUE', 'DATASET_VALUE'].includes(object.objectType)) return 'Result';
  if (['METHOD', 'PARAMETER', 'PROTOCOL', 'MODEL'].includes(object.objectType)) return 'Method';
  if (['FIGURE', 'TABLE'].includes(object.objectType)) return object.objectType === 'FIGURE' ? 'Figure' : 'Table';
  return 'Workspace';
}
