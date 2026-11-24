// The Ranch's Recent Changes: what changed in each directory over the last two
// weeks, newest first, read from the recorded history rather than the disk.

import { detectFileType } from '../history/file-types.js';
import { shownCell } from './sheets.js';

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

/**
 * Whether the cell an object change `c` left as version `a` holds a formula:
 * as that reading says, or as a later reading of the same file bytes says. A
 * reader that learns to mark formulas reads a folder again with the same bytes,
 * so a save recorded before it still reads as typed and recalculated cells.
 */
export const FORMULA_CELL = `COALESCE(json_extract(a.metadata_json, '$.formula'),
    EXISTS (SELECT 1 FROM scientific_object_versions n WHERE n.object_id = c.object_id
      AND n.content_hash = a.content_hash AND json_extract(n.metadata_json, '$.formula') = 1), 0)`;

const VALUE_CHANGES = (count) => `
  SELECT c.snapshot_id, s.project_id, a.path, a.label, a.anchor_json, b.value_text AS before_value, a.value_text AS after_value,
    ${FORMULA_CELL} AS formula
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
  const anchor = JSON.parse(row.anchor_json ?? 'null');
  // As the worksheet formats it, else without a binary workbook's floating-point residue.
  const display = (value) => {
    const formatted = shown?.(row.project_id, row.path, anchor, value);
    if (formatted || value == null) return formatted ?? null;
    const tidied = shownCell(null, value);
    return tidied !== value ? tidied : null;
  };
  const beforeDisplay = display(row.before_value);
  const afterDisplay = display(row.after_value);
  return { ...first, ...(beforeDisplay ? { beforeDisplay } : {}), ...(afterDisplay ? { afterDisplay } : {}) };
}

/**
 * The values each snapshot changed, by snapshot and then path: { count, first,
 * recalculated }. `recalculated` counts the formula cells among them, which
 * changed because their inputs did; `first` is a typed value when there is one.
 */
function valueChangesBySnapshot(db, snapshotIds, shown) {
  const bySnapshot = new Map();
  for (let start = 0; start < snapshotIds.length; start += ID_BATCH) {
    const ids = snapshotIds.slice(start, start + ID_BATCH);
    for (const row of db.prepare(VALUE_CHANGES(ids.length)).all(...ids)) {
      if (!bySnapshot.has(row.snapshot_id)) bySnapshot.set(row.snapshot_id, new Map());
      const byPath = bySnapshot.get(row.snapshot_id);
      const formula = Boolean(row.formula);
      const known = byPath.get(row.path) ?? { count: 0, recalculated: 0, first: null, firstFormula: true };
      byPath.set(row.path, known);
      known.count += 1;
      if (formula) known.recalculated += 1;
      if (!known.first || (known.firstFormula && !formula)) {
        known.first = captionedChange(row, shown);
        known.firstFormula = formula;
      }
    }
  }
  for (const byPath of bySnapshot.values()) {
    for (const [filePath, { count, recalculated, first }] of byPath) {
      byPath.set(filePath, { count, first, ...(recalculated ? { recalculated } : {}) });
    }
  }
  return bySnapshot;
}

// Lasso reads every cell of these. Excel writes a workbook again when it opens
// one, and a save can change only formatting; neither changes a cell.
const CELL_READ_TYPES = new Set(['spreadsheet', 'table']);

/**
 * The workbooks (by snapshot and path, "snapshot\0path") a capture read again
 * and found no cell of changed: every object it recorded for them is the same
 * label and value under a new version. A workbook with nothing recorded is not
 * among them, since Lasso cannot say it was read.
 */
function unchangedWorkbooks(db, rows) {
  const saved = rows.filter((row) => row.change_type === 'MODIFIED' && row.snapshot_id
    && CELL_READ_TYPES.has(detectFileType(row.path_after ?? row.path_before ?? '')));
  const key = (snapshotId, filePath) => `${snapshotId}\u0000${filePath}`;
  const asked = new Set(saved.map((row) => key(row.snapshot_id, row.path_after ?? row.path_before)));
  const snapshotIds = [...new Set(saved.map((row) => row.snapshot_id))];
  const unchanged = new Set();
  for (let start = 0; start < snapshotIds.length; start += ID_BATCH) {
    const ids = snapshotIds.slice(start, start + ID_BATCH);
    for (const row of db.prepare(`
      SELECT c.snapshot_id, COALESCE(a.path, b.path) AS path,
        MAX(CASE WHEN c.kind = 'modified' AND a.value_text IS b.value_text AND a.label IS b.label THEN 0 ELSE 1 END) AS changed
      FROM object_changes c
      LEFT JOIN scientific_object_versions a ON a.id = c.after_version_id
      LEFT JOIN scientific_object_versions b ON b.id = c.before_version_id
      WHERE c.snapshot_id IN (${ids.map(() => '?').join(',')})
      GROUP BY c.snapshot_id, COALESCE(a.path, b.path)`).all(...ids)) {
      const found = key(row.snapshot_id, row.path);
      if (!row.changed && asked.has(found)) unchanged.add(found);
    }
  }
  return unchanged;
}

// Markdown is compared a block at a time, which a reader calls a paragraph.
const TEXT_UNITS = { text: 'line', code: 'line', markdown: 'paragraph' };

/**
 * How many lines (or Markdown paragraphs) an edit to a text file added and
 * removed, from the comparison recorded with it, so its row can say so
 * rather than quote a passage.
 */
function textChangesOf(row) {
  const unit = TEXT_UNITS[row.diff_format];
  if (!unit || !Number.isInteger(row.diff_added) || !Number.isInteger(row.diff_removed)) return {};
  if (row.diff_added === 0 && row.diff_removed === 0) return {};
  return { textChanges: { added: row.diff_added, removed: row.diff_removed, unit } };
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
    SELECT e.id, e.project_id, e.occurred_at, e.source, e.resulting_snapshot_id, COUNT(c.id) AS file_count,
      a.display_name AS actor_name, a.actor_type
    FROM timeline_events e JOIN file_changes c ON c.event_id = e.id JOIN actors a ON a.id = e.actor_id
    WHERE e.project_id IN (${placeholders}) AND e.occurred_at >= ?
    GROUP BY e.id
    ORDER BY e.occurred_at DESC
    LIMIT ?
  `).all(...projectIds, since, MAX_HISTORY_ENTRIES + 1);
  const listed = events.filter((event) => event.source !== 'IMPORT' && event.file_count <= MAX_FILES_PER_EVENT);
  // Lasso writing its AI record into a document changed none of its words, and is no one's edit.
  const visible = events.filter((event) => event.source !== 'AI_RECORD');
  const snapshotOf = new Map(listed.map((event) => [event.id, event.resulting_snapshot_id]));
  const changes = new Map();
  const values = valueChangesBySnapshot(db, listed.map((event) => event.resulting_snapshot_id).filter(Boolean), shown);
  for (let start = 0; start < listed.length; start += ID_BATCH) {
    const ids = listed.slice(start, start + ID_BATCH).map((event) => event.id);
    for (const row of db.prepare(`SELECT id, event_id, change_type, path_before, path_after, project_file_id,
        json_extract(structured_diff_json, '$.format') AS diff_format,
        json_extract(structured_diff_json, '$.added') AS diff_added,
        json_extract(structured_diff_json, '$.removed') AS diff_removed
      FROM file_changes WHERE event_id IN (${ids.map(() => '?').join(',')}) ORDER BY rowid`).all(...ids)) {
      if (!changes.has(row.event_id)) changes.set(row.event_id, []);
      changes.get(row.event_id).push({ ...row, snapshot_id: snapshotOf.get(row.event_id) });
    }
  }
  // Recent Changes lists what a save changed; a workbook written with no cell changed is left out.
  const unchanged = unchangedWorkbooks(db, [...changes.values()].flat());
  const changedSomething = (row) => !(row.change_type === 'MODIFIED'
    && unchanged.has(`${row.snapshot_id}\u0000${row.path_after ?? row.path_before}`));
  const entries = visible.slice(0, MAX_HISTORY_ENTRIES).flatMap((event) => {
    // Who history says made the change and how Lasso came to record it
    // (WATCHER for a save it saw, AGENT_EDIT, IMPORT for a first reading).
    const base = { directoryId: event.project_id, at: event.occurred_at, source: event.source,
      actor: { name: event.actor_name, type: event.actor_type } };
    // A folder's first reading lists every file as added: one event, "added to The Ranch".
    if (event.source === 'IMPORT') {
      return [{ ...base, id: event.id, change: 'directory-added', path: null, previousPath: null, fileCount: event.file_count }];
    }
    if (event.file_count > MAX_FILES_PER_EVENT) {
      return [{ ...base, id: event.id, change: 'many', path: null, previousPath: null, fileCount: event.file_count }];
    }
    return (changes.get(event.id) ?? []).filter(changedSomething).map((row) => ({
      ...base, id: row.id, change: VERBS[row.change_type] ?? 'edited',
      path: row.path_after ?? row.path_before,
      previousPath: row.path_after && row.path_before && row.path_before !== row.path_after ? row.path_before : null,
      fileId: row.project_file_id,
      ...valueChangesOf(values, event.resulting_snapshot_id, row),
      ...textChangesOf(row),
    }));
  });
  return { entries: entries.slice(0, MAX_HISTORY_ENTRIES),
    truncated: visible.length > MAX_HISTORY_ENTRIES || entries.length > MAX_HISTORY_ENTRIES };
}
