// Moving through a spreadsheet or CSV a cell at a time: the cell beside the
// one the card shows, which fn and an arrow key move the card to.

import { contextualStoredValue } from './value-match.js';

const SHEET_FILE = /\.(?:xlsx|xlsm|xls|csv|tsv)$/i;
/** A column's name sits above its cells, a row's name to the left of them. */
const HEADER_ROW = -1;
const LABEL_COLUMN = -1;
/** Rows of a large table read in one step, past rows with nothing in the column. */
const ROWS_SCANNED = 200;
/** A cell the card can show ahead of a name it shares a place with. */
const VALUE_TYPES = new Set(['DATASET_VALUE', 'RESULT', 'TABLE', 'VALUE']);
const STEPS = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };

export const SHEET_DIRECTIONS = new Set(['into', ...Object.keys(STEPS)]);

/** Where an object sits in its sheet, as { row, column }, or null for one that sits in no cell. */
export function sheetPlace(object) {
  const anchor = object?.anchor ?? {};
  if (anchor.kind === 'table-cell' && Number.isInteger(anchor.rowIndex) && Number.isInteger(anchor.columnIndex)) {
    return { row: anchor.rowIndex, column: anchor.columnIndex };
  }
  if (anchor.kind === 'table-row' && Number.isInteger(anchor.rowIndex)) return { row: anchor.rowIndex, column: LABEL_COLUMN };
  if (anchor.kind === 'table-column' && Number.isInteger(anchor.columnIndex)) return { row: HEADER_ROW, column: anchor.columnIndex };
  return null;
}

/** Whether fn+Right on this suggestion moves into its sheet a cell at a time. */
export function movesInSheet(object) {
  if (!object || !SHEET_FILE.test(String(object.path ?? ''))) return false;
  return object.objectType === 'DATASET' || sheetPlace(object) !== null;
}

const sheetOf = (object) => object.metadata?.sheet ?? object.anchor?.sheet ?? null;
const sameTable = (object, source) => object.path === source.path && sheetOf(object) === sheetOf(source);
const placeKey = ({ row, column }) => `${row}:${column}`;

/** The objects at each place of a table, a value ahead of a dictionary entry at the same cell. */
function gridOf(objects, source) {
  const places = new Map();
  for (const object of objects) {
    const place = sheetPlace(object);
    if (!place || !sameTable(object, source)) continue;
    const key = placeKey(place);
    const held = places.get(key);
    if (!held || (!VALUE_TYPES.has(held.object.objectType) && VALUE_TYPES.has(object.objectType))) {
      places.set(key, { object, ...place });
    }
  }
  return [...places.values()];
}

/** The nearest place from `from` in a direction, along its row or column. */
function nearest(entries, from, direction) {
  const [down, right] = STEPS[direction];
  let best = null;
  for (const entry of entries) {
    const along = down ? entry.column === from.column && (entry.row - from.row) * down > 0
      : entry.row === from.row && (entry.column - from.column) * right > 0;
    if (!along) continue;
    const distance = Math.abs(entry.row - from.row) + Math.abs(entry.column - from.column);
    if (!best || distance < best.distance) best = { ...entry, distance };
  }
  return best;
}

/** The first value of a table: its top row's first cell. */
function firstValue(entries) {
  const cells = entries.filter((entry) => entry.row !== HEADER_ROW && entry.column !== LABEL_COLUMN);
  const pool = cells.length ? cells : entries;
  return pool.reduce((best, entry) => !best || entry.row < best.row
    || (entry.row === best.row && entry.column < best.column) ? entry : best, null);
}

export const sheetNavigationMethods = {
  /**
   * The cell beside a sheet object in a direction ("up", "down", "left",
   * "right"), or with "into" the cell a dive into it lands on: a cell is
   * itself, a row its first value, a column its first value below the name,
   * and a whole sheet its first value. Empty cells are passed over. Null at
   * the sheet's edge, or for an object that is not in a sheet.
   */
  sheetNeighbour(projectId, snapshotId, objectId, direction) {
    if (!SHEET_DIRECTIONS.has(direction)) return null;
    const source = this.objectAt(projectId, snapshotId, objectId);
    if (!movesInSheet(source)) return null;
    const entries = gridOf(this.sheetObjects(projectId, snapshotId, source), source);
    const from = sheetPlace(source);
    const found = direction === 'into' ? this.landingCell(entries, source, from)
      : this.steppedCell(projectId, snapshotId, source, entries, from, direction);
    if (!found) return null;
    const object = this.enrichObject(projectId, { ...found.object, projectId });
    return { object, insertText: sheetInsertText(object), place: { row: found.row, column: found.column } };
  },

  /** The objects of a snapshot that can sit in the source's table, read from its search index when it has one. */
  sheetObjects(projectId, snapshotId, source) {
    const index = this.searchIndexFor(projectId, snapshotId);
    if (!index) return this.workspaceRetrievalObjects(projectId, snapshotId);
    const pathId = index.pathIds.get(source.path);
    const positions = [];
    for (let position = 0; position < index.count; position += 1) {
      if (index.pathOf[position] === pathId) positions.push(position);
    }
    return this.indexedObjectsAt(index, positions);
  },

  landingCell(entries, source, from) {
    const own = from && entries.find((entry) => entry.row === from.row && entry.column === from.column);
    if (source.objectType === 'DATASET' || !from) return firstValue(entries);
    if (from.column === LABEL_COLUMN) return nearest(entries, from, 'right') ?? own ?? { object: source, ...from };
    if (from.row === HEADER_ROW) return nearest(entries, from, 'down') ?? own ?? { object: source, ...from };
    return own ?? { object: source, ...from };
  },

  /**
   * The next place in a direction. A large table's rows past its first are in
   * the table index, so a step up or down, or along a row read from there,
   * looks in the index too and takes whichever is nearer.
   */
  steppedCell(projectId, snapshotId, source, entries, from, direction) {
    if (!from) return null;
    const near = nearest(entries, from, direction);
    const table = this.snapshotTables(projectId, snapshotId)
      .find((candidate) => candidate.file.path === source.path && (candidate.sheet ?? null) === sheetOf(source));
    if (!table) return near;
    const deep = this.indexedSheetStep(table, entries, from, direction);
    if (!deep || (near && near.distance <= deep.distance)) return near;
    const held = entries.find((entry) => entry.row === deep.row && entry.column === deep.column);
    if (held) return held;
    const [object] = this.indexedObjects(projectId, snapshotId, table, [deep.descriptor]);
    return object ? { object, row: deep.row, column: deep.column } : near;
  },

  /** The next place in a direction among a large table's stored rows, as a descriptor to record. */
  indexedSheetStep(table, entries, from, direction) {
    const { meta } = table;
    const [down] = STEPS[direction];
    const placed = (row) => this.indexedRowObjects(table, row).map((descriptor) => ({ descriptor, ...sheetPlace(descriptor) }))
      .filter((entry) => Number.isInteger(entry.row));
    if (!down) {
      // A row the index read already has all its cells among the entries.
      if (from.row === HEADER_ROW || entries.some((entry) => entry.row === from.row && entry.column !== from.column)) return null;
      const row = this.tables.rowNumbered(meta.id, from.row);
      return row ? nearest(placed(row), from, direction) : null;
    }
    if (from.row === HEADER_ROW && down < 0) return null;
    const current = from.row === HEADER_ROW ? null : this.tables.rowNumbered(meta.id, from.row);
    if (from.row !== HEADER_ROW && !current) return null;
    const dataStart = meta.shape.dataStart;
    const at = current?.ordinal ?? dataStart - 1;
    const rows = down > 0 ? this.tables.rows(meta.id, at + 1, at + 1 + ROWS_SCANNED)
      : this.tables.rows(meta.id, Math.max(dataStart, at - ROWS_SCANNED), at).reverse();
    for (const row of rows) {
      const hit = nearest(placed(row).filter((entry) => entry.column === from.column), from, direction);
      if (hit) return hit;
    }
    return null;
  },
};

/** What Tab types for a sheet object: a cell's value, or a row's or column's name. */
function sheetInsertText(object) {
  if (object.anchor?.kind === 'table-cell' && object.objectType !== 'VARIABLE') {
    return contextualStoredValue(object, '') ?? String(object.valueText ?? object.label);
  }
  return String(object.label);
}
