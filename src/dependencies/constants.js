// Limits, versions and sets that several dependency modules share.

export const OBJECT_TYPES = new Set([
  'REFERENCE', 'PAPER', 'RESULT', 'VALUE', 'CODE', 'CODE_BLOCK', 'CODE_LINE',
  'NOTEBOOK_CELL', 'DATASET', 'DATASET_ROW', 'DATASET_VALUE', 'TABLE', 'FIGURE', 'METHOD', 'MODEL',
  'PARAMETER', 'PROTOCOL', 'ANALYSIS_RUN', 'DOCUMENT', 'VARIABLE', 'DRAWING', 'DRAWING_ANNOTATION',
]);

/** The types workspace suggestions retrieve by their own words. */
export const RETRIEVABLE_TYPES = new Set([
  'VARIABLE', 'RESULT', 'VALUE', 'DATASET_ROW', 'DATASET_VALUE', 'DATASET', 'METHOD', 'MODEL',
  'PARAMETER', 'PROTOCOL', 'ANALYSIS_RUN', 'FIGURE', 'TABLE', 'DOCUMENT',
  'DRAWING_ANNOTATION',
]);

/** The types a study variable's name can be typed for. */
export const STUDY_DATA_TYPES = new Set(['VARIABLE', 'RESULT', 'VALUE', 'DATASET_ROW', 'DATASET_VALUE', 'TABLE', 'DRAWING_ANNOTATION']);

// A folder with more objects than this at a snapshot is searched through a
// compact index (search-index.js) instead of lists of its mapped objects.
// The suggestion lists count each object at about 1,200 bytes, twice over
// (retrieval and study variables), so past this many they no longer fit the
// 64 MB cache budget together and every keystroke would read them again.
export const SEARCH_INDEX_OBJECTS = 25_000;

// 5: videos are transcribed, so folders indexed before read their videos.
// 6: Word documents' sentences and paragraphs are indexed as passages.
export const INDEX_VERSION = 6;
// The object types a whole file can be named as while typing.
export const WHOLE_FILE_TYPES = ['DRAWING', 'DATASET', 'DOCUMENT', 'PAPER', 'CODE_BLOCK', 'MODEL'];

// The reader that turns file bytes into indexed objects. Bumped whenever
// extraction changes what it reads out of unchanged files, so a project indexed
// by an older build can be offered a re-read. A snapshot records the version
// that produced its objects in snapshot_object_indexes.extractor_version; 0
// there means a build that recorded none.
// 2: notes written below a table are read as text, not as rows of the table.
// 3: a row label outside column A is no longer also read as a cell of its
//    own row.
// 4: worksheet cells are anchored at their sheet row, and statements with
//    year columns read their indented labels as rows.
// 5: all eligible files remain indexed in large folders, and ordinary STEP
//    feature groups are no longer discarded by small per-kind limits.
// 6: worksheets and delimited files of any size are read whole into the
//    table index; those past the in-memory limit were skipped or cut short.
// 8: a deck's slide titles, short lines, table rows and charts are offered,
//    not only its sentences.
// 9: a table's rows are keyed by their label (or, without one, by a token
//    kept from the file's previous version), its columns by their name and
//    its notes by their text, not by row number or column index.
export const EXTRACTOR_VERSION = 9;

// The reader whose PDF text the text store keeps (text-store.js). It moves
// only when PDF text is read differently, so a reader change elsewhere does
// not throw away every PDF's stored text.
export const PDF_TEXT_VERSION = 8;

export const MAX_INDEXED_TABLE_ROWS = 1_000;

// The suggestions a card offers. A linked source's values (a column's, a
// row's cells, a part's measurements) are listed whole, up to the second
// limit; past it, typing a value's first digits brings it to the top.
export const SUGGESTIONS_SHOWN = 12;
export const LINKED_VALUES_SHOWN = 100;

// What a code line's key starts with, after its file's id; recorded so later readings keep it.
export const CODE_LINES_KEY = 'lines';
