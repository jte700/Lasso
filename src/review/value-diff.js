// The values and passages a file's saves changed between two versions of its
// folder, for the files Lasso reads into objects but cannot show line by line
// or as a grid: Word files, PDFs, decks, drawings. Each object's changes are
// put together across the saves: what it read before the first, and what it
// reads after the last. A passage reworded in one save and again in the next
// is one change, from its first words to its last.

import { compareOrder, placeOf, readingOrder } from '../ranch/change-detail.js';
import { FORMULA_CELL } from '../ranch/history.js';
import { shownCell } from '../ranch/sheets.js';

export const MAX_VALUES = 200;
const MAX_TEXT = 2000;

const CHANGES = `
  SELECT c.kind, c.object_id, c.before_version_id, o.object_type,
    b.label AS before_label, b.value_text AS before_value, b.anchor_json AS before_anchor, b.metadata_json AS before_metadata,
    a.label AS after_label, a.value_text AS after_value, a.anchor_json AS after_anchor, a.metadata_json AS after_metadata,
    ps.replaces_version_id, r.object_id AS replaces_object, r.label AS replaced_label, r.value_text AS replaced_value,
    CASE WHEN a.id IS NULL THEN 0 ELSE ${FORMULA_CELL} END AS formula
  FROM object_changes c
  JOIN snapshots s ON s.id = c.snapshot_id
  JOIN scientific_objects o ON o.id = c.object_id
  LEFT JOIN scientific_object_versions a ON a.id = c.after_version_id
  LEFT JOIN scientific_object_versions b ON b.id = c.before_version_id
  LEFT JOIN passage_successions ps ON ps.snapshot_id = c.snapshot_id AND ps.object_id = c.object_id
  LEFT JOIN scientific_object_versions r ON r.id = ps.replaces_version_id
  WHERE s.project_id = ? AND s.version > ? AND s.version <= ? AND (a.path = ? OR (a.path IS NULL AND b.path = ?))
  ORDER BY s.version`;

const parse = (text) => {
  try { return JSON.parse(text ?? 'null'); } catch { return null; }
};
const clip = (text) => (text == null ? null : String(text).length > MAX_TEXT ? `${String(text).slice(0, MAX_TEXT)}…` : String(text));

/**
 * The file's changed values from version `fromVersion` (exclusive) to
 * `toVersion`: [{ kind: added | removed | modified, label, place, before, after,
 * recalculated? }] in reading order, and how many there were in all.
 */
export function valueChanges(db, projectId, filePath, fromVersion, toVersion) {
  const rows = db.prepare(CHANGES).all(projectId, fromVersion, toVersion, filePath, filePath);
  const replaced = new Set(rows.map((row) => row.replaces_version_id).filter(Boolean));
  // A successor passage carries on its predecessor's line of changes.
  const lineage = new Map();
  const rootOf = (objectId) => {
    let root = objectId;
    while (lineage.has(root)) root = lineage.get(root);
    return root;
  };
  const merged = new Map();
  for (const row of rows) {
    if (row.object_type === 'VARIABLE' && !parse(row.after_metadata ?? row.before_metadata)?.dictionary) continue;
    if (row.kind === 'moved') continue;
    if (row.kind === 'removed' && replaced.has(row.before_version_id)) continue;
    const successor = row.kind === 'added' && row.replaces_object;
    if (successor) lineage.set(row.object_id, row.replaces_object);
    const key = rootOf(row.object_id);
    const known = merged.get(key);
    const before = successor ? { label: row.replaced_label, value: row.replaced_value } : row.kind === 'added' ? null
      : { label: row.before_label, value: row.before_value };
    const after = row.kind === 'removed' ? null : {
      label: row.after_label, value: row.after_value, anchor: parse(row.after_anchor), metadata: parse(row.after_metadata) ?? {},
      formula: Boolean(row.formula),
    };
    if (!known) {
      merged.set(key, { first: before, last: after, anchor: parse(row.after_anchor ?? row.before_anchor),
        metadata: parse(row.after_metadata ?? row.before_metadata) ?? {} });
    } else {
      known.last = after;
      if (after) { known.anchor = after.anchor ?? known.anchor; known.metadata = after.metadata; }
    }
  }
  const values = [];
  for (const { first, last, anchor, metadata } of merged.values()) {
    if (!first && !last) continue;
    if (first && last && first.value === last.value && first.label === last.label) continue;
    const kind = !first ? 'added' : !last ? 'removed' : 'modified';
    const valued = (kind === 'removed' ? first.value : last.value) != null;
    const labelOnly = kind === 'modified' && first.value === last.value;
    const tidy = (value) => (value == null ? null : shownCell(null, value));
    values.push({
      kind, label: clip(labelOnly ? null : (last ?? first).label), place: placeOf(anchor, metadata, filePath),
      before: kind === 'added' ? null : clip(labelOnly || !valued ? first.label : tidy(first.value)),
      after: kind === 'removed' ? null : clip(labelOnly || !valued ? last.label : tidy(last.value)),
      ...(kind === 'modified' && !labelOnly && last.formula ? { recalculated: true } : {}),
      order: [kind === 'modified' && !labelOnly && last.formula ? 1 : 0, ...readingOrder(anchor)],
    });
  }
  values.sort((left, right) => compareOrder(left.order, right.order));
  return { values: values.slice(0, MAX_VALUES).map(({ order, ...value }) => value), count: values.length };
}
