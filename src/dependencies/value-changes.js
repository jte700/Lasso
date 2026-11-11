// Which suggested values changed recently, and from what, so the suggestion
// card can say "19,250 · was 18,400". One fact per place, and only about
// values that changed since the user last used their file, or in the last
// few days, whichever is shorter. Read from the change records each index
// writes (object_changes, see history/object-versions.js).

import { BoundedCache } from '../cache.js';
import { comparableNumber, numericDescriptor } from './value-match.js';

// A value that changed longer ago than this is not called out.
export const CHANGE_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
// A typed number is read as an earlier value only when it has at least this many digits.
const MIN_STALE_DIGITS = 2;

const RECENT_CHANGES = `
  SELECT c.object_id, c.snapshot_id, s.created_at, b.value_text AS before_value, a.value_text AS after_value,
    a.id AS after_version_id, a.path, a.metadata_json
  FROM snapshots s
  JOIN object_changes c ON c.snapshot_id = s.id
  JOIN scientific_object_versions a ON a.id = c.after_version_id
  JOIN scientific_object_versions b ON b.id = c.before_version_id
  JOIN scientific_objects o ON o.id = c.object_id
  WHERE s.project_id = ? AND s.created_at >= ? AND s.version <= ? AND c.kind = 'modified'
    AND b.value_text IS NOT a.value_text
    AND NOT (o.object_type = 'VARIABLE' AND COALESCE(json_extract(a.metadata_json, '$.dictionary'), 0) = 0)
  ORDER BY s.version`;

const LAST_ACCEPTED = `SELECT project_file_id, MAX(last_used_at_ms) AS at_ms FROM recommendation_usage
  WHERE project_id = ? AND kind = 'accept' GROUP BY project_file_id`;

/** Whether a stored value is written in `text`, read as a number when it is one. */
function writtenIn(text, value) {
  const stored = String(value ?? '').trim();
  if (!stored) return false;
  if (!numericDescriptor(stored)) return String(text ?? '').toLowerCase().includes(stored.toLowerCase());
  const number = comparableNumber(stored);
  return (String(text ?? '').match(/\d[\d,]*(?:\.\d+)?/g) ?? []).some((written) => comparableNumber(written) === number);
}

export const valueChangeMethods = {
  /**
   * The values that changed in a folder's recent snapshots, up to and
   * including `snapshotId`: objectId -> { previousValue, currentValue,
   * changedAt, snapshotId, versionId, path, formula }. The latest change of
   * each object wins.
   */
  recentValueChanges(projectId, snapshotId, now = Date.now()) {
    this.valueChangeCache ??= new BoundedCache({ maxEntries: 8 });
    const windowStart = now - (this.timeline.config.changeWindowDays ?? CHANGE_WINDOW_DAYS) * DAY_MS;
    const key = `${snapshotId}|${Math.floor(windowStart / DAY_MS)}`;
    const cached = this.valueChangeCache.get(key);
    if (cached) return cached;
    const version = this.db.prepare('SELECT version FROM snapshots WHERE id = ?').get(snapshotId)?.version;
    const changes = new Map();
    if (version != null) {
      for (const row of this.db.prepare(RECENT_CHANGES).all(projectId, new Date(windowStart).toISOString(), version)) {
        changes.set(row.object_id, {
          previousValue: row.before_value, currentValue: row.after_value, changedAt: row.created_at,
          snapshotId: row.snapshot_id, versionId: row.after_version_id, path: row.path,
          formula: Boolean(JSON.parse(row.metadata_json ?? '{}').formula),
        });
      }
    }
    this.valueChangeCache.set(key, changes);
    return changes;
  },

  /**
   * When the user last accepted a suggestion from each file of a folder, by
   * the file's path at `snapshotId`: path -> epoch ms. Kept for a second, so
   * the suggestions of one keystroke read it once.
   */
  lastAcceptedByPath(projectId, snapshotId, now = Date.now()) {
    const key = `${projectId}|${snapshotId}|${Math.floor(now / 1000)}`;
    if (this.lastAccepted?.key === key) return this.lastAccepted.paths;
    const paths = new Map();
    for (const row of this.db.prepare(LAST_ACCEPTED).all(projectId)) {
      const file = this.timeline.snapshotFileById(snapshotId, row.project_file_id);
      if (file) paths.set(file.path, row.at_ms);
    }
    this.lastAccepted = { key, paths };
    return paths;
  },

  /**
   * The change to show beside a suggested object, or null: its value changed
   * since the user last accepted its file, or within the change window,
   * whichever is shorter, and the suggestion offers the value it changed to.
   */
  suggestionChange(projectId, snapshotId, object, now = Date.now()) {
    if (!object?.id || object.valueText == null) return null;
    const change = this.recentValueChanges(projectId, snapshotId, now).get(object.id);
    if (!change || change.currentValue !== object.valueText) return null;
    const accepted = this.lastAcceptedByPath(projectId, snapshotId, now).get(object.path);
    if (accepted && Date.parse(change.changedAt) <= accepted) return null;
    return {
      kind: change.formula ? 'recalculated' : 'edited',
      previousValue: change.previousValue,
      currentValue: change.currentValue,
      changedAt: change.changedAt,
      snapshotId: change.snapshotId,
    };
  },

  /**
   * Whether `claim` types the value an object had before a recent change,
   * for a source the user has used before, while the sentence does not
   * already hold the current value. Then the suggestion offers to replace
   * the typed value with the current one.
   */
  staleTypedChange(projectId, snapshotId, object, claim, now = Date.now()) {
    const typed = comparableNumber(claim?.value);
    if (typed.replace(/\D/g, '').length < MIN_STALE_DIGITS) return null;
    const change = this.recentValueChanges(projectId, snapshotId, now).get(object.id);
    if (!change || change.currentValue !== object.valueText) return null;
    if (comparableNumber(change.previousValue) !== typed) return null;
    if (writtenIn(claim.text, change.currentValue)) return null;
    if (!this.lastAcceptedByPath(projectId, snapshotId, now).has(object.path)) return null;
    return {
      kind: 'stale-typed',
      previousValue: change.previousValue,
      currentValue: change.currentValue,
      changedAt: change.changedAt,
      snapshotId: change.snapshotId,
    };
  },
};
