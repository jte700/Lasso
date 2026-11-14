// Study variables and the rows, columns and parts named while writing, with the
// objects each one brings.

import { humanVariable, normalizedVariable } from './tabular.js';
import { DRAWING_NAME_MIN_LETTERS } from './drawing-discovery.js';
import { fileReferenceMatch, isWholeFile, typedAsWritten } from './file-reference.js';
import { STUDY_DATA_TYPES, WHOLE_FILE_TYPES } from './constants.js';
import { pendingObject, studyVariable } from './object-descriptors.js';
import { rowCompletionFragments } from './row-field-match.js';
import { recommendationRelevanceBand } from './ranking.js';
import { nameFragmentEarnsCard } from './show-gate.js';
import { variableTokens, wordTokens } from './text-similarity.js';
import { measuredPartWords, namesMeasuredPart, variableNameMatch } from './variable-match.js';
import { CONTEXTUAL_INSERTION_CUES, sameDocument } from './workspace-completion.js';
import { FRAGMENT_FUNCTION_WORDS, progressiveVariableFragments, writingSourceContext } from './writing-context.js';

// How much the table index adds to a suggestion: rows matched per table, rows
// shown among the names offered, and cells offered for an accepted source.
const INDEXED_MATCHES_PER_TABLE = 12;
const INDEXED_ROWS_SHOWN = 8;
const INDEXED_RELATED_OBJECTS = 64;

// Words that only say a sentence reports the writer's own work ("these results
// indicate", "in the current analysis we observed") or where data sits ("the
// marketing rows"). They name no data, so they never tell two names apart.
const REPORTING_WORDS = new Set([...CONTEXTUAL_INSERTION_CUES, ...FRAGMENT_FUNCTION_WORDS,
  'current', 'present', 'work', 'studies', 'finding', 'findings', 'outcome', 'outcomes',
  'row', 'rows', 'column', 'columns', 'cell', 'cells', 'record', 'records', 'value', 'values',
  'table', 'tables', 'sheet', 'sheets', 'field', 'fields', 'entry', 'entries']);

function wordSuffixes(words) {
  return words.map((_, index) => words.slice(index).join(''));
}

export const studyVariablesMethods = {
  studyVariables(projectId, snapshotId = null) {
    const project = this.timeline.getProject(projectId);
    const target = snapshotId ?? project.currentSnapshotId;
    if (this.studyVariableCache.has(target)) return this.studyVariableCache.get(target);
    const workspaceObjects = this.workspaceRetrievalCache.get(target);
    const indexed = (workspaceObjects ?? this.objectsAt(projectId, target, STUDY_DATA_TYPES))
      .filter((object) => STUDY_DATA_TYPES.has(object.objectType))
      .map(studyVariable).filter((object) => object.variable && /[A-Za-z]/.test(object.variable));
    this.studyVariableCache.set(target, indexed);
    return indexed;
  },

  /**
   * The names in a list of study variables, kept with the list. Many objects
   * share a name, as every cell of a column does, so what is typed is matched
   * against each name once rather than against every object. Measured parts
   * are found by the first word of the part's name.
   */
  variableIndexOf(objects) {
    let index = this.variableIndexes.get(objects);
    if (index) return index;
    const names = [];
    const byVariable = new Map();
    const nameOf = new Int32Array(objects.length);
    const parts = new Map();
    objects.forEach((object, position) => {
      let name = byVariable.get(object.variable);
      if (name === undefined) {
        name = names.length;
        byVariable.set(object.variable, name);
        names.push({ normalizedVariable: object.normalizedVariable, variableWords: object.variableWords,
          wordSuffixes: wordSuffixes(object.variableWords) });
      }
      nameOf[position] = name;
      const part = measuredPartWords(object);
      if (part.length) {
        if (!parts.has(part[0])) parts.set(part[0], []);
        parts.get(part[0]).push({ position, part });
      }
    });
    index = { names, nameOf, parts };
    this.variableIndexes.set(objects, index);
    return index;
  },

  /** The objects in a list of study variables that what is typed can name, in list order, with how. */
  matchingStudyVariables(objects, normalizedQuery, queryWords) {
    const { names, nameOf, parts } = this.variableIndexOf(objects);
    const matches = names.map((name) => variableNameMatch(name, normalizedQuery, queryWords));
    const measured = new Set((parts.get(queryWords[0]) ?? [])
      .filter(({ position, part }) => namesMeasuredPart(objects[position], queryWords, part))
      .map(({ position }) => position));
    const output = [];
    for (let position = 0; position < objects.length; position += 1) {
      const match = matches[nameOf[position]];
      const partMeasurement = !match.exact && !match.prefix && !match.contains && measured.has(position);
      if (match.exact || match.prefix || match.contains || partMeasurement || match.tokenPrefix) {
        output.push({ object: objects[position], match: { ...match, partMeasurement } });
      }
    }
    return output;
  },

  /** The keys of objects already in a list, kept with the list. */
  keysOf(objects) {
    let keys = this.objectKeySets.get(objects);
    if (!keys) {
      keys = new Set(objects.map((object) => object.objectKey));
      this.objectKeySets.set(objects, keys);
    }
    return keys;
  },

  /**
   * Named rows past the first rows of a snapshot's large tables whose names
   * begin with `query`, or have a word that does: a bounded range scan of the
   * table index, never a pass over the table. They are scored as the
   * indexer's own rows are, and recorded as objects only if they are shown.
   */
  indexedStudyVariables(projectId, snapshotId, query, known) {
    const target = snapshotId ?? this.timeline.getProject(projectId).currentSnapshotId;
    const output = [];
    for (const table of this.snapshotTables(projectId, target)) {
      for (const row of this.tables.search(table.meta.id, query, INDEXED_MATCHES_PER_TABLE)) {
        const descriptor = this.indexedRowObjects(table, row).find((candidate) => candidate.type === 'DATASET_ROW');
        if (!descriptor || known.has(descriptor.key)) continue;
        output.push({ ...studyVariable(pendingObject(projectId, target, descriptor)),
          pendingIndex: { table, descriptor, snapshotId: target } });
      }
    }
    return output;
  },

  /**
   * Rows past the first rows of an accepted source's large table: the source
   * row's own cells, or the rows the words after it begin to name, with the
   * value in the source's column. Found in the table index and recorded as
   * objects to offer.
   */
  indexedRelatedObjects(projectId, source, tail, { variableKey, known }) {
    const ownerId = this.sourceProjectId(source) ?? projectId;
    const sheet = source.metadata.sheet ?? source.anchor?.sheet ?? null;
    const table = this.snapshotTables(ownerId, source.snapshotId)
      .find((candidate) => candidate.file.path === source.path && (candidate.sheet ?? null) === sheet);
    if (!table) return [];
    const rowLabel = String(source.anchor?.rowKey ?? source.metadata.row ?? '').trim();
    // A row, or a cell of a table whose rows are its variables, stands for its row.
    const byRow = source.objectType === 'DATASET_ROW' || (rowLabel && normalizedVariable(rowLabel) === variableKey);
    const descriptors = [];
    if (byRow) {
      const row = Number.isInteger(source.anchor?.rowIndex) ? this.tables.rowNumbered(table.meta.id, source.anchor.rowIndex) : null;
      if (row) descriptors.push(...this.indexedRowObjects(table, row).filter((descriptor) => descriptor.type !== 'DATASET_ROW'));
    } else {
      // The rows the words after the source can name, as the in-memory rows
      // are matched: the name being typed at the end, and a numbered row
      // ("Control 3", "district 45003") written anywhere after it.
      const typed = [...rowCompletionFragments(tail).map((fragment) => fragment.text),
        ...[...String(tail).matchAll(/\b[A-Za-z]{1,16}[\s_-]*\d+\b/g)].map((match) => match[0])];
      for (const text of new Set(typed)) {
        for (const row of this.tables.search(table.meta.id, text, INDEXED_MATCHES_PER_TABLE)) {
          descriptors.push(...this.indexedRowObjects(table, row).filter((descriptor) => descriptor.type !== 'DATASET_ROW'
            && normalizedVariable(descriptor.metadata.variable ?? descriptor.metadata.column) === variableKey));
        }
      }
    }
    const fresh = descriptors.filter((descriptor) => !known.has(descriptor.key)).slice(0, INDEXED_RELATED_OBJECTS);
    return fresh.length ? this.indexedObjects(ownerId, source.snapshotId, table, fresh) : [];
  },

  candidatesForStudyVariable(projectId, fragment, options = {}) {
    const query = String(fragment.text ?? '').trim();
    if (normalizedVariable(query).length < 2) return [];
    const normalizedQuery = normalizedVariable(query);
    const queryWords = variableTokens(humanVariable(query));
    // The name decides eligibility. Earlier words in this sentence distinguish
    // identically named columns/rows before duplicate names are collapsed.
    const contextWords = wordTokens(options.sentenceContext)
      .filter((word) => !REPORTING_WORDS.has(word) && !queryWords.includes(word));
    const directoryWords = contextWords.length ? wordTokens(this.timeline.getProject(projectId).name) : [];
    const permitted = this.autocompleteFilter(projectId);
    // A folder too large to hold is searched in its index; only the matching objects are read.
    const searchIndex = this.searchIndexFor(projectId, options.snapshotId);
    const known = searchIndex ? null : this.studyVariables(projectId, options.snapshotId);
    const indexed = this.indexedStudyVariables(projectId, options.snapshotId, query,
      searchIndex ? this.indexedKeys(searchIndex) : this.keysOf(known));
    // Only names that match can score; an object that matches no way scores under the threshold.
    const matching = [...(searchIndex ? this.matchingIndexedVariables(searchIndex, normalizedQuery, queryWords, contextWords)
      : this.matchingStudyVariables(known, normalizedQuery, queryWords)),
      ...indexed.map((object) => {
        const match = variableNameMatch({ ...object, wordSuffixes: wordSuffixes(object.variableWords) }, normalizedQuery, queryWords);
        return { object, match: { ...match, partMeasurement: !match.exact && !match.prefix && !match.contains
          && namesMeasuredPart(object, queryWords) } };
      })];
    const ranked = matching
      .filter(({ object }) => !options.documentPath || object.path !== options.documentPath)
      .filter(({ object }) => permitted(object))
      // A measurement's label starts with its drawing's name ("Bracket overall X
      // extent"), so it waits until the drawing itself can be named and offered first.
      .filter(({ object }) => object.objectType !== 'DRAWING_ANNOTATION'
        || normalizedQuery.length >= DRAWING_NAME_MIN_LETTERS)
      .flatMap(({ object, match }) => {
        const { exact, prefix, contains, tokenPrefix, partMeasurement } = match;
        const variableObject = object.objectType === 'VARIABLE' ? 1 : 0;
        const rowObject = object.objectType === 'DATASET_ROW' && !object.namedRow ? 1 : 0;
        // Words that each begin a word of the name, in any order, are how a
        // column is abbreviated ("cur per"). They do not name a row or a value:
        // "Quebec district 30002" would otherwise match every district.
        if (!exact && !prefix && !contains && !partMeasurement && !variableObject && !rowObject) return [];
        // Named rows rank below variables and line items that match as well.
        const namedRow = object.namedRow ? 1 : 0;
        const dictionary = object.metadata.dictionary ? 1 : 0;
        const dataPath = /(^|\/)(?:data|datasets?|results?|outputs?|tables?|metabolomics)(\/|$)/i.test(object.path) ? 1 : 0;
        const base = exact ? 0.95 : prefix ? 0.82 : contains ? 0.74 : partMeasurement ? 0.72 : tokenPrefix ? 0.68 : 0;
        const profileQuality = object.metadata.range ? 0.025
          : object.metadata.samples?.length ? 0.012 : object.metadata.dictionary ? 0.01 : -0.015;
        const preference = variableObject * 0.04 + rowObject * 0.065
          + dictionary * 0.03 + dataPath * 0.02 + profileQuality - namedRow * 0.03;
        // How the typed words match the name sets the relevance band (exact,
        // begins, contains, out of order). What kind of object it is and which
        // folder holds it (-0.045 to 0.14, a fifth of that here) only order names
        // that match alike: a column whose name merely contains the words never
        // passes a row or column whose name begins with them.
        const score = Math.min(0.99, base + 0.2 * (preference + 0.045));
        // A name with the typed words further in ("Peak Pressure" for "pres") is
        // a name match, not one the words begin.
        const reasons = namedRow ? [exact ? 'Exact row name' : 'Matching row name']
          : [exact ? 'Exact variable name' : prefix || (tokenPrefix && !contains) ? 'Matching variable prefix' : 'Matching variable name'];
        if (dictionary) reasons.push('data dictionary definition');
        else if (rowObject || namedRow) reasons.push('named dataset row');
        else if (variableObject) reasons.push('inferred from dataset column');
        const sourceWords = contextWords.length
          ? new Set([...directoryWords, ...wordTokens(`${object.label} ${object.searchText}`)]) : null;
        return [{
          ...object,
          label: object.variable,
          completionText: object.variable,
          score: Number(score.toFixed(3)),
          contextScore: sourceWords ? contextWords.filter((word) => sourceWords.has(word)).length / contextWords.length : 0,
          matchTier: exact ? 0 : 1,
          reasons,
          variableDefinition: object.objectType === 'VARIABLE' ? {
            variable: object.variable,
            description: object.metadata.description ?? object.metadata.inferredMeaning ?? object.valueText,
            units: object.metadata.units ?? null,
            path: object.path,
            inferred: !object.metadata.dictionary,
          } : null,
        }];
      }).filter((object) => object.score >= 0.68)
      // Only eight deep rows become indexed objects. Apply sentence context
      // within their relevance bands before that cap can discard the right file.
      .sort((left, right) => recommendationRelevanceBand(right.score) - recommendationRelevanceBand(left.score)
        || right.contextScore - left.contextScore
        || right.score - left.score
        || Number(right.objectType === 'DATASET_ROW' && !right.namedRow) - Number(left.objectType === 'DATASET_ROW' && !left.namedRow)
        || Number(right.objectType === 'VARIABLE') - Number(left.objectType === 'VARIABLE')
        || left.variable.localeCompare(right.variable)
        || left.path.localeCompare(right.path));
    // A name ranks once, as one choice among the names being typed. The same
    // name in other documents (a trial balance's Credit CAD beside the general
    // ledger's) is its own suggestion, offered right after it: withSameNamed.
    const byName = new Map();
    for (const candidate of this.ranking.rank(projectId, this.recordIndexedCandidates(projectId, ranked), {
      query, documentPath: options.documentPath, relatedPaths: options.relatedPaths,
      minimumScore: 0.68, limit: ranked.length, diversify: false,
    })) {
      const key = normalizedVariable(candidate.variable);
      const named = byName.get(key) ?? [];
      // Within one document the name is offered once.
      if (!named.some((other) => sameDocument(other, candidate))) byName.set(key, [...named, candidate]);
    }
    return [...byName.values()].slice(0, options.limit ?? 40)
      .map(([first, ...others]) => (others.length ? { ...first, sameNamed: others } : first));
  },

  /**
   * Scored candidates with the best few rows from the table index recorded as
   * objects, since only recorded objects are offered; the rest are left out.
   */
  recordIndexedCandidates(projectId, scored) {
    const pending = scored.filter((candidate) => candidate.pendingIndex).slice(0, INDEXED_ROWS_SHOWN);
    if (!pending.length) return scored;
    const recorded = new Map();
    for (const candidate of pending) {
      const { table, descriptor, snapshotId } = candidate.pendingIndex;
      const [object] = this.indexedObjects(projectId, snapshotId, table, [descriptor]);
      if (!object) continue;
      const { pendingIndex, ...rest } = candidate;
      recorded.set(candidate, { ...rest, id: object.id, versionId: object.versionId, snapshotId: object.snapshotId,
        snapshotVersion: object.snapshotVersion, metadata: object.metadata, searchText: object.searchText });
    }
    return scored.flatMap((candidate) => !candidate.pendingIndex ? [candidate]
      : recorded.has(candidate) ? [recorded.get(candidate)] : []);
  },

  /** Words after `settledAt`, a value already accepted, are the only ones read. */
  progressiveStudyVariable(projectId, input, cursor, settledAt = -1) {
    if (cursor !== String(input.text ?? '').length) return null;
    const context = writingSourceContext(input.text, cursor, input.section);
    if (context.literatureIntent) return null;
    for (const fragment of progressiveVariableFragments(input.text, cursor, settledAt)) {
      const candidates = this.candidatesForStudyVariable(projectId, fragment, {
        documentPath: input.documentPath,
        sentenceContext: input.text.slice(Math.max(context.sentenceStart, settledAt), fragment.start),
        relatedPaths: this.relatedSourcePaths(projectId, input),
        limit: 40,
      });
      // A couple of letters name nothing yet; a search asks for every match.
      const named = input.surface === 'search' ? candidates
        : candidates.filter(candidate => nameFragmentEarnsCard(fragment.text, candidate));
      if (named.length) return { fragment, candidates: named, context };
    }
    return context.projectIntent ? { fragment: null, candidates: [], context } : null;
  },

  /** A whole file (drawing, dataset or worksheet, document, PDF) the words at
   * the cursor name. Its label is the text Tab inserts in place of them. */
  fileReference(projectId, input, cursor, settledAt = -1) {
    const fragments = progressiveVariableFragments(input.text, cursor, settledAt);
    if (!fragments.length) return null;
    const permitted = this.autocompleteFilter(projectId);
    const files = this.objectsAt(projectId, null, WHOLE_FILE_TYPES)
      .filter(object => isWholeFile(object) && object.path !== input.documentPath && permitted(object));
    for (const fragment of fragments) {
      const candidates = files.flatMap(object => {
        const match = fileReferenceMatch(object, fragment.text);
        if (match && input.surface !== 'search'
          && !nameFragmentEarnsCard(fragment.text, { label: match.label }, { wholeFile: true })) return [];
        // "floor plan" or "3D model" names what kind of drawing a file is, read
        // from its format. A file whose own name or title has the words comes first.
        const kindOnly = match?.matchedBy === 'drawing-alias';
        return match ? [this.enrichObject(projectId, {
          ...object, label: match.label, score: match.score, matchTier: kindOnly ? 1 : 0, fileReference: true,
          reasons: [kindOnly ? 'Matching drawing type'
            : object.objectType === 'DRAWING' ? 'Matching drawing reference' : 'Matching file name'],
        })] : [];
      }).sort((left, right) => right.score - left.score);
      if (candidates.length) return { ...fragment, type: 'ENTITY', partial: true,
        value: fragment.text, candidates, asWritten: typedAsWritten(fragment.text) };
    }
    return null;
  },
};
