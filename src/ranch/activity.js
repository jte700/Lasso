// How much a file has been used, for The Ranch's network view and its
// "Recently Used" order. Only deliberate actions count: accepting the file
// with Tab, opening it from a suggestion, looking at it in The Ranch, sharing
// it, and linking a document to it.

/** What one of each action is worth. A share or a link says more than a glance. */
export const ACTIVITY_WEIGHTS = Object.freeze({ tabs: 3, opens: 1, visits: 1, shares: 4, references: 2 });

export const EMPTY_COUNTS = Object.freeze({ tabs: 0, opens: 0, visits: 0, shares: 0, references: 0 });

/**
 * @param {Partial<typeof EMPTY_COUNTS>} counts
 * @returns {number} the weighted sum, 0 for a file nobody has used
 */
export function activityScore(counts) {
  return Object.entries(ACTIVITY_WEIGHTS)
    .reduce((total, [name, weight]) => total + weight * Math.max(0, Number(counts?.[name]) || 0), 0);
}

/**
 * Scores scaled to 0...1 against the busiest file. The scale is logarithmic,
 * so one heavily used file does not leave every other file looking unused.
 * @param {Map<string, number>} scores
 * @returns {Map<string, number>}
 */
export function normalizedActivity(scores) {
  // Reduced rather than spread: a large library has more files than arguments.
  const highest = [...scores.values()].reduce((most, score) => Math.max(most, score), 0);
  if (highest <= 0) return new Map([...scores.keys()].map((key) => [key, 0]));
  const scale = Math.log1p(highest);
  return new Map([...scores].map(([key, score]) => [key, round(Math.log1p(Math.max(0, score)) / scale)]));
}

/** Adds two sets of counts into a new one. */
export function addCounts(left, right) {
  return Object.fromEntries(Object.keys(EMPTY_COUNTS)
    .map((name) => [name, (left?.[name] ?? 0) + (right?.[name] ?? 0)]));
}

/** The latest of several ISO timestamps or epoch milliseconds, as ISO, or null. */
export function latestTime(...values) {
  const latest = values.flat().map((value) => (typeof value === 'number' ? value : Date.parse(value ?? '')))
    .filter(Number.isFinite).reduce((most, time) => Math.max(most, time), -Infinity);
  return Number.isFinite(latest) ? new Date(latest).toISOString() : null;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
