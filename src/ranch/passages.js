// The passages of a text or PDF file that one version changed, for The
// Ranch's text and PDF viewers to tint with what they were, the way
// sheets.js names a workbook's changed cells. A passage edited in its own
// words is a new passage that replaces the old one (passage_successions);
// one changed in place keeps its object and records a modified version.

const PASSAGE_ANCHORS = new Set(['text-excerpt', 'pdf-excerpt']);

const CHANGED_PASSAGES = `
  SELECT a.anchor_json, b.value_text AS before_value, a.value_text AS after_value, sn.created_at
  FROM passage_successions s
  JOIN object_changes c ON c.snapshot_id = s.snapshot_id AND c.object_id = s.object_id
  JOIN scientific_object_versions a ON a.id = c.after_version_id
  JOIN scientific_object_versions b ON b.id = s.replaces_version_id
  JOIN snapshots sn ON sn.id = s.snapshot_id
  WHERE s.snapshot_id = ? AND a.path = ? AND b.value_text IS NOT a.value_text
  UNION ALL
  SELECT a.anchor_json, b.value_text, a.value_text, sn.created_at
  FROM object_changes c
  JOIN scientific_object_versions a ON a.id = c.after_version_id
  JOIN scientific_object_versions b ON b.id = c.before_version_id
  JOIN snapshots sn ON sn.id = c.snapshot_id
  WHERE c.snapshot_id = ? AND c.kind = 'modified' AND a.path = ? AND b.value_text IS NOT a.value_text
    AND json_extract(a.anchor_json, '$.kind') IN ('text-excerpt', 'pdf-excerpt')`;

/**
 * The passages one snapshot's index changed in a file: { kind, pageNumber,
 * start, end, lineStart, lineEnd, before, after, changedAt }, where start and
 * end are offsets in a text file's characters and pageNumber a PDF's page.
 */
export function passageChanges(db, snapshotId, filePath) {
  return db.prepare(CHANGED_PASSAGES).all(snapshotId, filePath, snapshotId, filePath).flatMap((row) => {
    const anchor = JSON.parse(row.anchor_json ?? 'null');
    if (!PASSAGE_ANCHORS.has(anchor?.kind)) return [];
    const number = (value) => (Number.isInteger(value) ? value : null);
    return [{
      kind: anchor.kind, pageNumber: number(anchor.pageNumber), start: number(anchor.start), end: number(anchor.end),
      lineStart: number(anchor.lineStart), lineEnd: number(anchor.lineEnd),
      before: row.before_value, after: row.after_value, changedAt: row.created_at,
    }];
  });
}
