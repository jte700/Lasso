// Numbers changed in an Excel 97-2003 workbook (.xls), where they are stored.
// An .xls is a compound file holding a Workbook stream of records; a number
// cell is a NUMBER record (an 8-byte double), an RK record (a 4-byte compact
// number) or one place in a MULRK record. Lasso overwrites only those value
// bytes, in the sectors of the file that hold them, so every other byte stays
// as Excel wrote it. A formula, words or an empty cell would need records of
// another size, so those are left to Excel. Excel works the formulas out
// again when it next opens the workbook.

import { documentExtractionInternals } from '../dependencies/document-extraction.js';
import { HttpError } from '../history/errors.js';
import { columnLetter } from './sheet-diff.js';

const { compoundWorkbookStream, biffRecords, biffShortString } = documentExtractionInternals;
const SIGNATURE = Buffer.from('d0cf11e0a1b11ae1', 'hex');
const FREE = 0xffffffff;
const NUMBER = 0x0203;
const RK = 0x027e;
const MULRK = 0x00bd;
const FORMULA = 0x0006;
const WORDS = new Set([0x00fd, 0x0204, 0x00d6]);
const BOUNDSHEET = 0x0085;

/** Where each sector of the Workbook stream sits in the file, or null for a stream held in the mini stream. */
function workbookSectors(buffer) {
  if (buffer.length < 512 || !buffer.subarray(0, 8).equals(SIGNATURE)) return null;
  const sectorSize = 2 ** buffer.readUInt16LE(30);
  if (![512, 4096].includes(sectorSize)) return null;
  const at = (index) => (index + 1) * sectorSize;
  const read = (index) => (at(index) + sectorSize <= buffer.length ? buffer.subarray(at(index), at(index) + sectorSize) : null);
  const fatIds = [];
  for (let index = 0; index < 109; index += 1) {
    const value = buffer.readUInt32LE(76 + index * 4);
    if (value !== FREE) fatIds.push(value);
  }
  let difat = buffer.readUInt32LE(68);
  for (let count = 0; count < buffer.readUInt32LE(72) && difat < 0xfffffffa; count += 1) {
    const data = read(difat);
    if (!data) break;
    for (let index = 0; index < sectorSize / 4 - 1; index += 1) {
      const value = data.readUInt32LE(index * 4);
      if (value !== FREE) fatIds.push(value);
    }
    difat = data.readUInt32LE(sectorSize - 4);
  }
  const fat = [];
  for (const id of fatIds.slice(0, buffer.readUInt32LE(44))) {
    const data = read(id);
    if (data) for (let offset = 0; offset < data.length; offset += 4) fat.push(data.readUInt32LE(offset));
  }
  const chain = (start) => {
    const ids = [];
    const seen = new Set();
    for (let current = start; current < 0xfffffffa && current < fat.length && !seen.has(current); current = fat[current]) {
      seen.add(current);
      ids.push(current);
    }
    return ids;
  };
  const directory = Buffer.concat(chain(buffer.readUInt32LE(48)).map(read).filter(Boolean));
  for (let offset = 0; offset + 128 <= directory.length; offset += 128) {
    const nameLength = directory.readUInt16LE(offset + 64);
    if (nameLength < 2 || nameLength > 64 || directory[offset + 66] !== 2) continue;
    if (!/^(?:Workbook|Book)$/i.test(directory.subarray(offset, offset + nameLength - 2).toString('utf16le'))) continue;
    const size = Number(directory.readBigUInt64LE(offset + 120));
    if (size < buffer.readUInt32LE(56)) return null;
    return { sectorSize, offsets: chain(directory.readUInt32LE(offset + 116)).map(at) };
  }
  return null;
}

/** The RK form of `value`, or null when it has none: a whole number, hundredths, or a double with short enough bits. */
export function rkFor(value) {
  const fits = (number) => Number.isInteger(number) && number >= -(2 ** 29) && number < 2 ** 29;
  if (fits(value)) return ((value << 2) | 2) >>> 0;
  const hundredths = Math.round(value * 100);
  if (fits(hundredths) && Math.abs(hundredths / 100 - value) < 1e-9) return ((hundredths << 2) | 3) >>> 0;
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleLE(value, 0);
  if (bytes.readUInt32LE(0) === 0 && (bytes.readUInt32LE(4) & 3) === 0) return bytes.readUInt32LE(4) >>> 0;
  return null;
}

/** The number a cell should hold, from its written form ("18,400", "-3", "12.5"). */
function numberOf(value, place) {
  const text = String(value ?? '').trim().replace(/,/g, '');
  const number = text === '' ? NaN : Number(text);
  if (!Number.isFinite(number)) {
    throw new HttpError(409, `Lasso can write only numbers into an .xls, and ${place} would read “${value}”. Make this change in Excel.`);
  }
  return number;
}

/**
 * An .xls workbook with number cells set: edits are { sheet, row (from 1),
 * column (from 0), value }. Throws, changing nothing, when any cell is one
 * Lasso cannot write.
 */
export function setLegacyWorkbookCells(buffer, edits) {
  const stream = compoundWorkbookStream(buffer);
  const sectors = workbookSectors(buffer);
  if (!stream || !sectors) throw new HttpError(422, 'This workbook could not be read.');
  const records = biffRecords(stream);
  const sheets = records.filter((record) => record.id === BOUNDSHEET && record.data.length >= 8)
    .map((record, index) => ({ start: record.data.readUInt32LE(0), name: biffShortString(record.data, 7, record.data[6]) || `Sheet ${index + 1}` }));
  const out = Buffer.from(buffer);
  const write = (streamOffset, bytes) => {
    for (let index = 0; index < bytes.length; index += 1) {
      const at = streamOffset + index;
      out[sectors.offsets[Math.floor(at / sectors.sectorSize)] + (at % sectors.sectorSize)] = bytes[index];
    }
  };
  for (const edit of edits) {
    const position = sheets.findIndex((sheet) => sheet.name === edit.sheet) >= 0
      ? sheets.findIndex((sheet) => sheet.name === edit.sheet) : sheets.length === 1 && !edit.sheet ? 0 : -1;
    if (position < 0) throw new HttpError(422, `The workbook has no sheet named ${edit.sheet}.`);
    const place = `${columnLetter(edit.column)}${edit.row}`;
    const number = numberOf(edit.value, place);
    const end = sheets[position + 1]?.start ?? stream.length;
    let written = false;
    for (const record of biffRecords(stream, sheets[position].start, end)) {
      if (record.data.length < 4 || record.data.readUInt16LE(0) !== edit.row - 1) continue;
      const column = record.data.readUInt16LE(2);
      const valueAt = record.offset + 4 + 6;
      if (record.id === MULRK) {
        const last = record.data.readUInt16LE(record.data.length - 2);
        if (edit.column < column || edit.column > last) continue;
      } else if (column !== edit.column) {
        continue;
      }
      if (record.id === FORMULA) throw new HttpError(409, `${place} holds a formula. Change the cells it works from instead.`);
      if (WORDS.has(record.id)) throw new HttpError(409, `${place} holds words, which Lasso doesn’t write into an .xls. Make this change in Excel.`);
      if (record.id === NUMBER) {
        const bytes = Buffer.alloc(8);
        bytes.writeDoubleLE(number, 0);
        write(valueAt, bytes);
      } else if (record.id === RK || record.id === MULRK) {
        const rk = rkFor(number);
        if (rk === null) throw new HttpError(409, `${place} can’t hold ${number} without Excel rewriting the cell. Make this change in Excel.`);
        const bytes = Buffer.alloc(4);
        bytes.writeUInt32LE(rk, 0);
        write(record.id === RK ? valueAt : record.offset + 4 + 4 + (edit.column - column) * 6 + 2, bytes);
      } else {
        continue;
      }
      written = true;
      break;
    }
    if (!written) throw new HttpError(409, `${place} is empty, and Lasso fills only cells that hold a number in an .xls. Make this change in Excel.`);
  }
  return out;
}
