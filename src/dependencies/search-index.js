// A large folder's objects as columns of numbers: what suggestions search
// while typing, kept without the objects themselves.
//
// A mapped object takes about a kilobyte, so a folder of 150,000 cannot be
// held within the cache budget, and reading them back on each keystroke takes
// seconds. This index keeps, for every object at a snapshot, only what finds
// it: where its version row is, its type and file, the words it can be
// matched by, the name it is typed by, its number. That is about 100 bytes an
// object. A keystroke searches the columns and reads back only the rows it
// offers (indexed-search.js). Positions are in the order `resolved` lists
// objects, so ties fall as they do in a folder small enough to hold.

import { compareText } from '../history/text-order.js';
import { OBJECT_TYPES, STUDY_DATA_TYPES } from './constants.js';
import { studyVariable } from './object-descriptors.js';
import { normalizedRowSearch } from './row-names.js';
import { humanVariable, normalizedVariable } from './tabular.js';
import { variableTokens, wordTokens } from './text-similarity.js';
import { measurementDescriptor } from './value-match.js';
import { measuredPartWords } from './variable-match.js';
import { isPassageExcerpt } from './workspace-completion.js';
import { retrievalFeatures, retrievalObject } from './workspace-retrieval.js';

/** Bumped when what the index holds changes, so a kept file from before is built again. */
export const SEARCH_INDEX_VERSION = 1;

/** Types by number, in the order `resolved` sorts their names. */
export const TYPE_NAMES = Object.freeze([...OBJECT_TYPES].sort(compareText));
const TYPE_CODES = new Map(TYPE_NAMES.map((name, code) => [name, code]));
export const typeCode = (name) => TYPE_CODES.get(name) ?? -1;

export const FLAG = Object.freeze({
  RETRIEVABLE: 1, IDENTIFIER: 2, DICTIONARY: 4, ROW_COUNT: 8, WHOLE_PDF: 16,
});

/** How a key of the `keys` column is told apart: a variable or column name, or a row's name. */
export const variableKeyOf = (key) => `v:${key}`;
export const rowKeyOf = (key) => `r:${key}`;

// Entries sorted at once; larger lists are sorted in runs and merged, a step each.
const SORT_RUN = 8_192;
const EMPTY = new Int32Array(0);
// About what a string kept in a table takes besides its letters.
const STRING_OVERHEAD_BYTES = 64;

const stringBytes = (strings) => strings.reduce((bytes, text) => bytes + text.length * 2 + STRING_OVERHEAD_BYTES, 0);

function wordSuffixes(words) {
  return words.map((_, index) => words.slice(index).join(''));
}

/** A study variable's name as typed words are matched against it (see variableNameMatch). */
function nameEntry(variable) {
  const variableWords = variableTokens(humanVariable(variable));
  return { variable, normalizedVariable: normalizedVariable(variable), variableWords, wordSuffixes: wordSuffixes(variableWords) };
}

/** For each token, the positions that have it, ascending: one array of positions and where each token's begin. */
export class Postings {
  constructor(tokens, offsets, positions) {
    this.tokens = tokens;
    this.offsets = offsets;
    this.positions = positions;
    this.ids = new Map(tokens.map((token, id) => [token, id]));
  }

  get(token) {
    const id = this.ids.get(token);
    return id === undefined ? EMPTY : this.positions.subarray(this.offsets[id], this.offsets[id + 1]);
  }

  get bytes() { return this.offsets.byteLength + this.positions.byteLength + stringBytes(this.tokens); }
}

/** Each entry's tokens as they are read, before entries have their positions. */
class TokenLists {
  constructor() {
    this.tokens = [];
    this.ids = new Map();
    this.flat = [];
    this.starts = [0];
  }

  add(tokens) {
    for (const token of tokens) {
      let id = this.ids.get(token);
      if (id === undefined) {
        id = this.tokens.length;
        this.ids.set(token, id);
        this.tokens.push(token);
      }
      this.flat.push(id);
    }
    this.starts.push(this.flat.length);
  }

  /** The postings once `order[position]` says which entry each position holds. */
  postings(order) {
    const offsets = new Int32Array(this.tokens.length + 1);
    for (const id of this.flat) offsets[id + 1] += 1;
    for (let id = 0; id < this.tokens.length; id += 1) offsets[id + 1] += offsets[id];
    const next = offsets.slice(0, this.tokens.length);
    const positions = new Int32Array(this.flat.length);
    for (let position = 0; position < order.length; position += 1) {
      const entry = order[position];
      for (let at = this.starts[entry]; at < this.starts[entry + 1]; at += 1) positions[next[this.flat[at]]++] = position;
    }
    return new Postings(this.tokens, offsets, positions);
  }
}

/**
 * `order` sorted by `compare`, in steps: runs are sorted, then merged in
 * pairs, so sorting a large folder's entries never holds the event loop long.
 */
function* sortedSteps(order, compare) {
  let runs = [];
  for (let start = 0; start < order.length; start += SORT_RUN) {
    runs.push(order.slice(start, start + SORT_RUN).sort(compare));
    yield;
  }
  while (runs.length > 1) {
    const merged = [];
    for (let index = 0; index < runs.length; index += 2) {
      const left = runs[index];
      const right = runs[index + 1];
      if (!right) { merged.push(left); continue; }
      const out = new Int32Array(left.length + right.length);
      let a = 0;
      let b = 0;
      let at = 0;
      while (a < left.length && b < right.length) out[at++] = compare(left[a], right[b]) <= 0 ? left[a++] : right[b++];
      out.set(left.subarray(a), at);
      out.set(right.subarray(b), at + left.length - a);
      merged.push(out);
      yield;
    }
    runs = merged;
  }
  return runs[0] ?? new Int32Array(0);
}

/** The columns of one snapshot's objects, and the lookups a keystroke makes in them. */
export class SnapshotSearchIndex {
  constructor(fields) {
    Object.assign(this, fields);
    this.count = this.rowids.length;
    this.pathIds = new Map(this.paths.map((filePath, id) => [filePath, id]));
    this.names = this.variables.map(nameEntry);
    this.bytes = [this.rowids, this.typeOf, this.pathOf, this.flags, this.numberOf, this.nameOf, this.nameOffsets,
      this.namePositions].reduce((bytes, column) => bytes + column.byteLength, 0)
      + this.own.bytes + this.text.bytes + this.keys.bytes + stringBytes(this.paths) + stringBytes(this.variables) * 3
      + this.pathWords.reduce((bytes, words) => bytes + stringBytes(words), 0);
    this.byRowid = null;
  }

  /** The positions of the objects typed by a name of `names`. */
  positionsNamed(nameId) {
    return this.namePositions.subarray(this.nameOffsets[nameId], this.nameOffsets[nameId + 1]);
  }

  /** Where the object of a version row is, or -1 when the index does not hold it. */
  positionOf(rowid) {
    // Positions by rowid, worked out the first time one is asked for.
    this.byRowid ??= Int32Array.from(this.rowids.keys()).sort((left, right) => this.rowids[left] - this.rowids[right]);
    let low = 0;
    let high = this.count - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const found = this.rowids[this.byRowid[middle]];
      if (found === rowid) return this.byRowid[middle];
      if (found < rowid) low = middle + 1;
      else high = middle - 1;
    }
    return -1;
  }

  has(position, flag) { return (this.flags[position] & flag) !== 0; }
}

/** Reads objects into columns as their rows arrive, in any order, then puts them in `resolved` order. */
export class SearchIndexBuilder {
  constructor() {
    this.rowids = [];
    this.objectRowids = [];
    this.labels = [];
    this.types = [];
    this.pathOf = [];
    this.flags = [];
    this.numbers = [];
    this.nameOf = [];
    this.paths = [];
    this.pathIds = new Map();
    this.pathWords = [];
    this.variables = [];
    this.variableIds = new Map();
    this.parts = [];
    this.own = new TokenLists();
    this.text = new TokenLists();
    this.keys = new TokenLists();
  }

  pathId(filePath) {
    let id = this.pathIds.get(filePath);
    if (id === undefined) {
      id = this.paths.length;
      this.pathIds.set(filePath, id);
      this.paths.push(filePath);
      this.pathWords.push(wordTokens(filePath));
    }
    return id;
  }

  /** Adds an offered object and the version row it was mapped from. */
  add(row, object) {
    const entry = this.rowids.length;
    const metadata = object.metadata;
    const retrieved = retrievalObject(object);
    const pathId = this.pathId(object.path);
    let flags = 0;
    if (retrieved) flags |= FLAG.RETRIEVABLE;
    if (retrieved && retrievalFeatures(object).identifier) flags |= FLAG.IDENTIFIER;
    if (metadata.dictionary) flags |= FLAG.DICTIONARY;
    if (metadata.metric === 'row-count') flags |= FLAG.ROW_COUNT;
    if (/\.pdf$/i.test(object.path) && ['PAPER', 'DRAWING', 'DOCUMENT'].includes(object.objectType)
      && !isPassageExcerpt(object)) flags |= FLAG.WHOLE_PDF;
    this.rowids.push(row.version_rowid);
    this.objectRowids.push(row.object_rowid);
    this.labels.push(row.label);
    this.types.push(typeCode(object.objectType));
    this.pathOf.push(pathId);
    this.flags.push(flags);
    this.numbers.push(measurementDescriptor(object.valueText)?.number ?? Number.NaN);
    this.own.add(retrieved ? retrieved.retrievalTokens : []);
    // A file's path is in every one of its objects' search text; its words are kept once, with the path.
    const ofPath = this.pathWords[pathId];
    this.text.add(wordTokens(`${object.label} ${row.search_text}`).filter((word) => !ofPath.includes(word)));
    const variable = normalizedVariable(metadata.variable ?? metadata.column);
    const rowName = normalizedRowSearch(object.anchor?.rowKey ?? metadata.row);
    this.keys.add([...new Set([variable, normalizedVariable(metadata.column), normalizedVariable(metadata.section)]
      .filter(Boolean).map(variableKeyOf)), ...(rowName ? [rowKeyOf(rowName)] : [])]);
    this.nameOf.push(retrieved && STUDY_DATA_TYPES.has(object.objectType) ? this.nameId(entry, object) : -1);
  }

  /** The name a study variable is typed by, or -1 for an object that has none. */
  nameId(entry, object) {
    const named = studyVariable(object);
    if (!named.variable || !/[A-Za-z]/.test(named.variable)) return -1;
    let id = this.variableIds.get(named.variable);
    if (id === undefined) {
      id = this.variables.length;
      this.variableIds.set(named.variable, id);
      this.variables.push(named.variable);
    }
    const part = measuredPartWords(named);
    if (part.length) this.parts.push({ entry, part });
    return id;
  }

  /** The finished index, in steps. */
  *finishSteps(identity) {
    const { labels, types, objectRowids } = this;
    const order = yield* sortedSteps(Int32Array.from(types.keys()), (left, right) => types[left] - types[right]
      || compareText(labels[left], labels[right]) || objectRowids[left] - objectRowids[right]);
    const column = (Kind, values) => {
      const out = new Kind(order.length);
      for (let position = 0; position < order.length; position += 1) out[position] = values[order[position]];
      return out;
    };
    const nameOf = column(Int32Array, this.nameOf);
    const nameOffsets = new Int32Array(this.variables.length + 1);
    for (const id of nameOf) if (id >= 0) nameOffsets[id + 1] += 1;
    for (let id = 0; id < this.variables.length; id += 1) nameOffsets[id + 1] += nameOffsets[id];
    const next = nameOffsets.slice(0, this.variables.length);
    const namePositions = new Int32Array(nameOffsets[this.variables.length]);
    nameOf.forEach((id, position) => { if (id >= 0) namePositions[next[id]++] = position; });
    yield;
    const positionOfEntry = new Int32Array(order.length);
    order.forEach((entry, position) => { positionOfEntry[entry] = position; });
    const own = this.own.postings(order);
    yield;
    const text = this.text.postings(order);
    yield;
    const keys = this.keys.postings(order);
    yield;
    return new SnapshotSearchIndex({
      ...identity,
      rowids: column(Float64Array, this.rowids), typeOf: column(Uint8Array, this.types),
      pathOf: column(Int32Array, this.pathOf), flags: column(Uint8Array, this.flags),
      numberOf: column(Float64Array, this.numbers), nameOf, nameOffsets, namePositions,
      paths: this.paths, pathWords: this.pathWords, variables: this.variables,
      parts: this.parts.map(({ entry, part }) => ({ position: positionOfEntry[entry], part }))
        .sort((left, right) => left.position - right.position),
      own, text, keys,
    });
  }
}
