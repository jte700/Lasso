// "Open file" lands where a preview cites: the worksheet cell, PDF page or
// text line. Previews report that place as `openAt` for the native opener.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInspectorPreview, buildSharePreview, buildTextPreview } from '../src/sharing/share-preview.js';
import { renderInspectorPanel } from '../src/sharing/share-page.js';

function storedZip(entries) {
  const localParts = [], centralParts = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name), data = Buffer.from(value);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(local, nameBuffer, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28); central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }
  const directory = Buffer.concat(centralParts), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end]);
}

const cell = (reference, index) => `<c r="${reference}" t="s"><v>${index}</v></c>`;
const number = (reference, value) => `<c r="${reference}"><v>${value}</v></c>`;

// Two sheets. "Cash Forecast" starts at C5 below a title and blank rows, so
// its compacted row indexes differ from the worksheet's row numbers.
const workbook = storedZip({
  'xl/workbook.xml': '<workbook><sheets><sheet name="Budget vs Actual" r:id="rId1"/><sheet name="Cash Forecast" r:id="rId2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>Account</t></si><si><t>Actual</t></si><si><t>Rent</t></si><si><t>Marketing</t></si>'
    + '<si><t>Cash Forecast</t></si><si><t>Week</t></si><si><t>Receipts</t></si><si><t>W1</t></si><si><t>W2</t></si></sst>',
  'xl/worksheets/sheet1.xml': '<worksheet><sheetData>'
    + `<row r="1">${cell('A1', 0)}${cell('B1', 1)}</row>`
    + `<row r="2">${cell('A2', 2)}${number('B2', 18000)}</row>`
    + `<row r="3">${cell('A3', 3)}${number('B3', 14000)}</row>`
    + '</sheetData></worksheet>',
  'xl/worksheets/sheet2.xml': '<worksheet><sheetData>'
    + `<row r="1">${cell('C1', 4)}</row>`
    + `<row r="5">${cell('C5', 5)}${cell('D5', 6)}</row>`
    + `<row r="6">${cell('C6', 7)}${number('D6', 125400)}</row>`
    + `<row r="7">${cell('C7', 8)}${number('D7', 47000)}</row>`
    + '</sheetData></worksheet>',
});

test('a cited worksheet cell opens at its sheet and physical cell, not the compacted row index', () => {
  // rowIndex 3 is the fourth non-empty row of "Cash Forecast": worksheet row 7.
  const anchor = { kind: 'table-cell', rowKey: 'W2', rowIndex: 3, column: 'Receipts', columnIndex: 3, sheet: 'Cash Forecast' };
  const file = { path: 'Finance-Planning.xlsx', content: workbook };
  const suggestion = buildSharePreview(file, anchor, {}, 2, 'DATASET_VALUE', { display: true });
  assert.equal(suggestion.location, 'Cash Forecast · D7');
  assert.deepEqual(suggestion.openAt, { sheet: 'Cash Forecast', cell: 'D7' });
  const inspector = buildInspectorPreview(file, anchor, {}, 'W2 · Receipts', 'DATASET_VALUE');
  assert.deepEqual(inspector.openAt, { sheet: 'Cash Forecast', cell: 'D7' });
});

test('row and variable citations open at the cell the preview highlights', () => {
  const file = { path: 'Finance-Planning.xlsx', content: workbook };
  const row = buildSharePreview(file, { kind: 'table-row', rowKey: 'Marketing', rowIndex: 2, sheet: 'Budget vs Actual' },
    {}, 2, 'DATASET_ROW', { display: true });
  assert.deepEqual(row.openAt, { sheet: 'Budget vs Actual', cell: 'A3' });
  const variable = buildSharePreview(file, { kind: 'table-column', column: 'Receipts', columnIndex: 3, sheet: 'Cash Forecast' },
    { variable: 'Receipts' }, 2, 'VARIABLE', { display: true });
  assert.equal(variable.location, 'Cash Forecast · D5 (column header)');
  assert.deepEqual(variable.openAt, { sheet: 'Cash Forecast', cell: 'D5' });
});

test('CSV cells open at their physical cell with no sheet, and at their text line in an editor', () => {
  const file = { path: 'accounts.csv', content: Buffer.from('Department,Actual,Budget\nPeople,76000,74000\nMarketing,14000,16000') };
  const anchor = { kind: 'table-cell', rowIndex: 2, rowKey: 'Marketing', columnIndex: 1 };
  assert.deepEqual(buildSharePreview(file, anchor, {}, 2, 'DATASET_VALUE').openAt, { sheet: null, cell: 'B3', line: 3 });
  assert.deepEqual(buildInspectorPreview(file, anchor, {}, 'Marketing · Actual', 'DATASET_VALUE').openAt, { sheet: null, cell: 'B3', line: 3 });
});

test('a quoted CSV field that spans lines moves later records to later text lines', () => {
  const file = { path: 'notes.csv', content: Buffer.from('Item,Note,Amount\nRent,"Due on\nthe first",1800\nPhone,Monthly,90') };
  const anchor = { kind: 'table-cell', rowIndex: 2, rowKey: 'Phone', columnIndex: 2 };
  assert.deepEqual(buildSharePreview(file, anchor, {}, 2, 'DATASET_VALUE').openAt, { sheet: null, cell: 'C3', line: 4 });
});

test('a whole-column citation opens at the column heading', () => {
  const file = { path: 'Finance-Planning.xlsx', content: workbook };
  const column = buildSharePreview(file, { kind: 'table-column', column: 'Receipts', columnIndex: 3, sheet: 'Cash Forecast' },
    {}, 2, 'TABLE', { display: true });
  assert.equal(column.location, 'Cash Forecast · Column D (all values)');
  assert.deepEqual(column.openAt, { sheet: 'Cash Forecast', cell: 'D5' });
});

test('public share previews carry no local open target', () => {
  const file = { path: 'Finance-Planning.xlsx', content: workbook };
  const shared = buildSharePreview(file, { kind: 'table-cell', rowIndex: 3, columnIndex: 3, sheet: 'Cash Forecast' });
  assert.equal(shared.openAt, undefined);
});

test('text sources open at the first cited line; Word documents also carry the cited words', () => {
  const plain = buildTextPreview('notes.txt', 'Intro\nThe retainer is $4,500.\nOutro', { lineStart: 2, lineEnd: 2 });
  assert.deepEqual(plain.openAt, { line: 2 });
  const markdown = buildTextPreview('brief.md', '# Brief\n\nCash on hand is $472,000.\n', { lineStart: 3 });
  assert.deepEqual(markdown.openAt, { line: 3 });
  const word = buildTextPreview('memo.docx', 'Heading\nPayment is due within 30 days.\nSignature', { lineStart: 2 });
  assert.deepEqual(word.openAt, { line: 2, text: 'Payment is due within 30 days.', occurrence: 1 });
  const whole = buildTextPreview('memo.txt', 'One\nTwo', {}, {}, '', 'DOCUMENT');
  assert.equal(whole.openAt, null);
});

test('Word finds the cited occurrence of repeated words, shortened to fit its search', () => {
  // "Fees" appears first in the contents, then as the cited heading.
  const contents = buildTextPreview('agreement.docx', 'Contents\nFees\nTerm\n\nFees\nThe fee is CAD 4,500.', { lineStart: 5 });
  assert.deepEqual(contents.openAt, { line: 5, text: 'Fees', occurrence: 2 });
  const line = 'Payment terms apply to every invoice. '.repeat(12).trim();
  const paragraph = buildTextPreview('agreement.docx', `Intro\n${line}`, { lineStart: 2 });
  const { text } = paragraph.openAt;
  assert.ok(text.length <= 200 && line.startsWith(text) && line[text.length] === ' ', 'shortened at a word');
  assert.equal(paragraph.openAt.occurrence, 1);
});

test('the inspector sends its open target with the local open action', () => {
  const preview = { kind: 'pdf', page: 3, pageNumber: 3, fileUrl: '/source.pdf', openAt: { page: 3 } };
  const html = renderInspectorPanel({ source: { label: 'Fee', filename: 'Plan.pdf', absolutePath: '/tmp/Plan.pdf' } }, 'reference', preview);
  assert.match(html, /"openAt":\{"page":3\}/);
});
