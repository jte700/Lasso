// Which objects' values or locations changed, compared inside SQLite. The
// server and the worker that reads value history off its thread read it the
// same way.

/** The newest version row. Versions are only added, so it marks how far a reading got. */
export const NEWEST_VERSION = 'SELECT MAX(rowid) AS rowid FROM scientific_object_versions';

/**
 * `{ newest, ids }`: the newest version row, and the objects matching `filter`
 * (versions as x, objects as o) with a version whose value or location
 * differs from the version before it. With `since`, a version row, only the
 * objects recorded after it are compared. An object found to have changed
 * always has, so those found before stay found.
 */
export function readChangedObjects(db, filter, parameters, since = null) {
  const newest = db.prepare(NEWEST_VERSION).get().rowid ?? 0;
  let scope = filter;
  let scopeParameters = parameters;
  // A whole folder is read through its objects. The few objects recorded
  // since are read from their versions, so CROSS JOIN pins x first.
  let objectJoin = 'JOIN';
  if (since !== null) {
    // NOT INDEXED reads the new rows by rowid rather than scanning an index.
    const recorded = db.prepare(`SELECT DISTINCT x.object_id FROM scientific_object_versions x NOT INDEXED
      CROSS JOIN scientific_objects o ON o.id = x.object_id WHERE x.rowid > ? AND (${filter})`)
      .all(since, ...parameters).map((row) => row.object_id);
    if (!recorded.length) return { newest, ids: [] };
    scope = `(${filter}) AND x.object_id IN (SELECT value FROM json_each(?))`;
    scopeParameters = [...parameters, JSON.stringify(recorded)];
    objectJoin = 'CROSS JOIN';
  }
  const ids = db.prepare(`SELECT DISTINCT object_id FROM (
      SELECT x.object_id, x.value_text, x.path,
        LAG(x.value_text) OVER versions AS previous_value, LAG(x.path) OVER versions AS previous_path
      FROM scientific_object_versions x ${objectJoin} scientific_objects o ON o.id = x.object_id
      JOIN snapshots s ON s.id = x.snapshot_id
      WHERE ${scope}
      WINDOW versions AS (PARTITION BY x.object_id ORDER BY s.version))
    WHERE previous_path IS NOT NULL AND (value_text IS NOT previous_value OR path IS NOT previous_path)`)
    .all(...scopeParameters).map((row) => row.object_id);
  return { newest, ids };
}
