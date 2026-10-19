import path from 'node:path';
import { diffInternals, parseDelimited } from './diff.js';
import { HttpError } from './errors.js';
import { extractDesignDocument, isDesignFile } from '../dependencies/drawing-objects.js';

function lineItems(text, language = 'text') {
  return text.replace(/\r\n/g, '\n').split('\n').map((value, index) => ({
    anchor: { kind: 'line', line: index + 1 },
    label: String(index + 1),
    text: value,
    language,
  }));
}

function tablePreview(text, filePath) {
  const delimiter = path.extname(filePath).toLowerCase() === '.tsv' ? '\t' : ',';
  const rows = parseDelimited(text, delimiter);
  const headers = rows.shift() ?? [];
  const values = rows;
  const first = values.map((row) => row[0]);
  const uniqueFirst = first.every(Boolean) && new Set(first).size === first.length;
  return {
    kind: 'table',
    headers,
    keyColumn: uniqueFirst ? headers[0] : null,
    rows: values.map((row, rowIndex) => ({
      key: uniqueFirst ? row[0] : `row:${rowIndex + 1}`,
      cells: headers.map((column, columnIndex) => ({
        column: column || `column:${columnIndex + 1}`,
        value: row[columnIndex] ?? '',
        anchor: {
          kind: 'table-cell',
          rowKey: uniqueFirst ? row[0] : `row:${rowIndex + 1}`,
          rowIndex,
          column: column || `column:${columnIndex + 1}`,
          columnIndex,
        },
      })),
    })),
  };
}

function jsonLeaves(value, jsonPath = '$', output = []) {
  if (value !== null && typeof value === 'object') {
    const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
    let found = false;
    for (const [key, child] of entries) {
      found = true;
      jsonLeaves(child, `${jsonPath}.${key}`, output);
    }
    if (!found) output.push({ path: jsonPath, value: JSON.stringify(value) });
  } else {
    output.push({ path: jsonPath, value: typeof value === 'string' ? value : JSON.stringify(value) });
  }
  return output;
}

export function buildPreview(snapshot, file, buffer) {
  const text = buffer.toString('utf8').replace(/\r\n/g, '\n');
  const base = {
    snapshotId: snapshot.id,
    version: snapshot.version,
    projectFileId: file.projectFileId,
    path: file.path,
    fileType: file.fileType,
    contentHash: file.contentHash,
  };

  if (isDesignFile(file)) {
    const design = extractDesignDocument(file, buffer);
    if (design.isDrawing) return { ...base, kind: 'drawing', warnings: design.warnings,
      items: design.pages.flatMap((page) => page.annotations.map((fact) => ({
        path: [fact.storey, fact.label, fact.propertyName && !fact.label.toLowerCase().includes(fact.propertyName.toLowerCase()) ? fact.propertyName : null].filter(Boolean).join(' · '),
        value: fact.value, basis: fact.measurementBasis,
        location: [fact.elementId, fact.propertySet, fact.propertyName].filter(Boolean).join(' · '),
        anchor: { kind: 'cad-property', identifier: fact.id, elementId: fact.elementId, propertyName: fact.propertyName, featureId: fact.featureId },
      }))) };
  }

  if (file.fileType === 'markdown') {
    return {
      ...base,
      kind: 'blocks',
      items: diffInternals.markdownBlocks(text).map((block, index) => ({
        anchor: { kind: 'markdown-block', blockIndex: index },
        blockType: block.type,
        text: block.text,
      })),
    };
  }
  if (file.fileType === 'code' || file.fileType === 'text' || file.fileType === 'yaml') {
    return { ...base, kind: 'lines', items: lineItems(text, file.fileType) };
  }
  if (file.fileType === 'table') return { ...base, ...tablePreview(text, file.path) };
  if (file.fileType === 'json') {
    try {
      return {
        ...base,
        kind: 'json',
        items: jsonLeaves(JSON.parse(text)).map((item) => ({
          ...item,
          anchor: { kind: 'json-path', path: item.path },
        })),
      };
    } catch {
      return { ...base, kind: 'lines', items: lineItems(text) };
    }
  }
  if (file.fileType === 'notebook') {
    try {
      return {
        ...base,
        kind: 'notebook',
        cells: diffInternals.notebookCells(text).map((cell, index) => ({
          ...cell,
          anchor: { kind: 'notebook-cell', cellId: cell.id, cellIndex: index },
        })),
      };
    } catch {
      return { ...base, kind: 'lines', items: lineItems(text) };
    }
  }
  return {
    ...base,
    kind: 'binary',
    metadata: file.metadata,
    size: file.size,
    message: 'Preview unavailable. This version is preserved and identified by its content hash.',
  };
}

function jsonPathValue(value, selector) {
  const pieces = selector === '$' ? [] : selector.slice(2).split('.');
  let current = value;
  for (const piece of pieces) {
    if (current == null || !(piece in current)) return null;
    current = current[piece];
  }
  return current;
}

function selectText(container, anchor, exactSnapshot) {
  if (container == null) return null;
  const text = String(container);
  const selection = anchor.selection;
  if (!selection) return text;
  if (exactSnapshot && Number.isInteger(selection.start) && Number.isInteger(selection.end)) {
    return text.slice(selection.start, selection.end);
  }
  if (selection.prefix != null && selection.suffix != null) {
    const prefixIndex = selection.prefix ? text.indexOf(selection.prefix) : 0;
    if (prefixIndex < 0) return null;
    const start = prefixIndex + selection.prefix.length;
    const end = selection.suffix ? text.indexOf(selection.suffix, start) : text.length;
    if (end < start) return null;
    return text.slice(start, end);
  }
  if (Number.isInteger(selection.start) && Number.isInteger(selection.end)) {
    return text.slice(selection.start, selection.end);
  }
  return text;
}

export function resolveAnchor(file, buffer, anchor, exactSnapshot = false) {
  if (!anchor?.kind) throw new HttpError(400, 'A stable preview anchor is required.');
  const text = buffer.toString('utf8').replace(/\r\n/g, '\n');
  let container = null;
  if (anchor.kind === 'cad-property') {
    const facts = extractDesignDocument(file, buffer).pages.flatMap((page) => page.annotations);
    container = facts.find((fact) => fact.id === anchor.identifier)?.value ?? null;
  } else if (anchor.kind === 'markdown-block' || anchor.kind === 'manuscript-span') {
    container = diffInternals.markdownBlocks(text)[anchor.blockIndex]?.text ?? null;
  } else if (anchor.kind === 'line') {
    container = text.split('\n')[anchor.line - 1] ?? null;
  } else if (anchor.kind === 'table-cell') {
    const model = tablePreview(text, file.path);
    const row = model.rows.find((candidate) => candidate.key === anchor.rowKey)
      ?? model.rows[anchor.rowIndex];
    container = row?.cells.find((cell) => cell.column === anchor.column)?.value
      ?? row?.cells[anchor.columnIndex]?.value
      ?? null;
  } else if (anchor.kind === 'json-path') {
    try {
      const value = jsonPathValue(JSON.parse(text), anchor.path);
      container = typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
      container = null;
    }
  } else if (anchor.kind === 'notebook-cell') {
    try {
      const cells = diffInternals.notebookCells(text);
      container = cells.find((cell) => cell.id === anchor.cellId)?.source
        ?? cells[anchor.cellIndex]?.source
        ?? null;
    } catch {
      container = null;
    }
  }
  const normalizedAnchor = anchor.kind === 'manuscript-span' && !anchor.selection
    ? { ...anchor, selection: { start: anchor.start, end: anchor.end, prefix: anchor.prefix, suffix: anchor.suffix } }
    : anchor;
  return selectText(container, normalizedAnchor, exactSnapshot);
}
