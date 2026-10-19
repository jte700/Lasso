const SURROGATE_FIRST = 0xD800;
const SURROGATE_LAST = 0xDFFF;

/**
 * Orders text as SQLite's BINARY collation does (UTF-8 bytes, which is code
 * point order), so lists built in memory match lists the database sorts.
 * UTF-16 units differ from that only where a surrogate pair meets a
 * character from U+E000 to U+FFFF.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
export function compareText(left, right) {
  if (left === right) return 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.charCodeAt(index);
    const b = right.charCodeAt(index);
    if (a === b) continue;
    const surrogateA = a >= SURROGATE_FIRST && a <= SURROGATE_LAST;
    const surrogateB = b >= SURROGATE_FIRST && b <= SURROGATE_LAST;
    if (surrogateA !== surrogateB) return surrogateA ? 1 : -1;
    return a - b;
  }
  return left.length - right.length;
}

/** Merges two lists already sorted by `compare`. */
export function mergeSorted(left, right, compare) {
  const merged = [];
  let a = 0;
  let b = 0;
  while (a < left.length && b < right.length) merged.push(compare(left[a], right[b]) <= 0 ? left[a++] : right[b++]);
  return merged.concat(left.slice(a), right.slice(b));
}
