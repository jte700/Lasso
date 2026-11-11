import { decodeChunk } from './table-storage.js';

// A table's rows as the table index lists them: for each stored row in order,
// its ordinal, row id and row number, read from the table's chunks. Typed
// arrays keep a large table's list small enough to hold for a while.

/** The first index from `from` whose value is at least `value`, in an ascending array. */
export function lowerBound(values, value, from = 0, to = values.length) {
  let low = from;
  let high = to;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The first index whose value is past `value`, in an ascending array. */
function upperBound(values, value) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function ascending(values) {
  for (let index = 1; index < values.length; index += 1) if (values[index] < values[index - 1]) return false;
  return true;
}

/** Reads a table's list of rows; a table that is gone, or not yet written, has none. */
export function readTableMap(statements, tableId) {
  const table = statements.mapTable.get(tableId);
  const parts = table ? statements.mapParts.all(tableId) : [];
  const total = parts.reduce((sum, part) => sum + part.row_count, 0);
  const map = {
    tableId, contentHash: table?.content_hash ?? null, complete: Boolean(table?.complete),
    ordinals: new Int32Array(total), rowIds: new Float64Array(total), rowNumbers: new Float64Array(total), byRow: null,
  };
  let offset = 0;
  for (const part of parts) {
    decodeChunk(part.entries, part.row_count, { firstOrdinal: part.first_ordinal, firstRowNumber: part.first_row_number,
      offset, ordinals: map.ordinals, rowIds: map.rowIds, rowNumbers: map.rowNumbers });
    offset += part.row_count;
  }
  const shape = JSON.parse(table?.shape_json ?? 'null');
  map.dataStart = shape?.dataStart ?? 0;
  // Only the rows of a table whose rows are named have names stored, and only past its header.
  map.termColumn = shape?.searchable && Number.isInteger(shape.labelColumn) ? shape.labelColumn : null;
  map.numbersAscending = ascending(map.rowNumbers);
  return map;
}

/** The places in the list where a row id is, in table order. */
export function placesOf(map, rowId) {
  if (!map.byRow) {
    map.byRow = Int32Array.from(map.rowIds.keys()).sort((left, right) => map.rowIds[left] - map.rowIds[right] || left - right);
  }
  const ids = map.rowIds;
  const byRow = map.byRow;
  let low = 0;
  let high = byRow.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ids[byRow[middle]] < rowId) low = middle + 1;
    else high = middle;
  }
  const places = [];
  for (let index = low; index < byRow.length && ids[byRow[index]] === rowId; index += 1) places.push(byRow[index]);
  return places;
}

/** The place of a row by ordinal, or -1. */
export function placeOfOrdinal(map, ordinal) {
  const place = lowerBound(map.ordinals, ordinal);
  return map.ordinals[place] === ordinal && place < map.ordinals.length ? place : -1;
}

/** The place of the first row in table order with this row number, or -1. */
export function placeOfRowNumber(map, rowNumber) {
  if (map.numbersAscending) {
    const place = lowerBound(map.rowNumbers, rowNumber);
    return place < map.rowNumbers.length && map.rowNumbers[place] === rowNumber ? place : -1;
  }
  return map.rowNumbers.indexOf(rowNumber);
}

/** Up to `count` places of rows at or above a row number, nearest first, later rows first among equal numbers. */
export function placesBefore(map, rowNumber, count) {
  if (map.numbersAscending) {
    const end = upperBound(map.rowNumbers, rowNumber);
    const places = [];
    for (let place = end - 1; place >= 0 && places.length < count; place -= 1) places.push(place);
    return places;
  }
  return [...map.rowNumbers.keys()].filter((place) => map.rowNumbers[place] <= rowNumber)
    .sort((left, right) => map.rowNumbers[right] - map.rowNumbers[left] || right - left).slice(0, count);
}
