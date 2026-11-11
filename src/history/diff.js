import path from 'node:path';
import { hashBuffer } from './blob-store.js';
import { isTextualType } from './file-types.js';
import { sequenceOperations } from './sequence-diff.js';

function decode(buffer) {
  return buffer?.toString('utf8').replace(/\r\n/g, '\n') ?? '';
}

function lineDiff(beforeText, afterText, format = 'text') {
  const beforeLines = beforeText.split('\n');
  const afterLines = afterText.split('\n');
  const operations = sequenceOperations(beforeLines, afterLines);
  const added = operations.filter((item) => item.kind === 'add').length;
  const removed = operations.filter((item) => item.kind === 'remove').length;
  return { format, added, removed, operations };
}

function markdownBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let current = [];
  let type = 'paragraph';
  let fenced = false;

  function flush() {
    if (!current.length) return;
    blocks.push({ type, text: current.join('\n') });
    current = [];
    type = 'paragraph';
  }

  for (const line of lines) {
    if (line.startsWith('```') || line.startsWith('~~~')) {
      if (!fenced) {
        flush();
        type = 'code';
        fenced = true;
      }
      current.push(line);
      if (fenced && current.length > 1 && (line.startsWith('```') || line.startsWith('~~~'))) {
        flush();
        fenced = false;
      }
      continue;
    }
    if (fenced) {
      current.push(line);
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      flush();
      blocks.push({ type: 'heading', text: line });
    } else if (/^\s*([-*+] |\d+\. )/.test(line)) {
      if (type !== 'list') flush();
      type = 'list';
      current.push(line);
    } else if (!line.trim()) {
      flush();
    } else {
      if (type !== 'paragraph') flush();
      current.push(line);
    }
  }
  flush();
  return blocks;
}

function markdownDiff(beforeText, afterText) {
  const beforeBlocks = markdownBlocks(beforeText);
  const afterBlocks = markdownBlocks(afterText);
  const operations = sequenceOperations(
    beforeBlocks.map((block) => `${block.type}\u0000${block.text}`),
    afterBlocks.map((block) => `${block.type}\u0000${block.text}`),
  ).map((operation) => {
    const separator = operation.text.indexOf('\u0000');
    return {
      ...operation,
      blockType: operation.text.slice(0, separator),
      text: operation.text.slice(separator + 1),
    };
  });
  return {
    format: 'markdown',
    added: operations.filter((item) => item.kind === 'add').length,
    removed: operations.filter((item) => item.kind === 'remove').length,
    operations,
  };
}

function unquotedCounts(line) {
  const counts = { ',': 0, ';': 0 };
  let quoted = false;
  for (const character of line) {
    if (character === '"') quoted = !quoted;
    else if (!quoted && character in counts) counts[character] += 1;
  }
  return counts;
}

/**
 * The delimiter of a .csv file. Spreadsheet exports in many locales separate
 * fields with semicolons; they are recognised only when the header has no
 * unquoted comma and the sampled rows agree on the semicolon count.
 */
export function csvDelimiter(text) {
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim()).slice(0, 6);
  if (!lines.length) return ',';
  const header = unquotedCounts(lines[0]);
  if (header[','] > 0 || header[';'] === 0) return ',';
  return lines.every((line) => unquotedCounts(line)[';'] === header[';']) ? ';' : ',';
}

/**
 * Rows of a delimited file. A comma delimiter is checked against csvDelimiter
 * unless `detect` is false, which preserves the original comma reading for
 * coordinates recorded before semicolon files were recognised.
 */
export function parseDelimited(text, delimiter, { detect = true } = {}) {
  if (delimiter === ',' && detect) delimiter = csvDelimiter(text);
  const reader = delimitedRows(delimiter);
  return reader.end(reader.write(text));
}

/**
 * The same reading taken a piece of text at a time, for a file too large to
 * hold at once. `write(text)` returns the rows its piece completed and `end()`
 * the last one; together they are the rows parseDelimited gives for the whole
 * text, wherever the pieces were cut.
 */
export function delimitedRows(delimiter) {
  let row = [];
  let cell = '';
  let quoted = false;
  // A quote that ends a piece inside a quoted cell either escapes a quote at
  // the start of the next piece or closes the cell; the next piece decides.
  let quoteAtEnd = false;
  const finishRow = (rows) => {
    row.push(cell.replace(/\r$/, ''));
    rows.push(row);
    row = [];
    cell = '';
  };
  return {
    write(text, rows = []) {
      let index = 0;
      if (quoteAtEnd && text.length) {
        quoteAtEnd = false;
        if (text[0] === '"') {
          cell += '"';
          index = 1;
        } else {
          quoted = false;
        }
      }
      for (; index < text.length; index += 1) {
        const character = text[index];
        if (quoted) {
          if (character === '"' && index + 1 === text.length) {
            quoteAtEnd = true;
          } else if (character === '"' && text[index + 1] === '"') {
            cell += '"';
            index += 1;
          } else if (character === '"') {
            quoted = false;
          } else {
            cell += character;
          }
        } else if (character === '"') {
          quoted = true;
        } else if (character === delimiter) {
          row.push(cell);
          cell = '';
        } else if (character === '\n') {
          finishRow(rows);
        } else {
          cell += character;
        }
      }
      return rows;
    },
    end(rows = []) {
      if (quoteAtEnd) {
        quoteAtEnd = false;
        quoted = false;
      }
      if (cell.length || row.length) finishRow(rows);
      return rows;
    },
  };
}

function tableModel(text, extension) {
  const rows = parseDelimited(text, extension === '.tsv' ? '\t' : ',');
  const headers = rows.shift() ?? [];
  const firstColumnValues = rows.map((row) => row[0]);
  const uniqueFirstColumn = firstColumnValues.every(Boolean)
    && new Set(firstColumnValues).size === firstColumnValues.length;
  const records = new Map();
  rows.forEach((row, index) => {
    const key = uniqueFirstColumn ? row[0] : `row:${index + 1}`;
    records.set(key, Object.fromEntries(headers.map((header, column) => [header || `column:${column + 1}`, row[column] ?? ''])));
  });
  return { headers, keyColumn: uniqueFirstColumn ? headers[0] : null, rowsAreNamed: uniqueFirstColumn, records };
}

function changedCells(rowKey, beforeRow, afterRow) {
  const columns = new Set([...Object.keys(beforeRow), ...Object.keys(afterRow)]);
  const cells = [];
  for (const column of columns) {
    const oldValue = beforeRow[column] ?? '';
    const newValue = afterRow[column] ?? '';
    if (oldValue !== newValue) cells.push({ rowKey, column, before: oldValue, after: newValue });
  }
  return cells;
}

/** Rows matched by name, when the first column of both tables names every row once. */
function namedRowChanges(before, after) {
  return {
    rowsAdded: [...after.records.keys()].filter((key) => !before.records.has(key)),
    rowsRemoved: [...before.records.keys()].filter((key) => !after.records.has(key)),
    cellsChanged: [...after.records].flatMap(([rowKey, afterRow]) => {
      const beforeRow = before.records.get(rowKey);
      return beforeRow ? changedCells(rowKey, beforeRow, afterRow) : [];
    }),
  };
}

/** The positions of the rows that have no row with the same content left in the other table. */
function unmatchedRows(contents, otherContents) {
  const available = new Map();
  for (const content of otherContents) available.set(content, (available.get(content) ?? 0) + 1);
  return contents.flatMap((content, index) => {
    const left = available.get(content) ?? 0;
    if (!left) return [index];
    available.set(content, left - 1);
    return [];
  });
}

/**
 * Rows matched by everything they hold, wherever they sit, for tables whose
 * first column does not name their rows: an inserted row or a new sort order
 * then leaves the other rows unchanged. The rows left over are paired in file
 * order as changed rows, and any surplus is added or removed. A row is named
 * by its own table's key, `row:N` by position.
 */
function unnamedRowChanges(before, after) {
  const [beforeKeys, afterKeys] = [before, after].map((table) => [...table.records.keys()]);
  const [beforeRows, afterRows] = [before, after].map((table) => [...table.records.values()]);
  const columns = [...new Set([beforeRows[0], afterRows[0]].flatMap((row) => Object.keys(row ?? {})))];
  const content = (row) => JSON.stringify(columns.map((column) => row[column] ?? ''));
  const beforeContents = beforeRows.map(content);
  const afterContents = afterRows.map(content);
  const leftBefore = unmatchedRows(beforeContents, afterContents);
  const leftAfter = unmatchedRows(afterContents, beforeContents);
  const paired = Math.min(leftBefore.length, leftAfter.length);
  return {
    rowsAdded: leftAfter.slice(paired).map((index) => afterKeys[index]),
    rowsRemoved: leftBefore.slice(paired).map((index) => beforeKeys[index]),
    cellsChanged: leftAfter.slice(0, paired).flatMap((afterIndex, position) => changedCells(
      afterKeys[afterIndex], beforeRows[leftBefore[position]], afterRows[afterIndex],
    )),
  };
}

function tableDiff(beforeText, afterText, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const before = tableModel(beforeText, extension);
  const after = tableModel(afterText, extension);
  const { rowsAdded, rowsRemoved, cellsChanged } = before.rowsAreNamed && after.rowsAreNamed
    ? namedRowChanges(before, after)
    : unnamedRowChanges(before, after);
  return {
    format: 'table',
    keyColumn: after.keyColumn ?? before.keyColumn,
    rowsAdded,
    rowsRemoved,
    cellsChanged,
    summary: {
      rowsAdded: rowsAdded.length,
      rowsRemoved: rowsRemoved.length,
      cellsChanged: cellsChanged.length,
    },
  };
}

function flattenJson(value, prefix = '$', output = new Map()) {
  if (value !== null && typeof value === 'object') {
    const entries = Array.isArray(value)
      ? value.map((item, index) => [index, item])
      : Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    if (!entries.length) output.set(prefix, value);
    for (const [key, child] of entries) flattenJson(child, `${prefix}.${key}`, output);
  } else {
    output.set(prefix, value);
  }
  return output;
}

function jsonDiff(beforeText, afterText) {
  try {
    const before = flattenJson(JSON.parse(beforeText));
    const after = flattenJson(JSON.parse(afterText));
    const changes = [];
    const paths = new Set([...before.keys(), ...after.keys()]);
    for (const jsonPath of [...paths].sort()) {
      if (!before.has(jsonPath)) changes.push({ path: jsonPath, kind: 'added', after: after.get(jsonPath) });
      else if (!after.has(jsonPath)) changes.push({ path: jsonPath, kind: 'removed', before: before.get(jsonPath) });
      else if (JSON.stringify(before.get(jsonPath)) !== JSON.stringify(after.get(jsonPath))) {
        changes.push({ path: jsonPath, kind: 'changed', before: before.get(jsonPath), after: after.get(jsonPath) });
      }
    }
    return { format: 'json', changes };
  } catch {
    return lineDiff(beforeText, afterText, 'text');
  }
}

function notebookCells(text) {
  const notebook = JSON.parse(text);
  return (notebook.cells ?? []).map((cell, index) => ({
    id: cell.id ?? `index:${index}`,
    type: cell.cell_type ?? 'unknown',
    source: Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? ''),
    outputsHash: hashBuffer(Buffer.from(JSON.stringify(cell.outputs ?? []))),
  }));
}

function notebookDiff(beforeText, afterText) {
  try {
    const before = new Map(notebookCells(beforeText).map((cell) => [cell.id, cell]));
    const after = new Map(notebookCells(afterText).map((cell) => [cell.id, cell]));
    const cellsAdded = [...after.keys()].filter((id) => !before.has(id));
    const cellsRemoved = [...before.keys()].filter((id) => !after.has(id));
    const cellsChanged = [];
    for (const [id, cell] of after) {
      const previous = before.get(id);
      if (!previous) continue;
      if (previous.source !== cell.source || previous.outputsHash !== cell.outputsHash || previous.type !== cell.type) {
        cellsChanged.push({
          id,
          type: cell.type,
          source: previous.source === cell.source ? null : lineDiff(previous.source, cell.source, 'code'),
          outputsChanged: previous.outputsHash !== cell.outputsHash,
        });
      }
    }
    return { format: 'notebook', cellsAdded, cellsRemoved, cellsChanged };
  } catch {
    return lineDiff(beforeText, afterText, 'text');
  }
}

export function createStructuredDiff({ fileType, filePath, beforeBuffer, afterBuffer, changeType }) {
  if (changeType === 'ADDED') return { format: 'file', message: 'File added.' };
  if (changeType === 'DELETED') return { format: 'file', message: 'File removed.' };
  if ((changeType === 'RENAMED' || changeType === 'MOVED') && beforeBuffer?.equals(afterBuffer)) {
    return { format: 'file', message: changeType === 'MOVED' ? 'File moved.' : 'File renamed.' };
  }
  if (!beforeBuffer || !afterBuffer) return { format: 'binary', message: 'File changed. Structured comparison unavailable.' };
  // XML, including LandXML civil data, is text and compares line by line like code.
  const xml = fileType === 'xml' || /\.landxml$/i.test(filePath ?? '');
  if (!isTextualType(fileType) && !xml) return { format: 'binary', message: 'File changed. Structured comparison unavailable.' };

  const beforeText = decode(beforeBuffer);
  const afterText = decode(afterBuffer);
  if (fileType === 'markdown') return markdownDiff(beforeText, afterText);
  if (fileType === 'table') return tableDiff(beforeText, afterText, filePath);
  if (fileType === 'json') return jsonDiff(beforeText, afterText);
  if (fileType === 'notebook') return notebookDiff(beforeText, afterText);
  if (fileType === 'code' || fileType === 'text' || fileType === 'yaml' || xml) {
    return lineDiff(beforeText, afterText, fileType === 'code' || xml ? 'code' : 'text');
  }
  return { format: 'binary', message: 'File changed. Structured comparison unavailable.' };
}

// Line and block comparisons are stored as runs that point into the two
// compared versions, whose bytes the blob store keeps. A one-line edit to a
// long file then stores a few runs instead of every line of both versions.
const RUN_FORMATS = new Set(['text', 'code', 'markdown']);

function continuesRun(run, operation) {
  if (run.kind !== operation.kind) return false;
  const nextBefore = run.beforeLine === undefined || operation.beforeLine === run.beforeLine + run.count;
  const nextAfter = run.afterLine === undefined || operation.afterLine === run.afterLine + run.count;
  return nextBefore && nextAfter;
}

/** The form of a structured diff that is written to history. */
export function compactStructuredDiff(diff) {
  if (!RUN_FORMATS.has(diff?.format) || !Array.isArray(diff.operations)) return diff;
  const runs = [];
  for (const operation of diff.operations) {
    const last = runs.at(-1);
    if (last && continuesRun(last, operation)) {
      runs[runs.length - 1] = { ...last, count: last.count + 1 };
      continue;
    }
    runs.push({
      kind: operation.kind,
      ...(operation.beforeLine === undefined ? {} : { beforeLine: operation.beforeLine }),
      ...(operation.afterLine === undefined ? {} : { afterLine: operation.afterLine }),
      count: 1,
    });
  }
  const { operations, ...rest } = diff;
  return { ...rest, operationRuns: runs };
}

function comparedUnits(format, buffer) {
  const text = decode(buffer);
  return format === 'markdown' ? markdownBlocks(text) : text.split('\n');
}

function operationAt(format, run, offset, before, after) {
  const beforeLine = run.beforeLine === undefined ? undefined : run.beforeLine + offset;
  const afterLine = run.afterLine === undefined ? undefined : run.afterLine + offset;
  const unit = run.kind === 'add' ? after[afterLine - 1] : before[beforeLine - 1];
  const text = format === 'markdown' ? unit?.text : unit;
  return {
    kind: run.kind,
    text,
    ...(beforeLine === undefined ? {} : { beforeLine }),
    ...(afterLine === undefined ? {} : { afterLine }),
    ...(format === 'markdown' ? { blockType: unit?.type } : {}),
  };
}

/**
 * The structured diff as it was computed, from its stored form.
 * `loadVersions` returns the compared versions' bytes: { before, after }.
 * Diffs stored before runs existed are returned unchanged. So is one whose
 * versions cannot be read, marked bytesReleased when retention released them.
 */
export function expandStructuredDiff(stored, loadVersions) {
  if (!Array.isArray(stored?.operationRuns)) return stored;
  let versions;
  try {
    versions = loadVersions();
  } catch (error) {
    return error?.code === 'BLOB_RELEASED' ? { ...stored, bytesReleased: true } : stored;
  }
  if (!versions?.before && stored.operationRuns.some((run) => run.kind !== 'add')) return stored;
  if (!versions?.after && stored.operationRuns.some((run) => run.kind === 'add')) return stored;
  const before = comparedUnits(stored.format, versions.before);
  const after = comparedUnits(stored.format, versions.after);
  const operations = stored.operationRuns.flatMap((run) => Array.from({ length: run.count },
    (_, offset) => operationAt(stored.format, run, offset, before, after)));
  const { operationRuns, ...rest } = stored;
  return { ...rest, operations };
}

export function deterministicEventTitle(changes) {
  if (!changes.length) return 'No file changes';
  if (changes.length > 1) return `${changes.length} files changed`;
  const change = changes[0];
  const label = {
    ADDED: 'Added',
    DELETED: 'Removed',
    RENAMED: 'Renamed',
    MOVED: 'Moved',
    MODIFIED: 'Modified',
  }[change.changeType];
  return `${label} ${change.pathAfter ?? change.pathBefore}`;
}

export const diffInternals = { markdownBlocks, tableModel, notebookCells, lineDiff };
