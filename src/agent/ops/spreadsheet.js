// The spreadsheet adapter (paper §6.3). It reads a workbook into a local typed
// graph: cells, formulas in a fixed language, a dependency graph partitioned
// by sheet behind the exact boundary-reachability interface, a full
// recalculation that ignores formula caches, detected tables with column
// summaries and formula regions. The model sees a small card; every operation
// runs over the whole workbook locally.

import { BoundaryReachability } from './reachability.js';
import { fmt, form, head, OpError, plural, result, runs, table } from './common.js';
import { cellName, columnLetters, evaluate, formulaText, isError, parseCellName, parseFormula, parseReference, r1c1, referencesOf, UnsupportedFormula } from './formula.js';
import { normalizeName, runSql, SqlError } from '../table-sql.js';
import { readWorkbook, serialToIso } from './workbook.js';

// Sheets with at most this many cells are disclosed whole in the card: cheaper than describing them.
const SMALL_SHEET_CELLS = 80;
const LOW_CARDINALITY = 8;

const vertexOf = (sheet, address) => `${sheet}!${address}`;
const splitVertex = (vertex) => {
  const bang = vertex.lastIndexOf('!');
  return { sheet: vertex.slice(0, bang), address: vertex.slice(bang + 1) };
};
const displayValue = (cell, value) => (cell?.date && typeof value === 'number' ? serialToIso(value) : value);

// ── state: one revision of the workbook ────────────────────────────────────

function boundsOf(state, name) {
  const sheet = state.sheets.get(name);
  return { rows: sheet?.maxRow ?? 1, columns: sheet?.maxColumn ?? 1 };
}

function ensureVertex(state, sheet, address) {
  const vertex = vertexOf(sheet, address);
  if (!state.graph.hasVertex(vertex)) {
    state.graph.addVertex(vertex, sheet);
    // A new cell joins every range node that covers it.
    const at = parseCellName(address);
    for (const [rangeVertex, reference] of state.ranges) {
      if (reference.sheet === sheet && at.row >= reference.r1 && at.row <= reference.r2 && at.column >= reference.c1 && at.column <= reference.c2) {
        state.graph.addEdge(vertex, rangeVertex);
      }
    }
  }
  return vertex;
}

function linkFormula(state, sheetName, address, cell) {
  const target = vertexOf(sheetName, address);
  const references = referencesOf(cell.formula.tree, { sheet: sheetName, row: cell.row, column: cell.column, anchor: cell.formula.anchor,
    bounds: (name) => boundsOf(state, name) });
  const sources = [];
  for (const reference of references) {
    if (!state.sheets.has(reference.sheet)) {
      state.problems.set(target, `refers to a sheet that does not exist (${reference.sheet})`);
      continue;
    }
    if (reference.single) {
      sources.push(ensureVertex(state, reference.sheet, cellName(reference.r1, reference.c1)));
      continue;
    }
    const rangeVertex = `${reference.sheet}!${cellName(reference.r1, reference.c1)}:${cellName(reference.r2, reference.c2)}`;
    if (!state.graph.hasVertex(rangeVertex)) {
      state.graph.addVertex(rangeVertex, reference.sheet);
      state.ranges.set(rangeVertex, reference);
      const sheet = state.sheets.get(reference.sheet);
      const area = (reference.r2 - reference.r1 + 1) * (reference.c2 - reference.c1 + 1);
      if (area <= sheet.cells.size) {
        for (let row = reference.r1; row <= reference.r2; row += 1) {
          for (let column = reference.c1; column <= reference.c2; column += 1) {
            const name = cellName(row, column);
            if (sheet.cells.has(name)) state.graph.addEdge(ensureVertex(state, reference.sheet, name), rangeVertex);
          }
        }
      } else {
        for (const [name, other] of sheet.cells) {
          if (other.row >= reference.r1 && other.row <= reference.r2 && other.column >= reference.c1 && other.column <= reference.c2) {
            state.graph.addEdge(ensureVertex(state, reference.sheet, name), rangeVertex);
          }
        }
      }
    }
    sources.push(rangeVertex);
  }
  for (const source of sources) state.graph.addEdge(source, target);
  cell.sources = sources;
}

function unlinkFormula(state, sheetName, address, cell) {
  const target = vertexOf(sheetName, address);
  for (const source of cell.sources ?? []) state.graph.removeEdge(source, target);
}

/** Formula cells that `vertex` reads, through range nodes. */
function formulaPrecedents(state, vertex) {
  const found = new Set();
  for (const source of state.graph.in.get(vertex) ?? []) {
    if (state.ranges.has(source)) {
      for (const inner of state.graph.in.get(source)) if (isFormulaVertex(state, inner)) found.add(inner);
    } else if (isFormulaVertex(state, source)) found.add(source);
  }
  return found;
}

function cellAt(state, vertex) {
  const { sheet, address } = splitVertex(vertex);
  return state.sheets.get(sheet)?.cells.get(address) ?? null;
}
const isFormulaVertex = (state, vertex) => Boolean(cellAt(state, vertex)?.formula);

function readValue(state, sheetName, row, column) {
  const sheet = state.sheets.get(sheetName);
  if (!sheet) return { error: '#REF!' };
  const cell = sheet.cells.get(cellName(row, column));
  if (!cell) return null;
  if (cell.formula) return state.computed.get(vertexOf(sheetName, cellName(row, column))) ?? { error: '#CALC!' };
  return cell.value;
}

/** Recomputes the given formula cells (all when null) in dependency order; cycles and unsupported formulas are marked, never guessed. */
function recalculate(state, only = null) {
  const targets = only ?? [...state.sheets.values()].flatMap((sheet) => [...sheet.cells].filter(([, cell]) => cell.formula).map(([address]) => vertexOf(sheet.name, address)));
  const inScope = new Set(targets);
  const indegree = new Map();
  const dependents = new Map();
  for (const vertex of targets) {
    const precedents = [...formulaPrecedents(state, vertex)].filter((item) => inScope.has(item));
    indegree.set(vertex, precedents.length);
    for (const precedent of precedents) {
      if (!dependents.has(precedent)) dependents.set(precedent, []);
      dependents.get(precedent).push(vertex);
    }
  }
  const queue = targets.filter((vertex) => indegree.get(vertex) === 0);
  const order = [];
  for (let index = 0; index < queue.length; index += 1) {
    order.push(queue[index]);
    for (const next of dependents.get(queue[index]) ?? []) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  for (const vertex of targets) state.problems.delete(vertex);
  for (const vertex of order) {
    const cell = cellAt(state, vertex);
    const { sheet } = splitVertex(vertex);
    if (cell.formula.unsupported) {
      state.problems.set(vertex, `unsupported formula: ${cell.formula.unsupported}`);
      state.computed.set(vertex, { error: '#UNSUPPORTED' });
      continue;
    }
    try {
      state.computed.set(vertex, evaluate(cell.formula.tree, { sheet, row: cell.row, column: cell.column, anchor: cell.formula.anchor,
        read: (name, row, column) => readValue(state, name, row, column), bounds: (name) => boundsOf(state, name) }));
    } catch (error) {
      if (!(error instanceof UnsupportedFormula)) throw error;
      state.problems.set(vertex, `unsupported formula: ${error.message}`);
      state.computed.set(vertex, { error: '#UNSUPPORTED' });
    }
    const tainted = [...formulaPrecedents(state, vertex)].find((precedent) => state.problems.has(precedent));
    if (tainted && !state.problems.has(vertex)) state.problems.set(vertex, `depends on ${tainted}, which cannot be computed`);
  }
  const ordered = new Set(order);
  for (const vertex of targets) {
    if (!ordered.has(vertex)) {
      state.problems.set(vertex, 'part of a circular reference');
      state.computed.set(vertex, { error: '#CYCLE!' });
    }
  }
  return order.length;
}

export function stateFromSheets(sheets) {
  const state = { sheets: new Map(sheets.map((sheet) => [sheet.name, sheet])), graph: new BoundaryReachability(), computed: new Map(),
    problems: new Map(), ranges: new Map() };
  for (const sheet of sheets) for (const address of sheet.cells.keys()) state.graph.addVertex(vertexOf(sheet.name, address), sheet.name);
  for (const sheet of sheets) for (const [address, cell] of sheet.cells) if (cell.formula?.tree) linkFormula(state, sheet.name, address, cell);
  // Index time: every region relation R_i is built once, so later revisions rebuild only the regions they edit.
  for (const sheet of sheets) state.graph.interfaceOf(sheet.name);
  recalculate(state);
  return state;
}

function cloneState(state) {
  return { sheets: new Map([...state.sheets].map(([name, sheet]) => [name, { ...sheet, cells: new Map(sheet.cells) }])),
    graph: state.graph.clone(), computed: new Map(state.computed), problems: new Map(state.problems), ranges: new Map(state.ranges) };
}

// ── structure: tables, column summaries, formula regions ───────────────────

/** A sheet is a table when its first row is all text headers and rows follow it without a gap. */
function detectTables(state) {
  const tables = [];
  for (const sheet of state.sheets.values()) {
    const byRow = new Map();
    for (const cell of sheet.cells.values()) {
      if (!byRow.has(cell.row)) byRow.set(cell.row, []);
      byRow.get(cell.row).push(cell);
    }
    const row = Math.min(...byRow.keys());
    const cells = byRow.get(row).sort((a, b) => a.column - b.column);
    const texts = cells.filter((cell) => typeof cell.value === 'string' && !cell.formula);
    if (texts.length < 2 || texts.length !== cells.length || (byRow.get(row + 1)?.length ?? 0) < 2) continue;
    let last = row + 1;
    while (byRow.has(last + 1)) last += 1;
    tables.push({ name: sheet.name, sheet: sheet.name, headerRow: row, firstRow: row + 1, lastRow: last,
      columns: cells.map((cell) => ({ name: cell.value, column: cell.column })) });
  }
  return tables;
}

function sqlTables(state, tables) {
  const registry = new Map();
  for (const found of tables) {
    const sheet = state.sheets.get(found.sheet);
    const rows = [];
    const cellsOf = [];
    for (let row = found.firstRow; row <= found.lastRow; row += 1) {
      const values = [];
      const cells = [];
      for (const column of found.columns) {
        const cell = sheet.cells.get(cellName(row, column.column)) ?? null;
        cells.push(cell);
        values.push(cell ? sqlValue(cell, cell.value) : null);
      }
      rows.push(values);
      cellsOf.push(cells);
    }
    registry.set(normalizeName(found.name), {
      name: found.name, columns: found.columns.map((column) => ({ name: column.name })), rows,
      rowNumber: (index) => found.firstRow + index,
      info: (index, columnIndex) => {
        const row = found.firstRow + index;
        const address = cellName(row, found.columns[columnIndex].column);
        const cell = cellsOf[index][columnIndex];
        const vertex = vertexOf(found.sheet, address);
        return { address,
          kind: !cell ? 'empty' : cell.formula ? 'formula' : 'literal',
          formula: cell?.formula?.tree ? formulaText(cell.formula.tree, { row: cell.row, column: cell.column, anchor: cell.formula.anchor }) : null,
          calc: !cell ? null : cell.formula ? (state.problems.has(vertex) ? null : sqlValue(cell, state.computed.get(vertex))) : sqlValue(cell, cell.value) };
      },
    });
  }
  return registry;
}

function sqlValue(cell, value) {
  if (value === null || value === undefined) return null;
  if (isError(value)) return null;
  if (cell.date && typeof value === 'number') return serialToIso(value);
  return value;
}

function columnSummary(state, found, column) {
  const sheet = state.sheets.get(found.sheet);
  const values = [];
  let empty = 0;
  let dates = 0;
  for (let row = found.firstRow; row <= found.lastRow; row += 1) {
    const cell = sheet.cells.get(cellName(row, column.column));
    if (!cell || cell.value === null || cell.value === '') { empty += 1; continue; }
    if (cell.date) dates += 1;
    values.push(cell.date ? serialToIso(cell.value) : cell.value);
  }
  const numbers = values.filter((value) => typeof value === 'number');
  const distinct = new Map();
  for (const value of values) distinct.set(value, (distinct.get(value) ?? 0) + 1);
  let type = 'text';
  if (dates === values.length && values.length) type = 'date';
  else if (numbers.length === values.length && values.length) type = numbers.every(Number.isInteger) ? 'integer' : 'number';
  else if (numbers.length && numbers.length < values.length) type = 'mixed';
  const parts = [`${columnLetters(column.column)} ${column.name}: ${type}`];
  if (empty) parts.push(`${plural(empty, 'empty cell')}`);
  if (type === 'integer' || type === 'number') {
    parts.push(`${fmt(Math.min(...numbers))}..${fmt(Math.max(...numbers))}, sum ${fmt(numbers.reduce((sum, value) => sum + value, 0))}`);
    if (distinct.size <= LOW_CARDINALITY) parts.push(`values ${[...distinct].map(([value, count]) => `${fmt(value)}×${count}`).join(' ')}`);
  } else if (type === 'date') {
    const sorted = [...values].sort();
    parts.push(`${sorted[0]}..${sorted.at(-1)}`);
  } else if (distinct.size <= LOW_CARDINALITY) {
    parts.push(`${distinct.size} distinct: ${[...distinct].sort((a, b) => b[1] - a[1]).map(([value, count]) => `${fmt(value)} ${count}`).join(', ')}`);
  } else {
    const repeated = [...distinct.values()].filter((count) => count > 1).length;
    parts.push(`${distinct.size.toLocaleString('en-US')} distinct${distinct.size === values.length ? ' (all unique)' : repeated && distinct.size > values.length / 2 ? ` (${repeated} values repeat)` : ''}`);
  }
  return parts.join(', ');
}

/** Per column: the dominant filled-down formula, where it holds, and every exception inside its span. A sound region lists its exceptions. */
function formulaRegions(state, sheetName) {
  const sheet = state.sheets.get(sheetName);
  const byColumn = new Map();
  for (const [address, cell] of sheet.cells) {
    if (!byColumn.has(cell.column)) byColumn.set(cell.column, []);
    byColumn.get(cell.column).push([address, cell]);
  }
  const regions = [];
  for (const [column, entries] of [...byColumn].sort((a, b) => a[0] - b[0])) {
    const keyed = entries.filter(([, cell]) => cell.formula?.tree).map(([address, cell]) => [address, cell, r1c1(cell.formula.tree, { row: cell.row, column: cell.column, anchor: cell.formula.anchor })]);
    if (keyed.length < 2) continue;
    const counts = new Map();
    for (const [, , key] of keyed) counts.set(key, (counts.get(key) ?? 0) + 1);
    const [dominant, count] = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (count < 2) continue;
    const members = keyed.filter(([, , key]) => key === dominant).map(([, cell]) => cell);
    const first = members.reduce((best, cell) => (cell.row < best.row ? cell : best));
    const last = members.reduce((best, cell) => (cell.row > best.row ? cell : best));
    const exceptions = [];
    for (let row = first.row; row <= last.row; row += 1) {
      const cell = sheet.cells.get(cellName(row, column));
      const key = cell?.formula?.tree ? r1c1(cell.formula.tree, { row: cell.row, column: cell.column, anchor: cell.formula.anchor }) : null;
      if (key === dominant) continue;
      exceptions.push({ address: cellName(row, column), kind: !cell ? 'empty' : cell.formula ? 'other formula' : 'literal', cell });
    }
    regions.push({ sheet: sheetName, column, first, last, count, text: formulaText(first.formula.tree, { row: first.row, column: first.column, anchor: first.formula.anchor }), exceptions });
  }
  return regions;
}

// ── listings ────────────────────────────────────────────────────────────────

/** Cells as sheet-grouped ranges: Orders!I2:I2401, Summary!B13:B14. */
export function compressCells(vertices) {
  const bySheet = new Map();
  for (const vertex of vertices) {
    const { sheet, address } = splitVertex(vertex);
    const at = parseCellName(address);
    if (!at) continue;
    if (!bySheet.has(sheet)) bySheet.set(sheet, new Map());
    const columns = bySheet.get(sheet);
    if (!columns.has(at.column)) columns.set(at.column, []);
    columns.get(at.column).push(at.row);
  }
  const parts = [];
  for (const [sheet, columns] of bySheet) {
    // Columns with identical row runs merge into rectangles (F2:H2100).
    const spans = [...columns].sort((a, b) => a[0] - b[0]).map(([column, rows]) => ({ column, runs: runs(rows) }));
    const merged = [];
    for (const span of spans) {
      const previous = merged.at(-1);
      if (previous && previous.c2 + 1 === span.column && JSON.stringify(previous.runs) === JSON.stringify(span.runs)) previous.c2 = span.column;
      else merged.push({ c1: span.column, c2: span.column, runs: span.runs });
    }
    for (const block of merged) {
      for (const [r1, r2] of block.runs) {
        const a = cellName(r1, block.c1);
        const b = cellName(r2, block.c2);
        parts.push(`${sheet}!${a === b ? a : `${a}:${b}`}`);
      }
    }
  }
  return parts;
}

function describeCell(state, sheetName, address, { calcOnly = false } = {}) {
  const cell = state.sheets.get(sheetName)?.cells.get(address);
  if (!cell) return `${address} (empty)`;
  const vertex = vertexOf(sheetName, address);
  if (!cell.formula) return `${address} ${JSON.stringify(displayValue(cell, cell.value))}`;
  const computed = displayValue(cell, state.computed.get(vertex));
  const text = cell.formula.tree ? formulaText(cell.formula.tree, { row: cell.row, column: cell.column, anchor: cell.formula.anchor }) : `=${cell.formula.source}`;
  const problem = state.problems.get(vertex);
  const cached = displayValue(cell, cell.value);
  const stale = !problem && cached !== null && !sameValue(cell.value, state.computed.get(vertex)) ? ` (cached ${fmt(cached)})` : '';
  return calcOnly ? `${address} ${fmt(computed)}` : `${address} ${text} → ${problem ? `unknown: ${problem}` : fmt(computed)}${stale}`;
}

function sameValue(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (isError(a) && isError(b)) return a.error === b.error;
  return a === b;
}

// ── the adapter ─────────────────────────────────────────────────────────────

export function openWorkbook(buffer, { path: filePath, revision, hash = revision }) {
  const started = performance.now();
  const { sheets } = readWorkbook(buffer);
  const base = stateFromSheets(sheets);
  const tables = detectTables(base);
  const indexMs = performance.now() - started;
  const fileRevision = revision;
  const sqlCache = new Map();
  const tablesOf = (state) => {
    if (!sqlCache.has(state)) sqlCache.set(state, sqlTables(state, tables));
    return sqlCache.get(state);
  };
  const totals = () => {
    let cells = 0;
    let formulas = 0;
    for (const sheet of base.sheets.values()) for (const cell of sheet.cells.values()) { cells += 1; if (cell.formula) formulas += 1; }
    return { cells, formulas };
  };

  /** The revision an op names: the file's own unless `rev` names a what-if revision of this session. */
  const stateFor = (params, session) => {
    const name = params.rev ?? params.base ?? fileRevision;
    if (name === fileRevision || name === 'r1') return { state: base, revision: fileRevision };
    const derived = session.revisions.get(name);
    if (!derived) throw new OpError(`unknown revision ${name}; this file is ${fileRevision}${session.revisions.size ? ` and what-if revisions are ${[...session.revisions.keys()].join(', ')}` : ''}`);
    if (derived.file !== hash) throw new OpError(`revision ${name} was derived from an earlier version of this file, which has since changed; redo the what-if`, 'stale');
    return { state: derived.state, revision: name };
  };

  function card() {
    const { cells, formulas } = totals();
    const lines = [`${filePath} · rev ${fileRevision} · workbook, ${plural(base.sheets.size, 'sheet')}, ${plural(cells, 'cell')}, ${plural(formulas, 'formula')}`];
    const problems = [...base.problems];
    if (problems.length) lines.push(`cannot compute ${plural(problems.length, 'formula')}: ${head(problems, 4, ([vertex, why]) => `${vertex} (${why})`).join('; ')}`);
    let stale = 0;
    for (const sheet of base.sheets.values()) {
      for (const [address, cell] of sheet.cells) if (cell.formula && cell.value !== null && !base.problems.has(vertexOf(sheet.name, address)) && !sameValue(cell.value, base.computed.get(vertexOf(sheet.name, address)))) stale += 1;
    }
    lines.push(stale ? `cached formula values: ${stale} differ from recalculation` : 'cached formula values: all match recalculation');
    for (const sheet of base.sheets.values()) {
      const found = tables.find((item) => item.sheet === sheet.name);
      const extent = `A1:${cellName(sheet.maxRow, sheet.maxColumn)}`;
      if (sheet.cells.size <= SMALL_SHEET_CELLS) {
        lines.push(`sheet ${sheet.name} ${extent}${found ? ' (a table for sql)' : ''}: ${plural(sheet.cells.size, 'cell')}, all shown by row (A | B | …; =formula→value):`);
        lines.push(...rowListing(base, sheet).map((line) => `  ${line}`));
      } else if (found) {
        lines.push(`sheet ${sheet.name} ${extent}: table, header row ${found.headerRow}, ${plural(found.lastRow - found.firstRow + 1, 'data row')} (${found.firstRow}–${found.lastRow})`);
        for (const column of found.columns) lines.push(`  ${columnSummary(base, found, column)}`);
        for (const region of formulaRegions(base, sheet.name)) {
          const span = `${cellName(region.first.row, region.column)}:${cellName(region.last.row, region.column)}`;
          const exceptions = region.exceptions.length ? `; exceptions ${head(region.exceptions, 12, (item) => `${item.address} (${item.kind})`).join(', ')}` : '';
          lines.push(`  formula region ${span}: ${region.text} filled down (${plural(region.count, 'cell')})${exceptions}`);
        }
      } else {
        lines.push(`sheet ${sheet.name} ${extent}: ${plural(sheet.cells.size, 'cell')}; read them with cells`);
      }
    }
    const crossing = crossSheetRelation(base);
    if (crossing.length) lines.push('cross-sheet dependencies (exact):', ...crossing.map((line) => `  ${line}`));
    return lines.join('\n');
  }

  const OPS_HELP = [
    'ops (batch several in one call):',
    ' {op:"sql", q:"SELECT … FROM Orders [JOIN Products ON …] WHERE … GROUP BY … HAVING … ORDER BY … LIMIT n"} exact over every row. Tables: '
      + `${tables.map((item) => item.name).join(', ')}. A column name gives each cell's value as stored in the file (quote names with spaces: "Unit Price"); dates as yyyy-mm-dd. Functions: SUM AVG MIN MAX COUNT(DISTINCT x) GROUP_CONCAT ROUND ABS UPPER LOWER SUBSTR COALESCE YEAR MONTH QUARTER CASE; about the cell itself: ROW() ADDRESS(col) KIND(col) ('formula'|'literal') FORMULA(col) CALC(col) (value recomputed from its formula). Arithmetic on text is an error, never zero.`,
    ' {op:"cells", range:"Sheet!A1:C9"} values and formulas',
    ' {op:"deps", cell:"Sheet!B3", dir:"dependents"|"precedents"} every cell it affects or reads, transitively',
    ' {op:"whatif", set:{"Sheet!B3":0.15}, formulas:{"Sheet!B9":"=SUM(…)"}, base?:"r2", show?:["Sheet!B12"]} recalculates a copy; returns every changed cell and a new revision; pass rev:"r2" to any op to read it',
  ].join('\n');

  function sqlOp(params, session) {
    if (typeof params.q !== 'string') throw new OpError('sql needs q, a SELECT query');
    const { state, revision } = stateFor(params, session);
    let output;
    const registry = tablesOf(state);
    const columns = [...registry.values()].flatMap((item) => item.columns.map((column) => column.name));
    try { output = runSql(params.q, (reference) => registry.get(normalizeName(reference.table)) ?? null, { columns }); } catch (error) {
      if (error instanceof SqlError) throw new OpError(error.message);
      throw error;
    }
    const scanned = output.scanned.map(({ table: name, rows }) => `${name} ${rows.toLocaleString('en-US')}/${rows.toLocaleString('en-US')} rows`).join(', ');
    const truncated = output.rows.length < output.total;
    const full = table(output.columns, output.rows);
    const forms = [form('full', `${plural(output.rows.length, 'row')}${truncated ? ` (LIMIT; ${output.total.toLocaleString('en-US')} before it)` : ''}\n${full}`)];
    if (output.rows.length > 40) {
      forms.push(form('head', `${plural(output.rows.length, 'row')}, first 40 shown; add LIMIT/OFFSET or a narrower WHERE for the rest\n${table(output.columns, output.rows.slice(0, 40))}`, false));
    }
    const problems = [...state.problems.keys()].filter((vertex) => tables.some((item) => vertex.startsWith(`${item.sheet}!`)));
    return result({ status: problems.length ? 'bounded' : 'exact', coverage: { universe: scanned, complete: true }, provenance: 'computed', revision,
      guarantee: problems.length ? `${plural(problems.length, 'cell')} in these tables cannot be computed; CALC() is null there` : 'every row read; values as stored',
      forms });
  }

  function cellsOp(params, session) {
    if (typeof params.range !== 'string') throw new OpError('cells needs range, as in "Summary!A1:C14"');
    const { state, revision } = stateFor(params, session);
    const reference = parseReference(params.range, [...state.sheets.keys()][0]);
    if (!reference || !state.sheets.has(reference.sheet)) throw new OpError(`cannot read range ${params.range}; sheets are ${[...state.sheets.keys()].join(', ')}`);
    const sheet = state.sheets.get(reference.sheet);
    const found = [...sheet.cells].filter(([, cell]) => cell.row >= reference.r1 && cell.row <= reference.r2 && cell.column >= reference.c1 && cell.column <= reference.c2)
      .sort((a, b) => a[1].row - b[1].row || a[1].column - b[1].column).map(([address]) => describeCell(state, reference.sheet, address));
    const area = (reference.r2 - reference.r1 + 1) * (reference.c2 - reference.c1 + 1);
    const forms = [form('full', `${reference.sheet}: ${plural(found.length, 'non-empty cell')} of ${area.toLocaleString('en-US')}\n${found.join('\n')}`)];
    if (found.length > 60) forms.push(form('head', `${reference.sheet}: ${plural(found.length, 'non-empty cell')}, first 60 shown\n${found.slice(0, 60).join('\n')}`, false));
    return result({ status: 'exact', provenance: 'format', revision, coverage: { universe: `${reference.sheet}!${cellName(reference.r1, reference.c1)}:${cellName(reference.r2, reference.c2)}`, complete: true }, forms });
  }

  function depsOp(params, session) {
    const { state, revision } = stateFor(params, session);
    const reference = parseReference(params.cell ?? '', null);
    if (!reference?.sheet || !state.sheets.has(reference.sheet)) throw new OpError('deps needs cell with its sheet, as in "Summary!B3"');
    const direction = /^prec|^in|^read|^feed/i.test(params.dir ?? '') ? 'in' : 'out';
    const sources = [];
    for (let row = reference.r1; row <= reference.r2; row += 1) for (let column = reference.c1; column <= reference.c2; column += 1) sources.push(ensureVertexReadOnly(state, reference.sheet, cellName(row, column)));
    const reached = new Set();
    const regions = new Set();
    for (const source of sources.filter(Boolean)) {
      const { vertices, handle } = state.graph.closure(source, direction);
      for (const vertex of vertices) if (!state.ranges.has(vertex) && !sources.includes(vertex)) reached.add(vertex);
      for (const region of Object.keys(handle.regions)) regions.add(region);
    }
    const listed = compressCells(reached);
    const unknown = [...state.problems].filter(([vertex, why]) => why.startsWith('unsupported') && reached.has(vertex));
    const label = direction === 'out' ? 'affected (dependents)' : 'read (precedents)';
    const forms = [form('full', `${plural(reached.size, 'cell')} ${label} of ${params.cell}: ${listed.join(', ') || 'none'}`)];
    if (listed.length > 30) forms.push(form('head', `${plural(reached.size, 'cell')} ${label} of ${params.cell}: ${head(listed, 30).join(', ')}`, false));
    return result({ status: unknown.length ? 'bounded' : 'exact', provenance: 'format', revision,
      coverage: { universe: `dependency graph of ${plural(state.graph.regionOf.size, 'vertex', 'vertices')} (regions ${[...regions].join(', ')})`, complete: true },
      guarantee: unknown.length ? `${plural(unknown.length, 'unsupported formula')} on the way; their own references are unknown` : 'reachability over every formula reference',
      forms });
  }

  function whatifOp(params, session) {
    const { state: baseState, revision: baseRevision } = stateFor({ rev: params.base }, session);
    const values = params.set ?? {};
    const formulas = params.formulas ?? {};
    if (!Object.keys(values).length && !Object.keys(formulas).length) throw new OpError('whatif needs set:{cell:value} and/or formulas:{cell:"=…"}');
    const buildsBefore = baseState.graph.relationBuilds;
    const state = cloneState(baseState);
    state.graph.relationBuilds = 0;
    const edited = [];
    const apply = (address, makeCell) => {
      const reference = parseReference(address, null);
      if (!reference?.sheet || !state.sheets.has(reference.sheet) || reference.r1 !== reference.r2 || reference.c1 !== reference.c2) {
        throw new OpError(`whatif cells need a sheet and one cell, as in "Summary!B3" (got ${address})`);
      }
      const name = cellName(reference.r1, reference.c1);
      const sheet = state.sheets.get(reference.sheet);
      const previous = sheet.cells.get(name);
      if (previous?.formula?.tree) unlinkFormula(state, reference.sheet, name, previous);
      const cell = makeCell({ row: reference.r1, column: reference.c1, date: previous?.date ?? false });
      sheet.cells.set(name, cell);
      sheet.maxRow = Math.max(sheet.maxRow, reference.r1);
      sheet.maxColumn = Math.max(sheet.maxColumn, reference.c1);
      const vertex = ensureVertex(state, reference.sheet, name);
      if (cell.formula?.tree) linkFormula(state, reference.sheet, name, cell);
      if (!cell.formula) state.computed.delete(vertex);
      edited.push(vertex);
    };
    for (const [address, value] of Object.entries(values)) {
      apply(address, ({ row, column, date }) => ({ row, column, value: typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : value, formula: null, date }));
    }
    for (const [address, text] of Object.entries(formulas)) {
      let tree;
      try { tree = parseFormula(String(text)); } catch (error) {
        if (error instanceof UnsupportedFormula) return result({ status: 'unsupported', forms: [form('full', `formula for ${address} is outside the supported language: ${error.message}`)] });
        throw error;
      }
      apply(address, ({ row, column }) => ({ row, column, value: null, formula: { tree, anchor: { row, column } }, date: false }));
    }
    const affected = new Set();
    for (const vertex of edited) for (const reached of state.graph.closure(vertex, 'out').vertices) if (isFormulaVertex(state, reached)) affected.add(reached);
    recalculate(state, [...affected]);
    const changed = [];
    for (const vertex of new Set([...edited, ...affected])) {
      const cell = cellAt(state, vertex);
      const before = cellAt(baseState, vertex);
      const old = before ? (before.formula ? baseState.computed.get(vertex) : before.value) : null;
      const now = cell.formula ? state.computed.get(vertex) : cell.value;
      if (!sameValue(old, now)) changed.push({ vertex, old: displayValue(before, old), now: displayValue(cell, now) });
    }
    const revision = `r${session.revisions.size + 2}`;
    session.revisions.set(revision, { state, file: hash, base: baseRevision });
    const show = (params.show ?? []).map((address) => {
      const reference = parseReference(address, null);
      if (!reference?.sheet) return `${address}: name a sheet`;
      const vertex = vertexOf(reference.sheet, cellName(reference.r1, reference.c1));
      const before = cellAt(baseState, vertex);
      const after = cellAt(state, vertex);
      const read = (s, c) => (c ? displayValue(c, c.formula ? s.computed.get(vertex) : c.value) : null);
      return `${address}: ${fmt(read(baseState, before))} → ${fmt(read(state, after))}`;
    });
    const edits = [...Object.entries(values).map(([address, value]) => `${address} = ${JSON.stringify(value)}`), ...Object.entries(formulas).map(([address, text]) => `${address} ${text}`)];
    const problems = [...affected].filter((vertex) => state.problems.has(vertex));
    const listing = changed.map((item) => `${splitVertex(item.vertex).sheet}!${splitVertex(item.vertex).address}: ${fmt(item.old)} → ${fmt(item.now)}`);
    const headLine = `revision ${revision} = ${baseRevision} with ${edits.join('; ')}\nrecalculated ${plural(affected.size, 'dependent formula')}; ${plural(changed.length, 'cell')} changed`
      + `${problems.length ? `; ${plural(problems.length, 'formula')} cannot be computed: ${head(problems, 3).join(', ')}` : ''}`;
    const showLine = show.length ? `\nrequested: ${show.join('; ')}` : '';
    const reuse = `\ndependency interface: ${state.graph.relationBuilds} region relation(s) rebuilt, the others reused (${buildsBefore} built before)`;
    const forms = [form('full', `${headLine}${showLine}\n${listing.join('\n')}${reuse}`)];
    if (listing.length > 30) forms.push(form('head', `${headLine}${showLine}\nchanged: ${compressCells(changed.map((item) => item.vertex)).join(', ')}\nfirst 30: ${listing.slice(0, 30).join('; ')}${reuse}`, false));
    return result({ status: problems.length ? 'bounded' : 'exact', provenance: 'computed', revision,
      coverage: { universe: `every formula reachable from the ${plural(edited.length, 'edited cell')}`, complete: true },
      guarantee: 'only dependents can change; each was recalculated from current values (caches ignored)', forms });
  }

  return {
    kind: 'workbook', revision: fileRevision, indexMs, opsHelp: OPS_HELP,
    card,
    fullText: () => fullText(base),
    ops: { sql: sqlOp, cells: cellsOp, deps: depsOp, whatif: whatifOp },
    state: base,
    tables,
  };
}

/** A small sheet row by row: "7: North | =SUMIFS(…)→5481836.28 | …", computed values shown after each formula. */
function rowListing(state, sheet) {
  const byRow = new Map();
  for (const [address, cell] of sheet.cells) {
    if (!byRow.has(cell.row)) byRow.set(cell.row, new Map());
    byRow.get(cell.row).set(cell.column, address);
  }
  return [...byRow.keys()].sort((a, b) => a - b).map((row) => {
    const columns = byRow.get(row);
    const parts = [];
    for (let column = 1; column <= Math.max(...columns.keys()); column += 1) {
      const address = columns.get(column);
      parts.push(address ? describeCell(state, sheet.name, address).replace(/^[A-Z]+\d+ /, '').replace(/ → /, '→') : '');
    }
    return `${row}: ${parts.join(' | ')}`;
  });
}

function ensureVertexReadOnly(state, sheet, address) {
  const vertex = vertexOf(sheet, address);
  return state.graph.hasVertex(vertex) ? vertex : null;
}

/** The boundary relation between sheets: each formula block that reads another sheet, and what it reads there. */
function crossSheetRelation(state) {
  const groups = new Map();
  for (const sheet of state.sheets.values()) {
    for (const [address, cell] of sheet.cells) {
      if (!cell.formula?.tree) continue;
      const foreign = (cell.sources ?? []).filter((source) => splitVertex(source).sheet !== sheet.name);
      if (!foreign.length) continue;
      const key = `${sheet.name}|${r1c1(cell.formula.tree, { row: cell.row, column: cell.column, anchor: cell.formula.anchor })}`;
      if (!groups.has(key)) groups.set(key, { cells: [], reads: new Set() });
      groups.get(key).cells.push(vertexOf(sheet.name, address));
      for (const source of foreign) groups.get(key).reads.add(source);
    }
  }
  return [...groups.values()].map((group) => `${compressCells(group.cells).join(', ')} ← ${head([...group.reads].sort(), 6).join(', ')}`);
}

/** The complete normalised source, for the full-context baseline: every cell, with its formula and cached value. */
function fullText(state) {
  const lines = [];
  for (const sheet of state.sheets.values()) {
    const letters = Array.from({ length: sheet.maxColumn }, (_, index) => columnLetters(index + 1));
    lines.push(`## Sheet ${sheet.name}, A1:${cellName(sheet.maxRow, sheet.maxColumn)}. One line per row: the row number, then columns ${letters.join(', ')} in order, separated by " | " (empty cells empty). A formula cell shows =FORMULA→its cached value.`);
    const byRow = new Map();
    for (const cell of sheet.cells.values()) {
      if (!byRow.has(cell.row)) byRow.set(cell.row, new Map());
      byRow.get(cell.row).set(cell.column, cell);
    }
    for (const row of [...byRow.keys()].sort((a, b) => a - b)) {
      const cells = letters.map((_, index) => {
        const cell = byRow.get(row).get(index + 1);
        if (!cell) return '';
        const value = fmt(displayValue(cell, cell.value));
        return cell.formula ? `${cell.formula.tree ? formulaText(cell.formula.tree, { row: cell.row, column: cell.column, anchor: cell.formula.anchor }) : `=${cell.formula.source}`}→${value}` : value;
      });
      while (cells.length && cells.at(-1) === '') cells.pop();
      lines.push(`${row}: ${cells.join(' | ')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * One cell as a caller outside this adapter reads it: its address, whether it is a formula or a literal, the formula
 * as written for that cell, its stored value and its value recomputed (null where it cannot be), or null for an
 * empty cell. `state` is an adapter's `state`.
 */
export function cellFacts(state, sheetName, address) {
  const cell = state.sheets.get(sheetName)?.cells.get(address);
  if (!cell) return null;
  const vertex = vertexOf(sheetName, address);
  const formula = !cell.formula ? null : cell.formula.tree ? formulaText(cell.formula.tree, { row: cell.row, column: cell.column, anchor: cell.formula.anchor }) : `=${cell.formula.source}`;
  const calc = !cell.formula ? sqlValue(cell, cell.value) : state.problems.has(vertex) ? null : sqlValue(cell, state.computed.get(vertex));
  return { address, kind: cell.formula ? 'formula' : 'literal', formula, value: sqlValue(cell, cell.value), calc };
}
