// Limits, versions and sets that several dependency modules share.

export const OBJECT_TYPES = new Set([
  'REFERENCE', 'PAPER', 'RESULT', 'VALUE', 'CODE', 'CODE_BLOCK', 'CODE_LINE',
  'NOTEBOOK_CELL', 'DATASET', 'DATASET_ROW', 'DATASET_VALUE', 'TABLE', 'FIGURE', 'METHOD', 'MODEL',
  'PARAMETER', 'PROTOCOL', 'ANALYSIS_RUN', 'DOCUMENT', 'VARIABLE', 'DRAWING', 'DRAWING_ANNOTATION',
]);

// 5: videos are transcribed, so folders indexed before read their videos.
export const INDEX_VERSION = 5;
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
export const EXTRACTOR_VERSION = 8;

export const MAX_INDEXED_TABLE_ROWS = 1_000;

// The suggestions a card offers. A linked source's values (a column's, a
// row's cells, a part's measurements) are listed whole, up to the second
// limit; past it, typing a value's first digits brings it to the top.
export const SUGGESTIONS_SHOWN = 12;
export const LINKED_VALUES_SHOWN = 100;

// What a code line's key starts with, after its file's id; recorded so later readings keep it.
export const CODE_LINES_KEY = 'lines';
