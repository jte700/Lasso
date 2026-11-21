// The rows behind values tabbed from a kept list: after "BILL-1160" and
// "BILL-1190" from Invoice's values, those two rows' other cells (Maple Paper
// Distribution, 2026-08-18, 22000, 32500) join the list below its own values,
// marked with the tabbed value they belong to, and typed words bring them up.

import path from 'node:path';
import { LINKED_VALUES_SHOWN } from './constants.js';
import { mapObjectRow } from './object-descriptors.js';
import { tabularProvenanceLabel } from './row-field-match.js';
import { contextualStoredValue } from './value-match.js';
import { contextualCompletionRange, typedValueCloseness } from './workspace-completion.js';
import { writingSourceContext } from './writing-context.js';

// Excel workbooks, CSV and other sheets: the files whose rows have cells.
const SHEET_EXTENSIONS = new Set(['.xlsx', '.xlsm', '.xls', '.csv', '.tsv', '.ods']);
// Accepted links looked at, as everywhere else a request's links are read.
const LINKS_READ = 50;

export function isSheetPath(filePath) {
  return SHEET_EXTENSIONS.has(path.extname(filePath ?? '').toLowerCase());
}

/** Whether two indexed sheet objects sit in the same file, sheet and row. */
export function sameTableRow(left, right) {
  if (!left || !right || left.path !== right.path) return false;
  const leftAnchor = left.anchor ?? {}, rightAnchor = right.anchor ?? {};
  if (!['table-cell', 'table-row'].includes(leftAnchor.kind)
    || !['table-cell', 'table-row'].includes(rightAnchor.kind)) return false;
  const leftSheet = leftAnchor.sheet ?? left.metadata?.sheet ?? null;
  const rightSheet = rightAnchor.sheet ?? right.metadata?.sheet ?? null;
  return leftSheet === rightSheet && Number.isInteger(leftAnchor.rowIndex)
    && leftAnchor.rowIndex === rightAnchor.rowIndex;
}

export const heldRowsMethods = {
  /**
   * A kept list with the other cells of each row a value was tabbed from in
   * this sentence, row by row in the order they were tabbed, each marked with
   * the tabbed value it came from. `rowScopeBoundary` omits rows tabbed at or
   * before that offset (after fn+Left steps back to the kept source's own list).
   * @param {string} projectId
   * @param {object} input the prediction request
   * @param {number} cursor
   * @param {object} held the kept source, flagged heldList
   * @param {object} list what valuesFromLinkedProjectObject offered for it
   * @returns {object} the list, with the rows' cells added when there are any
   */
  withTabbedRows(projectId, input, cursor, held, list) {
    if (!held?.heldList || !list || !isSheetPath(held.source.path)) return list;
    const tabbed = this.tabbedRows(input, cursor, held);
    if (!tabbed.length) return list;
    const text = String(input.text ?? '');
    const { sentenceStart } = writingSourceContext(text, cursor);
    const accepted = Array.isArray(input.acceptedDependencies) ? input.acceptedDependencies : input.pendingDependencies;
    const latestEnd = (Array.isArray(accepted) ? accepted.slice(0, LINKS_READ) : [])
      .filter((item) => Number.isInteger(item?.start) && Number.isInteger(item.end)
        && item.start >= sentenceStart && item.end <= cursor)
      .reduce((max, item) => Math.max(max, item.end), held.anchor.end);
    const floor = Math.max(held.anchor.end, latestEnd);
    const tail = text.slice(floor, cursor);
    const written = this.valuesWrittenInSentence(projectId, input, cursor);
    const seen = new Set(list.completions.map((item) => item.dependencyCandidate?.id));
    const added = [];
    for (const { value, row, tabbedValue } of tabbed) {
      for (const object of this.rowMateObjects(projectId, value, row)) {
        if (object.id === value.id || object.id === held.source.id || seen.has(object.id)) continue;
        const replacementText = object.anchor?.kind === 'table-row'
          ? String(object.anchor.rowKey ?? object.label ?? '').trim() || null
          : contextualStoredValue(object, tail);
        if (!replacementText || written.get(object.id)?.has(replacementText.toLowerCase())) continue;
        seen.add(object.id);
        added.push({
          id: `${object.id}:row-mate:${added.length}`,
          replacementText,
          category: object.objectType === 'RESULT' ? 'Result' : 'Value',
          detail: `From ${tabbedValue}`,
          rowMateOf: tabbedValue,
          provenanceLabel: tabularProvenanceLabel(object),
          ...contextualCompletionRange(text, cursor, replacementText, { floor }),
          confidence: 0.46,
          dependencyCandidate: this.enrichObject(projectId, {
            ...object,
            reasons: [`same row as ${tabbedValue}`],
          }),
          generated: false,
        });
      }
    }
    if (!added.length) return list;
    // A row mate supersedes a generic Row completion for the same tabbed row.
    const mateTexts = new Set(added.map((item) => item.replacementText.toLowerCase()));
    const base = list.completions.filter((item) => !(item.category === 'Row' && mateTexts.has(item.replacementText.toLowerCase())));
    const merged = [...base, ...added]
      .map((item, order) => ({ item, order, near: typedValueCloseness(tail, item.replacementText) }))
      .sort((left, right) => right.near - left.near || left.order - right.order)
      .map(({ item }) => item);
    let completions = merged;
    if (merged.length > LINKED_VALUES_SHOWN) {
      // Keep row mates inside the card's limit when the column alone fills it.
      const kept = merged.slice(0, LINKED_VALUES_SHOWN);
      const missingMates = merged.slice(LINKED_VALUES_SHOWN).filter((item) => item.rowMateOf);
      if (missingMates.length) {
        const trimmed = [];
        let dropped = 0;
        for (let index = kept.length - 1; index >= 0; index -= 1) {
          if (dropped < missingMates.length && !kept[index].rowMateOf) { dropped += 1; continue; }
          trimmed.push(kept[index]);
        }
        trimmed.reverse();
        completions = [...trimmed, ...missingMates];
      }
    }
    return { ...list, completions, hasRowMates: true };
  },

  /**
   * The rows of the cells tabbed from `held` in the sentence being written
   * after `rowScopeBoundary`, in the order they were tabbed, each paired with
   * the tabbed value that brought its row in.
   */
  tabbedRows(input, cursor, held) {
    const text = String(input.text ?? '');
    const { sentenceStart } = writingSourceContext(text, cursor);
    const rowScopeBoundary = Number.isInteger(input.rowScopeBoundary) ? input.rowScopeBoundary : -1;
    const accepted = Array.isArray(input.acceptedDependencies) ? input.acceptedDependencies : input.pendingDependencies;
    const links = (Array.isArray(accepted) ? accepted.slice(0, LINKS_READ) : [])
      .filter((item) => Number.isInteger(item?.start) && Number.isInteger(item.end)
        && item.start >= sentenceStart && item.end > rowScopeBoundary && item.end <= cursor
        && item.sourceObjectId && item.sourceSnapshotId)
      .toSorted((left, right) => left.start - right.start);
    const rows = [];
    const seenRows = new Set();
    for (const item of links) {
      const found = this.sourceVersion(item.sourceObjectId, item.sourceSnapshotId);
      if (!found) continue;
      const value = mapObjectRow(found);
      if (!['table-cell', 'table-row'].includes(value.anchor?.kind) || !this.holdsTableValue(held.source, value)) continue;
      if (!Number.isInteger(value.anchor.rowIndex)) continue;
      // A name tabbed from the column naming the rows is its row.
      const row = value.anchor.kind === 'table-row' ? value : this.rowOfCell(value);
      if (row && row.id === held.source.id) continue;
      const sheet = value.anchor.sheet ?? value.metadata?.sheet ?? '';
      const rowId = `${value.path}\u0000${sheet}\u0000${value.anchor.rowIndex}`;
      if (seenRows.has(rowId)) continue;
      seenRows.add(rowId);
      const tabbedValue = text.slice(item.start, item.end).trim()
        || String(value.valueText ?? value.anchor.rowKey ?? value.label ?? '').trim();
      if (!tabbedValue) continue;
      rows.push({ value, row, tabbedValue });
    }
    return rows;
  },

  /** Every cell in `value`'s row (including its row-label object), left to right. */
  rowMateObjects(projectId, value, row) {
    const owner = this.sourceProjectId(value) ?? projectId;
    const sheet = value.anchor?.sheet ?? value.metadata?.sheet ?? null;
    const rowIndex = value.anchor?.rowIndex;
    if (!Number.isInteger(rowIndex)) return [];
    const labelColumn = this.tableLabelColumn(value, sheet);
    const searchIndex = this.searchIndexFor(owner, value.snapshotId);
    const retrieved = searchIndex
      ? this.relatedIndexedObjects(searchIndex, row ?? value, '', {
        wholeDrawing: false, namedRow: true, sourceRow: row?.anchor?.rowKey ?? value.anchor?.rowKey ?? '',
      })
      : this.objectsAt(owner, value.snapshotId, ['DATASET_ROW', 'DATASET_VALUE', 'TABLE', 'RESULT']);
    const mates = retrieved.filter((object) => object.path === value.path
      && (object.anchor?.sheet ?? object.metadata?.sheet ?? null) === sheet
      && ['table-cell', 'table-row'].includes(object.anchor?.kind)
      && object.anchor.rowIndex === rowIndex);
    if (row && !mates.some((object) => object.id === row.id)) mates.push(row);
    // A deep row past the snapshot's first indexed rows comes from the table index.
    const table = this.snapshotTables(owner, value.snapshotId)
      .find((candidate) => candidate.file.path === value.path && (candidate.sheet ?? null) === sheet);
    if (table) {
      const stored = this.tables.rowNumbered(table.meta.id, rowIndex);
      if (stored) {
        const known = this.keysOf(mates);
        const missing = this.indexedRowObjects(table, stored).filter((descriptor) => !known.has(descriptor.key));
        if (missing.length) mates.push(...this.indexedObjects(owner, value.snapshotId, table, missing));
      }
    }
    const columnOf = (object) => (object.anchor?.kind === 'table-row'
      ? labelColumn : (object.anchor?.columnIndex ?? Number.MAX_SAFE_INTEGER));
    return mates.toSorted((left, right) => columnOf(left) - columnOf(right));
  },

  /** The named row a table cell sits in, or null when its row has no name. */
  rowOfCell(cell) {
    const owner = this.sourceProjectId(cell);
    const sheet = cell.anchor.sheet ?? null;
    const found = this.objectsAt(owner, cell.snapshotId, ['DATASET_ROW']).find((object) => object.path === cell.path
      && object.anchor?.kind === 'table-row' && (object.anchor.sheet ?? null) === sheet
      && object.anchor.rowIndex === cell.anchor.rowIndex);
    if (found) return found;
    const table = this.snapshotTables(owner, cell.snapshotId)
      .find((candidate) => candidate.file.path === cell.path && (candidate.sheet ?? null) === sheet);
    const stored = table && Number.isInteger(cell.anchor.rowIndex)
      ? this.tables.rowNumbered(table.meta.id, cell.anchor.rowIndex) : null;
    const descriptor = stored ? this.indexedRowObjects(table, stored).find((item) => item.type === 'DATASET_ROW') : null;
    return descriptor ? this.indexedObjects(owner, cell.snapshotId, table, [descriptor])[0] ?? null : null;
  },
};
