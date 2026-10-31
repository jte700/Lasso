// Which typed words a source object itself contains. A suggestion is offered
// for words the writer typed that appear in the object's own text: a column
// or row title, a cell value, a slide or document sentence, a room, part or
// measurement name. Where the object is filed (its folder, format, sheet
// position, how it was extracted) is not something a sentence can match.

import { writingSourceContext } from './writing-context.js';

/**
 * Metadata that holds the object's own words, rather than facts about the
 * file. A sheet's name and a row's column headers are shared by every object
 * in the sheet, so they would make one typed word match all of them.
 */
const CONTENT_METADATA_KEYS = Object.freeze([
  'variable', 'column', 'samples', 'units', 'description', 'definition', 'label', 'value',
  'roomName', 'entityName', 'propertyName', 'featureName', 'productId', 'searchTerms', 'storey',
]);

/** Objects that stand for a whole file, matched by its name: their parts are objects of their own. */
const WHOLE_FILE_TYPES = new Set(['DOCUMENT', 'DATASET', 'TABLE']);

/** Words a sentence is built with that say nothing about which source it means. */
const FUNCTION_WORDS = new Set([
  'about', 'above', 'after', 'again', 'all', 'also', 'and', 'any', 'are', 'because', 'been', 'before', 'being',
  'below', 'between', 'both', 'but', 'can', 'could', 'did', 'does', 'doing', 'down', 'during', 'each', 'few',
  'for', 'from', 'further', 'get', 'got', 'had', 'has', 'have', 'having', 'her', 'here', 'him', 'his', 'how',
  'into', 'its', 'just', 'let', 'like', 'may', 'might', 'more', 'most', 'much', 'must', 'need', 'needs', 'not',
  'across', 'among', 'based', 'levels', 'per', 'prior', 'shown', 'used', 'using', 'via', 'within', 'without',
  'now', 'off', 'once', 'only', 'other', 'our', 'ours', 'out', 'over', 'own', 'please', 'same', 'shall', 'she',
  'should', 'some', 'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
  'those', 'through', 'too', 'under', 'until', 'upon', 'very', 'was', 'were', 'what', 'when', 'where', 'which',
  'while', 'who', 'whom', 'why', 'will', 'with', 'would', 'yet', 'you', 'your', 'yours',
]);

/**
 * Words that say a study is being reported, not which source reports it:
 * "We found that" or "The results showed" name no column and no passage.
 */
const STUDY_CUE_WORDS = new Set([
  'analyse', 'analysed', 'analysis', 'analyze', 'analyzed', 'cohort', 'compare', 'compared', 'data', 'dataset', 'demonstrate', 'demonstrated', 'detect', 'detected', 'estimate',
  'estimated', 'experiment', 'find', 'found', 'identified', 'identify', 'include', 'included', 'includes',
  'indicate', 'indicated', 'indicates', 'measure', 'measured', 'model', 'observe', 'observed', 'observes',
  'report', 'reported', 'result', 'results', 'reveal', 'revealed', 'sample', 'samples', 'show', 'showed',
  'shows', 'study',
]);

/**
 * One key for a word's common forms, so "raise", "raised" and "raising"
 * match, as do "pool" and "pools".
 * @param {string} word
 * @returns {string}
 */
export function matchKey(word) {
  let value = String(word).toLowerCase();
  // The plural first ("meetings" to "meeting"), then the verb ending, then a
  // silent e, so each form of a word ends on the same letters.
  if (value.length > 4 && value.endsWith('ies')) value = `${value.slice(0, -3)}y`;
  else if (value.length > 4 && /(?:s|x|z|ch|sh)es$/.test(value)) value = value.slice(0, -2);
  else if (value.length > 3 && value.endsWith('s') && !/(?:ss|us|is)$/.test(value)) value = value.slice(0, -1);
  if (value.length > 5 && value.endsWith('ing')) value = value.slice(0, -3);
  else if (value.length > 4 && value.endsWith('ied')) value = `${value.slice(0, -3)}y`;
  else if (value.length > 4 && value.endsWith('ed') && !value.endsWith('eed')) value = value.slice(0, -2);
  if (value.length > 3 && value.endsWith('e')) value = value.slice(0, -1);
  return value;
}

// A hyphenated word ("General-Ledger", "gal-3") counts whole and by its parts.
function words(text) {
  return (String(text ?? '').toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [])
    .flatMap((word) => word.includes('-') ? [word, ...word.split('-').filter((part) => /^[a-z][a-z0-9]{2,}$/.test(part))] : [word]);
}

function strings(value, output = [], depth = 0) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value) && depth < 2) for (const item of value) strings(item, output, depth + 1);
  return output;
}

/**
 * The match keys of an object's own words: its label, its value, the text it
 * is offered as, and the metadata that holds its words.
 * @param {{ objectType?: string, anchor?: object | null, label?: string, valueText?: string,
 *   metadata?: Record<string, unknown> }} object
 * @param {string} [offeredText]
 * @returns {string[]}
 */
export function ownWordKeys(object, offeredText = '') {
  const metadata = object.metadata ?? {};
  const text = WHOLE_FILE_TYPES.has(object.objectType) && !object.anchor ? `${object.label} ${offeredText}`
    : [object.label, object.valueText, offeredText, ...CONTENT_METADATA_KEYS.flatMap((key) => strings(metadata[key]))].join(' ');
  // "not" in a source is never the "not" of a typed "notes".
  return [...new Set(words(text).filter((word) => !FUNCTION_WORDS.has(word)).map(matchKey))];
}

/**
 * The match keys of the words a writer typed that could name a source, in
 * the order typed, each once.
 * @param {string} sentence
 * @returns {string[]}
 */
export function typedWordKeys(sentence) {
  return [...new Set(words(sentence).filter((word) => !FUNCTION_WORDS.has(word) && !STUDY_CUE_WORDS.has(word))
    .map(matchKey))];
}

/**
 * The sentence being written: the text before the caret, after the last
 * sentence ending or line break.
 * @param {string} text
 * @param {number} cursor
 * @returns {string}
 */
export function typedSentence(text, cursor) {
  // Where the server's suggestions read it from, so "Inc. " ends no sentence here either.
  return writingSourceContext(text, cursor).sentence;
}

/**
 * The words of a source's text, as written there, that are forms of the
 * words typed: what its preview marks. Each word once, in source order.
 * @param {string} sentence
 * @param {string} sourceText
 * @returns {string[]}
 */
export function matchedSourceWords(sentence, sourceText) {
  const typed = new Set(typedWordKeys(sentence));
  if (!typed.size) return [];
  const seen = new Set();
  return (String(sourceText ?? '').match(/[A-Za-z][A-Za-z0-9]{2,}/g) ?? []).filter((word) => {
    const lower = word.toLowerCase();
    if (seen.has(lower) || !typed.has(matchKey(lower))) return false;
    seen.add(lower);
    return true;
  });
}
