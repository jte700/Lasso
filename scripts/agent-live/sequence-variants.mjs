// Fresh variants of the workbook sequence task: a check, an explanation, a
// correction, a recheck and a what-if, asked in one conversation. The first
// such task (the trial's "summary-check") was the only one of its kind, and
// everything built for it was built while looking at it. These have other
// folders, sheets, columns and layouts, another range that stops short,
// another misspelt value and other rates, so that what answers them is the
// method and not a memory of one workbook.
//
// Each variant is a workbook written as Excel writes one (shared strings,
// formulas with their cached values), the truth worked out here from the
// generator's own rows and never by reading the file back, and five steps
// with graders over a reply's ANSWER line.

import { writeZip } from '../../src/agent/ops/zip.js';

const xml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const letters = (index) => { let out = ''; for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) out = String.fromCharCode(65 + (n % 26)) + out; return out; };
const cents = (value) => Math.round(value * 100) / 100;

/** A workbook from sheets of rows; a cell is a number, a string, or { f: formula, v: cached value }. */
export function writeWorkbook(sheets) {
  const strings = [];
  const index = new Map();
  const shared = (text) => { if (!index.has(text)) { index.set(text, strings.length); strings.push(text); } return index.get(text); };
  const cell = (reference, value) => {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'number') return `<c r="${reference}"><v>${value}</v></c>`;
    if (typeof value === 'string') return `<c r="${reference}" t="s"><v>${shared(value)}</v></c>`;
    return `<c r="${reference}"><f>${xml(value.f)}</f><v>${value.v}</v></c>`;
  };
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const main = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const files = {
    '[Content_Types].xml': `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`,
    'xl/workbook.xml': `${head}<workbook ${main} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
      sheets.map((sheet, at) => `<sheet name="${xml(sheet.name)}" sheetId="${at + 1}" r:id="rId${at + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
      sheets.map((_, at) => `<Relationship Id="rId${at + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${at + 1}.xml"/>`).join('')}</Relationships>`,
  };
  sheets.forEach((sheet, at) => {
    const rows = sheet.rows.map((cells, row) => (cells?.length ? `<row r="${row + 1}">${cells.map((value, column) => cell(`${letters(column)}${row + 1}`, value)).join('')}</row>` : ''));
    files[`xl/worksheets/sheet${at + 1}.xml`] = `${head}<worksheet ${main}><sheetData>${rows.join('')}</sheetData></worksheet>`;
  });
  files['xl/sharedStrings.xml'] = `${head}<sst ${main} count="${strings.length}" uniqueCount="${strings.length}">${strings.map((text) => `<si><t>${xml(text)}</t></si>`).join('')}</sst>`;
  return writeZip(files);
}

function seeded(seed) {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  next.int = (low, high) => low + Math.floor(next() * (high - low + 1));
  next.pick = (list) => list[Math.floor(next() * list.length)];
  return next;
}

const PROFILES = {
  payroll: { seed: 4107, folder: 'Staffing', file: 'Timesheets 2026.xlsx', rows: 1800, cut: 1500, year: 2026,
    data: { sheet: 'Shifts', columns: ['Shift ID', 'Day', 'Employee', 'Site', 'Role', 'Hours', 'Rate', 'Cost'], prefix: 'SH-' },
    people: ['A. Okafor', 'B. Lindqvist', 'C. Marsh', 'D. Petrov', 'E. Vance', 'F. Nakamura', 'G. Ortiz', 'H. Whitlock', 'I. Brandt', 'J. Mbeki', 'K. Sorensen', 'L. Draper'],
    groups: ['Leeds', 'Hull', 'York', 'Derby'], misspelt: ['Leeds', 'Leds'], kinds: [['Picker', 14.2], ['Driver', 17.85], ['Supervisor', 22.4], ['Loader', 13.1]], quantity: [4, 12],
    summary: { sheet: 'Roll-up', title: 'Roll-up 2026', ratesRow: 3, headerRow: 6, header: ['Site', 'Cost', 'Shifts'], rates: [['On-cost', 0.22], ['EUR per GBP', 1.17]],
      total: 'All sites', after: 'With on-cost', converted: 'In EUR' },
    change: 0.25, words: { amount: 'Cost', rows: 'shift', group: 'site', rate: 'on-cost rate' } },
  stock: { seed: 9233, folder: 'Warehouse', file: 'Stock movements.xlsx', rows: 1300, cut: 1000, year: 2025,
    data: { sheet: 'Movements', columns: ['Ref', 'Date', 'SKU', 'Zone', 'Kind', 'Units', 'Unit value', 'Value'], prefix: 'MV' },
    people: ['SKU-1001', 'SKU-1002', 'SKU-1147', 'SKU-2050', 'SKU-2051', 'SKU-3300', 'SKU-3391', 'SKU-4012', 'SKU-4500', 'SKU-5120'],
    groups: ['Ambient', 'Chilled', 'Frozen', 'Bulk', 'Returns'], misspelt: ['Chilled', 'Chiled'], kinds: [['Receipt', 41.5], ['Transfer', 18.75], ['Adjustment', 9.6]], quantity: [1, 60],
    summary: { sheet: 'Totals', title: 'Stock value 2025', ratesRow: 2, headerRow: 5, header: ['Zone', 'Value', 'Movements'], rates: [['Duty', 0.08], ['USD per CAD', 0.74]],
      total: 'Grand total', after: 'With duty', converted: 'In USD' },
    change: 0.1, words: { amount: 'Value', rows: 'movement', group: 'zone', rate: 'duty rate' } },
};

/** Every number in a text: "22,464,421.57", "26.04 million". */
function numbersIn(text) {
  const scale = { million: 1e6, m: 1e6, thousand: 1e3, k: 1e3 };
  return [...String(text).replace(/(\d),(?=\d{3}\b)/g, '$1').matchAll(/(-|−)?[$£€]?\s?(\d+(?:\.\d+)?)\s*(million|thousand|m|k)?\b/gi)]
    .map((match) => (match[1] ? -1 : 1) * Number(match[2]) * (scale[match[3]?.toLowerCase()] ?? 1));
}
const answerOf = (reply) => { const at = String(reply).toUpperCase().lastIndexOf('ANSWER:'); return at < 0 ? String(reply) : String(reply).slice(at + 7); };
const near = (value, tolerance = 0.011) => (text) => numbersIn(text).some((number) => Math.abs(Math.abs(number) - Math.abs(value)) <= tolerance);
const says = (pattern) => (text) => pattern.test(text);
const grader = (checks) => (reply) => {
  const results = checks.map(([label, check, where = 'answer']) => ({ label, ok: Boolean(check(where === 'reply' ? String(reply) : answerOf(reply))) }));
  return { correct: results.every((item) => item.ok), checks: results };
};

/**
 * One variant: `{ id, path, buffer, truth, task }`, the task as the live harness runs one. `sizes` (`{ rows, cut }`)
 * makes a smaller workbook of the same shape, for a test that checks the method and not the scale.
 */
export function sequenceVariant(name, sizes = {}) {
  if (!PROFILES[name]) throw new Error(`no sequence variant named ${name}; there are ${Object.keys(PROFILES).join(', ')}`);
  const profile = { ...PROFILES[name], ...sizes };
  const random = seeded(profile.seed);
  const { data, summary } = profile;
  const last = profile.rows + 1;
  const spelt = new Set();
  while (spelt.size < 3) spelt.add(random.int(Math.floor(profile.rows * 0.2), profile.cut - 50));
  const rows = [];
  for (let index = 0; index < profile.rows; index += 1) {
    const [kind, base] = random.pick(profile.kinds);
    const group = random.pick(profile.groups);
    const quantity = random.int(...profile.quantity);
    const price = cents(base * (0.9 + random() * 0.2));
    const day = new Date(Date.UTC(profile.year, 0, 1 + Math.floor((index * 364) / profile.rows))).toISOString().slice(0, 10);
    rows.push({ id: `${data.prefix}${String(index + 1).padStart(5, '0')}`, day, who: random.pick(profile.people),
      group: spelt.has(index) && group === profile.misspelt[0] ? profile.misspelt[1] : group, kind, quantity, price, amount: quantity * price });
  }
  // Three rows carry the misspelt value whatever the draw gave them.
  for (const index of spelt) rows[index].group = profile.misspelt[1];
  const sum = (list) => list.reduce((total, row) => total + row.amount, 0);
  const first = summary.headerRow + 1;
  const totalRow = first + profile.groups.length;
  const amountColumn = letters(data.columns.length - 1);
  const groupColumn = letters(3);
  const [rate, convert] = summary.rates.map(([, value]) => value);
  const all = sum(rows);
  const truncated = sum(rows.slice(0, profile.cut - 1));
  const byGroup = profile.groups.map((group) => rows.filter((row) => row.group === group));
  const misspelt = rows.map((row, index) => ({ row, number: index + 2 })).filter(({ row }) => row.group === profile.misspelt[1]);
  const truth = { rows: profile.rows, all, truncated, difference: all - truncated, firstOmitted: profile.cut + 1, lastRow: last, omitted: last - profile.cut,
    after: truncated * (1 + rate), converted: truncated * (1 + rate) * convert,
    corrected: [all, all * (1 + rate), all * (1 + rate) * convert],
    groupSum: sum(byGroup.flat()), misspeltValue: profile.misspelt[1], misspeltRows: misspelt.map(({ number }) => number), misspeltAmount: sum(misspelt.map(({ row }) => row)),
    changed: all * (1 + profile.change) * convert,
    cells: { total: `B${totalRow}`, after: `B${totalRow + 1}`, converted: `B${totalRow + 2}`, rate: `B${summary.ratesRow}`, groups: `B${first}:B${totalRow - 1}` } };

  const dataSheet = { name: data.sheet, rows: [data.columns, ...rows.map((row, index) => [row.id, row.day, row.who, row.group, row.kind, row.quantity, row.price,
    { f: `F${index + 2}*G${index + 2}`, v: row.amount }])] };
  const sheet = [];
  sheet[0] = [summary.title];
  summary.rates.forEach(([label, value], at) => { sheet[summary.ratesRow - 1 + at] = [label, value]; });
  sheet[summary.headerRow - 1] = summary.header;
  profile.groups.forEach((group, at) => {
    const row = first + at;
    sheet[row - 1] = [group, { f: `SUMIFS(${data.sheet}!$${amountColumn}$2:$${amountColumn}$${last},${data.sheet}!$${groupColumn}$2:$${groupColumn}$${last},A${row})`, v: sum(byGroup[at]) },
      { f: `COUNTIFS(${data.sheet}!$${groupColumn}$2:$${groupColumn}$${last},A${row})`, v: byGroup[at].length }];
  });
  sheet[totalRow - 1] = [summary.total, { f: `SUM(${data.sheet}!${amountColumn}2:${amountColumn}${profile.cut})`, v: truncated }, { f: `SUM(C${first}:C${totalRow - 1})`, v: byGroup.flat().length }];
  sheet[totalRow] = [summary.after, { f: `B${totalRow}*(1+B${summary.ratesRow})`, v: truth.after }];
  sheet[totalRow + 1] = [summary.converted, { f: `B${totalRow + 1}*B${summary.ratesRow + 1}`, v: truth.converted }];
  for (let at = 0; at < sheet.length; at += 1) sheet[at] ??= [];
  const buffer = writeWorkbook([dataSheet, { name: summary.sheet, rows: sheet }]);

  const file = `${profile.folder}/${profile.file}`;
  const { cells } = truth;
  const words = profile.words;
  const task = { id: `sequence/${name}`, source: file, kind: 'sequence', steps: [
    { prompt: `In ${file}, does the ${summary.total} figure in ${summary.sheet}!${cells.total} equal the sum of every ${words.amount} value in the ${data.sheet} sheet? Give both numbers to two decimals.`,
      grade: grader([['says they differ', says(/\b(?:no\b|not equal|does not|doesn't|differ|different|mismatch|less than|short)/i)], [`${cells.total} value`, near(truth.truncated)], [`sum of all ${words.amount}`, near(truth.all)]]) },
    { prompt: `Explain exactly why they differ: which ${words.rows} rows are and are not included, and by how much do the two figures differ?`,
      grade: grader([['names the cut-off row', says(new RegExp(`\\b(?:${profile.cut}|${profile.cut + 1})\\b`)), 'reply'], ['difference', near(truth.difference)]]) },
    { prompt: `Suppose ${cells.total}'s formula is corrected so that it covers every ${words.rows}. What would ${cells.total}, ${cells.after} and ${cells.converted} become? Give each to two decimals.`,
      grade: grader(truth.corrected.map((value, at) => [`corrected ${[cells.total, cells.after, cells.converted][at]}`, near(value)])) },
    { prompt: `With that correction made, does ${cells.total} then equal the sum of the ${words.group} figures in ${cells.groups}? If not, explain the difference exactly.`,
      grade: grader([['says they differ', says(/\b(?:no\b|not equal|does not|doesn't|differ|different|mismatch|short|less)/i)],
        ['finds the misspelt value', says(new RegExp(`\\b${profile.misspelt[1]}\\b`)), 'reply'], ['difference', near(truth.misspeltAmount)]]) },
    { prompt: `Keeping the correction, if the ${words.rate} in ${cells.rate} were also changed to ${Math.round(profile.change * 100)}%, what would ${cells.converted} become? Give it to two decimals.`,
      grade: grader([[`${cells.converted} at ${Math.round(profile.change * 100)}%`, near(truth.changed)]]) },
  ] };
  return { id: name, path: file, folder: profile.folder, buffer, truth, task, profile };
}

export const sequenceVariants = () => Object.keys(PROFILES).map(sequenceVariant);
