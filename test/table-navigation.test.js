import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { workbook, workbookSheets } from './fixtures/workbook.js';
import { navigateTableSource } from '../src/dependencies/table-navigation.js';

test('table arrows preserve the other axis, reverse, skip empty values and stop at edges', async (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-navigation-'));
  const root = path.join(sandbox, 'Sources');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Costs.csv'), 'Item,Cost,Actual,Forecast\nPaper,12,13,14\nInk,30,,32\nToner,55,56,57\n');
  fs.writeFileSync(path.join(root, 'Other.csv'), 'Item,Cost,Actual\nPaper,999,888\n');
  const app = createApplication({ dataDir: path.join(sandbox, 'data'), watchProjects: false, port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const { project } = app.timeline.importProject(root, { id: 'human:test', displayName: 'Test', actorType: 'HUMAN_SELF' }, { watch: false });
  app.dependencies.ensureIndex(project.id);
  const objects = app.dependencies.objectsAt(project.id);
  const row = objects.find(o => o.path === 'Costs.csv' && o.objectType === 'DATASET_ROW' && o.label === 'Paper');
  const move = (source, direction) => navigateTableSource(app.dependencies, source, direction);
  const first = move(row, 'right');
  assert.equal(first.valueText, '12');
  const second = move(first, 'right');
  assert.equal(second.valueText, '13');
  const third = move(second, 'right');
  assert.equal(third.valueText, '14');
  assert.equal(move(third, 'right'), null);
  assert.equal(move(second, 'left').id, first.id);
  assert.equal(move(first, 'left').id, row.id);
  assert.equal(move(row, 'left'), null);
  assert.equal(move(second, 'down').valueText, '56');
  assert.equal(move(move(second, 'down'), 'up').id, second.id);
  assert.equal(move(second, 'up'), null);
  assert.equal(move(first, 'down').valueText, '30');
  assert.equal(move({ ...first, anchor: { kind: 'line-range' } }, 'right'), null);
  assert.throws(() => move(first, 'sideways'), /direction/i);
  await app.workspace.add([root], { id: 'human:test', displayName: 'Test', actorType: 'HUMAN_SELF' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(`${base}/api/dependency-objects/${first.id}/navigate?version=${first.versionId}&direction=right`);
  assert.equal(response.status, 200);
  const next = (await response.json()).source;
  assert.equal(next.id, second.id);
  const preview = await fetch(`${base}/api/dependency-objects/${next.id}/preview?version=${next.versionId}`);
  assert.equal(preview.status, 200);
  const invalid = await fetch(`${base}/api/dependency-objects/${first.id}/navigate?direction=sideways`);
  assert.equal(invalid.status, 400);

});

test('a dive starts at the suggested cell, or a whole file at its top-left cell', async (t) => {
  // Arrange
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-navigation-dive-'));
  const root = path.join(sandbox, 'Sources');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Invoices.csv'), 'Invoice,Amount\nBILL-1,120\nBILL-2,340\n');
  const app = createApplication({ dataDir: path.join(sandbox, 'data'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const { project } = app.timeline.importProject(root, { id: 'human:test', displayName: 'Test', actorType: 'HUMAN_SELF' }, { watch: false });
  app.dependencies.ensureIndex(project.id);
  const objects = app.dependencies.objectsAt(project.id).filter(o => o.path === 'Invoices.csv');
  const cell = objects.find(o => o.anchor?.kind === 'table-cell' && o.valueText === '340');
  const file = objects.find(o => !['table-row', 'table-cell', 'table-column'].includes(o.anchor?.kind));
  // Act
  const fromCell = navigateTableSource(app.dependencies, cell, 'here');
  const fromFile = navigateTableSource(app.dependencies, file, 'here');
  // Assert
  assert.equal(fromCell.id, cell.id);
  assert.ok(fromFile, 'the whole file dives in somewhere');
  const topLeft = objects.filter(o => ['table-row', 'table-cell'].includes(o.anchor?.kind))
    .map(o => o.anchor.rowIndex).sort((a, b) => a - b)[0];
  assert.equal(fromFile.anchor.rowIndex, topLeft);
  assert.equal(navigateTableSource(app.dependencies, fromFile, 'left'), null);
});

test('a ledger whose rows are named further right dives in at its first column, and its row stands at its name', async (t) => {
  // Arrange: rows are named by Account Code, so Date in column A sits left of the names.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-navigation-ledger-'));
  const root = path.join(sandbox, 'Sources');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Ledger.csv'), 'Date,Journal ID,Account Code,Account,Debit CAD,Credit CAD,Reference,Description\n'
    + '2026-09-03,JE-0901,1100,Accounts receivable,38500,0,INV-0921,Customer invoice posted\n'
    + '2026-09-03,JE-0901,4000,Revenue,0,38500,INV-0921,Customer invoice posted\n');
  const app = createApplication({ dataDir: path.join(sandbox, 'data'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const { project } = app.timeline.importProject(root, { id: 'human:test', displayName: 'Test', actorType: 'HUMAN_SELF' }, { watch: false });
  app.dependencies.ensureIndex(project.id);
  const objects = app.dependencies.objectsAt(project.id).filter(o => o.path === 'Ledger.csv');
  const file = objects.find(o => !o.anchor);
  const dateColumn = objects.find(o => o.anchor?.kind === 'table-column' && o.label === 'Date');
  const journal = objects.find(o => o.anchor?.kind === 'table-cell' && o.valueText === 'JE-0901');
  const move = (source, direction) => navigateTableSource(app.dependencies, source, direction);
  // Act
  const fromFile = move(file, 'here');
  const fromColumn = move(dateColumn, 'here');
  // Assert
  assert.equal(fromFile?.valueText, '2026-09-03');
  assert.equal(fromColumn?.id, fromFile.id);
  assert.equal(move(journal, 'left')?.valueText, '2026-09-03');
  const name = move(journal, 'right');
  assert.equal(name?.anchor.kind, 'table-row');
  assert.equal(move(name, 'right')?.valueText, 'Accounts receivable');
  assert.equal(move(name, 'left')?.id, journal.id);
});

test('a workbook dives into its first sheet at the top-left, and a column on another sheet at its top', async (t) => {
  // Arrange: the second sheet starts lower down, below a title.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-navigation-sheets-'));
  const root = path.join(sandbox, 'Sources');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Planning.xlsx'), workbookSheets({
    Budget: { 1: ['Account', 'Actual', 'Budget'], 2: ['Rent', '18000', '19000'], 3: ['Travel', '4200', '5000'] },
    Cash: { 1: ['Cash forecast'], 4: ['Week', 'Receipts', 'Payments'], 5: ['W1', '125400', '98000'], 6: ['W2', '47000', '51000'] },
  }));
  const app = createApplication({ dataDir: path.join(sandbox, 'data'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const { project } = app.timeline.importProject(root, { id: 'human:test', displayName: 'Test', actorType: 'HUMAN_SELF' }, { watch: false });
  const objects = app.dependencies.objectsAt(project.id).filter(o => o.path === 'Planning.xlsx');
  const file = objects.find(o => !o.anchor);
  const payments = objects.find(o => o.anchor?.kind === 'table-column' && o.label === 'Payments');
  const move = (source, direction) => navigateTableSource(app.dependencies, source, direction);
  // Act
  const fromFile = move(file, 'here');
  const fromPayments = move(payments, 'here');
  // Assert
  assert.equal(fromFile?.label, 'Rent');
  assert.equal(fromFile.anchor.sheet, 'Budget');
  assert.equal(fromPayments?.valueText, '98000');
  assert.equal(fromPayments.anchor.sheet, 'Cash');
  assert.equal(move(fromPayments, 'down')?.valueText, '51000');
  assert.equal(move(move(fromPayments, 'left'), 'left')?.label, 'W1');
});

test('table movement never crosses sheets or versions', () => {
  const cell = (id, sheet, snapshotId, columnIndex) => ({ id, path: 'Book.xlsx', projectId: 'p', snapshotId,
    anchor: { kind: 'table-cell', sheet, rowIndex: 4, columnIndex } });
  const origin = cell('a', 'First', 'v1', 1);
  const service = { sourceProjectId: () => 'p', snapshotTables: () => [], tableLabelColumn: () => 0,
    objectsAt: (project, snapshot) => {
      assert.equal(project, 'p'); assert.equal(snapshot, 'v1');
      return [origin, cell('other-sheet', 'Second', 'v1', 2), cell('b', 'First', 'v1', 3)];
    } };
  assert.equal(navigateTableSource(service, origin, 'right').id, 'b');
});


test('Excel movement continues into rows beyond the prediction index', async (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-navigation-deep-'));
  const root = path.join(sandbox, 'Sources');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Costs.xlsx'), workbook('Costs', Object.fromEntries([
    ['Item', 'Cost', 'Actual'], ...Array.from({ length: 850 }, (_, i) => [`Item ${i}`, i + 10, i + 20])
  ].map((row, index) => [index + 1, row]))));
  const app = createApplication({ dataDir: path.join(sandbox, 'data'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const { project } = app.timeline.importProject(root, { id: 'human:test', displayName: 'Test', actorType: 'HUMAN_SELF' }, { watch: false });
  app.dependencies.ensureIndex(project.id);
  const cells = app.dependencies.objectsAt(project.id).filter(o => o.anchor?.kind === 'table-cell' && o.anchor.columnIndex === 1);
  const last = cells.sort((a, b) => b.anchor.rowIndex - a.anchor.rowIndex)[0];
  assert.ok(last.anchor.rowIndex < 851);
  const next = navigateTableSource(app.dependencies, last, 'down');
  assert.equal(next.anchor.rowIndex, last.anchor.rowIndex + 1);
  assert.equal(next.anchor.columnIndex, 1);
  assert.equal(navigateTableSource(app.dependencies, next, 'up').id, last.id);
  assert.equal(navigateTableSource(app.dependencies, next, 'right').anchor.columnIndex, 2);
  assert.ok(app.dependencies.sourceVersion(next.id, next.snapshotId));
});

test('worksheet row labels behind spacer columns remain reachable', async (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-navigation-spacer-'));
  const root = path.join(sandbox, 'Sources');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Costs.xlsx'), workbook('Budget', {
    3: ['', '', 'Account', 'Actual', 'Budget'],
    4: ['', '', 'Revenue', '485000', '500000'],
    5: ['', '', 'Rent', '18000', '19000'],
  }));
  const app = createApplication({ dataDir: path.join(sandbox, 'data'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const { project } = app.timeline.importProject(root, { id: 'human:test', displayName: 'Test', actorType: 'HUMAN_SELF' }, { watch: false });
  const objects = app.dependencies.objectsAt(project.id);
  const row = objects.find(o => o.objectType === 'DATASET_ROW' && o.label === 'Revenue');
  const first = navigateTableSource(app.dependencies, row, 'right');
  assert.equal(first.valueText, '485000');
  assert.equal(first.anchor.columnIndex, 3);
  assert.equal(navigateTableSource(app.dependencies, first, 'left').id, row.id);
  assert.equal(navigateTableSource(app.dependencies, row, 'down').label, 'Rent');
});
