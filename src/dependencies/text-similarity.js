// Word and edit-distance helpers: how alike two names, words or phrases are.

export const STOP_WORDS = new Set([
  'about', 'after', 'before', 'between', 'from', 'have', 'into', 'levels', 'prior', 'shown',
  'that', 'the', 'their', 'this', 'using', 'with', 'were', 'was', 'and', 'for', 'our', 'has',
]);

export function wordTokens(value) {
  return [...new Set(String(value ?? '').toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [])]
    .filter((token) => !STOP_WORDS.has(token));
}

export function variableTokens(value) {
  return String(value ?? '').toLowerCase().match(/[a-z][a-z0-9]*/g) ?? [];
}

export function overlapScore(left, right) {
  return tokenOverlap(wordTokens(left), new Set(wordTokens(right)));
}

export function tokenOverlap(a, b) {
  if (!a.length) return 0;
  return a.filter((token) => b.has(token)).length / Math.max(2, a.length);
}

export function prefixTokenScore(query, candidate) {
  const expected = normalizedName(query);
  if (expected.length < 2) return 0;
  const tokens = String(candidate ?? '').match(/[A-Za-z][A-Za-z0-9'’-]*/g) ?? [];
  let best = 0;
  for (const token of tokens) {
    const actual = normalizedName(token);
    if (actual === expected) return 1;
    if (actual.startsWith(expected)) best = Math.max(best, 0.92);
    else if (expected.startsWith(actual) && actual.length >= 3) best = Math.max(best, 0.82);
  }
  return best;
}

export function normalizedName(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z]/g, '');
}

export function rowEditDistance(left, right) {
  const a = normalizedName(left);
  const b = normalizedName(right);
  if (!a || !b) return Number.MAX_SAFE_INTEGER;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
}

export function editDistance(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  const previous = Array.from({ length: b.length + 1 }, (_value, index) => index);
  for (let aIndex = 1; aIndex <= a.length; aIndex += 1) {
    const current = [aIndex];
    for (let bIndex = 1; bIndex <= b.length; bIndex += 1) {
      current[bIndex] = Math.min(
        current[bIndex - 1] + 1,
        previous[bIndex] + 1,
        previous[bIndex - 1] + Number(a[aIndex - 1] !== b[bIndex - 1]),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
}
