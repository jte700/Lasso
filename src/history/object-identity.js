/**
 * When an object's recorded version still stands, and what kind of change a
 * new one is.
 *
 * A part of a file (a cell, row, variable, passage, slide, line, note or
 * annotation) is the same version for as long as what was recorded about it
 * is: its location, label, value, search text and metadata. An edit elsewhere
 * in its file leaves it alone. An object that is the whole file means the
 * file itself, so its version also follows the file's bytes. Readers give
 * every part an anchor saying where in its file it is, so an object without
 * one is its file: a document, paper, dataset, code file, figure, video or
 * unreadable workbook named as a whole. A drawing's sheet or model has an
 * anchor (its page) but is the drawing.
 */

/** Whether an object of this type and anchor (JSON or parsed) stands for its whole file. */
export function isWholeFileObject(objectType, anchor = null) {
  return anchor == null || objectType === 'DRAWING';
}

/**
 * Whether a stored version row records the same version as these stored
 * fields (see storedFields in object-versions.js). The row's content_hash is
 * compared only for a whole-file object.
 */
export function sameVersion(row, fields, objectType = row.object_type) {
  const [filePath, anchor, label, value, searchText, contentHash, metadata] = fields;
  return row.path === filePath && row.anchor_json === anchor && row.label === label
    && (row.value_text ?? null) === value && row.search_text === searchText && row.metadata_json === metadata
    && (!isWholeFileObject(objectType, anchor) || row.content_hash === contentHash);
}

/**
 * What a new version of an object is, given the version it replaces (null
 * when the object is new): 'added', 'moved' when only where it is changed
 * (its anchor or path, and the metadata and search text that repeat them),
 * or 'modified'.
 */
export function changeKind(before, fields, objectType) {
  if (!before) return 'added';
  const [filePath, anchor, label, value, , contentHash] = fields;
  const relocated = before.path !== filePath || before.anchor_json !== anchor;
  const sameMeaning = before.label === label && (before.value_text ?? null) === value
    && (!isWholeFileObject(objectType, anchor) || before.content_hash === contentHash);
  return relocated && sameMeaning ? 'moved' : 'modified';
}
