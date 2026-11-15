// Spatial browsing stays in one file, sheet and snapshot. Empty/unindexed
// values are not insertion targets; movement finds the next source on the axis.
import { HttpError } from '../history/errors.js';

export function navigateTableSource(service, source, direction) {
  const steps = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
  if (!Object.hasOwn(steps, direction)) throw new HttpError(400, 'Unknown table navigation direction.');
  if (!['table-row', 'table-cell'].includes(source.anchor?.kind)) return null;
  const projectId = service.sourceProjectId(source);
  const sheet = source.anchor.sheet ?? null;
  const table = service.snapshotTables(projectId, source.snapshotId)
    .find(t => t.file.path === source.path && (t.sheet ?? null) === sheet);
  const labelColumn = table?.meta.shape.labelColumn ?? 0;
  const position = object => ({ row: object.anchor?.rowIndex,
    column: object.anchor?.kind === 'table-row' ? labelColumn : object.anchor?.columnIndex });
  const start = position(source);
  if (!Number.isInteger(start.row) || !Number.isInteger(start.column)) return null;
  const [dx, dy] = steps[direction];
  const distance = object => {
    if (!['table-row', 'table-cell'].includes(object.anchor?.kind)) return Infinity;
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
