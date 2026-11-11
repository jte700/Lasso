// The Ranch's Recent Changes: what changed in each directory over the last two
// weeks, newest first, read from the recorded history rather than the disk.

export const HISTORY_DAYS = 14;
/** Enough for two busy weeks; older entries are still in each file's history. */
export const MAX_HISTORY_ENTRIES = 500;
/**
 * A capture that changed more files than this (a sync, a checkout, a batch
 * export) is one row, "N files changed", so it cannot crowd out the rest of
 * the two weeks.
 */
export const MAX_FILES_PER_EVENT = 25;
const DAY_MS = 24 * 60 * 60 * 1000;
// SQLite's limit on bound parameters is far above this; it keeps statements small.
const ID_BATCH = 400;

const VERBS = { ADDED: 'added', DELETED: 'removed', RENAMED: 'renamed', MOVED: 'moved', MODIFIED: 'edited' };

const VALUE_CHANGES = (count) => `
  SELECT c.snapshot_id, s.project_id, a.path, a.label, a.anchor_json, b.value_text AS before_value, a.value_text AS after_value
  FROM object_changes c
  JOIN snapshots s ON s.id = c.snapshot_id
  JOIN scientific_object_versions a ON a.id = c.after_version_id
  JOIN scientific_object_versions b ON b.id = c.before_version_id
  JOIN scientific_objects o ON o.id = c.object_id
  WHERE c.snapshot_id IN (${Array(count).fill('?').join(',')}) AND c.kind = 'modified'
    AND b.value_text IS NOT a.value_text
    -- A column's inferred profile restates its values; only the values themselves count.
    AND NOT (o.object_type = 'VARIABLE' AND COALESCE(json_extract(a.metadata_json, '$.dictionary'), 0) = 0)
  ORDER BY c.snapshot_id, a.path, a.label`;

/**
 * One changed value as a caption names it, with the values as a worksheet
 * shows them (beforeDisplay, afterDisplay) when `shown` finds them different.
 */
function captionedChange(row, shown) {
  const first = { label: row.label, before: row.before_value, after: row.after_value };
  if (!shown) return first;
  const anchor = JSON.parse(row.anchor_json ?? 'null');
  const beforeDisplay = shown(row.project_id, row.path, anchor, row.before_value);
  const afterDisplay = shown(row.project_id, row.path, anchor, row.after_value);
  return { ...first, ...(beforeDisplay ? { beforeDisplay } : {}), ...(afterDisplay ? { afterDisplay } : {}) };
}

/** The values each snapshot changed, by snapshot and then path: { count, first }. */
function valueChangesBySnapshot(db, snapshotIds, shown) {
  const bySnapshot = new Map();
  for (let start = 0; start < snapshotIds.length; start += ID_BATCH) {
    const ids = snapshotIds.slice(start, start + ID_BATCH);
    for (const row of db.prepare(VALUE_CHANGES(ids.length)).all(...ids)) {
      if (!bySnapshot.has(row.snapshot_id)) bySnapshot.set(row.snapshot_id, new Map());
      const byPath = bySnapshot.get(row.snapshot_id);
      const known = byPath.get(row.path);
      if (known) known.count += 1;
      else byPath.set(row.path, { count: 1, first: captionedChange(row, shown) });
    }
  }
  return bySnapshot;
}

/** A file change's value changes, when its save changed any values the index reads. */
function valueChangesOf(values, snapshotId, row) {
  if (row.change_type !== 'MODIFIED') return {};
  const found = values.get(snapshotId)?.get(row.path_after ?? row.path_before);
  return found ? { valueChanges: found } : {};
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string[]} projectIds
 * @param {number} now epoch milliseconds
 * @param {{ shown?: (directoryId: string, path: string, anchor: object|null, value: string|null) => string|null }} [options]
 *   how a worksheet shows a value, for the captions
 * @returns {{ entries: object[], truncated: boolean }}
 */
export function recentHistory(db, projectIds, now, { shown = null } = {}) {
  if (!projectIds.length) return { entries: [], truncated: false };
  const since = new Date(now - HISTORY_DAYS * DAY_MS).toISOString();
  const placeholders = projectIds.map(() => '?').join(',');
  const events = db.prepare(`
    SELECT e.id, e.project_id, e.occurred_at, e.source, e.resulting_snapshot_id, COUNT(c.id) AS file_count
    FROM timeline_events e JOIN file_changes c ON c.event_id = e.id
    WHERE e.project_id IN (${placeholders}) AND e.occurred_at >= ?
    GROUP BY e.id
    ORDER BY e.occurred_at DESC
    LIMIT ?
  `).all(...projectIds, since, MAX_HISTORY_ENTRIES + 1);
  const listed = events.filter((event) => event.source !== 'IMPORT' && event.file_count <= MAX_FILES_PER_EVENT);
  const changes = new Map();
  const values = valueChangesBySnapshot(db, listed.map((event) => event.resulting_snapshot_id).filter(Boolean), shown);
  for (let start = 0; start < listed.length; start += ID_BATCH) {
    const ids = listed.slice(start, start + ID_BATCH).map((event) => event.id);
    for (const row of db.prepare(`SELECT id, event_id, change_type, path_before, path_after, project_file_id
      FROM file_changes WHERE event_id IN (${ids.map(() => '?').join(',')}) ORDER BY rowid`).all(...ids)) {
      if (!changes.has(row.event_id)) changes.set(row.event_id, []);
      changes.get(row.event_id).push(row);
    }
  }
  const entries = events.slice(0, MAX_HISTORY_ENTRIES).flatMap((event) => {
    const base = { directoryId: event.project_id, at: event.occurred_at };
    // A folder's first reading lists every file as added: one event, "added to The Ranch".
    if (event.source === 'IMPORT') {
      return [{ ...base, id: event.id, change: 'directory-added', path: null, previousPath: null, fileCount: event.file_count }];
    }
    if (event.file_count > MAX_FILES_PER_EVENT) {
      return [{ ...base, id: event.id, change: 'many', path: null, previousPath: null, fileCount: event.file_count }];
    }
    return (changes.get(event.id) ?? []).map((row) => ({
      ...base, id: row.id, change: VERBS[row.change_type] ?? 'edited',
      path: row.path_after ?? row.path_before,
      previousPath: row.path_after && row.path_before && row.path_before !== row.path_after ? row.path_before : null,
      fileId: row.project_file_id,
      ...valueChangesOf(values, event.resulting_snapshot_id, row),
    }));
  });
  return { entries: entries.slice(0, MAX_HISTORY_ENTRIES),
    truncated: events.length > MAX_HISTORY_ENTRIES || entries.length > MAX_HISTORY_ENTRIES };
}
