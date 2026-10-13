// Naming and addressing for indexed objects.
//
// The index addresses objects by opaque keys. A terminal needs something a
// person can type, and something that reads as an exact source location. Both
// are derived from the anchor the indexer already recorded, so a name never
// carries information the graph does not have.

import path from 'node:path';

/** `Office Supplies` → `office-supplies`. Stable, lossy, and never unique by itself. */
export function slug(value) {
  return String(value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
}

/** Spreadsheet column index → letter. 0 → A, 26 → AA. */
export function columnLetter(index) {
  let remaining = Number(index);
  if (!Number.isInteger(remaining) || remaining < 0) return '';
  let letters = '';
  do {
    letters = String.fromCharCode(65 + (remaining % 26)) + letters;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return letters;
}

// Column 0 labels the rows of a row-oriented table, so column 1 is the first
// column that holds a value.
const PRIMARY_VALUE_COLUMN = 1;

function isSpreadsheet(filePath) {
  return ['.xlsx', '.xls', '.ods'].includes(path.posix.extname(String(filePath ?? '')).toLowerCase());
}

/**
 * The name a person types. Derived from the most specific label the anchor
 * carries — the row for a row-oriented cell, the column for a column, the
 * symbol for a code line.
 *
 * Names are intentionally not made unique here: two sources that genuinely
 * share a name are a conflict the user resolves with an alias, not something
 * to paper over with a suffix.
 */
export function dependencyName(object) {
  const anchor = object.anchor ?? {};
  const metadata = object.metadata ?? {};
  switch (anchor.kind) {
    case 'table-cell': {
      // A data dictionary defines a variable rather than holding a value.
      if (metadata.dictionary) return slug(metadata.variable ?? object.label);
      const row = anchor.rowKey ?? metadata.row;
      const column = anchor.column ?? metadata.column;
      const labelled = row != null && !/^row:\d+$/.test(String(row));
      // In a row-oriented table the row names the thing and the first data
      // column holds its current value, so that one cell carries the bare name
      // and every other column is qualified by its header.
      if (metadata.orientation === 'ROW' && labelled) {
        return anchor.columnIndex === PRIMARY_VALUE_COLUMN
          ? slug(row)
          : `${slug(row)}-${slug(column)}`;
      }
      if (labelled) return `${slug(row)}-${slug(column)}`;
      return `${slug(column)}-row-${Number(anchor.rowIndex ?? 0) + 1}`;
    }
    // The row itself is the container of its cells, never the value.
    case 'table-row': return `${slug(anchor.rowKey ?? object.label)}-row`;
    case 'table-column': return slug(anchor.column ?? object.label);
    case 'drawing-sheet': return slug(`sheet ${anchor.sheetNumber ?? metadata.sheetNumber ?? object.label ?? anchor.pageNumber}`);
    case 'cad-property':
    case 'drawing-annotation': return slug(object.label ?? anchor.label ?? anchor.identifier);
    case 'table-summary': return slug(`${metadata.dataset ?? object.label}-${anchor.metric ?? 'summary'}`);
    case 'line': return slug(metadata.symbol ?? object.label);
    case 'notebook-cell': return slug(`${metadata.dataset ?? object.label}`);
    case 'json-path': return slug(String(anchor.path ?? '').split('.').at(-1) || object.label);
    case 'reference-entry': return slug(metadata.citationKey ?? object.label);
    case 'document-table':
    case 'document-figure': return slug(metadata.componentLabel ?? object.label);
    default: return slug(object.label) || slug(path.posix.basename(object.path ?? ''));
  }
}

/**
 * The exact source location, in whatever notation that source type uses:
 * `Accounting!B17` for a workbook cell, `row 42` for a CSV row,
 * `quarterly_forecast()` for a code symbol.
 */
export function sourceLocator(object) {
  const anchor = object.anchor ?? {};
  const metadata = object.metadata ?? {};
  const sheet = metadata.sheet ?? anchor.sheet ?? null;
  const spreadsheet = isSpreadsheet(object.path);

  switch (anchor.kind) {
    case 'table-cell': {
      if (spreadsheet && Number.isInteger(anchor.rowIndex) && Number.isInteger(anchor.columnIndex)) {
        const cell = `${columnLetter(anchor.columnIndex)}${anchor.rowIndex + 1}`;
        return sheet ? `${sheet}!${cell}` : cell;
      }
      const column = anchor.column ?? metadata.column;
      const row = Number.isInteger(anchor.rowIndex) ? `row ${anchor.rowIndex + 1}` : anchor.rowKey;
      return [sheet, row, column].filter(Boolean).join(' · ');
    }
    case 'table-row': {
      if (spreadsheet && Number.isInteger(anchor.rowIndex)) {
        return sheet ? `${sheet}!${anchor.rowIndex + 1}:${anchor.rowIndex + 1}` : `row ${anchor.rowIndex + 1}`;
      }
      return [sheet, Number.isInteger(anchor.rowIndex) ? `row ${anchor.rowIndex + 1}` : anchor.rowKey]
        .filter(Boolean).join(' · ');
    }
    case 'table-column': {
      if (spreadsheet && Number.isInteger(anchor.columnIndex)) {
        const letter = columnLetter(anchor.columnIndex);
        return sheet ? `${sheet}!${letter}:${letter}` : `column ${letter}`;
      }
      return `column: ${anchor.column ?? metadata.column ?? ''}`.trim();
    }
    case 'cad-property': return [
      (anchor.elementId ?? metadata.elementId) ? `element ${anchor.elementId ?? metadata.elementId}` : null,
      (anchor.propertyName ?? metadata.propertyName) ? `property ${anchor.propertyName ?? metadata.propertyName}` : null,
    ].filter(Boolean).join(' · ');
    case 'drawing-sheet':
    case 'drawing-annotation': {
      const sheetNumber = anchor.sheetNumber ?? metadata.sheetNumber;
      const pageNumber = anchor.pageNumber ?? metadata.pageNumber;
      return [
        sheetNumber ? `sheet ${sheetNumber}` : null,
        pageNumber != null ? `page ${pageNumber}` : null,
        anchor.kind === 'drawing-annotation' ? anchor.identifier ?? anchor.label ?? object.label : null,
      ].filter(Boolean).join(' · ');
    }
    case 'table-summary': return [sheet, anchor.metric].filter(Boolean).join(' · ');
    case 'line': return metadata.symbol ? `${metadata.symbol}()  line ${anchor.line}` : `line ${anchor.line}`;
    case 'notebook-cell': return `cell ${Number(anchor.cellIndex ?? 0) + 1}`;
    case 'json-path': return String(anchor.path ?? '');
    case 'reference-entry': return `@${anchor.key}`;
    case 'document-table':
    case 'document-figure': return metadata.componentLabel ?? String(anchor.identifier ?? '');
    case 'manuscript-span': return `block ${anchor.blockIndex}`;
    default: return sheet ? `sheet ${sheet}` : '';
  }
}

/** The directory an object lives in, used by `--directory` and rule prefixes. */
export function sourceDirectory(objectPath) {
  const directory = path.posix.dirname(String(objectPath ?? ''));
  return directory === '.' ? '' : directory;
}

/** `Finance/Q3/model.xlsx` → `model.xlsx`. */
export function sourceFileName(objectPath) {
  return path.posix.basename(String(objectPath ?? ''));
}

/** The full canonical address an alias pins: `path:locator`. */
export function canonicalAddress(object) {
  const locator = sourceLocator(object);
  return locator ? `${object.path}:${locator}` : String(object.path ?? '');
}

/**
 * Parses the address form accepted by `alias`:
 * `Finance/Q3/model.xlsx:Summary!B17`, or a bare path.
 *
 * The split is at the *first* colon, because a locator may contain one of its
 * own — `column: revenue` — while an indexed path never does.
 */
export function parseAddress(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const separator = raw.indexOf(':');
  // A Windows-style drive letter is not a locator separator.
  if (separator <= 1) return { path: raw, locator: null };
  return { path: raw.slice(0, separator), locator: raw.slice(separator + 1).trim() || null };
}

/** Names an object well enough to tell it apart from a same-named sibling. */
export function describeObject(object) {
  return {
    name: object.name ?? dependencyName(object),
    objectId: object.id,
    objectKey: object.objectKey,
    objectType: object.objectType,
    label: object.label,
    value: object.valueText ?? null,
    path: object.path,
    directory: sourceDirectory(object.path),
    fileName: sourceFileName(object.path),
    locator: object.locator ?? sourceLocator(object),
    sheet: object.metadata?.sheet ?? object.anchor?.sheet ?? object.metadata?.sheetNumber ?? object.anchor?.sheetNumber ?? null,
    units: object.metadata?.units ?? null,
    definition: object.metadata?.definition ?? null,
  };
}
