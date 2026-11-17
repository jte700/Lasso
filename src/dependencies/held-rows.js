// The rows behind values tabbed from a kept list: after "BILL-1160" and
// "BILL-1190" from Invoice's values, those two rows' other cells (22000,
// 32500, their dates) join the list below its own values, and the digits
// typed bring them up.

import path from 'node:path';
import { mapObjectRow } from './object-descriptors.js';
import { typedValueCloseness } from './workspace-completion.js';
import { writingSourceContext } from './writing-context.js';

// Excel workbooks, CSV and other sheets: the files whose rows have cells.
const SHEET_EXTENSIONS = new Set(['.xlsx', '.xlsm', '.xls', '.csv', '.tsv', '.ods']);
// Accepted links looked at, as everywhere else a request's links are read.
const LINKS_READ = 50;

export const heldRowsMethods = {
  /**
   * A kept list with the cells of each row a value was tabbed from in this
   * sentence, row by row in the order they were tabbed. What is typed brings
   * the values it begins to the top, wherever they were.
   * @param {string} projectId
   * @param {object} input the prediction request
   * @param {number} cursor
   * @param {object} held the kept source, flagged heldList
   * @param {object} list what valuesFromLinkedProjectObject offered for it
   * @returns {object} the list, with the rows' cells added when there are any
   */
  withTabbedRows(projectId, input, cursor, held, list) {
    if (!held?.heldList || !list || !SHEET_EXTENSIONS.has(path.extname(held.source.path ?? '').toLowerCase())) return list;
    const seen = new Set(list.completions.map((item) => item.dependencyCandidate?.id));
    const added = [];
    for (const row of this.tabbedRows(input, cursor, held)) {
      // The row stands where the kept source does, so the words typed since count the same.
      const cells = this.valuesFromLinkedProjectObject(projectId, input, cursor,
        { ...held, id: `held-row:${row.id}`, source: row, heldList: false });
      for (const item of cells?.completions ?? []) {
        const id = item.dependencyCandidate?.id;
        if (seen.has(id)) continue;
        seen.add(id);
        added.push(item);
      }
    }
    if (!added.length) return list;
    const typed = String(input.text ?? '').slice(held.anchor.end, cursor);
    const completions = [...list.completions, ...added]
      .map((item, order) => ({ item, order, near: typedValueCloseness(typed, item.replacementText) }))
      .sort((left, right) => right.near - left.near || left.order - right.order)
      .map(({ item }) => item);
    return { ...list, completions };
  },

  /**
   * The rows of the cells tabbed from `held` in the sentence being written,
   * in the order they were tabbed.
   */
  tabbedRows(input, cursor, held) {
    const text = String(input.text ?? '');
    const { sentenceStart } = writingSourceContext(text, cursor);
    const accepted = Array.isArray(input.acceptedDependencies) ? input.acceptedDependencies : input.pendingDependencies;
    const links = (Array.isArray(accepted) ? accepted.slice(0, LINKS_READ) : [])
      .filter((item) => Number.isInteger(item?.start) && Number.isInteger(item.end)
        && item.start >= sentenceStart && item.end <= cursor && item.sourceObjectId && item.sourceSnapshotId)
      .toSorted((left, right) => left.start - right.start);
    const rows = [];
    for (const item of links) {
      const found = this.sourceVersion(item.sourceObjectId, item.sourceSnapshotId);
      if (!found) continue;
      const value = mapObjectRow(found);
      if (!['table-cell', 'table-row'].includes(value.anchor?.kind) || !this.holdsTableValue(held.source, value)) continue;
      // A name tabbed from the column naming the rows is its row.
      const row = value.anchor.kind === 'table-row' ? value : this.rowOfCell(value);
      if (row && row.id !== held.source.id && !rows.some((known) => known.id === row.id)) rows.push(row);
    }
    return rows;
  },

  /** The named row a table cell sits in, or null when its row has no name. */
  rowOfCell(cell) {
    const owner = this.sourceProjectId(cell);
    const sheet = cell.anchor.sheet ?? null;
    return this.objectsAt(owner, cell.snapshotId, ['DATASET_ROW']).find((object) => object.path === cell.path
      && object.anchor?.kind === 'table-row' && (object.anchor.sheet ?? null) === sheet
      && object.anchor.rowIndex === cell.anchor.rowIndex) ?? null;
  },
};
