import { normalizedRowSearch, rowSearchAliases } from './row-names.js';

// The names a large table's rows are found by in the table index.

const MAX_TERM_LENGTH = 64;
// A longer label is not a name anyone types.
const MAX_LABEL_LENGTH = 180;

/** The names a row can be found by: its label whole, from each word on, and as a numbered reference. */
export function rowTerms(label) {
  const text = String(label ?? '').trim();
  if (!text || text.length > MAX_LABEL_LENGTH) return [];
  const terms = new Set(rowSearchAliases(text));
  const words = text.replace(/[_./-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (let index = 1; index < words.length; index += 1) terms.add(words.slice(index).join(''));
  return [...terms].map((term) => term.slice(0, MAX_TERM_LENGTH)).filter((term) => term.length >= 2);
}

/**
 * The term a row's whole name is stored under, one of its `rowTerms`, or ''
 * when its name gives none (too short, too long, or no letters or digits).
 * Rows whose names only end the same way share it too, so a caller checks
 * each row's name.
 */
export function nameTerm(label) {
  const text = String(label ?? '').trim();
  if (!text || text.length > MAX_LABEL_LENGTH) return '';
  const term = normalizedRowSearch(text).slice(0, MAX_TERM_LENGTH);
  return term.length >= 2 ? term : '';
}
