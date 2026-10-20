import test from 'node:test';
import assert from 'node:assert/strict';
import { builtInNumberFormat, displaySpreadsheetNumber, formatSpreadsheetNumber } from '../src/dependencies/spreadsheet-number-format.js';

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

test('previews show numbers the way the sheet displays them', () => {
  const thousands = '#,##0;(#,##0);"-"';
  assert.equal(displaySpreadsheetNumber('485000', thousands), '485,000');
  assert.equal(displaySpreadsheetNumber('-15000', thousands), '(15,000)');
  assert.equal(displaySpreadsheetNumber('0', thousands), '-');
  const dollars = '"$"#,##0;("$"#,##0);"-"';
  assert.equal(displaySpreadsheetNumber('129950', dollars), '$129,950');
  assert.equal(displaySpreadsheetNumber('-12050', dollars), '($12,050)');
  assert.equal(displaySpreadsheetNumber('-0.03', '0.0%;(0.0%);"-"'), '(3.0%)');
  assert.equal(displaySpreadsheetNumber('0.027027', '0.0%;(0.0%);"-"'), '2.7%');
  assert.equal(displaySpreadsheetNumber('0.00038491147036181676', '0.00%;(0.00%);"-"'), '0.04%');
});

test('previews handle common built-in, currency and accounting formats', () => {
  assert.equal(displaySpreadsheetNumber('1234.5', '#,##0.00'), '1,234.50');
  assert.equal(displaySpreadsheetNumber('-1234.5', '#,##0.00'), '-1,234.50');
  assert.equal(displaySpreadsheetNumber('2.5', builtInNumberFormat(1)), '3');
  assert.equal(displaySpreadsheetNumber('1234.567', builtInNumberFormat(4)), '1,234.57');
  assert.equal(displaySpreadsheetNumber('1234.5', '[$€-407] #,##0.00'), '€ 1,234.50');
  assert.equal(displaySpreadsheetNumber('-1000', '#,##0_);[Red](#,##0)'), '(1,000)');
  assert.equal(displaySpreadsheetNumber('1234.5', '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)'), '$1,234.50');
  assert.equal(displaySpreadsheetNumber('0', '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)'), '$-');
  assert.equal(displaySpreadsheetNumber('12.5', '0.0" kg"'), '12.5 kg');
  assert.equal(displaySpreadsheetNumber('1500000', '#,##0,'), '1,500');
  assert.equal(displaySpreadsheetNumber('1500000', '0.0,,"M"'), '1.5M');
  assert.equal(displaySpreadsheetNumber('12345', '0.00E+00'), '1.23E+04');
  assert.equal(displaySpreadsheetNumber('1.005', '0.00'), '1.01', 'halves round away from zero');
  assert.equal(displaySpreadsheetNumber('5', '#.##'), '5.');
  assert.equal(displaySpreadsheetNumber('0', '#,###'), '');
});

test('general numbers drop floating-point noise and unsupported formats keep the stored value', () => {
  assert.equal(displaySpreadsheetNumber('0.30000000000000004', null), '0.3');
  assert.equal(displaySpreadsheetNumber('0.010169491525423728', 'General'), '0.010169492', 'General fits 11 characters');
  assert.equal(displaySpreadsheetNumber('-1234567.891234', null), '-1234567.891');
  assert.equal(displaySpreadsheetNumber('123456789012', null), '123456789012', 'long whole numbers such as IDs keep every digit');
  assert.equal(displaySpreadsheetNumber('1E+20', null), '1E+20');
  assert.equal(displaySpreadsheetNumber('485000', null), '485000');
  for (const format of ['yyyy-mm-dd', 'h:mm', '[>=1000]#,##0;0', '# ?/?', '(000) 000-0000', '@']) {
    assert.equal(displaySpreadsheetNumber('1234.5', format), null, format);
  }
  assert.equal(displaySpreadsheetNumber('TBD', '#,##0'), null);
  assert.equal(displaySpreadsheetNumber('', '#,##0'), null);
});

test('tiny and huge numbers never display as NaN', () => {
  assert.equal(displaySpreadsheetNumber('1.1102230246251565E-16', '#,##0.00'), '0.00');
  assert.equal(displaySpreadsheetNumber('-1.1368683772161603E-13', '"$"#,##0.00;("$"#,##0.00);"-"'), '($0.00)');
  assert.equal(displaySpreadsheetNumber('3.2E-7', null), '0.00000032');
  assert.equal(displaySpreadsheetNumber('5E-7', 'General'), '0.0000005');
  assert.equal(displaySpreadsheetNumber('1E-9', '0%'), '0%');
  assert.equal(displaySpreadsheetNumber('1e21', '0'), null, 'beyond Excel precision keeps the stored value');
});

test('General inside a styled section and engineering notation are not misread', () => {
  assert.equal(displaySpreadsheetNumber('5', '[Red]General'), '5');
  assert.equal(displaySpreadsheetNumber('-5', 'General;[Red]-General'), null);
  assert.equal(displaySpreadsheetNumber('5', 'General" kg"'), null);
  assert.equal(displaySpreadsheetNumber('12345', builtInNumberFormat(48)), null);
  assert.equal(displaySpreadsheetNumber('12345', '##0.0E+0'), null);
});
