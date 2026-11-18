// One row of The Ranch's Recent Changes opened like an audit log entry: who
// and what recorded the change, the directory versions it went between, the
// file's size and fingerprint on each side, and what changed inside it. Text
// is compared line by line with a little around each change, tables cell by
// cell, and the files Lasso reads into objects (workbooks, PDFs, Word files,
// decks, drawings) value by value. Everything comes from recorded history;
// nothing is read from the disk.

import { HttpError } from '../history/errors.js';
import { diffInternals, expandStructuredDiff } from '../history/diff.js';
import { isTextualType } from '../history/file-types.js';
import { sourceLocator } from '../terminal/names.js';

/** Lines kept either side of a changed line, as `diff -U3` keeps them. */
export const CONTEXT_LINES = 3;
/** Lines shown in one change; past this the detail says it was cut short. */
export const MAX_SHOWN_LINES = 400;
/** A new or removed text file shows this many of its lines. */
export const MAX_WHOLE_FILE_LINES = 60;
export const MAX_VALUES = 200;
export const MAX_TABLE_CELLS = 200;
export const MAX_LISTED_FILES = 300;
/** Characters of one line or value; a minified file's one line is cut here. */
const MAX_TEXT = 600;
const MAX_REQUEST = 400;

const VERBS = { ADDED: 'added', DELETED: 'removed', RENAMED: 'renamed', MOVED: 'moved', MODIFIED: 'edited' };

const clip = (text, limit = MAX_TEXT) => {
  if (text == null) return null;
  const value = String(text);
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
};

const EVENT = `
  SELECT e.id, e.project_id, e.occurred_at, e.source, e.previous_snapshot_id, e.resulting_snapshot_id,
    a.display_name AS actor_name, a.actor_type, i.display_name AS initiator_name, i.actor_type AS initiator_type,
    x.request_text, ps.version AS previous_version, rs.version AS resulting_version,
    (SELECT COUNT(*) FROM file_changes f WHERE f.event_id = e.id) AS file_count
  FROM timeline_events e
  JOIN actors a ON a.id = e.actor_id
  LEFT JOIN actors i ON i.id = e.initiated_by_actor_id
  LEFT JOIN agent_executions x ON x.id = e.agent_execution_id
  LEFT JOIN snapshots ps ON ps.id = e.previous_snapshot_id
  JOIN snapshots rs ON rs.id = e.resulting_snapshot_id
  WHERE e.id = ?`;

const OBJECT_CHANGES = `
  SELECT c.kind, c.before_version_id, o.object_type,
    b.path AS before_path, b.label AS before_label, b.value_text AS before_value,
    b.anchor_json AS before_anchor, b.metadata_json AS before_metadata,
    a.path AS after_path, a.label AS after_label, a.value_text AS after_value,
    a.anchor_json AS after_anchor, a.metadata_json AS after_metadata,
    s.replaces_version_id, r.label AS replaced_label, r.value_text AS replaced_value
  FROM object_changes c
  JOIN scientific_objects o ON o.id = c.object_id
  LEFT JOIN scientific_object_versions b ON b.id = c.before_version_id
  LEFT JOIN scientific_object_versions a ON a.id = c.after_version_id
  LEFT JOIN passage_successions s ON s.snapshot_id = c.snapshot_id AND s.object_id = c.object_id
  LEFT JOIN scientific_object_versions r ON r.id = s.replaces_version_id
  WHERE c.snapshot_id = ? AND (a.path = ? OR (a.path IS NULL AND b.path = ?))`;

const parse = (text) => {
  try { return JSON.parse(text ?? 'null'); } catch { return null; }
};

/**
 * The detail of one Recent Changes row: a file change by its id, or a whole
 * capture (a directory's first reading, many files at once) by its event's.
 * @param {{ db: import('node:sqlite').DatabaseSync, timeline: object, shown?: Function }} context
 *   `shown(directoryId, path, anchor, value)` is how a worksheet shows a value
 */
export function changeDetail({ db, timeline, shown = null }, id) {
  if (typeof id !== 'string' || !id || id.length > 128) throw new HttpError(400, 'Choose a change.');
  const fileChange = db.prepare('SELECT * FROM file_changes WHERE id = ?').get(id);
  const event = db.prepare(EVENT).get(fileChange?.event_id ?? id);
  if (!event) throw new HttpError(404, 'Lasso has no record of this change.');
  const base = {
    id, directoryId: event.project_id, at: event.occurred_at, source: event.source,
    actor: { name: event.actor_name, type: event.actor_type },
    initiatedBy: event.initiator_name ? { name: event.initiator_name, type: event.initiator_type } : null,
    request: clip(event.request_text, MAX_REQUEST),
    version: { before: event.previous_version ?? null, after: event.resulting_version },
  };
  return fileChange ? fileDetail({ db, timeline, shown }, event, fileChange, base) : captureDetail(db, event, base);
}

/** A capture of many files, or a directory's first reading: the files it recorded. */
function captureDetail(db, event, base) {
  const files = db.prepare(`SELECT change_type, path_before, path_after FROM file_changes WHERE event_id = ?
    ORDER BY COALESCE(path_after, path_before) LIMIT ?`).all(event.id, MAX_LISTED_FILES)
    .map((row) => ({ change: VERBS[row.change_type] ?? 'edited', path: row.path_after ?? row.path_before,
      previousPath: row.path_after && row.path_before !== row.path_after ? row.path_before : null }));
  return { ...base, change: event.source === 'IMPORT' ? 'directory-added' : 'many', path: null, previousPath: null,
    fileId: null, fileCount: event.file_count, files, file: null, lines: null, table: null, fields: null,
    values: [], valueCount: 0, movedCount: 0, bytesReleased: false };
}

function fileDetail({ db, timeline, shown }, event, row, base) {
  const before = row.content_hash_before && event.previous_snapshot_id
    ? timeline.snapshotFileById(event.previous_snapshot_id, row.project_file_id) : null;
  const after = row.content_hash_after ? timeline.snapshotFileById(event.resulting_snapshot_id, row.project_file_id) : null;
  const filePath = row.path_after ?? row.path_before;
  const fileType = after?.fileType ?? before?.fileType ?? null;
  const read = (hash) => (hash ? timeline.blobs.get(hash) : null);
  let released = false;
  const stored = parse(row.structured_diff_json) ?? {};
  let diff = expandStructuredDiff(stored, () => ({ before: read(row.content_hash_before), after: read(row.content_hash_after) }));
  if (diff?.bytesReleased) released = true;
  // Markdown is recorded a block at a time; a reader of the change wants its lines.
  if (diff?.format === 'markdown' && !released) diff = markdownLines(read, row) ?? diff;

  let lines = null;
  let table = null;
  let fields = null;
  if (Array.isArray(diff?.operations)) {
    lines = hunksOf(diff);
  } else if (diff?.format === 'table') {
    table = tableOf(diff);
  } else if (diff?.format === 'json') {
    fields = (diff.changes ?? []).slice(0, MAX_VALUES).map((change) => ({ path: change.path, kind: change.kind,
      before: change.before === undefined ? null : clip(JSON.stringify(change.before)),
      after: change.after === undefined ? null : clip(JSON.stringify(change.after)) }));
  } else if ((row.change_type === 'ADDED' || row.change_type === 'DELETED') && isTextualType(fileType)) {
    // A new file reads as all added, a removed one as all removed, as a diff shows them.
    try {
      const bytes = read(row.change_type === 'ADDED' ? row.content_hash_after : row.content_hash_before);
      if (bytes) lines = wholeFileLines(bytes, row.change_type === 'ADDED' ? 'add' : 'remove');
    } catch (error) {
      if (error?.code !== 'BLOB_RELEASED') throw error;
      released = true;
    }
  }

  // Text and tables already say what changed; the objects read from them would say it twice.
  const values = lines || table || fields ? { values: [], valueCount: 0, movedCount: 0 }
    : valuesOf(db, event, filePath, row.path_before, shown);
  return {
    ...base, change: VERBS[row.change_type] ?? 'edited', path: filePath,
    previousPath: row.path_after && row.path_before && row.path_before !== row.path_after ? row.path_before : null,
    fileId: row.project_file_id, fileCount: 1, files: [],
    file: { type: fileType, before: side(before, row.content_hash_before), after: side(after, row.content_hash_after) },
    lines, table, fields, ...values, bytesReleased: released,
  };
}

function markdownLines(read, row) {
  try {
    const [before, after] = [row.content_hash_before, row.content_hash_after].map((hash) => read(hash));
    if (!before || !after) return null;
    const text = (bytes) => bytes.toString('utf8').replace(/\r\n/g, '\n');
    return diffInternals.lineDiff(text(before), text(after), 'markdown');
  } catch (error) {
    if (error?.code === 'BLOB_RELEASED') return null;
    throw error;
  }
}

function side(file, hash) {
  if (!hash) return null;
  return { size: file?.size ?? null, hash, modifiedAt: Number.isFinite(file?.mtimeMs) ? new Date(file.mtimeMs).toISOString() : null };
}

/**
 * Changed lines with CONTEXT_LINES around them, as hunks:
 * { added, removed, hunks: [{ lines: [{ kind: same | add | remove, text, before, after }] }], truncated }.
 */
function hunksOf(diff) {
  const operations = diff.operations;
  const changed = operations.map((operation) => operation.kind !== 'equal');
  const keep = new Array(operations.length).fill(false);
  changed.forEach((isChanged, index) => {
    if (!isChanged) return;
    for (let near = Math.max(0, index - CONTEXT_LINES); near <= Math.min(operations.length - 1, index + CONTEXT_LINES); near += 1) {
      keep[near] = true;
    }
  });
  const hunks = [];
  let current = null;
  let shown = 0;
  let truncated = false;
  operations.forEach((operation, index) => {
    if (!keep[index]) { current = null; return; }
    if (shown >= MAX_SHOWN_LINES) { truncated = true; return; }
    if (!current) { current = { lines: [] }; hunks.push(current); }
    current.lines.push({
      kind: operation.kind === 'equal' ? 'same' : operation.kind,
      text: clip(operation.text ?? ''),
      before: operation.beforeLine ?? null, after: operation.afterLine ?? null,
      ...(operation.blockType ? { block: operation.blockType } : {}),
    });
    shown += 1;
  });
  return { added: diff.added ?? 0, removed: diff.removed ?? 0, hunks, truncated };
}

function wholeFileLines(bytes, kind) {
  const all = bytes.toString('utf8').replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const lines = all.slice(0, MAX_WHOLE_FILE_LINES).map((text, index) => ({
    kind, text: clip(text), before: kind === 'remove' ? index + 1 : null, after: kind === 'add' ? index + 1 : null,
  }));
  return { added: kind === 'add' ? all.length : 0, removed: kind === 'remove' ? all.length : 0,
    hunks: lines.length ? [{ lines }] : [], truncated: all.length > lines.length };
}

function tableOf(diff) {
  const cells = (diff.cellsChanged ?? []).slice(0, MAX_TABLE_CELLS)
    .map((cell) => ({ row: cell.rowKey, column: cell.column, before: clip(cell.before), after: clip(cell.after) }));
  return {
    keyColumn: diff.keyColumn ?? null,
    rowsAdded: (diff.rowsAdded ?? []).slice(0, MAX_TABLE_CELLS),
    rowsRemoved: (diff.rowsRemoved ?? []).slice(0, MAX_TABLE_CELLS),
    cells,
    counts: { rowsAdded: diff.rowsAdded?.length ?? 0, rowsRemoved: diff.rowsRemoved?.length ?? 0,
      cellsChanged: diff.cellsChanged?.length ?? 0 },
  };
}

/**
 * Where an object sits, in the words its file uses: "Budget!B2", "Page 3",
 * "Slide 4", "Paragraph 6", "Lines 12–14".
 */
export function placeOf(anchor, metadata, filePath) {
  if (!anchor) return null;
  if (anchor.kind === 'pdf-excerpt' && Number.isInteger(anchor.pageNumber)) return `Page ${anchor.pageNumber}`;
  if (Number.isInteger(anchor.slideNumber)) return `Slide ${anchor.slideNumber}`;
  if (anchor.kind === 'text-excerpt' && Number.isInteger(anchor.lineStart)) {
    const end = Number.isInteger(anchor.lineEnd) ? anchor.lineEnd : anchor.lineStart;
    // A Word document's text is a paragraph per line, with a blank line between.
    if (metadata?.format === 'DOCUMENT') {
      const [first, last] = [anchor.lineStart, end].map((line) => (line + 1) / 2);
      return first === last ? `Paragraph ${first}` : `Paragraphs ${first}–${last}`;
    }
    return anchor.lineStart === end ? `Line ${anchor.lineStart}` : `Lines ${anchor.lineStart}–${end}`;
  }
  // A worksheet's anchors hold the sheet's own row number; the locator counts from the first row read.
  const worksheet = anchor.rowCoordinate === 'worksheet' && Number.isInteger(anchor.rowIndex);
  const counted = worksheet ? { ...anchor, rowIndex: anchor.rowIndex - 1 } : anchor;
  const locator = sourceLocator({ anchor: counted, metadata: metadata ?? {}, path: filePath });
  return locator ? locator[0].toUpperCase() + locator.slice(1) : null;
}

/** A sort key that keeps a file's changes in reading order. */
function readingOrder(anchor) {
  return [anchor?.sheet ?? '', anchor?.pageNumber ?? anchor?.slideNumber ?? 0,
    anchor?.lineStart ?? anchor?.line ?? anchor?.rowIndex ?? 0, anchor?.columnIndex ?? 0];
}

function compareOrder(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] === right[index]) continue;
    return typeof left[index] === 'string' ? String(left[index]).localeCompare(String(right[index]))
      : left[index] - right[index];
  }
  return 0;
}

/**
 * The values the index recorded as added, removed or changed in this file at
 * this capture. An edited passage, recorded as a new passage replacing the
 * old one, is one change from the old words to the new.
 */
function valuesOf(db, event, filePath, previousPath, shown) {
  const rows = db.prepare(OBJECT_CHANGES).all(event.resulting_snapshot_id, filePath, previousPath ?? filePath);
  const replaced = new Set(rows.map((row) => row.replaces_version_id).filter(Boolean));
  const renamed = Boolean(previousPath && previousPath !== filePath);
  let moved = 0;
  const values = [];
  for (const row of rows) {
    if (row.kind === 'removed' && replaced.has(row.before_version_id)) continue;
    const anchor = parse(row.after_anchor ?? row.before_anchor);
    const metadata = parse(row.after_metadata ?? row.before_metadata) ?? {};
    // A column's inferred profile restates its values; only the values themselves count.
    if (row.object_type === 'VARIABLE' && !metadata.dictionary) continue;
    const successor = row.kind === 'added' && row.replaces_version_id;
    const kind = successor ? 'modified' : row.kind;
    let before = successor ? row.replaced_value : row.before_value;
    let after = row.after_value;
    const beforeLabel = successor ? row.replaced_label : row.before_label;
    // Everything in a renamed file moves with it; elsewhere a move is a row or passage shifted.
    if (kind === 'moved') {
      if (!renamed) moved += 1;
      continue;
    }
    // Recorded again with the same words and value: nothing a reader would call a change.
    if (kind === 'modified' && before === after && beforeLabel === row.after_label) continue;
    // An object with no value of its own (a file, a heading) is said by its label.
    let label = row.after_label ?? row.before_label;
    const valued = !(kind === 'modified' && before === after) && (kind === 'removed' ? before : after) != null;
    if (kind === 'modified' && before === after) {
      // Only its label changed. A renamed file renames what is read from it,
      // which says nothing the rename does not.
      if (renamed) continue;
      [before, after, label] = [beforeLabel, row.after_label, null];
    } else if (kind === 'added' && after == null) {
      [after, label] = [row.after_label, null];
    } else if (kind === 'removed' && before == null) {
      [before, label] = [row.before_label, null];
    }
    // Only values are shown as the worksheet formats them, never labels standing in for them.
    const display = (value) => (shown && valued && value != null ? shown(event.project_id, filePath, anchor, value) : null);
    const beforeDisplay = kind === 'added' ? null : display(before);
    const afterDisplay = kind === 'removed' ? null : display(after);
    values.push({
      kind, label: clip(label, 160), place: placeOf(anchor, metadata, filePath),
      before: kind === 'added' ? null : clip(before), after: kind === 'removed' ? null : clip(after),
      ...(beforeDisplay ? { beforeDisplay } : {}), ...(afterDisplay ? { afterDisplay } : {}),
      order: readingOrder(anchor),
    });
  }
  values.sort((left, right) => compareOrder(left.order, right.order));
  return { values: values.slice(0, MAX_VALUES).map(({ order, ...value }) => value), valueCount: values.length, movedCount: moved };
}
