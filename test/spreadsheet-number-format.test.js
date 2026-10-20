import test from 'node:test';
import assert from 'node:assert/strict';
import { builtInNumberFormat, formatSpreadsheetNumber } from '../src/dependencies/spreadsheet-number-format.js';

test('date cells read as calendar dates', () => {
  assert.equal(formatSpreadsheetNumber('45352', builtInNumberFormat(14)), '2024-03-01');
  assert.equal(formatSpreadsheetNumber('45352', 'mmm d, yyyy'), '2024-03-01');
  assert.equal(formatSpreadsheetNumber('45352', 'dd/mm/yyyy'), '2024-03-01');
});

test('dates in the 1904 system and before Excel\'s phantom leap day are correct', () => {
  assert.equal(formatSpreadsheetNumber('43890', 'yyyy-mm-dd', { date1904: true }), '2024-03-01');
  assert.equal(formatSpreadsheetNumber('59', 'yyyy-mm-dd'), '1900-02-28');
  assert.equal(formatSpreadsheetNumber('61', 'yyyy-mm-dd'), '1900-03-01');
});

test('times and date-times keep the parts their format shows', () => {
  assert.equal(formatSpreadsheetNumber('0.5', builtInNumberFormat(20)), '12:00');
  assert.equal(formatSpreadsheetNumber('45352.75', 'yyyy-mm-dd h:mm'), '2024-03-01 18:00');
  assert.equal(formatSpreadsheetNumber('0.000694444', 'h:mm:ss'), '00:01:00');
});

test('percentages read as the sheet shows them', () => {
  assert.equal(formatSpreadsheetNumber('0.153', '0.0%'), '15.3%');
  assert.equal(formatSpreadsheetNumber('0.25', builtInNumberFormat(9)), '25%');
  assert.equal(formatSpreadsheetNumber('-0.0412', builtInNumberFormat(10)), '-4.12%');
});

test('plain numbers, currency and text formats keep the stored value', () => {
  for (const format of [null, 'General', '#,##0.00', '[$€-2] #,##0.00', '_($* #,##0.00_)', '#,##0 "days"', '0.00E+00', '@']) {
    assert.equal(formatSpreadsheetNumber('1234.5', format), null, String(format));
  }
  assert.equal(formatSpreadsheetNumber('', 'yyyy-mm-dd'), null);
  assert.equal(formatSpreadsheetNumber('TBD', 'yyyy-mm-dd'), null);
  assert.equal(formatSpreadsheetNumber('30.5', '[h]:mm'), null, 'elapsed durations are not clock times');
});
