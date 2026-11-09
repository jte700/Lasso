// How a typed name matches a variable, a measured part or a row identifier.

import { humanVariable, normalizedVariable } from './tabular.js';
import { tokenOverlap, variableTokens, wordTokens } from './text-similarity.js';
import { measurementDescriptor } from './value-match.js';

// What can have values below it: a CAD part's measurements, a table row's
// cells or a column's values. Anything else offered is a value itself.
export const VALUE_HOLDERS = new Set(['DRAWING', 'DATASET_ROW', 'VARIABLE']);

// Rows keyed by a code ("CO-001", "S014") are found by typing the code's own
// terms elsewhere; as typed names they would bury real names on two letters.
const IDENTIFIER_HEADER = /(?:^|\s)(?:id|code|no|number|ref|reference|sample|subject|participant|patient)$/i;
const IDENTIFIER_VALUE = /^[A-Za-z]{0,6}[-_]?\d[\w-]*$/;

export function isIdentifierRow(object) {
  const header = humanVariable(object.metadata.columns?.[0] ?? '');
  return IDENTIFIER_HEADER.test(header) || IDENTIFIER_VALUE.test(String(object.metadata.row ?? object.label).trim());
}

export function measuredPartWords(object) {
  return variableTokens(humanVariable(object.metadata?.entityName ?? ''));
}

// "bracket length": a measured part's name leads the words and the rest begin
// words of one of its measurements, so other models' lengths do not qualify.
export function namesMeasuredPart(object, queryWords, part = measuredPartWords(object)) {
  if (!part.length || queryWords.length <= part.length || part.some((word, index) => queryWords[index] !== word)) return false;
  return queryWords.slice(part.length).every((word) => object.variableWords.some((candidate) => candidate.startsWith(word)));
}

/** How a variable's name matches what is typed, apart from naming a measured part. */
export function variableNameMatch(name, normalizedQuery, queryWords) {
  const exact = name.normalizedVariable === normalizedQuery;
  const prefix = !exact && name.normalizedVariable.startsWith(normalizedQuery);
  // Only a match that starts a word counts; "is" must not match "Revision".
  const contains = !prefix && name.wordSuffixes.some((suffix) => suffix.startsWith(normalizedQuery));
  const tokenPrefix = queryWords.length > 0 && queryWords.every((word) => name.variableWords
    .some((candidateWord) => candidateWord === word || candidateWord.startsWith(word)));
  return { exact, prefix, contains, tokenPrefix };
}

// Weak keys allow these features to disappear as bounded snapshot caches evict
// their immutable objects. Query text is never retained here.
const matchingFeatures = new WeakMap();
export function objectMatchingFeatures(object) {
  const cached = matchingFeatures.get(object);
  if (cached) return cached;
  const fields = [object.metadata.variable, object.metadata.column, object.metadata.description,
    object.metadata.definition, object.metadata.inferredMeaning, object.label].filter(Boolean);
  const features = {
    numeric: measurementDescriptor(object.valueText),
    words: new Set(wordTokens(`${object.label} ${object.searchText}`)),
    variables: fields.map(normalizedVariable),
    variableWords: fields.map((field) => new Set(wordTokens(humanVariable(field)))),
    definitionKeys: [object.metadata.variable, object.metadata.column, object.metadata.row,
      String(object.label).split(' · ')[0]].map(normalizedVariable),
  };
  if (Object.isFrozen(object)) matchingFeatures.set(object, features);
  return features;
}

export function variableSimilarity(expected, expectedWords, features) {
  if (expected === null) return 0;
  if (features.variables.includes(expected)) return 1;
  return Math.max(0, ...features.variableWords.map((words) => tokenOverlap(expectedWords, words)));
}
