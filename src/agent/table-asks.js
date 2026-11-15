// Whole-table asks: what no excerpt of a table can show. A total by group, a
// filter, a join across sheets, the rows that repeat are worked out from
// every row of the tables named, read at the revision the index holds, and
// the answer says how many rows that was.
//
// An agent asks in SQL ("SELECT Region, SUM(Net) FROM Orders GROUP BY
// Region"), or in plain words for the common cases ("total Net by quarter",
// "duplicate Order IDs"), which are turned into a query the answer shows.
// The query language and its limits are table-sql.js; how cells are read is
// table-data.js. These methods are installed on the evidence service, and
// are reached only for a model over MCP (evidence.js, `context.mcp`).
//
// A table is named by its sheet, by its file when the file is one table, or
// by both ("Operations 2025.xlsx".Orders). A name two files answer to is
// never chosen between: the answer lists them.

import path from 'node:path';
import { BoundedCache } from '../cache.js';
import { extractSpreadsheetTables, isLargeSpreadsheet, MAX_IN_MEMORY_PART_BYTES } from '../dependencies/document-extraction.js';
import { spreadsheetLayout, tabularLayout } from '../dependencies/tabular.js';
import { parseDelimited } from '../history/diff.js';
import { AgentError } from './errors.js';
import { fold as foldAsk, namesHeader } from './ask.js';
import { estimateTokens } from './metrics.js';
import { cellNumber, typedTable } from './table-data.js';
import { normalizeName, parseSql, runSql, SqlError, tablesNamed, tablesWritten } from './table-sql.js';
import { cellFacts } from './ops/spreadsheet.js';
import { operationKind } from './file-ops.js';

// Cells of the tables kept read, and of one file's tables at most: beyond it the file is refused, not read in part.
const MAX_TABLE_CELLS = 4_000_000;
// A result's rows are sent within this many tokens unless the call's budget is larger, and never more than this many rows.
const RESULT_TOKENS = 1500;
const RESULT_ROWS = 500;
const TABLE_FILES = ['table', 'spreadsheet'];
// An ask that wants something worked out is told a query can do it when a table behind its answer has this many rows.
const HINT_ROWS = 30;
// Tables with more cells than this are counted from the table index for that line, not read for it.
const COUNTED_NOT_READ = 200_000;
// An ask written as a query begins with SELECT, or names a file and then does ("Operations 2025.xlsx: SELECT …").
const FILE_THEN_SQL = /^["'`]?(\S[\s\S]*?\.[A-Za-z][A-Za-z0-9]{1,9})["'`]?[\s:;,]+(select\s[\s\S]+)$/i;
const SQL_MARKS = /[*=()'"<>]|\b(?:where|group by|order by|join|limit|having|count|sum|avg|distinct)\b/i;
const GROUPING = /\b(?:grouped by|group by|broken down by|split by|for each|for every|in each|per|by)\s+(\S[\s\S]*)$/i;
const REPEATS = /\bduplicate[sd]?\b|\bduplicated\b|\bmore than once\b|\brepeated\b/i;
const PERIODS = [[/\bquarter(?:ly|s)?\b/, 'quarter'], [/\bmonth(?:ly|s)?\b/, 'month'], [/\b(?:year(?:ly|s)?|annual(?:ly)?)\b/, 'year']];
const COUNTING = /\b(?:counts?|number of|how many)\b/i;
const DISTINCT = /\b(?:distinct|unique)\b/i;
const FILTERING = /\b(?:where|whose|blank|empty|missing|without)\b|=/i;
// A file named after a query: "SELECT … FROM Orders in Finance/Operations 2025.xlsx". Not the IN of a list, which a "(" follows.
const SQL_THEN_FILE = /\s+in\s+(?!\()(?:the\s+)?(?:file\s+|workbook\s+)?(["'`]?)([^"'`()=<>*]+?\.[A-Za-z][A-Za-z0-9]{1,9})\1\s*$/i;
// Rows of a table shown where the ask wants something worked out from it: enough to see how its cells are written.
const SAMPLE_ROWS = 2;
const HINT_TABLES = 4;
const HINT_COLUMNS = 16;
// Words of an ask that wants something worked out from rows, not a row shown.
const WORKED_OUT = /\b(?:total|sum|average|mean|median|count|how many|number of|each|every|per|grouped|duplicates?|duplicated|more than once|differs?|difference|mismatch(?:es)?|compare|highest|lowest|largest|smallest|percent(?:age)?|share|ratio|rank(?:ed|ing)?|sorted)\b/i;
const OPERATIONS = [[/\b(?:average|mean)\b/i, 'AVG', 'average'], [/\b(?:total|sum|altogether|in all)\b/i, 'SUM', 'total'],
  [/\b(?:highest|largest|maximum|max|biggest)\b/i, 'MAX', 'highest'], [/\b(?:lowest|smallest|minimum|min)\b/i, 'MIN', 'lowest']];

const quoted = (name) => `"${String(name).replace(/"/g, '""')}"`;
const baseName = (filePath) => path.posix.basename(filePath, path.posix.extname(filePath));
// A figure without the noise binary arithmetic leaves in a sum (5481836.279500003).
const clean = (value) => (typeof value === 'number' && !Number.isInteger(value) ? Number(value.toPrecision(12)) : value);

/** Whether a name written in a query is this file: its name, with or without its extension, or the end of its path. */
function namesFile(project, filePath, name) {
  const wanted = String(name).toLowerCase().replace(/\\/g, '/').replace(/^\/+/, '');
  const full = `${project.name}/${filePath}`.toLowerCase();
  return [full, full.replace(/\.[^./]+$/, '')].some((form) => form === wanted || form.endsWith(`/${wanted}`));
}

/** The query an ask is, with the file it names before it, or null when the ask is words. */
export function sqlOfAsk(text) {
  const whole = String(text ?? '').trim();
  let before = null;
  let sql = whole;
  if (!/^select\s/i.test(whole)) {
    const match = FILE_THEN_SQL.exec(whole);
    if (!match) return null;
    [, before, sql] = match;
  }
  if (!/\sfrom\s/i.test(sql)) return null;
  const after = before ? null : SQL_THEN_FILE.exec(sql);
  if (after) { sql = sql.slice(0, after.index); before = after[2].trim(); }
  try { parseSql(sql); } catch (error) {
    // "select the rows from the list where…" is a sentence; a query that fails to read has a query's marks.
    if (!(error instanceof SqlError) || !SQL_MARKS.test(sql)) return null;
  }
  return { sql: sql.trim(), before };
}

// A cell or range as a spreadsheet names it: Summary!B12, Roll-up!B11, 'Net sales'!$B$2:$C$4. The sheet is one word
// (hyphens and dots allowed), or quoted.
const CELL_REFERENCE = /(?:'([^']+)'|([\p{L}_][\p{L}\p{N}_.-]*))!\$?([A-Za-z]{1,3})\$?(\d{1,7})(?::\$?([A-Za-z]{1,3})\$?(\d{1,7}))?(?![\p{L}\p{N}])/u;
const columnLetters = (index) => { let label = ''; for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) label = String.fromCharCode(65 + (n % 26)) + label; return label; };
const whereOf = (conditions) => (conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '');
/** Whether an ask's words want this column's values listed: "distinct Region", "unique values of Region", "Region values". */
const valuesOf = (name) => {
  const column = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`\\b(?:distinct|unique)\\s+(?:values?\\s+(?:of|in|for)\\s+(?:the\\s+)?)?${column}\\b|\\b${column}\\s+values\\b`, 'i');
};
const NO_FILTER = { clauses: [], columns: new Set() };

/**
 * The conditions an ask puts on a table's columns in plain words: a column that is blank or not ("blank Region",
 * "Region is not empty", "without a Region"), or that has a value ("where Region = Noth", "whose Region is North").
 * `clauses` are made once the table is read, so that a value is written as its column has it (north for North) and
 * a figure is a figure; `columns` are the columns filtered on. A value of several words needs its quotes.
 */
function filtersOf(text, columns) {
  const clauses = [];
  const filtered = new Set();
  for (const name of [...columns].sort((left, right) => right.length - left.length)) {
    const column = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const filled = new RegExp(`\\b${column}\\s+(?:is|are)\\s+not\\s+(?:blank|empty|missing|null)\\b|\\b(?:non-?blank|non-?empty)\\s+${column}\\b`, 'i');
    const blank = new RegExp(`\\b(?:blank|empty|missing|no)\\s+${column}\\b|\\b${column}\\s*(?:is|are|=)\\s*(?:blank|empty|missing|null)\\b|\\bwithout\\s+(?:an?\\s+|the\\s+)?${column}\\b`, 'i');
    const equals = new RegExp(`\\b(?:where|whose|with|when)\\s+(?:the\\s+)?${column}\\s*(?:==?|is|equals?)\\s*("[^"]+"|'[^']+'|[^\\s,;]+)`, 'i');
    const value = equals.exec(text)?.[1];
    if (filled.test(text)) clauses.push(() => `${quoted(name)} IS NOT NULL`);
    else if (blank.test(text)) clauses.push(() => `${quoted(name)} IS NULL`);
    else if (value) {
      const wanted = value.replace(/^["']|["']$/g, '');
      clauses.push((table) => {
        const at = table.columns.findIndex((candidate) => candidate.name === name);
        const number = cellNumber(wanted);
        if (number != null && ['number', 'percent', 'mixed'].includes(table.columns[at]?.kind)) return `${quoted(name)} = ${number}`;
        // The value as a cell of the column writes it, when one does but for its capitals.
        const written = table.rows.map((row) => row[at]).find((cell) => typeof cell === 'string' && foldAsk(cell) === foldAsk(wanted));
        return `${quoted(name)} = '${String(written ?? wanted).replace(/'/g, "''")}'`;
      });
    } else continue;
    filtered.add(name);
  }
  return { clauses, columns: filtered };
}

export const tableAskMethods = {
  /** A file revision's tables, read whole and typed once: `[typed table]` with `cells`, how many they hold. */
  tablesOfFile(file) {
    this.typedTables ??= new BoundedCache({ maxEntries: 16, maxWeight: MAX_TABLE_CELLS, weight: (tables) => tables.cells + 1 });
    let tables = this.typedTables.get(file.contentHash);
    if (!tables) {
      tables = this.readTables(file);
      // A workbook's cells can be asked about in a query: FORMULA("Net"), KIND("Net"), CALC("Net"), ADDRESS("Net").
      if (operationKind(file) === 'workbook') {
        try {
          const { adapter } = this.openOperations(file);
          for (const table of tables) {
            table.info = (row, column) => {
              const address = `${columnLetters(column)}${table.rowNumber(row)}`;
              return cellFacts(adapter.state, table.name, address) ?? { address, kind: 'empty', formula: null, value: null, calc: null };
            };
          }
        } catch (error) { if (!(error instanceof AgentError)) throw error; }
      }
      tables.cells = tables.reduce((total, table) => total + table.rows.length * table.columns.length, 0);
      this.typedTables.set(file.contentHash, tables);
    }
    return tables;
  },

  /**
   * Reads a table file's rows as the indexer reads them: a workbook's sheets and a delimited file from the stored
   * bytes, each under the header the indexer finds; a file too large for that from the table index, which has every
   * row. A file with more cells than the limit is refused.
   */
  readTables(file) {
    const base = baseName(file.path);
    const buffer = this.timeline.blobs.get(file.contentHash);
    if (file.fileType === 'spreadsheet' && !isLargeSpreadsheet(buffer)) {
      return [...extractSpreadsheetTables(buffer)].map((sheet) => {
        const layout = spreadsheetLayout(sheet);
        // A statement's layout keeps its heading row among the rows; it is not data.
        const heading = layout.statement && layout.rows[0]?.every((cell, at) => !layout.headers[at] || String(cell ?? '').trim() === layout.headers[at]);
        return typedTable({ name: sheet.name, headers: layout.headers, rows: heading ? layout.rows.slice(1) : layout.rows,
          rowNumbers: heading ? layout.rowNumbers?.slice(1) : layout.rowNumbers });
      });
    }
    if (file.fileType === 'table' && buffer.length <= MAX_IN_MEMORY_PART_BYTES) {
      const tsv = path.extname(file.path).toLowerCase() === '.tsv';
      const layout = tabularLayout(parseDelimited(buffer.toString('utf8').replace(/\r\n/g, '\n'), tsv ? '\t' : ','));
      return [typedTable({ name: base, headers: layout.headers, rows: layout.rows, rowNumbers: layout.rows.map((_, index) => layout.headerRowIndex + 2 + index) })];
    }
    return this.dependencies.tables.sheets(file.contentHash).map((meta) => {
      const start = meta.shape?.dataStart ?? 0;
      const headers = meta.shape?.headers ?? [];
      if ((meta.rowCount - start) * Math.max(1, headers.length) > MAX_TABLE_CELLS) {
        throw new AgentError('too_large', `${file.path} has ${(meta.rowCount - start).toLocaleString('en-US')} rows, more than a query reads here.`);
      }
      const stored = [];
      for (let from = start; from < meta.rowCount; from += 10_000) stored.push(...this.dependencies.tables.rows(meta.id, from, Math.min(meta.rowCount, from + 10_000)));
      return typedTable({ name: file.fileType === 'spreadsheet' ? meta.sheet : base, headers, rows: stored.map((row) => row.cells.map((cell) => String(cell ?? ''))),
        rowNumbers: stored.map((row) => (file.fileType === 'table' ? row.rowNumber + 1 : row.rowNumber)) });
    });
  },

  /**
   * A file's tables by name, each with how many rows it has and its columns' names. Tables the table index holds
   * whole and that are large are counted there, without reading their rows; any other file is read, and kept for the
   * query likely to follow.
   */
  tableSizes(file) {
    if (!this.typedTables?.has(file.contentHash)) {
      const base = baseName(file.path);
      const indexed = this.dependencies.tables.sheets(file.contentHash).map((meta) => ({ name: file.fileType === 'spreadsheet' ? meta.sheet : base,
        rows: Math.max(0, meta.rowCount - (meta.shape?.dataStart ?? 0)), columns: (meta.shape?.headers ?? []).map(String).filter(Boolean) }));
      if (indexed.reduce((total, table) => total + table.rows * Math.max(1, table.columns.length), 0) > COUNTED_NOT_READ) return indexed;
    }
    return this.tablesOfFile(file).map((table) => ({ name: table.name, rows: table.rows.length, columns: table.columns.map((column) => column.name) }));
  },

  /**
   * A folder's tables by name, from what its index already holds: each sheet of each table file with its columns'
   * names. No file is read for it; a query's tables are read once they are known.
   */
  tableCatalog(project) {
    this.tableCatalogs ??= new BoundedCache({ maxEntries: 8 });
    let catalog = this.tableCatalogs.get(project.snapshotId);
    if (!catalog) {
      catalog = [];
      for (const [filePath, objects] of this.snapshotObjects(project)) {
        const sheets = new Map();
        for (const object of objects) {
          if (object.anchor?.kind !== 'table-column') continue;
          const sheet = object.anchor.sheet ?? object.metadata?.sheet ?? null;
          if (!sheets.has(sheet)) sheets.set(sheet, []);
          sheets.get(sheet).push(object.anchor);
        }
        // A file's sheets by name, so that a list of them reads the same each time.
        for (const [sheet, columns] of [...sheets].sort(([left], [right]) => String(left ?? '').localeCompare(String(right ?? '')))) {
          catalog.push({ project, path: filePath, sheet, name: sheet ?? baseName(filePath),
            columns: columns.sort((left, right) => (left.columnIndex ?? 0) - (right.columnIndex ?? 0)).map((column) => String(column.column ?? '')).filter(Boolean) });
        }
      }
      this.tableCatalogs.set(project.snapshotId, catalog);
    }
    return catalog;
  },

  /** The tables an agent may ask about in these folders, or of one file when `named` is given. */
  tablesInScope(context, projects, named = null) {
    return projects.filter((project) => project.snapshotId).flatMap((project) => this.tableCatalog(project))
      .filter((entry) => this.allowed(context, entry.project.id, entry.path)
        && (!named || (entry.project.id === named.project.id && entry.path === named.file.path)));
  },

  /** A catalog entry's typed table, with its file and source. */
  loadTable(context, entry) {
    const file = this.snapshotFile(context, entry.project, entry.path);
    if (!file || !TABLE_FILES.includes(file.fileType)) throw new AgentError('not_found', `${entry.project.name}/${entry.path} is not a table Lasso can read.`);
    const table = this.tablesOfFile(file).find((candidate) => normalizeName(candidate.name) === normalizeName(entry.name));
    if (!table) throw new AgentError('not_found', `${entry.project.name}/${entry.path} has no table named ${entry.name}.`);
    return { entry, file, table, src: this.sourceFor(context, entry.project, file) };
  },

  /**
   * The one table each name of a query means, among the tables in scope: a sheet's name, a file's name when the file
   * is one table, or a file and a sheet. Never a guess: a name several tables answer to lists them, and a name none
   * answers to lists the tables there are.
   */
  resolveTables(context, projects, references, named = null) {
    const scope = this.tablesInScope(context, projects, named);
    const place = (entry) => ({ folder: entry.project.name, path: entry.path, ...(entry.sheet ? { sheet: entry.sheet } : {}) });
    return references.map((reference) => {
      const pool = reference.file ? scope.filter((entry) => namesFile(entry.project, entry.path, reference.file)) : scope;
      const wanted = normalizeName(reference.table);
      let found = pool.filter((entry) => entry.sheet != null && normalizeName(entry.sheet) === wanted);
      if (!found.length) {
        found = reference.file ? pool.filter((entry) => entry.sheet == null && normalizeName(entry.name) === wanted)
          : pool.filter((entry) => namesFile(entry.project, entry.path, reference.table));
      }
      const written = `${reference.file ? `${reference.file}.` : ''}${reference.table}`;
      if (!found.length) {
        const similar = [...new Set((pool.length ? pool : scope).map((entry) => entry.name))].slice(0, 24);
        throw new AgentError('not_found', `No table in the shared folders is named ${written}.${similar.length ? ` The tables are: ${similar.join(', ')}.` : ''}`, { similar });
      }
      const files = new Set(found.map((entry) => `${entry.project.id}|${entry.path}`));
      if (files.size > 1) {
        throw new AgentError('ambiguous', `${found.length} tables are named ${written}; say which file, as in FROM "${found[0].path}"${found[0].sheet ? `.${found[0].sheet}` : ''}.`,
          { matches: found.map(place) });
      }
      if (found.length > 1) {
        throw new AgentError('ambiguous', `${found[0].path} has the sheets ${found.map((entry) => entry.sheet).join(', ')}; name one, as in FROM "${baseName(found[0].path)}".${found[0].sheet}.`,
          { matches: found.map(place) });
      }
      return { reference, ...this.loadTable(context, found[0]) };
    });
  },

  /**
   * A query's answer: its rows, the tables it read and how many rows of each. Complete when every row of the result
   * is sent; a longer result is cut within the budget and says so. `ran` is the query, shown when Lasso wrote it.
   */
  askSql(context, projects, sql, { named = null, ran = false, note = null } = {}) {
    let query;
    let result;
    let resolved;
    try {
      // The columns of the tables it names, so that a name of two words can be written without quotes. A table it
      // cannot find here is reported below, by the reading that knows which name was meant.
      let columns = [];
      try {
        columns = this.resolveTables(context, projects, tablesWritten(sql), named).flatMap((entry) => entry.table.columns.map((column) => column.name));
      } catch (error) { if (!(error instanceof AgentError) && !(error instanceof SqlError)) throw error; }
      query = parseSql(sql, { columns });
      resolved = this.resolveTables(context, projects, tablesNamed(query), named);
      const key = (reference) => `${reference.file ?? ''}\u0000${reference.table}`;
      const tables = new Map(resolved.map((entry) => [key(entry.reference), entry.table]));
      result = runSql(query, (reference) => tables.get(key(reference)) ?? null);
    } catch (error) {
      if (error instanceof SqlError) throw new AgentError('invalid_request', error.message);
      throw error;
    }
    // A column read as it stands is shown as its cell is written ("9.10", "12.5%"); a worked-out figure as the number.
    const cells = result.rows.map((row, at) => row.map((value, column) => result.written?.[at]?.[column] ?? clean(value)));
    const budget = Math.max(RESULT_TOKENS, context.budget ?? 0);
    let spent = estimateTokens(result.columns.join(' | '));
    let shown = 0;
    while (shown < cells.length && shown < RESULT_ROWS) {
      spent += estimateTokens(cells[shown].join(' | ')) + 1;
      if (spent > budget && shown) break;
      shown += 1;
    }
    const tables = resolved.filter((entry, at) => resolved.findIndex((other) => other.table === entry.table) === at)
      .map((entry) => ({ src: entry.src, name: entry.table.name, rows: entry.table.rows.length }));
    return { kind: 'computed', status: shown < cells.length ? 'partial' : 'complete', items: [{ src: tables[0].src, type: 'query', tables,
      columns: result.columns, rows: cells.slice(0, shown), total: cells.length,
      ...(shown < cells.length ? { more_rows: cells.length - shown } : {}),
      ...(query.limit !== null && result.total > query.limit + query.offset ? { before_limit: result.total } : {}),
      ...(ran ? { ran: sql } : {}), ...(note ? { note } : {}) }] };
  },

  /**
   * What is worked out from a table's every row, asked in plain words, as the query it means:
   * - for each value of a column, or each quarter, month or year of a date column, a total, mean, extreme or count
   *   ("total Net by quarter of 2025", "number of orders per Customer", "Net by Region");
   * - the values of a column that repeat, or each of its values with how many rows have it ("duplicate Order IDs",
   *   "distinct Region values with counts");
   * - the rows a column's value picks, their count, or a total over them ("Orders rows where Region is blank",
   *   "count of Orders rows where Region = North", "total Net for Orders rows where Region is North");
   * - a column's total, mean or extreme over a sheet the ask names ("Orders sheet total of the Net column").
   * Every column must be named as its table has it, and a period needs the table's one date column or a named one.
   * A sheet the ask names is the table meant; else each table that has the columns is answered, up to three, and
   * none is chosen. The answer shows the query. Null when the ask is none of these, and it is answered as any other.
   */
  askGrouped(context, projects, parsed) {
    const text = parsed.original;
    const repeats = REPEATS.test(text);
    const grouping = GROUPING.exec(text);
    const distinct = DISTINCT.test(text);
    const operation = OPERATIONS.find(([pattern]) => pattern.test(text)) ?? null;
    const filtering = FILTERING.test(text);
    if (!repeats && !grouping && !distinct && !filtering && !operation) return null;
    const named = parsed.files.length ? this.tryMention(context, parsed.files[0], parsed) : null;
    const asked = foldAsk(text);
    const target = grouping ? foldAsk(grouping[1]) : '';
    const before = grouping ? foldAsk(text.slice(0, grouping.index)) : asked;
    const longest = (names) => [...names].sort((left, right) => right.length - left.length)[0] ?? null;
    const counting = COUNTING.test(text);
    const period = grouping ? PERIODS.find(([pattern]) => pattern.test(target))?.[1] ?? null : null;
    const years = parsed.words.filter((word) => /^(?:19|20)\d{2}$/.test(word));
    const inScope = this.tablesInScope(context, projects, named);
    // A sheet the ask names ("the Orders sheet", "Orders rows where…") is the table meant.
    const sheets = inScope.filter((entry) => entry.sheet != null && namesHeader(asked, entry.sheet));
    const items = [];
    for (const entry of sheets.length ? sheets : inScope) {
      if (items.length >= 3) break;
      const mentioned = entry.columns.filter((name) => namesHeader(asked, name));
      // A table none of whose columns the ask names is not read on the chance of a date column, unless the ask names it.
      if (!mentioned.length && !(grouping && period && (sheets.length || named))) continue;
      const filter = filtering ? filtersOf(text, entry.columns) : NO_FILTER;
      const by = grouping && !period ? longest(entry.columns.filter((name) => namesHeader(target, name))) : null;
      const measure = longest(entry.columns.filter((name) => name !== by && !filter.columns.has(name) && namesHeader(before, name)));
      // "distinct Region values", "unique values of Region", "Region values": the column whose values are wanted.
      const valued = distinct ? longest(mentioned.filter((name) => !filter.columns.has(name) && valuesOf(name).test(text))) : null;
      const shape = repeats && !grouping ? 'repeats' : grouping && (period || by) ? 'grouped' : valued ? 'values'
        : filter.clauses.length ? 'filtered' : operation && measure && sheets.length ? 'whole' : null;
      if (!shape) continue;
      // Its cells are read only now, for what a date column is, whether the measure is figures, and how a value is written.
      let loaded;
      try { loaded = this.loadTable(context, entry); } catch (error) { if (error instanceof AgentError) continue; throw error; }
      const kindOf = (name) => loaded.table.columns.find((column) => column.name === name)?.kind ?? null;
      const large = loaded.table.rows.length >= HINT_ROWS;
      const figures = measure && ['number', 'percent', 'mixed'].includes(kindOf(measure));
      // "how many adverse events per site" adds a column of figures up, and so does a measure named without a word for
      // what to do with it ("Net by Region"); "number of orders per customer" counts rows.
      const worked = figures ? operation ?? (counting && !/\bhow many\b/i.test(text) ? null : OPERATIONS[1]) : null;
      const mixed = worked && kindOf(measure) === 'mixed';
      const value = worked ? `${worked[1]}(${mixed ? `NUMBER(${quoted(measure)})` : quoted(measure)}) AS ${quoted(`${worked[2]} ${measure}`)}` : 'COUNT(*) AS rows';
      const conditions = filter.clauses.map((clause) => clause(loaded.table));
      let sql = null;
      let note = null;
      if (shape === 'repeats') {
        const column = longest(mentioned);
        sql = `SELECT ${quoted(column)}, COUNT(*) AS times FROM ${quoted(entry.name)}${whereOf(conditions)} GROUP BY 1 HAVING COUNT(*) > 1 ORDER BY 2 DESC, 1`;
      } else if (shape === 'values') {
        sql = `SELECT ${quoted(valued)}, COUNT(*) AS rows FROM ${quoted(entry.name)}${whereOf(conditions)} GROUP BY 1 ORDER BY 2 DESC, 1`;
      } else if (shape === 'grouped') {
        if (!worked && !counting) continue;
        // A measure named without a word for what to do with it is added up only over a table too long to read where
        // it is shown; a short one is shown as it is, in its own order.
        if (worked && !operation && !counting && !large) continue;
        let key = by ? quoted(by) : null;
        if (period) {
          const dates = loaded.table.columns.filter((column) => column.kind === 'date').map((column) => column.name);
          const date = longest(dates.filter((name) => namesHeader(asked, name))) ?? (dates.length === 1 ? dates[0] : null);
          if (!date) continue;
          const on = quoted(date);
          const year = years.length === 1 ? years[0] : null;
          if (year) conditions.push(`YEAR(${on}) = ${year}`);
          key = period === 'year' ? `YEAR(${on}) AS year` : period === 'month' ? `STRFTIME('%Y-%m', ${on}) AS month`
            : `${year ? "'Q'" : `YEAR(${on}) || ' Q'`} || QUARTER(${on}) AS quarter`;
        }
        sql = `SELECT ${key}, ${value} FROM ${quoted(entry.name)}${whereOf(conditions)} GROUP BY 1 ORDER BY 1`;
      } else if (shape === 'filtered' && (worked || counting)) {
        sql = `SELECT ${value} FROM ${quoted(entry.name)}${whereOf(conditions)}`;
      } else if (shape === 'filtered') {
        // The rows themselves: the columns the ask names besides those it filters on, or every column.
        const shown = mentioned.filter((name) => !filter.columns.has(name));
        sql = `SELECT ${shown.length ? shown.map(quoted).join(', ') : '*'} FROM ${quoted(entry.name)}${whereOf(conditions)}`;
      } else if (shape === 'whole' && worked && large) {
        // A short table's total is answered as before, with each row's value beside it.
        sql = `SELECT ${value} FROM ${quoted(entry.name)}`;
      }
      if (!sql) continue;
      if (mixed && /NUMBER\(/.test(sql)) {
        // A measure that is mostly figures is worked out without its cells of text, and the answer says how many those are.
        const at = loaded.table.columns.findIndex((column) => column.name === measure);
        const skipped = loaded.table.rows.filter((row) => typeof row[at] === 'string').length;
        note = `${skipped} cell${skipped === 1 ? '' : 's'} of ${JSON.stringify(measure)} ${skipped === 1 ? 'is' : 'are'} not figures and left out`;
      }
      try {
        items.push(...this.askSql(context, [entry.project], sql, { named: { project: entry.project, file: { path: entry.path } }, ran: true, note }).items);
      } catch (error) {
        // A table that cannot answer it (text where figures were expected) is passed over; the ask is then answered as any other.
        if (!(error instanceof AgentError)) throw error;
      }
    }
    return items.length ? { kind: 'computed', status: items.some((item) => item.more_rows) ? 'partial' : 'complete', items } : null;
  },

  /**
   * Cells named as a spreadsheet names them, a sheet then a cell or a range of up to 50 ("Summary!B12",
   * "'Net sales'!B2:C4"): each cell's text as its file has it, with its column's name and its row's label. A
   * lookup, complete. The sheet must be one a shared file has, in the file the ask names when it names one; a
   * sheet several files have is listed, never chosen. Null when the ask has no such reference or no file has the
   * sheet, and it is answered as any other. Values are what the cells hold: formulas are not read.
   */
  askCells(context, projects, parsed) {
    const match = CELL_REFERENCE.exec(parsed.original);
    if (!match) return null;
    const sheet = match[1] ?? match[2];
    const named = parsed.files.length ? this.tryMention(context, parsed.files[0], parsed) : null;
    const found = this.tablesInScope(context, projects, named).filter((entry) => entry.sheet != null && normalizeName(entry.sheet) === normalizeName(sheet));
    if (!found.length) return null;
    if (found.length > 1) {
      throw new AgentError('ambiguous', `${found.length} files have a sheet named ${sheet}; name the file with it.`,
        { matches: found.map((entry) => ({ folder: entry.project.name, path: entry.path, sheet: entry.sheet })) });
    }
    const { table, src, file } = this.loadTable(context, found[0]);
    const index = (letters) => [...letters.toUpperCase()].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
    const [firstColumn, lastColumn] = [index(match[3]), index(match[5] ?? match[3])].sort((left, right) => left - right);
    const [firstRow, lastRow] = [Number(match[4]), Number(match[6] ?? match[4])].sort((left, right) => left - right);
    if ((lastColumn - firstColumn + 1) * (lastRow - firstRow + 1) > 50) throw new AgentError('too_large', 'A range of more than 50 cells is asked as a query: SELECT … FROM the sheet.');
    // A workbook's cells are read with their formulas, and anywhere on the sheet, the rows above its table included.
    let workbook = null;
    if (operationKind(file) === 'workbook') { try { workbook = this.openOperations(file).adapter.state; } catch (error) { if (!(error instanceof AgentError)) throw error; } }
    const numbers = table.rows.map((_, at) => table.rowNumber(at));
    const cells = [];
    for (let row = firstRow; row <= lastRow; row += 1) {
      const at = numbers.indexOf(row);
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        const address = `${columnLetters(column)}${row}`;
        const facts = workbook ? cellFacts(workbook, table.name, address) : null;
        const inTable = at >= 0 && column < table.columns.length;
        if (!inTable && !facts) continue;
        const shown = (value) => (value == null ? '' : String(typeof value === 'number' ? Number(value.toPrecision(12)) : value));
        // A formula's value is the one worked out from it now; the value stored beside it is said only when it differs.
        const stored = inTable ? table.written(at, column) ?? '' : shown(facts.value);
        const value = facts?.formula && facts.calc != null ? shown(facts.calc) : stored;
        cells.push({ at: address, ...(inTable ? { column: table.columns[column].name, row: table.written(at, 0) ?? '' } : {}), value,
          ...(facts?.formula ? { formula: facts.formula, ...(facts.calc != null && typeof facts.value === 'number' && Math.abs(facts.calc - facts.value) > 1e-9 * Math.max(1, Math.abs(facts.calc)) ? { stored: shown(facts.value) } : {}) } : {}) });
      }
    }
    if (!cells.length) {
      throw new AgentError('not_found', `${sheet}!${match[3]}${match[4]} is not a cell of the table Lasso reads in that sheet: its rows are rows ${Math.min(...numbers)} to ${Math.max(...numbers)}`
        + ` and its columns A to ${columnLetters(table.columns.length - 1)}. The row of column names and anything above it are not rows of the table.`);
    }
    return { kind: 'cells', status: 'complete', items: [{ src, type: 'cells', sheet: table.name, cells }] };
  },

  /**
   * The tables a query could read where an answer shows a table only in part, or answers an ask that wants something
   * worked out ("every order where…", "the total") with rows: each sheet of the files it drew on, with its rows
   * counted and its columns named, as `{ query_tables: [{ name, rows, columns }] }`. So the next ask can be a query
   * over all of them, written with the right names, and a table shown as "first 12 of 215 rows", the rows that
   * matched, is not read as the whole of it. Where the ask wants something worked out, a large table's rows in the
   * answer are cut to two, enough to see how its cells are written: rows a model then re-reads on every later call
   * are no use to a question their sum answers. Nothing for an answer already worked out, or drawn from no table.
   */
  queryTables(context, answer, text) {
    const items = answer.items ?? [];
    if (!items.length || ['computed', 'operation'].includes(answer.kind)) return {};
    const cut = items.some((item) => item.type === 'table' && (item.more_rows || (item.rows_total ?? 0) > (item.rows?.length ?? 0)));
    // The ask wants something worked out, or names a file for words the file does not have: either way its rows are not the answer.
    const worked = WORKED_OUT.test(text) || (answer.kind === 'digest' && answer.absent?.length > 0);
    if (!cut && !worked) return {};
    const listed = [];
    const large = new Set();
    const sources = new Map([...context.sources.values()].map((entry) => [entry.id, entry.body]));
    for (const src of new Set(items.map((item) => item.src).filter(Boolean))) {
      const body = sources.get(src);
      const project = context.projects.find((candidate) => candidate.name === body?.folder);
      const file = project ? this.snapshotFile(context, project, body.path) : null;
      if (!file || !TABLE_FILES.includes(file.fileType)) continue;
      try {
        for (const table of this.tableSizes(file)) {
          if (!table.rows) continue;
          listed.push({ name: table.name, rows: table.rows, columns: table.columns.slice(0, HINT_COLUMNS) });
          if (table.rows >= HINT_ROWS) large.add(`${src}\u0000${file.fileType === 'spreadsheet' ? table.name : ''}`);
        }
      } catch (error) { if (!(error instanceof AgentError)) throw error; }
    }
    // A table small enough to be read where it is shown needs no query, unless it was shown in part.
    if (!listed.length || (!cut && !large.size)) return {};
    if (worked) {
      for (const item of items) {
        if (item.type !== 'table' || !item.rows || item.rows.length <= SAMPLE_ROWS || !large.has(`${item.src}\u0000${item.sheet ?? ''}`)) continue;
        if (item.rows_total == null) item.more_rows = (item.more_rows ?? 0) + item.rows.length - SAMPLE_ROWS;
        item.rows = item.rows.slice(0, SAMPLE_ROWS);
      }
    }
    return { query_tables: listed.slice(0, HINT_TABLES) };
  },
};
