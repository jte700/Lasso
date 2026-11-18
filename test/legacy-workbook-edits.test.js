// A number in an Excel 97-2003 workbook (.xls) changed where it is stored,
// as a review's suggestion or an AI's edit makes it: the cell's value bytes
// and nothing else, so the file stays as Excel wrote it. Cells Lasso cannot
// change that way (formulas, text, empty cells) are refused with a reason.

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSpreadsheetTables } from '../src/dependencies/document-extraction.js';
import { setLegacyWorkbookCells } from '../src/review/legacy-workbook.js';
import { biffFormula, biffLabelSst, biffMulRk, biffRk, rkInteger, sampleLegacyXls } from './fixtures/legacy-xls.js';

/** Row 2 holds numbers as Excel writes them most plainly, row 3 a formula and an RK number, row 4 two numbers in one MULRK. */
const workbook = () => sampleLegacyXls(0, 1, [biffLabelSst(2, 0, 4), biffFormula(2, 1, 450), biffRk(2, 2, rkInteger(430)),
  biffMulRk(3, 1, [rkInteger(10), rkInteger(20)])]);
const cell = (row, column, value) => ({ sheet: 'Accounting', row, column, value });

test('A number in an .xls is changed where it is stored, and every other byte stays as it was', () => {
  // Arrange
  const before = workbook();

  // Act
  const after = setLegacyWorkbookCells(before, [cell(2, 1, '250'), cell(3, 2, '445'), cell(4, 2, '12.5'), cell(4, 1, '-3')]);

  // Assert
  const [sheet] = extractSpreadsheetTables(after);
  assert.deepEqual(sheet.rows[1], ['Payroll Taxes and Benefits-Direct', '250', '215']);
  assert.deepEqual(sheet.rows[2], ['Total Expenses', '450', '445']);
  assert.deepEqual(sheet.rows[3].slice(1), ['-3', '12.5']);
  assert.equal(after.length, before.length);
  const changed = [...after].filter((byte, index) => byte !== before[index]).length;
  assert.ok(changed > 0 && changed <= 20, `only the four values' bytes change (${changed})`);
});

test('A formula, words, an empty cell or a value that is not a number are not written into an .xls', () => {
  // Arrange
  const before = workbook();
  const write = (edit) => () => setLegacyWorkbookCells(before, [edit]);

  // Act and Assert
  assert.throws(write(cell(3, 1, '500')), /B3 holds a formula/);
  assert.throws(write(cell(2, 0, '500')), /A2 holds words/);
  assert.throws(write(cell(2, 3, '500')), /D2 is empty/);
  assert.throws(write(cell(2, 1, 'fifty')), /only numbers/);
  assert.throws(write(cell(3, 2, '1.23456')), /can.t hold 1\.23456/);
  assert.throws(write({ ...cell(2, 1, '5'), sheet: 'Budget' }), /no sheet named Budget/);
});
