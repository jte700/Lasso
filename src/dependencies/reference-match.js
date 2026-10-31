// How a typed author or title matches a paper or reference, and how a reference is written in text.

import { firstAuthorFamily } from './authors.js';
import { normalizedVariable } from './tabular.js';
import { editDistance, normalizedName, overlapScore, prefixTokenScore, variableTokens } from './text-similarity.js';

export function referenceSimilarity(query, object) {
  const expected = normalizedVariable(query);
  if (expected.length < 2) return 0;
  const fields = [
    object.label,
    object.valueText,
    object.metadata.author,
    object.metadata.title,
    object.metadata.subject,
    object.metadata.fileName,
    object.path,
  ].filter(Boolean).map(String);
  let best = 0;
  for (const field of fields) {
    const normalized = normalizedVariable(field);
    if (normalized === expected) return 1;
    if (normalized.startsWith(expected)) best = Math.max(best, 0.96);
    else if (normalized.includes(expected)) best = Math.max(best, 0.86);
    best = Math.max(best, prefixTokenScore(query, field));
    if (expected.length >= 3) {
      for (const token of field.match(/[A-Za-z0-9][A-Za-z0-9'’_.-]*/g) ?? []) {
        const actual = normalizedVariable(token);
        const compared = actual.slice(0, Math.min(actual.length, expected.length));
        const allowance = Math.max(1, Math.floor(expected.length / 4));
        if (compared && editDistance(expected, compared) <= allowance) best = Math.max(best, 0.74);
      }
    }
  }
  if (variableTokens(query).length > 1) {
    best = Math.max(best, ...fields.map((field) => overlapScore(query, field) * 0.9));
  }
  return best;
}

export function authorSimilarity(claimAuthor, author) {
  const expected = normalizedName(claimAuthor);
  if (!expected) return 0;
  const first = String(author ?? '').split(/\s+(?:and|&)\s+|\s*;\s*/i)[0].trim();
  const fields = [first, firstAuthorFamily(first), ...(first.match(/[A-Za-z'’-]+/g) ?? [])]
    .map(normalizedName).filter(Boolean);
  let best = 0;
  for (const actual of fields) {
    if (expected === actual) return 1;
    if (actual.startsWith(expected)) best = Math.max(best, 0.94);
    else if (expected.startsWith(actual) && actual.length >= 3) best = Math.max(best, 0.86);
    const distance = editDistance(expected, actual);
    const similarity = 1 - distance / Math.max(expected.length, actual.length);
    if (similarity >= 0.7) best = Math.max(best, similarity);
  }
  return best;
}

function narrativeCitationText(object) {
  const author = String(object?.metadata?.author ?? '').trim();
  const family = firstAuthorFamily(author);
  const authors = Array.isArray(object?.metadata?.authors) ? object.metadata.authors : [];
  const multiple = authors.length > 1 || /\s+(?:and|&)\s+|;/.test(author);
  const year = String(object?.metadata?.year ?? '').trim();
  if (family) return `${family}${multiple ? ' et al.' : ''}${year ? ` (${year})` : ''}`;
  const label = String(object?.label ?? '').trim();
  return label.replace(/,\s*((?:19|20)\d{2}[a-z]?)$/i, ' ($1)');
}

export function referenceCompletionText(object, query, mode = 'any') {
  if (mode === 'author') {
    return narrativeCitationText(object);
  }
  if (mode === 'any') {
    const author = authorSimilarity(query, object.metadata.author);
    const title = referenceTitleSimilarity(query, object);
    if (author >= 0.7 && author >= title) return narrativeCitationText(object);
  }
  return String(object.metadata.title ?? object.label ?? '').trim();
}

export function referenceTitleSimilarity(query, object) {
  const expected = normalizedVariable(query);
  if (expected.length < 2) return 0;
  const fields = [object.metadata.title, object.metadata.subject,
    object.objectType === 'DOCUMENT' ? object.valueText : null].filter(Boolean);
  if (!fields.length) return 0;
  return referenceSimilarity(query, { ...object, label: '', valueText: '', path: '', metadata: {
    author: null, fileName: null, title: fields[0], subject: fields.slice(1).join(' '),
  } });
}
