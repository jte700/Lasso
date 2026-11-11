// The readers that turn a file's bytes into source objects, one per kind of
// file, each with its own version. An index records the versions that read it
// (snapshot_object_indexes.reader_versions_json), so when one reader improves,
// a re-read reads only that reader's files again and carries the rest.
//
// A reader's `extract` names how its files are read: 'video' from the file
// where it lies (videoObjectSteps), 'table' a batch of rows at a time and off
// the thread when large (tableObjectSteps), 'file' from its bytes in memory
// (objectsFromFile). docs/reader-contract.md describes the step protocol a
// reader in another process would follow.
//
// Bump a reader's version whenever it reads the same bytes differently, and
// add a line saying what changed.

import path from 'node:path';
import { isCodeType } from '../history/file-types.js';
import { isDesignFile } from './drawing-objects.js';

const TEXT_EXTENSIONS = new Set(['.txt', '.bib', '.ris', '.enw', '.nbib']);

/** In the order they are asked: the first that accepts a file reads it. */
export const READERS = Object.freeze([
  { id: 'video', version: 1, extract: 'video', accepts: (file) => file.fileType === 'video' },
  // 2: worksheet cells that hold a formula say so (metadata.formula).
  // 3: so do those of sheets too large to read at once, answered by the table index.
  { id: 'table', version: 3, extract: 'table', accepts: (file) => ['table', 'spreadsheet'].includes(file.fileType) },
  // A PDF is read as a drawing when its pages are drawings, otherwise as a paper.
  { id: 'pdf', version: 1, extract: 'file', accepts: (file) => file.fileType === 'pdf' },
  { id: 'design', version: 1, extract: 'file', accepts: (file) => isDesignFile(file) },
  { id: 'document', version: 1, extract: 'file', accepts: (file) => file.fileType === 'document' },
  { id: 'presentation', version: 1, extract: 'file', accepts: (file) => file.fileType === 'presentation' },
  { id: 'code', version: 1, extract: 'file', accepts: (file) => isCodeType(file.fileType) },
  { id: 'notebook', version: 1, extract: 'file', accepts: (file) => file.fileType === 'notebook' },
  { id: 'image', version: 1, extract: 'file', accepts: (file) => file.fileType === 'image' },
  { id: 'json', version: 1, extract: 'file', accepts: (file) => file.fileType === 'json' },
  { id: 'text', version: 1, extract: 'file', accepts: (file) => file.fileType === 'markdown'
    || (file.fileType === 'text' && TEXT_EXTENSIONS.has(path.extname(file.path).toLowerCase())) },
].map(Object.freeze));

// Files no reader above accepts are kept in history but give no objects.
const NO_READER = Object.freeze({ id: 'none', version: 1, extract: 'file', accepts: () => true });

/** The reader of a file. */
export function readerFor(file) {
  return READERS.find((reader) => reader.accepts(file)) ?? NO_READER;
}

/** Every reader's current version, by id: what a new index records. */
export function readerVersions() {
  return Object.fromEntries(READERS.map((reader) => [reader.id, reader.version]));
}

// An index recorded before readers had versions of their own was read by the
// first version of each.
const FIRST_VERSIONS = Object.freeze(Object.fromEntries(READERS.map((reader) => [reader.id, 1])));
const recordedOrFirst = (recorded) => (recorded && typeof recorded === 'object' ? recorded : FIRST_VERSIONS);

/** The readers whose version differs from `recorded`, the versions an index was read with. */
export function readersChangedSince(recorded) {
  const versions = recordedOrFirst(recorded);
  return new Set(READERS.filter((reader) => versions[reader.id] !== reader.version).map((reader) => reader.id));
}

/**
 * The versions that read an index made by reading some files now and carrying
 * the rest from one read with `recorded`: a reader any of whose files were
 * carried keeps its recorded version, so those files are still read again
 * when that reader is behind.
 */
export function readerVersionsAfter(recorded, carriedReaders) {
  const versions = recordedOrFirst(recorded);
  return Object.fromEntries(READERS.map((reader) => [reader.id, carriedReaders.has(reader.id) ? versions[reader.id] : reader.version]));
}
