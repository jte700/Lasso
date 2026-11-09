// Table rows and fields named while writing: row references, fragments of a
// row or field name, and the cues that ask for a field.

import { canonicalRowReference, normalizedRowSearch, rowSearchAliases } from './row-names.js';
import { humanVariable, normalizedVariable } from './tabular.js';
import { rowEditDistance, STOP_WORDS, variableTokens } from './text-similarity.js';

const rowReferencePrefix = (reference) => reference.replace(/\d+$/, '');

/** A word and number name a row only when the table's own row identifiers use
 * that word: "control 2" or "CON 9" beside CON4, but not "was 48", which is
 * the value being typed. */
export function rowReferencesInText(value, rowKeys) {
  const prefixes = new Set(rowKeys.map((rowKey) => rowReferencePrefix(canonicalRowReference(rowKey))).filter(Boolean));
  return new Set([...String(value ?? '').matchAll(/\b[A-Za-z]{1,16}[\s_-]*\d+\b/gi)]
    .map((match) => canonicalRowReference(match[0]))
    .filter((reference) => reference && prefixes.has(rowReferencePrefix(reference))));
}

function dependencyReferencesTableRow(dependency) {
  const source = dependency?.source ?? {};
  const anchor = source.anchor ?? {};
  if (source.objectType === 'DATASET_ROW' || anchor.kind === 'table-row') return true;
  if (anchor.kind !== 'table-cell' || !anchor.rowKey) return false;
  const linkedText = normalizedRowSearch(dependency?.spanText);
  const rowKey = normalizedRowSearch(anchor.rowKey);
  const sourceValue = normalizedRowSearch(source.valueText);
  return Boolean(linkedText && rowKey && linkedText === rowKey && linkedText !== sourceValue);
}

export function semanticDependencySource(dependency) {
  const source = dependency?.source ?? {};
  if (!dependencyReferencesTableRow(dependency)) return source;
  const anchor = source.anchor ?? {};
  const rowKey = String(anchor.rowKey ?? source.metadata?.row ?? dependency.spanText ?? '').trim();
  return {
    ...source,
    objectType: 'DATASET_ROW',
    valueText: null,
    anchor: {
      kind: 'table-row',
      rowKey,
      rowIndex: anchor.rowIndex,
      sheet: anchor.sheet,
    },
    metadata: {
      ...source.metadata,
      row: rowKey,
      variable: rowKey || source.metadata?.variable || null,
      column: null,
      referenceKind: 'ROW',
    },
  };
}

export function rowCompletionFragments(value) {
  const source = String(value ?? '');
  const tokens = [...source.matchAll(/[A-Za-z0-9][A-Za-z0-9_.-]*/g)];
  if (!tokens.length || tokens.at(-1).index + tokens.at(-1)[0].length !== source.length) return [];
  return tokens.slice(-3).map((match, index, suffix) => {
    const first = suffix[index];
    const text = source.slice(first.index);
    return { text, start: first.index, end: source.length, normalized: normalizedRowSearch(text) };
  }).filter((fragment) => fragment.normalized.length >= 2)
    .sort((left, right) => right.normalized.length - left.normalized.length);
}

export function rowCompletionScore(fragment, rowKey) {
  const query = fragment.normalized;
  let best = 0;
  for (const alias of rowSearchAliases(rowKey)) {
    if (alias === query) best = Math.max(best, 1);
    else if (alias.startsWith(query)) {
      best = Math.max(best, 0.9 + Math.min(0.08, query.length / Math.max(alias.length, 1) * 0.08));
    } else if (query.length >= 3) {
      const compared = alias.slice(0, Math.min(alias.length, query.length));
      const distance = rowEditDistance(query, compared);
      const allowance = Math.max(1, Math.floor(query.length / 4));
      if (distance <= allowance) best = Math.max(best, 0.78 - distance * 0.08);
    }
  }
  return best;
}

export function fieldCompletionFragments(value) {
  const source = String(value ?? '');
  const tokens = [...source.matchAll(/[A-Za-z0-9][A-Za-z0-9_.()/-]*/g)];
  if (!tokens.length || tokens.at(-1).index + tokens.at(-1)[0].length !== source.length) return [];
  return tokens.slice(-4).map((match, index, suffix) => {
    const first = suffix[index];
    const text = source.slice(first.index);
    return { text, start: first.index, end: source.length, normalized: normalizedVariable(text) };
  }).filter((fragment) => fragment.normalized.length >= 1)
    .sort((left, right) => right.normalized.length - left.normalized.length);
}

export function fieldCompletionScore(fragment, field) {
  const query = fragment.normalized;
  const candidate = normalizedVariable(field);
  if (!query || !candidate) return 0;
  if (candidate === query) return 1;
  if (candidate.startsWith(query)) return 0.9 + Math.min(0.08, query.length / candidate.length * 0.08);
  const words = variableTokens(humanVariable(field));
  if (words.some((word) => word.startsWith(humanVariable(fragment.text)))) return 0.86;
  if (query.length >= 3 && candidate.includes(query)) return 0.76;
  return 0;
}

export function fieldNavigationCue(value) {
  return /(?:^|\s)(?:for|during|in|at|from|under|across|column|field|period|quarter|year|month)(?:\s+the)?\s*$/i
    .test(String(value ?? ''));
}

export function mentionedFields(value, fields) {
  const text = ` ${humanVariable(value)} `;
  return new Set(fields.filter((field) => {
    const normalized = humanVariable(field);
    return normalized && text.includes(` ${normalized} `);
  }).map(normalizedVariable));
}

// Cue words that ask for any field rather than one kind.
export const OPEN_FIELD_CUES = new Set(['is', 'was', 'are', 'were']);

/** How many words of a column's name the writer used ("budget" for September Budget CAD). */
export function namedFieldWords(tail, field) {
  const written = new Set(variableTokens(tail));
  return variableTokens(humanVariable(field))
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word) && written.has(word)).length;
}

export function tabularProvenanceLabel(object) {
  const anchor = object.anchor ?? {};
  const parts = [object.metadata.sheet, anchor.rowKey ?? object.metadata.row, anchor.column ?? object.metadata.column]
    .filter((part, index, values) => part != null && part !== '' && values.indexOf(part) === index);
  return parts.join(' · ');
}
