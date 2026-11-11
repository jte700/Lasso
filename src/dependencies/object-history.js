// What happened to source objects over time: one object's versions, and
// what one snapshot's index changed, from the change records each index after
// a folder's first writes (object_changes, see history/object-versions.js).

import { json } from '../db.js';
import { HttpError } from '../history/errors.js';
import { sameVersion } from '../history/object-identity.js';
import { replacedVersion } from '../history/passage-succession.js';

const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 500;
// How many earlier wordings of a passage its history follows.
const MAX_EARLIER_WORDINGS = 20;
// How many of a value's past versions a preview lists.
const PREVIEW_HISTORY_LIMIT = 20;

/**
 * Why a snapshot was recorded, from its timeline event's source: a re-read
 * of unchanged files by a newer reader, an agent's edit, or otherwise a
 * person's edit (a watcher save, a checkpoint, an import).
 */
export function changeCause(source, actorType = null) {
  if (source === 'REINDEX') return 'reread';
  if (source === 'AGENT_EDIT' || actorType === 'AI_AGENT') return 'agent';
  return 'edit';
}

function historyLimit(limit) {
  const number = Number(limit);
  if (!Number.isInteger(number) || number < 1) return DEFAULT_HISTORY_LIMIT;
  return Math.min(number, MAX_HISTORY_LIMIT);
}

const storedFieldsOf = (row) => [row.path, row.anchor_json, row.label, row.value_text ?? null, row.search_text,
  row.content_hash, row.metadata_json];

// One object's versions and removals with the snapshot, event and change record of each.
const OBJECT_ENTRIES = `
  SELECT v.id AS version_id, v.snapshot_id, v.path, v.anchor_json, v.label, v.value_text, v.search_text,
    v.content_hash, v.metadata_json, s.version, s.created_at, c.kind, e.source, a.actor_type
  FROM scientific_object_versions v
  JOIN snapshots s ON s.id = v.snapshot_id
  LEFT JOIN object_changes c ON c.object_id = v.object_id AND c.snapshot_id = v.snapshot_id
  LEFT JOIN timeline_events e ON e.resulting_snapshot_id = v.snapshot_id
  LEFT JOIN actors a ON a.id = e.actor_id
  WHERE v.object_id = ?
  UNION ALL
  SELECT c.before_version_id, c.snapshot_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    s.version, s.created_at, c.kind, e.source, a.actor_type
  FROM object_changes c
  JOIN snapshots s ON s.id = c.snapshot_id
  LEFT JOIN timeline_events e ON e.resulting_snapshot_id = c.snapshot_id
  LEFT JOIN actors a ON a.id = e.actor_id
  WHERE c.object_id = ? AND c.kind = 'removed'
  ORDER BY version`;

export const objectHistoryMethods = {
  /**
   * An object's versions, most recent first, as { value, label, changedAt,
   * snapshotId, kind, cause, source }, with a removal as an entry of kind
   * 'removed' whose value is null. `kind` is what the change record says;
   * the first version of an object is 'added', and a version recorded before
   * change records were kept has no kind (null). A version written again
   * only because an index was written in full, reading the same, is left out.
   */
  objectHistory(objectId, { limit = DEFAULT_HISTORY_LIMIT } = {}) {
    const object = this.db.prepare('SELECT object_type FROM scientific_objects WHERE id = ?').get(objectId);
    if (!object) throw new HttpError(404, 'Indexed object not found.');
    const wanted = historyLimit(limit);
    const entries = this.ownHistory(objectId, object.object_type);
    // An edited passage is a new object that replaces the one before it; its
    // history goes on through the earlier wording, without that one's removal.
    let replaced = replacedVersion(this.db, objectId);
    for (let step = 0; replaced && entries.length < wanted && step < MAX_EARLIER_WORDINGS; step += 1) {
      const earlier = this.ownHistory(replaced.object_id, object.object_type)
        .filter((entry) => !(entry.kind === 'removed' && entry.snapshotId === replaced.snapshot_id));
      entries.push(...earlier);
      replaced = replacedVersion(this.db, replaced.object_id);
    }
    return entries.slice(0, wanted);
  },

  /** An object's value history for its preview, most recent first; empty when it has none to show. */
  previewHistory(objectId) {
    try {
      return this.objectHistory(objectId, { limit: PREVIEW_HISTORY_LIMIT })
        .map(({ value, changedAt, snapshotId, kind, cause }) => ({ value, changedAt, snapshotId, kind, cause }));
    } catch {
      return [];
    }
  },

  /** One object's own versions and removals, most recent first (see objectHistory). */
  ownHistory(objectId, objectType) {
    const entries = [];
    let previous = null;
    for (const row of this.db.prepare(OBJECT_ENTRIES).all(objectId, objectId)) {
      const removal = row.kind === 'removed';
      const restated = !removal && !row.kind && previous && sameVersion(previous, storedFieldsOf(row), objectType);
      if (!restated) {
        entries.push({
          value: removal ? null : row.value_text,
          label: removal ? previous?.label ?? null : row.label,
          changedAt: row.created_at,
          snapshotId: row.snapshot_id,
          versionId: removal ? null : row.version_id,
          kind: row.kind ?? (entries.length ? null : 'added'),
          cause: changeCause(row.source, row.actor_type),
          source: row.source ?? null,
        });
      }
      previous = removal ? null : row;
    }
    return entries.reverse();
  },

  /**
   * What one snapshot's index changed, value by value: { objectId, objectKey,
   * objectType, path, label, kind, before, after, anchor }, where `before`
   * and `after` are the object's values on either side (null for an object
   * added or removed). Empty for a folder's first index, which has nothing
   * to compare with.
   */
  snapshotChanges(snapshotId) {
    if (!this.db.prepare('SELECT 1 FROM snapshots WHERE id = ?').get(snapshotId)) {
      throw new HttpError(404, 'Snapshot not found.');
    }
    return this.db.prepare(`
      SELECT c.object_id, c.kind, o.object_key, o.object_type,
        b.path AS before_path, b.label AS before_label, b.value_text AS before_value, b.anchor_json AS before_anchor,
        a.path AS after_path, a.label AS after_label, a.value_text AS after_value, a.anchor_json AS after_anchor
      FROM object_changes c
      JOIN scientific_objects o ON o.id = c.object_id
      LEFT JOIN scientific_object_versions b ON b.id = c.before_version_id
      LEFT JOIN scientific_object_versions a ON a.id = c.after_version_id
      WHERE c.snapshot_id = ?
      ORDER BY COALESCE(a.path, b.path), COALESCE(a.label, b.label), o.object_key
    `).all(snapshotId).map((row) => ({
      objectId: row.object_id,
      objectKey: row.object_key,
      objectType: row.object_type,
      path: row.after_path ?? row.before_path,
      label: row.after_label ?? row.before_label,
      kind: row.kind,
      before: row.before_value ?? null,
      after: row.after_value ?? null,
      anchor: json(row.after_anchor ?? row.before_anchor, null),
    }));
  },
};
