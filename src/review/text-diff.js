// A text or code file's changes between two versions, as a reviewer reads
// them: the changed lines with three around each, numbered in both versions.
// A comment is pinned to a line of the newer version by its number and its
// words, and found again after later saves move it.

import { sequenceOperations } from '../history/sequence-diff.js';

export const CONTEXT_LINES = 3;
export const MAX_SHOWN_LINES = 600;
/** Characters of one line; a minified file's one line is cut here. */
const MAX_LINE = 600;
/** A text file larger than this is not compared here. */
export const MAX_COMPARED_TEXT = 4 * 1024 * 1024;

/** A file's lines, without the empty one a final line break leaves. */
export function linesOf(buffer) {
  if (!buffer) return [];
  const text = buffer.toString('utf8').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return text === '' ? [] : lines;
}

const clip = (text) => (text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…` : text);

/**
 * { added, removed, hunks: [{ lines: [{ kind: same | add | remove, text, before, after }] }], truncated }.
 * `pinned` holds line numbers of the newer version kept in view, for comments on lines that did not change.
 */
export function lineDiff(beforeLines, afterLines, pinned = new Set()) {
  const operations = sequenceOperations(beforeLines, afterLines);
  const keep = operations.map(() => false);
  operations.forEach((operation, index) => {
    const marked = operation.kind !== 'remove' && pinned.has(operation.afterLine);
    if (operation.kind === 'equal' && !marked) return;
    const reach = operation.kind === 'equal' ? 1 : CONTEXT_LINES;
    for (let near = Math.max(0, index - reach); near <= Math.min(operations.length - 1, index + reach); near += 1) keep[near] = true;
  });
  const hunks = [];
  let current = null;
  let shown = 0;
  let truncated = false;
  operations.forEach((operation, index) => {
    if (!keep[index]) { current = null; return; }
    if (shown >= MAX_SHOWN_LINES) { truncated = true; return; }
    if (!current) { current = { lines: [] }; hunks.push(current); }
    current.lines.push({ kind: operation.kind === 'equal' ? 'same' : operation.kind, text: clip(operation.text ?? ''),
      before: operation.kind === 'add' ? null : operation.beforeLine, after: operation.kind === 'remove' ? null : operation.afterLine });
    shown += 1;
  });
  return { added: operations.filter((item) => item.kind === 'add').length,
    removed: operations.filter((item) => item.kind === 'remove').length, hunks, truncated };
}

/**
 * Where a comment pinned to `anchor` ({ line, text }) sits in `lines` now: the
 * same line when it still reads the same, else the nearest line that reads
 * as it did, else null (the line is gone).
 */
export function findLine(lines, anchor) {
  if (lines[anchor.line - 1] === anchor.text) return anchor.line;
  let best = null;
  lines.forEach((text, index) => {
    if (text !== anchor.text) return;
    if (best === null || Math.abs(index + 1 - anchor.line) < Math.abs(best - anchor.line)) best = index + 1;
  });
  return best;
}
