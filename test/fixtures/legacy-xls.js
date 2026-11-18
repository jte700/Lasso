// Excel 97-2003 workbooks (.xls) built record by record for tests: a compound
// file holding one Workbook stream, with a shared string table, one sheet
// named Accounting, and the cells a test asks for.

export function biffRecord(id, data = Buffer.alloc(0)) {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(id, 0);
  header.writeUInt16LE(data.length, 2);
  return Buffer.concat([header, data]);
}

export function biffBof(type) {
  const data = Buffer.alloc(16);
  data.writeUInt16LE(0x0600, 0);
  data.writeUInt16LE(type, 2);
  return biffRecord(0x0809, data);
}

export function biffSst(strings) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(strings.length, 0);
  header.writeUInt32LE(strings.length, 4);
  const values = strings.map((value) => {
    const text = Buffer.from(value, 'latin1');
    const stringHeader = Buffer.alloc(3);
    stringHeader.writeUInt16LE(value.length, 0);
    return Buffer.concat([stringHeader, text]);
  });
  return biffRecord(0x00fc, Buffer.concat([header, ...values]));
}

export function biffLabelSst(row, column, stringIndex) {
  const data = Buffer.alloc(10);
  data.writeUInt16LE(row, 0);
  data.writeUInt16LE(column, 2);
  data.writeUInt32LE(stringIndex, 6);
  return biffRecord(0x00fd, data);
}

export function biffNumber(row, column, value) {
  const data = Buffer.alloc(14);
  data.writeUInt16LE(row, 0);
  data.writeUInt16LE(column, 2);
  data.writeDoubleLE(value, 6);
  return biffRecord(0x0203, data);
}

/** A formula cell as Excel 97-2003 stores it: the formula's last result, then its (here empty) expression. */
export function biffFormula(row, column, value) {
  const data = Buffer.alloc(22);
  data.writeUInt16LE(row, 0);
  data.writeUInt16LE(column, 2);
  data.writeDoubleLE(value, 6);
  return biffRecord(0x0006, data);
}

export function sampleLegacyXls(headerRow = 0, dataRow = 1, moreCells = []) {
  const strings = ['Account', 'Current Period', 'Prior Period', 'Payroll Taxes and Benefits-Direct', 'Total Expenses'];
  const sheet = Buffer.concat([
    biffBof(0x0010),
    biffLabelSst(headerRow, 0, 0), biffLabelSst(headerRow, 1, 1), biffLabelSst(headerRow, 2, 2),
    biffLabelSst(dataRow, 0, 3), biffNumber(dataRow, 1, 225), biffNumber(dataRow, 2, 215),
    ...moreCells,
    biffRecord(0x000a),
  ]);
  const sheetName = Buffer.from('Accounting', 'latin1');
  const boundData = Buffer.alloc(8 + sheetName.length);
  boundData[6] = sheetName.length;
  sheetName.copy(boundData, 8);
  const globalsWithoutOffset = [biffBof(0x0005), biffSst(strings), biffRecord(0x0085, boundData), biffRecord(0x000a)];
  boundData.writeUInt32LE(globalsWithoutOffset.reduce((total, part) => total + part.length, 0), 0);
  const workbook = Buffer.concat([...globalsWithoutOffset, sheet]);
  const workbookStream = Buffer.alloc(4096);
  workbook.copy(workbookStream);

  const header = Buffer.alloc(512, 0);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(header);
  header.writeUInt16LE(0x003e, 24);
  header.writeUInt16LE(3, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(1, 44);
  header.writeUInt32LE(0, 48);
  header.writeUInt32LE(4096, 56);
  header.writeUInt32LE(0xfffffffe, 60);
  header.writeUInt32LE(0, 64);
  header.writeUInt32LE(0xfffffffe, 68);
  header.writeUInt32LE(0, 72);
  for (let index = 0; index < 109; index += 1) header.writeUInt32LE(0xffffffff, 76 + index * 4);
  header.writeUInt32LE(9, 76);

  const directory = Buffer.alloc(512);
  const writeDirectoryEntry = (offset, name, type, startSector, size) => {
    const encoded = Buffer.from(`${name}\0`, 'utf16le');
    encoded.copy(directory, offset, 0, Math.min(encoded.length, 64));
    directory.writeUInt16LE(Math.min(encoded.length, 64), offset + 64);
    directory[offset + 66] = type;
    directory.writeUInt32LE(0xffffffff, offset + 68);
    directory.writeUInt32LE(0xffffffff, offset + 72);
    directory.writeUInt32LE(0xffffffff, offset + 76);
    directory.writeUInt32LE(startSector, offset + 116);
    directory.writeBigUInt64LE(BigInt(size), offset + 120);
  };
  writeDirectoryEntry(0, 'Root Entry', 5, 0xfffffffe, 0);
  writeDirectoryEntry(128, 'Workbook', 2, 1, workbookStream.length);

  const fat = Buffer.alloc(512, 0xff);
  fat.writeUInt32LE(0xfffffffe, 0);
  for (let sector = 1; sector < 8; sector += 1) fat.writeUInt32LE(sector + 1, sector * 4);
  fat.writeUInt32LE(0xfffffffe, 8 * 4);
  fat.writeUInt32LE(0xfffffffd, 9 * 4);
  return Buffer.concat([header, directory, workbookStream, fat]);
}

/** A number stored as Excel's compact RK form, as Excel writes whole numbers. */
export function biffRk(row, column, raw) {
  const data = Buffer.alloc(10);
  data.writeUInt16LE(row, 0);
  data.writeUInt16LE(column, 2);
  data.writeUInt32LE(raw >>> 0, 6);
  return biffRecord(0x027e, data);
}

/** Several RK numbers side by side in one row, from `column` on. */
export function biffMulRk(row, column, raws) {
  const data = Buffer.alloc(4 + raws.length * 6 + 2);
  data.writeUInt16LE(row, 0);
  data.writeUInt16LE(column, 2);
  raws.forEach((raw, index) => data.writeUInt32LE(raw >>> 0, 4 + index * 6 + 2));
  data.writeUInt16LE(column + raws.length - 1, 4 + raws.length * 6);
  return biffRecord(0x00bd, data);
}

/** The RK form of a whole number. */
export const rkInteger = (value) => ((value << 2) | 2) >>> 0;
