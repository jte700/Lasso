import path from 'node:path';
import { hashBuffer } from './blob-store.js';

function decode(buffer) {
  return buffer?.toString('utf8').replace(/\r\n/g, '\n') ?? '';
}

function lcsOperations(beforeLines, afterLines) {
  const n = beforeLines.length;
  const m = afterLines.length;
  if (n * m > 1_000_000) {
    return [
      ...beforeLines.map((text, index) => ({ kind: 'remove', text, beforeLine: index + 1 })),
      ...afterLines.map((text, index) => ({ kind: 'add', text, afterLine: index + 1 })),
    ];
  }

  const matrix = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      matrix[i][j] = beforeLines[i] === afterLines[j]
        ? matrix[i + 1][j + 1] + 1
        : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    }
  }

  const operations = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && beforeLines[i] === afterLines[j]) {
      operations.push({ kind: 'equal', text: beforeLines[i], beforeLine: i + 1, afterLine: j + 1 });
      i += 1;
      j += 1;
    } else if (j < m && (i === n || matrix[i][j + 1] > matrix[i + 1][j])) {
      operations.push({ kind: 'add', text: afterLines[j], afterLine: j + 1 });
      j += 1;
    } else {
      operations.push({ kind: 'remove', text: beforeLines[i], beforeLine: i + 1 });
      i += 1;
    }
  }
  return operations;
}

function lineDiff(beforeText, afterText, format = 'text') {
  const beforeLines = beforeText.split('\n');
  const afterLines = afterText.split('\n');
  const operations = lcsOperations(beforeLines, afterLines);
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
  const operations = lcsOperations(
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

export function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
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
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  if (cell.length || row.length) {
    row.push(cell.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
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
  return { headers, keyColumn: uniqueFirstColumn ? headers[0] : null, records };
}

function tableDiff(beforeText, afterText, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const before = tableModel(beforeText, extension);
  const after = tableModel(afterText, extension);
  const rowsAdded = [...after.records.keys()].filter((key) => !before.records.has(key));
  const rowsRemoved = [...before.records.keys()].filter((key) => !after.records.has(key));
  const cellsChanged = [];
  for (const [rowKey, afterRow] of after.records) {
    const beforeRow = before.records.get(rowKey);
    if (!beforeRow) continue;
    const columns = new Set([...Object.keys(beforeRow), ...Object.keys(afterRow)]);
    for (const column of columns) {
      const oldValue = beforeRow[column] ?? '';
      const newValue = afterRow[column] ?? '';
      if (oldValue !== newValue) cellsChanged.push({ rowKey, column, before: oldValue, after: newValue });
    }
  }
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

  const beforeText = decode(beforeBuffer);
  const afterText = decode(afterBuffer);
  if (fileType === 'markdown') return markdownDiff(beforeText, afterText);
  if (fileType === 'table') return tableDiff(beforeText, afterText, filePath);
  if (fileType === 'json') return jsonDiff(beforeText, afterText);
  if (fileType === 'notebook') return notebookDiff(beforeText, afterText);
  if (fileType === 'code' || fileType === 'text' || fileType === 'yaml') {
    return lineDiff(beforeText, afterText, fileType === 'code' ? 'code' : 'text');
  }
  return { format: 'binary', message: 'File changed. Structured comparison unavailable.' };
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
