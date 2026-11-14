// What an object is retrieved by while typing: the text it offers, its own
// words and how it scores. Shared by the list a small folder keeps in memory
// (workspace-suggestions.js) and the columns a large folder keeps (search-index.js).

import { RETRIEVABLE_TYPES } from './constants.js';
import { ownWordKeys } from './direct-match.js';
import { dependencyFilePriority } from './file-objects.js';
import { workspaceCompletionText } from './workspace-completion.js';

export const RESULT_TYPES = new Set(['VARIABLE', 'RESULT', 'VALUE', 'DATASET_ROW', 'DATASET_VALUE', 'DATASET', 'TABLE']);
export const METHOD_TYPES = new Set(['METHOD', 'MODEL', 'PARAMETER', 'PROTOCOL', 'ANALYSIS_RUN']);

/** An object as workspace suggestions retrieve it, or null when it offers no text. */
export function retrievalObject(object) {
  if (!RETRIEVABLE_TYPES.has(object.objectType)) return null;
  const retrievalText = workspaceCompletionText(object);
  if (!retrievalText || (object.objectType === 'VARIABLE' && !/[A-Za-z]/.test(retrievalText))) return null;
  // Only the object's own words: a sentence never matches where it is filed.
  return { ...object, retrievalText, retrievalTokens: ownWordKeys(object, retrievalText) };
}

/** What scoring reads of an object besides its words. */
export function retrievalFeatures(object) {
  return {
    resultType: RESULT_TYPES.has(object.objectType),
    methodType: METHOD_TYPES.has(object.objectType),
    identifier: /^(?:sample|subject|participant|patient)?[_ -]?id$|^(?:group|cohort)$/i.test(object.metadata.variable ?? object.label),
    priority: dependencyFilePriority({ path: object.path }),
  };
}

/**
 * How well an object that shares typed words answers the sentence. More of
 * the typed words, and the last one typed, put an object higher.
 * @param {{ coverage: number, endsOnMatch: boolean, intended: boolean, dictionary: boolean, rowCount: boolean, identifier: boolean }} match
 * @returns {number}
 */
export function retrievalScore({ coverage, endsOnMatch, intended, dictionary, rowCount, identifier }) {
  let score = 0.46 + coverage * 0.4 + (endsOnMatch ? 0.06 : 0);
  if (intended) score += 0.04;
  if (dictionary) score += 0.02;
  if (rowCount) score -= 0.32;
  if (identifier) score *= 0.38;
  return Number(Math.min(0.98, score).toFixed(3));
}
