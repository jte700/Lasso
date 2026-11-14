// Suggestions for a folder too large to hold as mapped objects. Each search a
// keystroke makes is done in the snapshot's search index (search-index.js),
// and only the objects it finds are read back from their version rows.
//
// A small folder scores every object it holds. Here a search that matches
// tens of thousands of objects (every cell of every "log2fc" column) reads
// back the best of them by what the index knows, up to the limits below, and
// scores those exactly as a small folder would. What is left out could only
// have tied with what is read.

import { runSync } from '../history/work.js';
import { matchKey } from './direct-match.js';
import { mapObjectRow, studyVariable } from './object-descriptors.js';
import { isOfferedObject } from './object-access.js';
import { normalizedRowSearch } from './row-names.js';
import { FLAG, SearchIndexBuilder, TYPE_NAMES, rowKeyOf, typeCode, variableKeyOf } from './search-index.js';
import { normalizedName } from './text-similarity.js';
import { namesMeasuredPart, variableNameMatch } from './variable-match.js';
import { METHOD_TYPES, RESULT_TYPES, retrievalFeatures, retrievalObject, retrievalScore } from './workspace-retrieval.js';
import { dependencyFilePriority } from './file-objects.js';

// Objects sharing typed words that are scored for one sentence.
const WORKSPACE_MATCHES = 256;
// Names matching alike that are looked at for one typed name, the objects
// read for each file and type under a name, and for the name altogether.
const STUDY_NAMES = 160;
const STUDY_SAMPLE = 6;
const STUDY_MATCHES = 3_000;
// Objects read as the values of an accepted source, and as candidates for a claim.
const RELATED_OBJECTS = 1_500;
const CLAIM_OBJECTS = 2_000;
// Objects read back between checks of whether enough have been scored.
const READ_BATCH = 64;

const VARIABLE = typeCode('VARIABLE');
const DATASET_ROW = typeCode('DATASET_ROW');
const DRAWING_ANNOTATION = typeCode('DRAWING_ANNOTATION');
const codesOf = (types) => Uint8Array.from(TYPE_NAMES, (name) => Number(types.has(name)));
const IS_RESULT = codesOf(RESULT_TYPES);
const IS_METHOD = codesOf(METHOD_TYPES);
const near = (left, right) => Math.abs(left - right) < 1e-9;

export const indexedSearchMethods = {
  /** Whether a snapshot holds too many objects to keep as lists, so its search index is used. */
  usesSearchIndex(projectId, snapshotId) {
    let large = this.largeSnapshots.get(snapshotId);
    if (large === undefined) {
      this.ensureIndex(projectId, snapshotId);
      large = this.timeline.objectVersions.indexedCount(snapshotId) > this.timeline.config.searchIndexObjects;
      this.largeSnapshots.set(snapshotId, large);
    }
    return large;
  },

  /** A large snapshot's search index, or null for a snapshot searched through its object lists. */
  searchIndexFor(projectId, snapshotId = null) {
    const target = snapshotId ?? this.timeline.getProject(projectId).currentSnapshotId;
    if (!this.usesSearchIndex(projectId, target)) return null;
    return this.searchIndexCache.get(target) ?? runSync(this.searchIndexSteps(projectId, target));
  },

  /**
   * A snapshot's search index, in steps: the one kept on disk when it still
   * holds the snapshot's objects, otherwise built from its version rows a
   * page at a time and kept.
   */
  *searchIndexSteps(projectId, snapshotId) {
    const cached = this.searchIndexCache.get(snapshotId);
    if (cached) return cached;
    const versions = this.timeline.objectVersions;
    const objectCount = versions.indexedCount(snapshotId);
    let index = this.searchIndexStore.load(projectId, snapshotId, objectCount);
    if (!index) {
      const builder = new SearchIndexBuilder();
      const at = { snapshotId, version: versions.snapshotVersion(snapshotId), hashOf: versions.fileHashes(snapshotId) };
      for (const rows of versions.resolvedPages(snapshotId)) {
        for (const row of rows) {
          if (row.project_id !== projectId) continue;
          const object = mapObjectRow(row, at);
          if (isOfferedObject(object)) builder.add(row, object);
        }
        yield;
      }
      index = yield* builder.finishSteps({ projectId, snapshotId, snapshotVersion: at.version, objectCount });
      this.searchIndexStore.save(index);
    }
    this.searchIndexCache.set(snapshotId, index);
    return index;
  },

  /** Drops a snapshot's search index, in memory and on disk, after its objects change. */
  forgetSearchIndex(snapshotId) {
    const index = this.searchIndexCache.get(snapshotId);
    this.searchIndexCache.delete(snapshotId);
    this.largeSnapshots.delete(snapshotId);
    const projectId = index?.projectId
      ?? this.db.prepare('SELECT project_id FROM snapshots WHERE id = ?').get(snapshotId)?.project_id;
    if (projectId) this.searchIndexStore.remove(projectId, { only: snapshotId });
  },

  /** The objects at positions of a search index, mapped as `objectsAt` maps them. */
  indexedObjectsAt(index, positions) {
    const versions = this.timeline.objectVersions;
    const at = { snapshotId: index.snapshotId, version: index.snapshotVersion,
      hashOf: versions.fileHashes(index.snapshotId) };
    return Array.from(positions, (position) => {
      const rowid = index.rowids[position];
      const key = `${index.snapshotId}|${rowid}`;
      let object = this.indexedObjectCache.get(key);
      if (!object) {
        object = this.mappedObject(versions.rowsByRowid([rowid])[0], at);
        this.indexedObjectCache.set(key, object);
      }
      return object;
    });
  },

  /** The same, as workspace suggestions retrieve them. */
  retrievedAt(index, positions) {
    return this.indexedObjectsAt(index, positions).map(retrievalObject).filter(Boolean);
  },

  /** Which object keys a search index holds as retrievable objects, as `keysOf` says of a list. */
  indexedKeys(index) {
    this.objectByKey ??= this.db.prepare('SELECT id FROM scientific_objects WHERE project_id = ? AND object_key = ?');
    return {
      has: (key) => {
        const object = this.objectByKey.get(index.projectId, key);
        const rowid = object ? this.timeline.objectVersions.versionRowidAt(index.snapshotId, object.id) : null;
        const position = rowid === null ? -1 : index.positionOf(rowid);
        return position >= 0 && index.has(position, FLAG.RETRIEVABLE);
      },
    };
  },

  /**
   * The objects sharing typed words that `scoreOf` accepts, best first by
   * what the index knows of each, until enough are scored.
   */
  indexedWorkspaceMatches(index, { typedWords, clauseWords, lastWord, resultIntent, methodIntent, sampleSizeIntent, minimumScore }, scoreOf) {
    const { count, typeOf, pathOf } = index;
    const shared = new Uint16Array(count);
    for (const word of typedWords) for (const position of index.own.get(word)) shared[position] += 1;
    // A word of the clause being written must be in the object (see workspaceSuggestions).
    const atCaret = new Uint8Array(count);
    for (const word of clauseWords) for (const position of index.own.get(word)) atCaret[position] = 1;
    const endsOnMatch = new Uint8Array(count);
    for (const position of index.own.get(lastWord)) endsOnMatch[position] = 1;
    index.pathPriority ??= index.paths.map((filePath) => dependencyFilePriority({ path: filePath }));
    const estimate = new Float32Array(count);
    const candidates = [];
    for (let position = 0; position < count; position += 1) {
      if (!shared[position] || !atCaret[position]) continue;
      const code = typeOf[position];
      estimate[position] = retrievalScore({
        coverage: shared[position] / typedWords.length, endsOnMatch: endsOnMatch[position] === 1,
        intended: (resultIntent && IS_RESULT[code] === 1) || (methodIntent && IS_METHOD[code] === 1),
        dictionary: index.has(position, FLAG.DICTIONARY),
        rowCount: index.has(position, FLAG.ROW_COUNT) && !sampleSizeIntent,
        identifier: index.has(position, FLAG.IDENTIFIER),
      });
      if (estimate[position] >= 0.34 && estimate[position] >= minimumScore - 1e-6) candidates.push(position);
    }
    const result = typeCode('RESULT');
    candidates.sort((left, right) => estimate[right] - estimate[left]
      || Number(typeOf[right] === result) - Number(typeOf[left] === result)
      || Number(typeOf[right] === VARIABLE) - Number(typeOf[left] === VARIABLE)
      || index.pathPriority[pathOf[right]] - index.pathPriority[pathOf[left]]
      || left - right);
    const scored = [];
    for (let start = 0; start < candidates.length && scored.length < WORKSPACE_MATCHES; start += READ_BATCH) {
      const batch = candidates.slice(start, start + READ_BATCH);
      this.indexedObjectsAt(index, batch).forEach((mapped, at) => {
        const object = retrievalObject(mapped);
        const entry = object && scoreOf(object, shared[batch[at]], endsOnMatch[batch[at]] === 1, retrievalFeatures(object));
        if (entry) scored.push(entry);
      });
    }
    return scored;
  },

  /**
   * The study variables what is typed can name, in index order, with how:
   * what `matchingStudyVariables` finds in a list. Of the cells one file
   * holds under a name, the first few are read, and any with a word typed
   * earlier in the sentence.
   */
  matchingIndexedVariables(index, normalizedQuery, queryWords, contextWords = []) {
    const { names, typeOf, pathOf } = index;
    const matched = [];
    names.forEach((name, id) => {
      const match = variableNameMatch(name, normalizedQuery, queryWords);
      const rank = match.exact ? 4 : match.prefix ? 3 : match.contains ? 2 : match.tokenPrefix ? 1 : 0;
      if (rank) matched.push({ id, match, rank });
    });
    matched.sort((left, right) => right.rank - left.rank || names[left.id].variable.localeCompare(names[right.id].variable));
    let inContext = null;
    if (contextWords.length) {
      inContext = new Uint8Array(index.count);
      for (const word of contextWords) for (const position of index.own.get(matchKey(word))) inContext[position] = 1;
    }
    const chosen = new Map();
    for (const { id, match, rank } of matched.slice(0, STUDY_NAMES)) {
      if (chosen.size >= STUDY_MATCHES) break;
      const read = new Map();
      for (const position of index.positionsNamed(id)) {
        const code = typeOf[position];
        // Words that only begin words of a name abbreviate a column or a row, never a value.
        if (rank === 1 && code !== VARIABLE && code !== DATASET_ROW) continue;
        const group = pathOf[position] * TYPE_NAMES.length + code;
        const taken = read.get(group) ?? 0;
        if (taken >= STUDY_SAMPLE && !inContext?.[position]) continue;
        read.set(group, taken + 1);
        chosen.set(position, { ...match, partMeasurement: false });
        if (chosen.size >= STUDY_MATCHES) break;
      }
    }
    for (const { position, part } of index.parts) {
      if (part[0] !== queryWords[0] || chosen.has(position) || chosen.size >= STUDY_MATCHES) continue;
      const name = names[index.nameOf[position]];
      if (!namesMeasuredPart(name, queryWords, part)) continue;
      const match = variableNameMatch(name, normalizedQuery, queryWords);
      chosen.set(position, { ...match, partMeasurement: !match.exact && !match.prefix && !match.contains });
    }
    const positions = [...chosen.keys()].sort((left, right) => left - right);
    const objects = this.indexedObjectsAt(index, positions);
    return positions.flatMap((position, at) => {
      const object = retrievalObject(objects[at]);
      return object ? [{ object: studyVariable(object), match: chosen.get(position) }] : [];
    });
  },

  /**
   * The retrievable objects that can be values of an accepted source: every
   * object `valuesFromLinkedProjectObject` could relate to it, and the data
   * dictionaries' variables, in index order. The source's own file comes first.
   */
  relatedIndexedObjects(index, source, variableKey, { wholeDrawing, namedRow, sourceRow }) {
    const { count, typeOf, pathOf } = index;
    const sourcePath = index.pathIds.get(source.path) ?? -1;
    const inFile = (accept) => {
      const positions = [];
      for (let position = 0; position < count; position += 1) {
        if (pathOf[position] === sourcePath && accept(position)) positions.push(position);
      }
      return positions;
    };
    const rowName = normalizedRowSearch(sourceRow);
    const related = wholeDrawing ? inFile((position) => typeOf[position] === DRAWING_ANNOTATION)
      : !namedRow ? [...index.keys.get(variableKeyOf(variableKey))]
        : rowName ? [...index.keys.get(rowKeyOf(rowName))].filter((position) => pathOf[position] === sourcePath)
          : inFile(() => true);
    const chosen = new Set([...related.filter((position) => pathOf[position] === sourcePath),
      ...related.filter((position) => pathOf[position] !== sourcePath)].slice(0, RELATED_OBJECTS));
    for (let position = 0; position < count; position += 1) {
      if (typeOf[position] === VARIABLE && index.has(position, FLAG.DICTIONARY)) chosen.add(position);
    }
    return this.retrievedAt(index, [...chosen].filter((position) => index.has(position, FLAG.RETRIEVABLE))
      .sort((left, right) => left - right));
  },

  /**
   * The objects of `types` that can back a claim: those whose value is the
   * claim's number, that are of its variable, or that share its words, best
   * first by those, with every variable (for definitions) and whole PDF.
   * A set of types small enough is read whole, as `objectsAt` reads it.
   */
  claimIndexedObjects(index, { types, claimNumber, claimWords, entity, expectedVariable, expectedVariableWords, sourcePath, changedIds }) {
    const { count, typeOf, pathOf, numberOf } = index;
    const ofType = types.size ? codesOf(types) : null;
    const onlyPath = sourcePath ? index.pathIds.get(sourcePath) ?? -2 : -1;
    const allowed = [];
    for (let position = 0; position < count; position += 1) {
      if ((!ofType || ofType[typeOf[position]] === 1) && (onlyPath === -1 || pathOf[position] === onlyPath)) allowed.push(position);
    }
    if (allowed.length <= CLAIM_OBJECTS) return this.indexedObjectsAt(index, allowed);
    const score = new Float32Array(count);
    if (claimNumber) {
      const typed = Math.abs(claimNumber.number);
      for (const position of allowed) {
        const value = Math.abs(numberOf[position]);
        // The forms valueMatch reads a number in: as written, as a percent, as a fold change.
        if (near(value, typed) || near(value / 100, typed) || near(value * 100, typed)
          || near(value, 1 + typed / 100) || near(value, 1 - typed / 100)) score[position] += 0.56;
      }
    }
    const exactVariable = new Uint8Array(count);
    if (expectedVariable) for (const position of index.keys.get(variableKeyOf(expectedVariable))) exactVariable[position] = 1;
    const wordHits = (words) => {
      const hits = new Uint16Array(count);
      for (const word of words) for (const position of index.text.get(word)) hits[position] += 1;
      const ofPath = index.pathWords.map((pathWords) => words.filter((word) => pathWords.includes(word)).length);
      return (position) => (hits[position] + ofPath[pathOf[position]]) / Math.max(2, words.length);
    };
    const shares = claimWords.length ? wordHits(claimWords) : () => 0;
    const sharesVariable = expectedVariableWords.length ? wordHits(expectedVariableWords) : () => 0;
    const named = new Uint8Array(count);
    const expectedName = normalizedName(entity ?? '');
    if (expectedName.length >= 2) {
      // A name being typed begins a word of the object, or a whole word of it begins the name.
      for (const token of index.text.tokens) {
        const actual = normalizedName(token);
        if (actual.startsWith(expectedName) || (actual.length >= 3 && expectedName.startsWith(actual))) {
          for (const position of index.text.get(token)) named[position] = 1;
        }
      }
    }
    const chosen = new Set();
    const scoring = [];
    for (const position of allowed) {
      score[position] += (exactVariable[position] ? 0.48 : 0.48 * sharesVariable(position))
        + 0.2 * Math.max(shares(position), named[position] * 0.82);
      if (score[position] > 0) scoring.push(position);
      if (typeOf[position] === VARIABLE || index.has(position, FLAG.WHOLE_PDF)) chosen.add(position);
    }
    scoring.sort((left, right) => score[right] - score[left] || left - right);
    for (const position of scoring.slice(0, CLAIM_OBJECTS)) chosen.add(position);
    for (const objectId of changedIds) {
      const rowid = this.timeline.objectVersions.versionRowidAt(index.snapshotId, objectId);
      const position = rowid === null ? -1 : index.positionOf(rowid);
      if (position >= 0 && (!ofType || ofType[typeOf[position]] === 1)) chosen.add(position);
    }
    return this.indexedObjectsAt(index, [...chosen].sort((left, right) => left - right));
  },
};
