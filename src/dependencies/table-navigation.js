// Spatial browsing stays in one file, sheet and snapshot. Empty/unindexed
// values are not insertion targets; movement finds the next source on the axis.
import { HttpError } from '../history/errors.js';

const STEPS = Object.freeze({ left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] });
// The dive into a sheet: where fn+Right lands before any arrow moves.
const DIVE = 'here';
const TABLE_KINDS = Object.freeze(['table-row', 'table-cell']);

const isTableSource = object => TABLE_KINDS.includes(object?.anchor?.kind);

export function navigateTableSource(service, source, direction) {
  if (direction === DIVE) return diveTarget(service, source);
  if (!Object.hasOwn(STEPS, direction)) throw new HttpError(400, 'Unknown table navigation direction.');
  if (!isTableSource(source)) return null;
  const projectId = service.sourceProjectId(source);
  const sheet = source.anchor.sheet ?? null;
  const table = service.snapshotTables(projectId, source.snapshotId)
    .find(t => t.file.path === source.path && (t.sheet ?? null) === sheet);
  const position = cellPosition(table?.meta.shape.labelColumn ?? 0);
  const start = position(source);
  if (!Number.isInteger(start.row) || !Number.isInteger(start.column)) return null;
  const [dx, dy] = STEPS[direction];
  const distance = object => {
    if (!isTableSource(object)) return Infinity;
    const at = position(object);
    if (!Number.isInteger(at.row) || !Number.isInteger(at.column)) return Infinity;
    if (dx && at.row !== start.row || dy && at.column !== start.column) return Infinity;
    const delta = dx ? (at.column - start.column) * dx : (at.row - start.row) * dy;
    return delta > 0 ? delta : Infinity;
  };
  let best = null, nearest = Infinity;
  for (const object of service.objectsAt(projectId, source.snapshotId)) {
    if (object.path !== source.path || (object.anchor?.sheet ?? null) !== sheet) continue;
    const delta = distance(object);
    if (delta < nearest) { best = object; nearest = delta; }
  }
  // Deep rows are read lazily, including rows beyond the prediction index.
  if (table) {
    const row = service.tables.rowNumbered(table.meta.id, start.row);
    if (row) {
      for (let ordinal = row.ordinal + dy; ordinal >= table.meta.shape.dataStart && ordinal < table.meta.rowCount; ordinal += dy) {
        const stored = service.tables.row(table.meta.id, ordinal);
        if (dy && Math.abs(stored.rowNumber - start.row) >= nearest) break;
        const descriptors = service.indexedRowObjects(table, stored);
        const target = descriptors.filter(d => distance(d) < nearest).sort((a, b) => distance(a) - distance(b))[0];
        if (target) {
          best = service.indexedObjects(projectId, source.snapshotId, table, [target])[0] ?? best;
          break;
        }
        if (!dy) break;
      }
    }
  }
  return best;
}

/** A row stands at its label column; a cell at its own column. */
function cellPosition(labelColumn) {
  return object => ({ row: object.anchor?.rowIndex,
    column: object.anchor?.kind === 'table-row' ? labelColumn : object.anchor?.columnIndex });
}

/**
 * fn+Right on a sheet's suggestion: a cell or row starts where it is; a
 * column at its top filled cell; a whole file at its first sheet's top-left
 * filled cell.
 */
function diveTarget(service, source) {
  if (isTableSource(source)) return source;
  const projectId = service.sourceProjectId(source);
  const tables = service.snapshotTables(projectId, source.snapshotId).filter(t => t.file.path === source.path);
  const column = source.anchor?.kind === 'table-column' && Number.isInteger(source.anchor.columnIndex)
    ? source.anchor.columnIndex : null;
  const sheet = source.anchor?.sheet ?? tables[0]?.sheet ?? null;
  const table = tables.find(t => (t.sheet ?? null) === sheet);
  const position = cellPosition(table?.meta.shape.labelColumn ?? 0);
  let best = null, bestAt = null;
  for (const object of service.objectsAt(projectId, source.snapshotId)) {
    if (object.path !== source.path || (object.anchor?.sheet ?? null) !== sheet || !isTableSource(object)) continue;
    const at = position(object);
    if (!Number.isInteger(at.row) || !Number.isInteger(at.column)) continue;
    if (column !== null && at.column !== column) continue;
    if (!bestAt || at.row < bestAt.row || (at.row === bestAt.row && at.column < bestAt.column)) {
      best = object;
      bestAt = at;
    }
  }
  return best;
}
