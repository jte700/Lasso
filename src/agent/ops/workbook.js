// Reads an .xlsx package into sheets of cells: literal values, formulas (with
// shared formulas expanded against their anchor), cached values and date
// formats. No values are recomputed here.

import { cellName, columnIndex, parseFormula, UnsupportedFormula } from './formula.js';
import { readZip } from './zip.js';

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const decodeXml = (text) => String(text).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name) => {
  if (name[0] === '#') return String.fromCodePoint(name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
  return ENTITY[name] ?? whole;
});
const attributes = (text) => Object.fromEntries([...String(text).matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)].map(([, key, value]) => [key, decodeXml(value)]));
// Text of every <t> run, skipping phonetic runs.
const runText = (xml) => decodeXml([...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((match) => match[1]).join(''));

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const isDateFormat = (code) => {
  const bare = String(code).replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[dmy]/i.test(bare) && !/[0#?]/.test(bare.replace(/[dmyhs:./\-\s,]/gi, ''));
};

/** An Excel serial date (1900 system) as yyyy-mm-dd. */
export function serialToIso(serial) {
  const milliseconds = Math.round((serial - 25569) * 86_400_000);
  return new Date(milliseconds).toISOString().slice(0, 10);
}
export function isoToSerial(iso) {
  return Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000) + 25569;
}

export function readWorkbook(buffer) {
  const zip = readZip(buffer);
  const workbookXml = zip.text('xl/workbook.xml');
  if (!workbookXml) throw new Error('not a workbook: xl/workbook.xml is missing');
  const relsXml = zip.text('xl/_rels/workbook.xml.rels') ?? '';
  const targets = Object.fromEntries([...relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)].map(([, attrs]) => {
    const parsed = attributes(attrs);
    return [parsed.Id, parsed.Target];
  }));
  const sharedXml = zip.text('xl/sharedStrings.xml') ?? '';
  const shared = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => runText(match[1]));
  const stylesXml = zip.text('xl/styles.xml') ?? '';
  const customFormats = Object.fromEntries([...stylesXml.matchAll(/<numFmt\b([^>]*)\/?>/g)].map(([, attrs]) => {
    const parsed = attributes(attrs);
    return [Number(parsed.numFmtId), parsed.formatCode];
  }));
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
  const dateStyles = [...cellXfs.matchAll(/<xf\b([^>]*?)(?:\/>|>)/g)].map(([, attrs]) => {
    const id = Number(attributes(attrs).numFmtId ?? 0);
    return BUILTIN_DATE_FORMATS.has(id) || (customFormats[id] !== undefined && isDateFormat(customFormats[id]));
  });

  const sheets = [];
  [...workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g)].forEach(([, attrs], index) => {
    const parsed = attributes(attrs);
    const relation = parsed['r:id'] ?? parsed.id;
    let target = targets[relation] ?? `worksheets/sheet${index + 1}.xml`;
    target = target.replace(/^\/?xl\//, '').replace(/^\//, '');
    const xml = zip.text(`xl/${target}`);
    if (xml === null) throw new Error(`sheet ${parsed.name} is missing from the package (${target})`);
    sheets.push(readSheet(parsed.name, xml, shared, dateStyles));
  });
  return { sheets };
}

function readSheet(name, xml, shared, dateStyles) {
  const cells = new Map();
  const sharedFormulas = new Map();
  let maxRow = 0;
  let maxColumn = 0;
  let unsupported = 0;
  const data = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml)?.[1] ?? '';
  for (const match of data.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = attributes(match[1]);
    const inner = match[2] ?? '';
    const reference = /^([A-Z]+)(\d+)$/.exec(attrs.r ?? '');
    if (!reference) continue;
    const column = columnIndex(reference[1]);
    const row = Number(reference[2]);
    const type = attrs.t ?? 'n';
    const isDate = dateStyles[Number(attrs.s ?? 0)] === true;
    const rawValue = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
    let value = null;
    if (type === 's') value = rawValue === undefined ? null : shared[Number(rawValue)] ?? null;
    else if (type === 'inlineStr') value = runText(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? '');
    else if (type === 'str') value = rawValue === undefined ? '' : decodeXml(rawValue);
    else if (type === 'b') value = rawValue === '1';
    else if (type === 'e') value = rawValue === undefined ? null : { error: decodeXml(rawValue) };
    else if (rawValue !== undefined) value = Number(rawValue);

    let formula = null;
    const formulaMatch = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(inner);
    if (formulaMatch) {
      const formulaAttrs = attributes(formulaMatch[1]);
      const text = formulaMatch[2] === undefined ? '' : decodeXml(formulaMatch[2]);
      try {
        if (formulaAttrs.t === 'array') throw new UnsupportedFormula('array formulas are not supported');
        if (formulaAttrs.t === 'shared') {
          if (text) {
            const tree = parseFormula(text);
            const entry = { tree, anchor: { row, column } };
            sharedFormulas.set(formulaAttrs.si, entry);
            formula = { tree, anchor: entry.anchor, shared: formulaAttrs.si };
          } else {
            const entry = sharedFormulas.get(formulaAttrs.si);
            if (!entry) throw new UnsupportedFormula(`shared formula ${formulaAttrs.si} has no master cell`);
            formula = { tree: entry.tree, anchor: entry.anchor, shared: formulaAttrs.si };
          }
        } else {
          formula = { tree: parseFormula(text), anchor: { row, column } };
        }
      } catch (error) {
        if (!(error instanceof UnsupportedFormula)) throw error;
        unsupported += 1;
        formula = { unsupported: error.message, source: text };
      }
    }
    if (value === null && !formula) continue;
    const date = isDate && typeof value === 'number';
    cells.set(cellName(row, column), { row, column, value, formula, date });
    if (row > maxRow) maxRow = row;
    if (column > maxColumn) maxColumn = column;
  }
  return { name, cells, maxRow, maxColumn, unsupported };
}
