// The shortest edit between two lists of lines (or markdown blocks). Lines
// found on one side only are set aside first: they are certainly removed or
// added, so new text costs the search nothing. The lines left are compared
// with a table of common lengths when both lists are short, as the earlier
// comparison did, and otherwise with Myers' algorithm in linear space, whose
// work grows with the length of the files times the number of changed lines,
// so a small edit to a very long file is still reported line by line.

/**
 * The most steps one search may take: every diagonal tried and every equal
 * line walked counts as one. Two long files with little in common would
 * otherwise take time that grows with the square of their length, and the
 * comparison runs while a folder's change is being recorded. Past this limit
 * the lines between the shared start and end are reported as removed and
 * then added. New text costs no steps; three million keep about a thousand
 * moved lines or two thousand added blank lines in a 50,000-line file exact,
 * and give up on a hopeless file in a few tens of milliseconds.
 */
export const MAX_DIFF_STEPS = 3_000_000;

/**
 * The largest table of common lengths, in cells (lines before times lines
 * after), that is filled in instead of searching. The table is always exact,
 * so no pair the earlier comparison reported exactly gets coarser.
 */
export const MAX_TABLE_CELLS = 1_000_000;

const UNMATCHED = -1;

function sharedPrefixLength(before, after) {
  const limit = Math.min(before.length, after.length);
  let length = 0;
  while (length < limit && before[length] === after[length]) length += 1;
  return length;
}

function sharedSuffixLength(before, after, prefix) {
  const limit = Math.min(before.length, after.length) - prefix;
  let length = 0;
  while (length < limit && before[before.length - 1 - length] === after[after.length - 1 - length]) length += 1;
  return length;
}

/**
 * The two lists as numbers, one per distinct line, so that comparing two
 * lines costs the same however long they are. Numbers below `distinctBefore`
 * are lines the before list holds.
 */
function numberedLines(before, after) {
  const numbers = new Map();
  const numberOf = (line) => {
    if (!numbers.has(line)) numbers.set(line, numbers.size);
    return numbers.get(line);
  };
  const a = Int32Array.from(before, numberOf);
  const distinctBefore = numbers.size;
  const b = Int32Array.from(after, numberOf);
  return { a, b, distinctBefore };
}

function positionsWhere(numbers, keep) {
  const positions = [];
  numbers.forEach((number, index) => {
    if (keep(number)) positions.push(index);
  });
  return Int32Array.from(positions);
}

/**
 * The positions of the lines found in both lists. A line found in one list
 * only can never be unchanged, so leaving it out of the comparison does not
 * change the shortest edit.
 */
function linesInBoth(a, b, distinctBefore) {
  const inAfter = new Uint8Array(distinctBefore);
  b.forEach((number) => {
    if (number < distinctBefore) inAfter[number] = 1;
  });
  return {
    keptBefore: positionsWhere(a, (number) => inAfter[number] === 1),
    keptAfter: positionsWhere(b, (number) => number < distinctBefore),
  };
}

/**
 * For each line of `a`, the line of `b` it stays as, found by filling in a
 * table of the longest common run from every pair of positions. Exact, with
 * work and memory that grow with the product of the two lengths.
 */
function tableMatches(a, b) {
  const width = b.length + 1;
  const common = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const cell = i * width + j;
      common[cell] = a[i] === b[j]
        ? common[cell + width + 1] + 1
        : Math.max(common[cell + width], common[cell + 1]);
    }
  }
  const match = new Int32Array(a.length).fill(UNMATCHED);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      match[i] = j;
      i += 1;
      j += 1;
    } else if (common[i * width + j + 1] > common[(i + 1) * width + j]) {
      j += 1;
    } else {
      i += 1;
    }
  }
  return match;
}

/**
 * One sweep of the search from the top left: each diagonal's furthest point
 * moves one edit on, then along its equal lines. Returns the middle of a
 * shortest path, [x1, y1, x2, y2], once it reaches the search from the
 * bottom right.
 */
function forwardSweep(search, box, edits) {
  const { a, b, forward, backward, origin } = search;
  const { left, top, right, bottom, delta } = box;
  const mayMeet = (delta & 1) !== 0;
  for (let k = edits; k >= -edits; k -= 2) {
    const down = k === -edits || (k !== edits && forward[origin + k - 1] < forward[origin + k + 1]);
    const startX = down ? forward[origin + k + 1] : forward[origin + k - 1];
    let x = down ? startX : startX + 1;
    let y = top + (x - left) - k;
    const startY = edits === 0 || !down ? y : y - 1;
    const walkedFrom = x;
    while (x < right && y < bottom && a[x] === b[y]) {
      x += 1;
      y += 1;
    }
    search.steps += x - walkedFrom;
    forward[origin + k] = x;
    const c = k - delta;
    if (mayMeet && c > -edits && c < edits && y >= backward[origin + c]) return [startX, startY, x, y];
  }
  return null;
}

/** The same sweep from the bottom right, meeting the search from the top left. */
function backwardSweep(search, box, edits) {
  const { a, b, forward, backward, origin } = search;
  const { left, top, delta } = box;
  const mayMeet = (delta & 1) === 0;
  for (let c = edits; c >= -edits; c -= 2) {
    const k = c + delta;
    const up = c === -edits || (c !== edits && backward[origin + c - 1] > backward[origin + c + 1]);
    const startY = up ? backward[origin + c + 1] : backward[origin + c - 1];
    let y = up ? startY : startY - 1;
    let x = left + (y - top) + k;
    const startX = edits === 0 || !up ? x : x + 1;
    const walkedFrom = y;
    while (x > left && y > top && a[x - 1] === b[y - 1]) {
      x -= 1;
      y -= 1;
    }
    search.steps += walkedFrom - y;
    backward[origin + c] = y;
    if (mayMeet && k >= -edits && k <= edits && x <= forward[origin + k]) return [x, y, startX, startY];
  }
  return null;
}

/**
 * The middle of a shortest path across the box: one edit with the equal
 * lines beside it. The two searches each advance an edit at a time until
 * they meet. Null when the step limit is reached first.
 */
function middleSnake(search, box) {
  const { left, top, right, bottom } = box;
  const mostEdits = Math.ceil((right - left + bottom - top) / 2);
  search.forward[search.origin + 1] = left;
  search.backward[search.origin + 1] = bottom;
  for (let edits = 0; edits <= mostEdits; edits += 1) {
    search.steps += 2 * (edits + 1);
    if (search.steps > search.maxSteps) return null;
    const snake = forwardSweep(search, box, edits) ?? backwardSweep(search, box, edits);
    if (snake) return snake;
  }
  return null;
}

/** Records the equal lines of a middle snake: those around its one edit. */
function matchSnake(search, [startX, startY, endX, endY]) {
  const { a, b, match } = search;
  let x = startX;
  let y = startY;
  while (x < endX && y < endY && a[x] === b[y]) {
    match[x] = y;
    x += 1;
    y += 1;
  }
  if (endX - x > endY - y) x += 1;
  else if (endX - x < endY - y) y += 1;
  for (; x < endX; x += 1, y += 1) match[x] = y;
}

/**
 * Records the equal lines from (left, top) to (right, bottom), splitting at
 * the middle snake; false when the step limit was reached.
 */
function matchBox(search, left, top, right, bottom) {
  const { a, b, match } = search;
  while (left < right && top < bottom && a[left] === b[top]) {
    match[left] = top;
    left += 1;
    top += 1;
  }
  while (left < right && top < bottom && a[right - 1] === b[bottom - 1]) {
    right -= 1;
    bottom -= 1;
    match[right] = bottom;
  }
  if (left === right || top === bottom) return true;
  const snake = middleSnake(search, { left, top, right, bottom, delta: (right - left) - (bottom - top) });
  if (!snake || !matchBox(search, left, top, snake[0], snake[1])) return false;
  matchSnake(search, snake);
  return matchBox(search, snake[2], snake[3], right, bottom);
}

/**
 * For each line of `a`, the line of `b` it stays as in a shortest edit, or
 * null when finding them would take more than `maxSteps`.
 */
function searchMatches(a, b, maxSteps) {
  // Both searches index their furthest points by diagonal, from -reach to
  // reach, and read one diagonal to either side.
  const reach = Math.ceil((a.length + b.length) / 2) + 1;
  const origin = reach + 1;
  const search = {
    a,
    b,
    origin,
    forward: new Int32Array(2 * origin + 1),
    backward: new Int32Array(2 * origin + 1),
    match: new Int32Array(a.length).fill(UNMATCHED),
    steps: 0,
    maxSteps,
  };
  return matchBox(search, 0, 0, a.length, b.length) ? search.match : null;
}

function matchedLines(a, b, { maxSteps, maxTableCells }) {
  if (a.length === 0 || b.length === 0) return new Int32Array(a.length).fill(UNMATCHED);
  if (a.length * b.length <= maxTableCells) return tableMatches(a, b);
  return searchMatches(a, b, maxSteps);
}

/**
 * For each line of `before`, the line of `after` it stays as, or UNMATCHED.
 * When the comparison gives up, no line is matched, so every line is
 * reported as removed and then added.
 */
function middleMatches(before, after, limits) {
  const { a, b, distinctBefore } = numberedLines(before, after);
  const { keptBefore, keptAfter } = linesInBoth(a, b, distinctBefore);
  const keptMatches = matchedLines(
    keptBefore.map((position) => a[position]),
    keptAfter.map((position) => b[position]),
    limits,
  );
  const match = new Int32Array(a.length).fill(UNMATCHED);
  keptMatches?.forEach((afterPosition, position) => {
    if (afterPosition !== UNMATCHED) match[keptBefore[position]] = keptAfter[afterPosition];
  });
  return match;
}

/**
 * The operations that turn `beforeLines` into `afterLines`, in file order:
 * { kind: 'equal' | 'add' | 'remove', text, beforeLine, afterLine } with line
 * numbers counted from 1. Where lines were replaced, the removed lines come
 * before the added ones.
 */
export function sequenceOperations(beforeLines, afterLines, { maxSteps = MAX_DIFF_STEPS, maxTableCells = MAX_TABLE_CELLS } = {}) {
  const prefix = sharedPrefixLength(beforeLines, afterLines);
  const suffix = sharedSuffixLength(beforeLines, afterLines, prefix);
  const beforeEnd = beforeLines.length - suffix;
  const afterEnd = afterLines.length - suffix;
  const match = middleMatches(
    beforeLines.slice(prefix, beforeEnd),
    afterLines.slice(prefix, afterEnd),
    { maxSteps, maxTableCells },
  );

  const operations = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  const equal = (count) => {
    for (let index = 0; index < count; index += 1) {
      operations.push({ kind: 'equal', text: beforeLines[beforeIndex], beforeLine: beforeIndex + 1, afterLine: afterIndex + 1 });
      beforeIndex += 1;
      afterIndex += 1;
    }
  };
  const replaceUpTo = (beforeStop, afterStop) => {
    for (; beforeIndex < beforeStop; beforeIndex += 1) {
      operations.push({ kind: 'remove', text: beforeLines[beforeIndex], beforeLine: beforeIndex + 1 });
    }
    for (; afterIndex < afterStop; afterIndex += 1) {
      operations.push({ kind: 'add', text: afterLines[afterIndex], afterLine: afterIndex + 1 });
    }
  };

  equal(prefix);
  match.forEach((afterPosition, position) => {
    if (afterPosition === UNMATCHED) return;
    replaceUpTo(prefix + position, prefix + afterPosition);
    equal(1);
  });
  replaceUpTo(beforeEnd, afterEnd);
  equal(suffix);
  return operations;
}
