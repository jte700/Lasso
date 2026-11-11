// Source objects as described when read from a file, stored in the index and
// read back: descriptors with their search text, anchors, and mapped rows.

import { json } from '../db.js';
import { correctedDocumentLabel } from './authors.js';
import { humanVariable, normalizedVariable } from './tabular.js';
import { sha } from './basics.js';
import { OBJECT_TYPES } from './constants.js';
import { variableTokens } from './text-similarity.js';
import { isIdentifierRow } from './variable-match.js';

export function anchorForSpan(blockIndex, blockType, blockText, start, end) {
  return {
    kind: 'manuscript-span',
    blockIndex,
    blockType,
    start,
    end,
    prefix: blockText.slice(Math.max(0, start - 32), start),
    suffix: blockText.slice(end, Math.min(blockText.length, end + 32)),
    blockFingerprint: sha(blockText.trim().replace(/\s+/g, ' ')),
  };
}

export const isTextPassage = (object) => ['PDF_EXCERPT', 'TEXT_EXCERPT'].includes(object.metadata?.componentType);

// Words a person could search for: strings and numbers, never JSON syntax,
// field names, or the literal "true", "false" and "null" of flags.
function searchableValues(value, output = [], depth = 0) {
  if (typeof value === 'string') output.push(value);
  else if (typeof value === 'number' && Number.isFinite(value)) output.push(String(value));
  else if (value && typeof value === 'object' && depth < 4) {
    for (const item of Array.isArray(value) ? value : Object.values(value)) searchableValues(item, output, depth + 1);
  }
  return output;
}

export function objectDescriptor({ key, type, path: filePath, anchor = null, label, value = null, contentHash, metadata = {} }) {
  return {
    key,
    type: OBJECT_TYPES.has(type) ? type : 'RESULT',
    path: filePath,
    anchor,
    label: String(label),
    value: value == null ? null : String(value),
    contentHash,
    metadata,
    searchText: `${label} ${value ?? ''} ${filePath} ${searchableValues(metadata).join(' ')}`.toLowerCase(),
  };
}

/**
 * `at` is the snapshot the row was read at, when the row does not carry it,
 * with `hashOf(path)`, its files' content hashes (ObjectVersionStore.fileHashes).
 * A row that carries its snapshot already carries its file's hash there.
 */
export function mapObjectRow(row, at = { snapshotId: row.snapshot_id, version: row.snapshot_version }) {
  const metadata = json(row.metadata_json, {});
  return {
    id: row.object_id,
    projectId: row.project_id,
    versionId: row.version_id,
    objectKey: row.object_key,
    objectType: row.object_type,
    snapshotId: at.snapshotId,
    snapshotVersion: at.version,
    path: row.path,
    anchor: json(row.anchor_json, null),
    label: correctedDocumentLabel(row.object_type, row.label, metadata),
    valueText: row.value_text,
    contentHash: at.hashOf?.(row.path) ?? row.content_hash,
    metadata,
    searchText: row.search_text,
  };
}

/** A row of a large table not yet recorded as an object, shaped as one for scoring. */
export function pendingObject(projectId, snapshotId, descriptor) {
  return { id: `indexed:${descriptor.key}`, projectId, versionId: null, objectKey: descriptor.key, objectType: descriptor.type,
    snapshotId, snapshotVersion: null, path: descriptor.path, anchor: descriptor.anchor,
    label: correctedDocumentLabel(descriptor.type, descriptor.label, descriptor.metadata), valueText: descriptor.value,
    contentHash: descriptor.contentHash, metadata: descriptor.metadata, searchText: descriptor.searchText };
}

/** An object with the variable a writer names it by, as study-variable suggestions read it. */
export function studyVariable(object) {
  // A row named in a Department or Supplier column ("Facilities") is not
  // a variable, but it is still a name the writer types.
  const namedRow = object.objectType === 'DATASET_ROW' && !object.metadata.variable
    && !isIdentifierRow(object);
  const variable = String(object.metadata.variable ?? object.metadata.column
    ?? (object.objectType === 'VARIABLE' ? object.label : namedRow ? object.metadata.row ?? object.label : '')).trim();
  return {
    ...object,
    namedRow,
    variable,
    normalizedVariable: normalizedVariable(variable),
    variableWords: variableTokens(humanVariable(variable)),
  };
}

export function freezeIndexedValue(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeIndexedValue(child);
  return Object.freeze(value);
}
