// A sentence that has named a figure and stops on a word asking for it
// ("The deposit in transit was ", "Revenue for September came in at ") wants
// that figure next. The value whose row the sentence named in full is the
// answer: it goes before column names, dictionary entries and other rows,
// and Tab writes the value alone, since the sentence already says what it is.
// A number begun after the words ("Gross profit was 1") asks the same, for a
// figure that begins with what was typed.

import { typedWordKeys } from './direct-match.js';
import { currentClauseStart } from './writing-context.js';

/** Words after which a sentence goes on with a figure. */
export const VALUE_CUE_WORDS = new Set([
  'was', 'were', 'is', 'are', 'be', 'been', 'at', 'of', 'for', 'to', 'by',
  'total', 'totals', 'totaled', 'totalled', 'equal', 'equals', 'equaled', 'equalled',
  'reached', 'owed', 'owes', 'cost', 'costs',
]);

/** Object types that hold one figure of a table. */
const TABLE_VALUE_TYPES = new Set(['DATASET_VALUE', 'RESULT', 'VALUE']);

// A column of planned or worked-out figures answers only when the sentence
// says so ("budget", "variance"): "Revenue was" asks what revenue was.
const QUALIFYING_COLUMN_WORDS = new Set(['budget', 'forecast', 'plan', 'planned', 'target', 'projected', 'estimate',
  'minus', 'variance', 'difference', 'delta', 'prior', 'previous'].flatMap((word) => typedWordKeys(word)));

/** Leaves room below for a column that fits badly while still above every other suggestion. */
const COLUMN_FIT_BASE = 5;

/**
 * @typedef {{ words: string[], figure: string | null }} ValueRequest
 * The typed words, as match keys, and the digits of a number begun after them.
 */

/**
 * What the clause being written asks for when it ends on a value cue
 * followed by the caret (spaces allowed); null otherwise.
 * @param {string} text
 * @param {number} [cursor]
 * @returns {ValueRequest | null}
 */
export function valueRequest(text, cursor) {
  const source = String(text ?? '');
  const end = Number.isInteger(cursor) ? cursor : source.length;
  const clause = source.slice(currentClauseStart(source, end), end);
  const lastWord = clause.match(/(\p{L}+)\s*$/u)?.[1]?.toLowerCase();
  if (!lastWord || !VALUE_CUE_WORDS.has(lastWord)) return null;
  const words = typedWordKeys(clause);
  return words.length ? { words, figure: null } : null;
}

/**
 * What a claim of a typed number asks for: its words and the number's digits.
 * @param {string} claimText such as "Gross profit was 1"
 * @returns {ValueRequest | null}
 */
export function figureRequest(claimText) {
  const text = String(claimText ?? '');
  const figure = digits(text.match(/[-+−]?[\d,]*\.?\d+\s*$/u)?.[0] ?? '');
  const words = typedWordKeys(text);
  return figure && words.length ? { words, figure } : null;
}

/** A number's digits and decimal point, without sign, grouping or spaces. */
function digits(number) {
  return String(number ?? '').replace(/[^\d.]/g, '');
}

/**
 * How well `object` answers `request`: 0 unless it is a table's figure whose
 * row the sentence named in full (every word of "Deposit in transit" typed)
 * and, when a number was begun, whose value begins with it. Then at least 1,
 * and higher the more its column fits: each column word typed adds one, each
 * planning or variance word not typed takes one away.
 * @param {{ objectType?: string, valueText?: string, anchor?: { rowKey?: string, column?: string } | null,
 *   metadata?: { row?: string, column?: string } }} object
 * @param {ValueRequest | null | undefined} request
 * @returns {number}
 */
export function valueAnswerScore(object, request) {
  if (!request?.words?.length || !TABLE_VALUE_TYPES.has(object?.objectType)) return 0;
  if (request.figure && !digits(object.valueText).startsWith(request.figure)) return 0;
  const row = object.anchor?.rowKey ?? object.metadata?.row;
  if (typeof row !== 'string') return 0;
  const rowWords = typedWordKeys(row);
  if (!rowWords.length || !rowWords.every((word) => request.words.includes(word))) return 0;
  const columnWords = typedWordKeys(String(object.anchor?.column ?? object.metadata?.column ?? ''));
  const typed = columnWords.filter((word) => request.words.includes(word)).length;
  const unasked = columnWords.filter((word) => QUALIFYING_COLUMN_WORDS.has(word) && !request.words.includes(word)).length;
  return Math.max(1, COLUMN_FIT_BASE + typed - unasked);
}
