// The values listed below a linked source: a column's values, a row's cells, a part's measurements.

import { matchedSourceWords } from './direct-match.js';
import { measurementOrder, measurementRelevance } from './drawing-objects.js';
import { canonicalRowReference, normalizedRowSearch, rowSearchAliases } from './row-names.js';
import { humanVariable, normalizedVariable } from './tabular.js';
import { LINKED_VALUES_SHOWN } from './constants.js';
import {
  fieldCompletionFragments, fieldCompletionScore, fieldNavigationCue, mentionedFields, namedFieldWords,
  rowCompletionFragments, rowCompletionScore, rowReferencesInText, tabularProvenanceLabel,
} from './row-field-match.js';
import {
  comparableNumber, contextualStoredValue, missingMeasurement, numericDescriptor, typedNumberPrefix,
} from './value-match.js';
import { contextualCompletionRange, sameDocument, typedValueCloseness } from './workspace-completion.js';

/**
 * Table cells as their sheet has them: rows top to bottom, each row's cells
 * left to right, with the linked source's own table first. Anything that is
 * not a cell keeps its place after them.
 * @param {object[]} objects
 * @param {object} source
 * @returns {object[]}
 */
function inSheetOrder(objects, source) {
  const end = Number.MAX_SAFE_INTEGER;
  const elsewhere = (object) => Number(!sameDocument(object, source));
  const table = (object) => `${object.path}\u0000${object.metadata.sheet ?? object.anchor?.sheet ?? ''}`;
  return objects.toSorted((left, right) => elsewhere(left) - elsewhere(right)
    || table(left).localeCompare(table(right))
    || (left.anchor?.rowIndex ?? end) - (right.anchor?.rowIndex ?? end)
    || (left.anchor?.columnIndex ?? end) - (right.anchor?.columnIndex ?? end));
}

/**
 * The values what was typed names first, closest first, each group keeping
 * the order it came in: a value it begins, one it is inside, then one whose row
 * or column has a typed word. A word every value shares ties them all, so it
 * moves nothing, and so does a word none has.
 * @param {object[]} objects
 * @param {string} typed the text since the source was taken
 * @returns {object[]}
 */
function typedFirst(objects, typed) {
  if (!typed.trim()) return objects;
  const closeness = (object) => {
    const inValue = typedValueCloseness(typed, object.contextualText);
    if (inValue) return inValue + 1;
    const names = [object.valueText, object.anchor?.rowKey ?? object.metadata.row, object.metadata.column ?? object.anchor?.column];
    return matchedSourceWords(typed, names.filter(Boolean).join(' ')).length ? 1 : 0;
  };
  return objects.map((object) => ({ object, near: closeness(object) }))
    .sort((left, right) => right.near - left.near)
    .map(({ object }) => object);
}

export const linkedValuesMethods = {
  valuesFromLinkedProjectObject(projectId, input, cursor, dependency) {
    if (!dependency || ['PAPER', 'REFERENCE'].includes(dependency.source.objectType)) return null;
    const source = dependency.source;
    const sourceRow = String(source.anchor?.rowKey ?? source.metadata.row ?? '').trim();
    // A named row (a department or supplier, keyed by a name column) has no
    // variable of its own; its cells are its fields, so it stands in for one.
    const namedRow = source.objectType === 'DATASET_ROW' && !source.metadata.variable && !source.metadata.column;
    // A whole drawing or CAD part ("Bracket") is the same: its measurements are its values.
    const wholeDrawing = source.objectType === 'DRAWING';
    const variable = String(source.metadata.variable ?? source.metadata.column
      ?? (source.objectType === 'VARIABLE' || wholeDrawing ? source.label : namedRow ? sourceRow || source.label : '')).trim();
    if (!variable) return null;
    const variableKey = normalizedVariable(variable);
    const tail = String(input.text ?? '').slice(dependency.anchor.end, cursor);
    const changeIntent = /\b(?:increas|decreas|reduc|higher|lower|rais|rise|drop|declin|change|difference|effect)\w*\b/i.test(tail);
    const sourceColumn = String(source.anchor?.column ?? source.metadata.column ?? '').trim();
    const dependencyText = String(input.text ?? '').slice(dependency.anchor.start, dependency.anchor.end);
    const dependencySelectsRow = !source.metadata.sectionRow && sourceRow && normalizedRowSearch(dependencyText) === normalizedRowSearch(sourceRow);
    const dependencySelectsColumn = source.anchor?.kind === 'table-cell' && sourceColumn
      && normalizedVariable(dependencyText) === normalizedVariable(sourceColumn);
    // A measurement accepted by its name ("Bracket Ø8 hole diameter") still
    // has its own value to state, unless that value is the linked text.
    const dependencyNamesMeasurement = source.objectType === 'DRAWING_ANNOTATION'
      && normalizedVariable(dependencyText) !== normalizedVariable(source.valueText);
    const retrieved = this.workspaceRetrievalObjects(this.sourceProjectId(source) ?? projectId, source.snapshotId);
    // A large table's later rows come from the table index, as few as the words typed name.
    const indexedRelated = wholeDrawing ? [] : this.indexedRelatedObjects(projectId, source, tail,
      { variableKey, known: this.keysOf(retrieved) });
    const workspaceObjects = indexedRelated.length ? [...retrieved, ...indexedRelated] : retrieved;
    // A data dictionary's cells describe the variable (its description and
    // units); they are not values of it, unless that file is the linked source.
    // Keyed by sheet: a workbook's data sheets beside its dictionary still count.
    const tableKey = (object) => `${object.path}\u0000${object.metadata.sheet ?? object.anchor?.sheet ?? ''}`;
    const dictionaryTables = new Set(workspaceObjects
      .filter((object) => object.objectType === 'VARIABLE' && object.metadata.dictionary
        && object.anchor?.kind === 'table-cell')
      .map(tableKey));
    const describesVariable = (object) => dictionaryTables.has(tableKey(object))
      && (source.objectType === 'VARIABLE' || tableKey(object) !== tableKey(source));
    const relatesToSource = wholeDrawing
      ? (object) => object.objectType === 'DRAWING_ANNOTATION' && object.path === source.path
        && (object.anchor?.pageNumber ?? null) === (source.anchor?.pageNumber ?? null)
      : namedRow
        ? (object) => tableKey(object) === tableKey(source)
          && normalizedRowSearch(object.anchor?.rowKey ?? object.metadata.row) === normalizedRowSearch(sourceRow)
        : (object) => normalizedVariable(object.metadata.variable ?? object.metadata.column) === variableKey
          || (source.metadata.sectionRow && normalizedVariable(object.metadata.section) === variableKey)
          // A table keyed by row names stores each cell under its row ("Revenue"); its column names the source.
          || (source.anchor?.kind === 'table-column' && normalizedVariable(object.metadata.column) === variableKey);
    // Another document's column of the same name is a suggestion of its own
    // (a trial balance's Credit CAD beside the general ledger's), so its cells
    // are not this column's values. What other files say of the variable by
    // name, as a results table's row for it, still counts, and so does every
    // file for a data dictionary's entry, which has no cells of its own.
    const columnOfAnotherDocument = (object) => source.anchor?.kind === 'table-column' && !source.metadata.dictionary
      && !sameDocument(object, source)
      && normalizedVariable(object.metadata.column ?? object.anchor?.column) === variableKey;
    const allRelatedObjects = workspaceObjects
      .filter((object) => !describesVariable(object) && !columnOfAnotherDocument(object))
      .filter((object) => (object.id !== source.id || dependencySelectsRow || dependencySelectsColumn
        || dependencyNamesMeasurement) && object.objectType !== 'VARIABLE' && relatesToSource(object));
    // A model with nothing measured (a native CAD file) leaves the sentence to other suggestions.
    if (wholeDrawing && !allRelatedObjects.length) return null;
    const sameSourceObjects = source.objectType === 'VARIABLE' ? [] : allRelatedObjects
      .filter((object) => object.path === source.path
        && String(object.metadata.sheet ?? '') === String(source.metadata.sheet ?? ''));
    const relatedObjects = sameSourceObjects.length ? sameSourceObjects : allRelatedObjects;
    const requestedRows = rowReferencesInText(tail,
      relatedObjects.map((object) => object.anchor?.rowKey ?? object.metadata.row));
    const fragments = requestedRows.size || dependencySelectsRow ? [] : rowCompletionFragments(tail);
    const rows = new Map();
    for (const object of relatedObjects) {
      const rowKey = String(object.anchor?.rowKey ?? object.metadata.row ?? '').trim();
      if (!rowKey || /^row:\d+$/i.test(rowKey)) continue;
      let bestFragment = null;
      let bestScore = 0;
      for (const fragment of fragments) {
        const score = rowCompletionScore(fragment, rowKey);
        if (score > bestScore) { bestFragment = fragment; bestScore = score; }
      }
      if (!bestFragment || bestScore < 0.68) continue;
      const key = normalizedRowSearch(rowKey);
      const representativeScore = Number(object.path === source.path) * 2
        + Number((object.metadata.sheet ?? null) === (source.metadata.sheet ?? null))
        + Number(!missingMeasurement(object.valueText)) * 0.1;
      const previous = rows.get(key);
      if (!previous || bestScore > previous.matchScore
        || (bestScore === previous.matchScore && representativeScore > previous.representativeScore)) {
        rows.set(key, { object, rowKey, fragment: bestFragment, matchScore: bestScore, representativeScore });
      }
    }
    const rowSuggestions = [...rows.values()]
      .sort((left, right) => right.matchScore - left.matchScore
        || right.representativeScore - left.representativeScore
        || left.rowKey.localeCompare(right.rowKey, undefined, { numeric: true, sensitivity: 'base' }))
      .slice(0, 8).map(({ object, rowKey, fragment, matchScore }, index) => {
        return {
          id: `${object.id}:row:${index}`,
          replacementText: rowKey,
          category: 'Row',
          provenanceLabel: [object.metadata.sheet, variable].filter(Boolean).join(' · '),
          claimStart: dependency.anchor.end + fragment.start,
          claimEnd: dependency.anchor.end + fragment.end,
          confidence: Number(Math.min(0.99, matchScore).toFixed(3)),
          dependencyCandidate: this.enrichObject(projectId, {
            ...object,
            score: Number(Math.min(0.99, matchScore).toFixed(3)),
            reasons: ['matching row identifier', 'same linked variable'],
          }),
          generated: false,
        };
      });
    if (rowSuggestions.length) {
      return {
        dependencyId: dependency.id,
        source,
        variable,
        changeIntent,
        requestedRows: [],
        heading: `Rows for ${variable}`,
        completions: rowSuggestions,
        notice: null,
      };
    }

    const fieldOrder = new Map();
    for (const object of relatedObjects) {
      const field = String(object.metadata.column ?? object.anchor?.column ?? '').trim();
      if (!field) continue;
      const columnIndex = Number.isInteger(object.anchor?.columnIndex)
        ? object.anchor.columnIndex : Number.MAX_SAFE_INTEGER;
      fieldOrder.set(field, Math.min(fieldOrder.get(field) ?? Number.MAX_SAFE_INTEGER, columnIndex));
    }
    const fields = [...fieldOrder].sort((left, right) => left[1] - right[1]
      || left[0].localeCompare(right[0])).map(([field]) => field);
    const explicitFields = mentionedFields(tail, fields);
    if (dependencySelectsRow && fields.length > 1 && !explicitFields.size) {
      const fragmentsForFields = fieldCompletionFragments(tail);
      const matchingFields = fields.map((field) => {
        let bestFragment = null;
        let bestScore = 0;
        for (const fragment of fragmentsForFields) {
          const score = fieldCompletionScore(fragment, field);
          if (score > bestScore) { bestFragment = fragment; bestScore = score; }
        }
        return { field, fragment: bestFragment, score: bestScore };
      }).filter((match) => match.score >= 0.76);
      const offerAllFields = !matchingFields.length && fieldNavigationCue(tail);
      if (matchingFields.length || offerAllFields) {
        const selectedFields = (matchingFields.length
          ? matchingFields : fields.map((field) => ({ field, fragment: null, score: 0.72 })))
          .sort((left, right) => right.score - left.score
            || fields.indexOf(left.field) - fields.indexOf(right.field));
        const fieldSuggestions = selectedFields.slice(0, 8).map(({ field, fragment, score }, index) => {
          const object = relatedObjects.find((candidate) => String(candidate.metadata.column ?? candidate.anchor?.column) === field);
          return {
            id: `${object.id}:field:${index}`,
            replacementText: field,
            category: 'Column',
            provenanceLabel: [object.metadata.sheet, sourceRow, field].filter(Boolean).join(' · '),
            claimStart: fragment ? dependency.anchor.end + fragment.start : cursor,
            claimEnd: fragment ? dependency.anchor.end + fragment.end : cursor,
            confidence: Number(Math.min(0.99, score).toFixed(3)),
            dependencyCandidate: this.enrichObject(projectId, {
              ...object,
              score: Number(Math.min(0.99, score).toFixed(3)),
              reasons: ['field in the selected row', fragment ? 'matching field prefix' : 'available field'],
            }),
            generated: false,
          };
        });
        return {
          dependencyId: dependency.id,
          source,
          variable,
          changeIntent,
          requestedRows: [],
          heading: `Columns for ${sourceRow || variable}`,
          completions: fieldSuggestions,
          notice: null,
        };
      }
    }
    const rowMatches = requestedRows.size || dependencySelectsRow ? relatedObjects.filter((object) => {
      const row = canonicalRowReference(object.anchor?.rowKey ?? object.metadata.row);
      if (requestedRows.size) return row && requestedRows.has(row);
      return normalizedRowSearch(object.anchor?.rowKey ?? object.metadata.row) === normalizedRowSearch(sourceRow);
    }) : [];
    let scopedObjects = requestedRows.size || dependencySelectsRow ? rowMatches : relatedObjects;
    if (dependencySelectsColumn) {
      scopedObjects = relatedObjects.filter((object) => object.id === source.id
        || (normalizedRowSearch(object.anchor?.rowKey ?? object.metadata.row) === normalizedRowSearch(sourceRow)
          && normalizedVariable(object.metadata.column ?? object.anchor?.column) === normalizedVariable(sourceColumn)));
    } else if (explicitFields.size) {
      scopedObjects = scopedObjects.filter((object) => explicitFields
        .has(normalizedVariable(object.metadata.column ?? object.anchor?.column)));
    }
    // The first digits of a value ("was 48") pick out the values they begin,
    // and a word of a column's name ("budget") breaks ties between its cells.
    const typedNumber = typedNumberPrefix(tail, requestedRows);
    const written = this.valuesWrittenInSentence(projectId, input, cursor);
    const completesTypedNumber = (text) => Boolean(typedNumber) && comparableNumber(text).startsWith(typedNumber);
    const fieldWordsNamed = (object) => namedFieldWords(tail, object.metadata.column ?? object.anchor?.column);
    const objects = scopedObjects
      .map((object) => {
        const field = humanVariable(object.metadata.column ?? object.metadata.metric ?? object.label);
        const numeric = numericDescriptor(object.valueText);
        const resultPath = /(^|\/)(?:results?|outputs?|analysis)(\/|$)/i.test(object.path);
        const derivedField = /\b(?:fold|change|difference|effect|estimate|ratio|percent|reduction|increase|decrease)\b/.test(field);
        const contextualText = contextualStoredValue(object, tail);
        if (!contextualText || written.get(object.id)?.has(contextualText.toLowerCase())) return null;
        let score = object.objectType === 'RESULT' ? 0.52
          : ['VALUE', 'DATASET_VALUE'].includes(object.objectType) ? 0.28 : 0.18;
        if (object.path === source.path) score += 0.18;
        if (resultPath) score += 0.18;
        if (derivedField) score += 0.2;
        if (numeric) score += 0.08;
        // Drawing measurements weigh a value being typed, with its unit, in measurementRelevance.
        if (object.objectType === 'DRAWING_ANNOTATION') score += measurementRelevance(object, tail);
        else if (completesTypedNumber(contextualText)) score += 0.3;
        if (requestedRows.size || dependencySelectsRow) score += 0.5;
        if (missingMeasurement(object.valueText)) score -= 0.16;
        return { ...object, contextualText, score: Number(Math.min(0.99, score).toFixed(3)) };
      }).filter(Boolean)
      .sort((left, right) => right.score - left.score
        || Number(completesTypedNumber(right.contextualText)) - Number(completesTypedNumber(left.contextualText))
        || fieldWordsNamed(right) - fieldWordsNamed(left)
        || Number(right.objectType === 'RESULT') - Number(left.objectType === 'RESULT')
        || measurementOrder(left) - measurementOrder(right)
        || left.path.localeCompare(right.path)
        || String(left.anchor?.rowKey ?? '').localeCompare(String(right.anchor?.rowKey ?? '')));
    // A table's values are listed where the sheet has them, with whatever the
    // words typed since name brought to the top; none are hidden. A named row
    // or field, or a word about a change, asks ranking for particular values.
    const listsInOrder = !requestedRows.size && !explicitFields.size && !changeIntent
      && objects.some((object) => object.anchor?.kind === 'table-cell');
    const suggestions = [];
    const seen = new Set();
    for (const object of listsInOrder ? typedFirst(inSheetOrder(objects, source), tail) : objects) {
      // Every cell of a row or column is listed, so the arrows reach each one:
      // equal values in two cells keep two places. The card names a CAD
      // measurement's feature ("Ø8 hole depth"), which keeps those apart too.
      // Two objects read from the same cell still show once.
      const anchor = object.anchor ?? {};
      const feature = anchor.kind === 'cad-property' ? object.label : '';
      const cell = anchor.kind === 'table-cell'
        ? `${anchor.rowIndex ?? anchor.rowKey ?? ''}:${anchor.columnIndex ?? anchor.column ?? ''}` : '';
      const fingerprint = `${object.contextualText.toLowerCase()}|${object.path}|${object.metadata.sheet ?? ''}|${feature}|${cell}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      suggestions.push({
        id: `${object.id}:value:${suggestions.length}`,
        replacementText: object.contextualText,
        category: object.objectType === 'RESULT' ? 'Result' : 'Value',
        provenanceLabel: tabularProvenanceLabel(object),
        ...contextualCompletionRange(input.text, cursor, object.contextualText, {
          floor: dependency.anchor.end,
          preserveSuffixes: [
            ...fields,
            ...scopedObjects.flatMap((candidate) => rowSearchAliases(candidate.anchor?.rowKey ?? candidate.metadata.row)),
          ],
        }),
        confidence: object.score,
        dependencyCandidate: this.enrichObject(projectId, {
          ...object,
          reasons: ['same linked variable', changeIntent ? 'matching change result' : 'matching stored value'],
        }),
        generated: false,
      });
      if (suggestions.length >= LINKED_VALUES_SHOWN) break;
    }
    return {
      dependencyId: dependency.id,
      source,
      variable,
      changeIntent,
      requestedRows: [...requestedRows],
      listsInOrder,
      heading: (dependencySelectsColumn || explicitFields.size) && scopedObjects.length
        && new Set(scopedObjects.map((object) => normalizedVariable(object.metadata.column ?? object.anchor?.column))).size === 1
        ? `Value for ${variable} · ${scopedObjects[0].metadata.column ?? scopedObjects[0].anchor?.column}`
        : `Values for ${variable}`,
      completions: suggestions,
      notice: suggestions.length ? null
        : `No source-backed value found for ${variable}${requestedRows.size
          ? ` at ${[...requestedRows].join(', ')}` : dependencySelectsRow ? ` at ${sourceRow}` : ''}`,
    };
  },
};
