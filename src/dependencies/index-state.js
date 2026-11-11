// Whether a snapshot's object index was made by the current reader, and how
// data dictionaries are applied to the variables it holds.

import { normalizedVariable } from './tabular.js';
import { EXTRACTOR_VERSION, INDEX_VERSION } from './constants.js';

// Which kinds of file each reader version reads differently from the one
// before it, so a reader upgrade re-reads only those. A version missing here
// changed more than a few kinds, and a folder it is new to is read whole.
const READER_CHANGES = new Map([[6, new Set(['table', 'spreadsheet'])], [7, new Set(['presentation', 'code', 'yaml'])],
  [8, new Set(['presentation'])], [9, new Set(['table', 'spreadsheet'])]]);

export function kindsChangedSince(version) {
  if (!Number.isInteger(version) || version < 1) return null;
  const kinds = new Set();
  for (let next = version + 1; next <= EXTRACTOR_VERSION; next += 1) {
    const changed = READER_CHANGES.get(next);
    if (!changed) return null;
    for (const kind of changed) kinds.add(kind);
  }
  return kinds.size ? kinds : null;
}

/** Worksheet objects name their rows by sheet row number. */
export function worksheetCoordinates(object) {
  object.metadata.spreadsheetExtractionVersion = 2;
  if (object.anchor && Number.isInteger(object.anchor.rowIndex)) object.anchor.rowCoordinate = 'worksheet';
  return object;
}

export function isDictionaryVariable(descriptor) {
  return descriptor.type === 'VARIABLE' && Boolean(descriptor.metadata.dictionary);
}

/**
 * Whether an index row needs no upgrade pass. Version two adds page-anchored
 * PDF sentences and paragraphs to existing imports without changing any
 * previously linked object or version. Version three adds the same passages
 * for Markdown and plain-text files. Version four adds STEP CAD models.
 * Spreadsheet version two records worksheet row coordinates under new keys.
 */
export function indexIsCurrent(indexed) {
  return Boolean(indexed?.indexed && indexed.drawing_index_version >= INDEX_VERSION && indexed.spreadsheet_index_version >= 2);
}

/** What a later index needs to carry these files' objects forward. */
export function indexSummary(counts, problems, definitions, truncated) {
  const problemsByPath = new Map();
  for (const problem of problems) problemsByPath.set(problem.path, [...(problemsByPath.get(problem.path) ?? []), problem]);
  return {
    truncated, counts, definitions, problems: problemsByPath,
    dictionaryPaths: new Set(definitions.map((definition) => definition.path)),
  };
}

/** `sources` are the dictionary variables in index order, from every indexed file. */
export function applyVariableDefinitions(descriptors, sources = descriptors) {
  const definitions = new Map();
  for (const descriptor of sources) {
    if (!isDictionaryVariable(descriptor)) continue;
    const key = normalizedVariable(descriptor.metadata.variable);
    if (key && !definitions.has(key)) definitions.set(key, descriptor);
  }
  for (const descriptor of descriptors) {
    if (descriptor.metadata.dictionary) continue;
    const key = normalizedVariable(descriptor.metadata.variable ?? descriptor.metadata.column);
    const definition = definitions.get(key);
    if (!definition) continue;
    descriptor.metadata = {
      ...descriptor.metadata,
      definition: definition.metadata.description,
      units: definition.metadata.units ?? descriptor.metadata.units ?? null,
      dictionaryPath: definition.path,
    };
    descriptor.searchText += ` ${definition.label} ${definition.value ?? ''} ${definition.metadata.units ?? ''}`.toLowerCase();
  }
}
