// Shared pieces of every adapter: results with status, coverage and guarantee
// (paper §3, §5.1), number formatting, and compact listings.

export class OpError extends Error {
  constructor(message, code = 'invalid') { super(message); this.code = code; }
}

/** Statuses (Appendix A): exact | bounded | unknown | unsupported | error. Provenance classes (§6.1): format | computed | lexical. */
export function result({ status = 'exact', coverage = null, provenance = 'computed', guarantee = null, forms, revision = null, notes = [] }) {
  return { status, coverage, provenance, guarantee, forms, revision, notes };
}

/** A candidate rendering for the planner: complete renderings are preferred; a partial one says what it leaves out. */
export const form = (name, text, complete = true, extra = {}) => ({ form: name, text, complete, ...extra });

export function fmt(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    if (Number.isInteger(value)) return String(value);
    const precise = Number(value.toPrecision(12));
    return Math.abs(precise) >= 1e15 || (Math.abs(precise) < 1e-6 && precise !== 0) ? precise.toExponential(6) : String(precise);
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'object' && 'error' in value) return value.error;
  return String(value);
}

export const plural = (count, word, many = `${word}s`) => `${count.toLocaleString('en-US')} ${count === 1 ? word : many}`;

/** Rows as a compact pipe table. */
export function table(columns, rows) {
  const clean = (value) => fmt(value).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '/');
  return [columns.map(clean).join(' | '), ...rows.map((row) => row.map(clean).join(' | '))].join('\n');
}

/** Sorted integers as runs: 2–2100, 2102, 2200–2401. */
export function runs(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const parts = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const start = sorted[index];
    while (index + 1 < sorted.length && sorted[index + 1] === sorted[index] + 1) index += 1;
    parts.push(start === sorted[index] ? [start, start] : [start, sorted[index]]);
  }
  return parts;
}

/** Bounded list: the first `limit` items and a count of the rest. */
export function head(items, limit, render = String) {
  const shown = items.slice(0, limit).map(render);
  return items.length > limit ? [...shown, `… ${(items.length - limit).toLocaleString('en-US')} more`] : shown;
}
