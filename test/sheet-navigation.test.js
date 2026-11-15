// fn and the arrow keys move the card through a spreadsheet or CSV a cell at
// a time: the server answers which cell is beside the one shown.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { workbook } from './fixtures/workbook.js';

const actor = { id: 'human:sheet-walker', displayName: 'Sheet walker', actorType: 'HUMAN_SELF' };

const STATEMENT = `Line,Q1,Q2,Q3
Revenue,485000,512000,530000
Expenses,210000,,240000
Profit,275000,290000,290000
`;

async function directory(t, files) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-sheet-walk-'));
  const root = path.join(sandbox, 'Books');
  fs.mkdirSync(root);
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(root, name), contents);
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  await app.workspace.add([fs.realpathSync(root)], actor);
  t.after(() => { app.close?.(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  return app;
}

const typed = (app, text) => app.workspace.predict({ text, cursor: text.length, blockIndex: 0 });
const candidates = (prediction) => [
  ...prediction.claims.flatMap((claim) => claim.candidates),
  ...prediction.workspaceCompletions.map((item) => item.dependencyCandidate).filter(Boolean),
];
const move = (app, from, direction) => app.workspace.sheetCell({ projectId: from.projectId, objectId: from.id,
  snapshotId: from.snapshotId, direction }).cell;

async function revenueRow(app) {
  const row = candidates(await typed(app, 'Reven')).find((candidate) => candidate.label === 'Revenue');
  assert.ok(row, 'typing "Reven" suggests the Revenue row');
  return row;
}

test('A row in a CSV is marked as a sheet to move through, and keeps its list of values', async (t) => {
  // Arrange
  const app = await directory(t, { 'Statement.csv': STATEMENT });

  // Act
  const row = await revenueRow(app);

  // Assert
  assert.equal(row.sheetGrid, true);
  assert.equal(row.narrowable, true, 'the values list behind fn+Right is kept for other clients');
});

test('Diving into a row lands on its first value, and the arrows move cell to cell', async (t) => {
  // Arrange
  const app = await directory(t, { 'Statement.csv': STATEMENT });
  const row = await revenueRow(app);

  // Act
  const first = move(app, row, 'into');
  const right = move(app, first.object, 'right');
  const down = move(app, right.object, 'down');
  const back = move(app, down.object, 'up');
  const left = move(app, first.object, 'left');

  // Assert
  assert.equal(first.insertText, '485000');
  assert.equal(right.insertText, '512000');
  assert.equal(down.insertText, '290000', 'the empty Q2 cell of Expenses is passed over');
  assert.equal(down.object.label, 'Profit · Q2');
  assert.equal(back.insertText, '512000');
  assert.equal(left.insertText, 'Revenue', 'left of the first value is the row name');
  assert.equal(move(app, left.object, 'left'), null, 'nothing is left of a row name');
});

test('Up from a first row reaches its column name, and past that is the edge', async (t) => {
  // Arrange
  const app = await directory(t, { 'Statement.csv': STATEMENT });
  const first = move(app, await revenueRow(app), 'into');

  // Act
  const header = move(app, first.object, 'up');

  // Assert
  assert.equal(header.insertText, 'Q1');
  assert.equal(move(app, header.object, 'up'), null);
  assert.equal(move(app, header.object, 'right').insertText, 'Q2');
  assert.equal(move(app, header.object, 'down').insertText, '485000');
});

test('A CAD part is not a sheet, so it keeps its list of measurements', async (t) => {
  // Arrange
  const app = await directory(t, { 'Statement.csv': STATEMENT });
  const row = await revenueRow(app);
  const measurement = { ...row, path: 'Bracket.step', objectType: 'DRAWING', anchor: null };

  // Act and Assert
  const { movesInSheet } = await import('../src/dependencies/sheet-navigation.js');
  assert.equal(movesInSheet(measurement), false);
  assert.equal(movesInSheet(row), true);
});

test('A sheet move names its suggestion and a direction', async (t) => {
  const app = await directory(t, { 'Statement.csv': STATEMENT });
  const row = await revenueRow(app);
  assert.throws(() => app.workspace.sheetCell({ ...row, objectId: row.id, direction: 'sideways' }), /into, up, down/);
  assert.throws(() => app.workspace.sheetCell({ direction: 'up' }), /projectId, objectId and snapshotId/);
});

test('Down past the rows held in memory goes on into a large table\'s indexed rows', async (t) => {
  // Arrange: 600 named rows of three values is more cells than are held as objects.
  const lines = ['Item,Cost,Units,Weight', ...Array.from({ length: 600 }, (_, index) => `Item ${index + 1},${1000 + index},${index % 7},${index * 2}`)];
  const app = await directory(t, { 'Inventory.csv': `${lines.join('\n')}\n` });
  const { dependencies } = app.workspace;
  const [project] = app.workspace.activeProjects();
  const cells = dependencies.objectsAt(project.id, null, ['DATASET_VALUE'])
    .filter((object) => object.metadata.column === 'Cost');
  const last = cells.reduce((best, cell) => (cell.anchor.rowIndex > best.anchor.rowIndex ? cell : best));

  // Act
  const next = move(app, { ...last, projectId: project.id }, 'down');

  // Assert
  assert.ok(cells.length < 600, `only the first rows are held (${cells.length})`);
  assert.ok(next, 'a cell below the last held one is found');
  assert.equal(Number(next.insertText), Number(last.valueText) + 1);
  assert.equal(next.object.anchor.rowIndex, last.anchor.rowIndex + 1);
  assert.equal(move(app, next.object, 'up').object.id, last.id, 'up comes back to the same cell');
  assert.equal(move(app, next.object, 'right').object.metadata.column, 'Units', 'an indexed row moves along too');
});

test('An Excel sheet moves the same way, with its own sheet name on each cell', async (t) => {
  // Arrange
  const rows = STATEMENT.trim().split('\n').map((line) => line.split(','));
  const app = await directory(t, { 'Statement.xlsx': workbook('Budget', rows) });
  const row = await revenueRow(app);

  // Act
  const first = move(app, row, 'into');
  const down = move(app, first.object, 'down');

  // Assert
  assert.equal(row.sheetGrid, true);
  assert.equal(first.insertText, '485000');
  assert.equal(down.insertText, '210000');
  assert.equal(down.object.metadata.sheet, 'Budget');
});
