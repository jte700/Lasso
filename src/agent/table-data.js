// A table's cells as a query reads them. A workbook's or a delimited file's
// reader gives every cell as the text written in it; here each column is read
// for what it holds, once, so that figures add and order as numbers, dates
// compare as dates, and text stays text.
//
// Nothing is guessed. A column is figures only when every filled cell is one;
// "007" is a code, not seven; a percentage is the fraction it stands for; and
// 03/04/2025 is a date only when its column settles which part is the day.

import { normalizeName } from './table-sql.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthNamed = (word) => {
  const folded = word.toLowerCase();
  const at = MONTHS.findIndex((month) => month === folded || (folded.length >= 3 && month.slice(0, 3) === folded) || (folded === 'sept' && month === 'september'));
  return at + 1;
};
const iso = (year, month, day) => {
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate())) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

/** A figure as written ("1,234.50", "-3", "$2,000", "(450)", "12.5%", "1e3") with whether it is a percentage, or null. */
function readNumber(text) {
  const match = /^(\()?\s*([-+])?\s*[$€£¥]?\s*([-+])?(\d{1,3}(?:,\d{3})+|\d+)?(\.\d+)?(?:[eE]([-+]?\d+))?\s*(%)?\s*(\))?$/.exec(String(text ?? '').trim());
  if (!match || (!match[4] && !match[5]) || Boolean(match[1]) !== Boolean(match[8]) || (match[2] && match[3])) return null;
  const whole = (match[4] ?? '0').replace(/,/g, '');
  // "007" and "0012" are codes: a figure does not begin with a zero it does not need.
  if (whole.length > 1 && whole.startsWith('0')) return null;
  let value = Number(`${whole}${match[5] ?? ''}${match[6] ? `e${match[6]}` : ''}`);
  if (!Number.isFinite(value)) return null;
  if (match[1] || (match[2] ?? match[3]) === '-') value = -value;
  return { value: match[7] ? value / 100 : value, percent: Boolean(match[7]) };
}

/** The number a cell's text states, a percentage as its fraction, or null when it is not a figure. */
export function cellNumber(text) {
  return readNumber(text)?.value ?? null;
}

/** The day a cell's text states, as YYYY-MM-DD, or null. A date written only in figures with slashes is not read here. */
export function cellDate(text) {
  const value = String(text ?? '').trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[-+]\d{2}:?\d{2})?)?$/.exec(value);
  if (match) return iso(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(value);
  if (match) return iso(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+(\d{4})$/.exec(value);
  if (match && monthNamed(match[2])) return iso(Number(match[3]), monthNamed(match[2]), Number(match[1]));
  match = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(value);
  if (match && monthNamed(match[1])) return iso(Number(match[3]), monthNamed(match[1]), Number(match[2]));
  return null;
}

/** A column of dates written in figures (03/04/2025): its cells as dates when the column settles which part is the day, else null. */
function figureDates(texts) {
  const parts = texts.map((text) => /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text));
  if (!parts.every(Boolean)) return null;
  const dayFirst = parts.some((match) => Number(match[1]) > 12);
  const monthFirst = parts.some((match) => Number(match[2]) > 12);
  if (dayFirst === monthFirst) return null;
  const dates = parts.map((match) => (dayFirst ? iso(Number(match[3]), Number(match[2]), Number(match[1])) : iso(Number(match[3]), Number(match[1]), Number(match[2]))));
  return dates.every(Boolean) ? dates : null;
}

const letter = (index) => { let label = ''; for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) label = String.fromCharCode(65 + (n % 26)) + label; return label; };

/**
 * A table ready to query: `{ name, columns: [{ name, kind }], rows, rowNumber(index), written(row, column) }`.
 * `headers` and `rows` are cell texts; `rowNumbers` each row's number in its sheet or file.
 * A column's kind is "number", "percent" (kept as fractions), "date" (kept as YYYY-MM-DD),
 * "mixed" (mostly figures, the rest left as text) or "text". An empty cell is null.
 * `written` gives a cell's text as its file has it, whatever it was read as.
 */
export function typedTable({ name, headers = [], rows = [], rowNumbers = null }) {
  const filled = (value) => String(value ?? '').trim() !== '';
  const kept = rows.map((row, index) => ({ row, number: rowNumbers?.[index] ?? index + 2 })).filter(({ row }) => row.some(filled));
  let width = Math.max(headers.length, ...kept.map(({ row }) => row.length), 0);
  while (width > 0 && !filled(headers[width - 1]) && !kept.some(({ row }) => filled(row[width - 1]))) width -= 1;
  const used = new Map();
  const columns = Array.from({ length: width }, (_, index) => {
    const given = String(headers[index] ?? '').replace(/\s+/g, ' ').trim() || `Column ${letter(index)}`;
    const key = normalizeName(given);
    const times = (used.get(key) ?? 0) + 1;
    used.set(key, times);
    return { name: times > 1 ? `${given} ${times}` : given };
  });
  const values = kept.map(() => new Array(width).fill(null));
  const written = kept.map(({ row }) => Array.from({ length: width }, (_, at) => String(row[at] ?? '').trim() || null));
  for (const [at, column] of columns.entries()) {
    const texts = kept.map(({ row }) => String(row[at] ?? '').trim());
    const present = texts.filter(Boolean);
    const numbers = present.map(readNumber);
    const figures = numbers.filter(Boolean).length;
    const dates = present.length && !figures ? (present.map(cellDate).every(Boolean) ? present.map(cellDate) : figureDates(present)) : null;
    column.kind = !present.length ? 'text' : figures === present.length ? (numbers.every((number) => number.percent) ? 'percent' : 'number')
      : dates ? 'date' : figures * 2 >= present.length ? 'mixed' : 'text';
    let next = 0;
    texts.forEach((text, rowIndex) => {
      if (!text) return;
      const number = numbers[next];
      const date = dates?.[next];
      next += 1;
      values[rowIndex][at] = column.kind === 'date' ? date : ['number', 'percent', 'mixed'].includes(column.kind) && number ? number.value : text;
    });
  }
  const numbersOfRows = kept.map(({ number }) => number);
  return { name, columns, rows: values, rowNumber: (index) => numbersOfRows[index] ?? null, written: (row, column) => written[row]?.[column] ?? null };
}
