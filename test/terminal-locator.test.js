// The terminal and agent answers cite a workbook cell by the address the
// workbook itself shows. Worksheet anchors already hold the sheet's own row
// number; anchors without that mark count rows from 0.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { sourceLocator } from '../src/terminal/names.js';
import { storedZip } from './fixtures/workbook.js';

const actor = { id: 'human:writer', displayName: 'Writer', actorType: 'HUMAN_SELF' };

const book = storedZip({
  'xl/workbook.xml': '<workbook><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml': `<worksheet><sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>Line</t></is></c><c r="B1" t="inlineStr"><is><t>Amount</t></is></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>Payroll</t></is></c><c r="B2"><v>18400</v></c></row>
  </sheetData></worksheet>`,
});

function indexed(t) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-terminal-locator-')));
  const root = path.join(sandbox, 'Budget');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'budget.xlsx'), book);
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const project = app.timeline.importProject(root, actor, { watch: false }).project;
  app.dependencies.ensureIndex(project.id);
  return { app, project };
}

test('A workbook cell is cited at the address the workbook shows', (t) => {
  // Arrange
  const { app, project } = indexed(t);

  // Act
  const objects = app.terminal.graph.namedObjects(project.id);
  const cell = objects.find((object) => object.anchor?.kind === 'table-cell' && object.valueText === '18400');
  const row = objects.find((object) => object.anchor?.kind === 'table-row' && object.anchor.rowIndex === cell?.anchor.rowIndex);

  // Assert
  assert.equal(cell?.anchor.rowCoordinate, 'worksheet', 'the index keeps the sheet\'s own row number');
  assert.equal(cell.locator, 'Budget!B2');
  assert.equal(row?.locator, 'Budget!2:2');
});

test('A worksheet anchor names its row as is, and an anchor without that mark counts from 0', () => {
  // Arrange
  const workbook = 'Finance/budget.xlsx';
  const sheetRows = { sheet: 'Budget', rowCoordinate: 'worksheet' };

  // Act
  const located = {
    worksheetCell: sourceLocator({ path: workbook, anchor: { kind: 'table-cell', rowIndex: 2, columnIndex: 1, ...sheetRows } }),
    worksheetRow: sourceLocator({ path: workbook, anchor: { kind: 'table-row', rowIndex: 2, ...sheetRows } }),
    countedCell: sourceLocator({ path: workbook, anchor: { kind: 'table-cell', rowIndex: 1, columnIndex: 1, sheet: 'Budget' } }),
    countedRow: sourceLocator({ path: workbook, anchor: { kind: 'table-row', rowIndex: 1, sheet: 'Budget' } }),
    delimitedWorksheetCell: sourceLocator({ path: 'income.csv', anchor: { kind: 'table-cell', rowIndex: 2, column: 'Amount', rowCoordinate: 'worksheet' } }),
    delimitedWorksheetRow: sourceLocator({ path: 'income.csv', anchor: { kind: 'table-row', rowIndex: 2, rowCoordinate: 'worksheet' } }),
    delimitedCountedCell: sourceLocator({ path: 'income.csv', anchor: { kind: 'table-cell', rowIndex: 1, column: 'Amount' } }),
    delimitedCountedRow: sourceLocator({ path: 'income.csv', anchor: { kind: 'table-row', rowIndex: 1 } }),
  };

  // Assert
  assert.deepEqual(located, {
    worksheetCell: 'Budget!B2',
    worksheetRow: 'Budget!2:2',
    countedCell: 'Budget!B2',
    countedRow: 'Budget!2:2',
    delimitedWorksheetCell: 'row 2 · Amount',
    delimitedWorksheetRow: 'row 2',
    delimitedCountedCell: 'row 2 · Amount',
    delimitedCountedRow: 'row 2',
  });
});
