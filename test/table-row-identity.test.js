// A table's rows, cells and columns keep their identity when the table is
// edited. A row with a name is known by that name (and, when the name
// repeats, by which of the equally named rows it is); a row without one is
// matched to the row it was in the file's previous version. So inserting,
// sorting or editing rows leaves links to the other cells where they were.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { anchorForSpan } from '../src/dependencies/service.js';
import { stableRowIdentities } from '../src/dependencies/row-identity.js';
import { diffInternals } from '../src/history/diff.js';

const writer = { id: 'human:writer', displayName: 'Writer', actorType: 'HUMAN_SELF' };

const LEDGER = 'Account,2026\nAdvertising,1200\nBad debt,300\nRent,900\n';
// Tidy readings: every column repeats its values, so no column names the rows.
const READINGS = ['Year,Age,Deaths', '1990,30,5', '1990,40,7', '1991,30,5', '1991,40,9', '1992,30,4', '1992,40,9'];

function workspace(t, files) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-row-identity-')));
  const root = path.join(sandbox, 'Ledger');
  fs.mkdirSync(root);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
  const application = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  t.after(async () => {
    await application.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const project = application.timeline.importProject(root, writer, { watch: false }).project;
  const save = (name, content) => {
    fs.writeFileSync(path.join(root, name), content);
    return application.timeline.capture(project.id, writer);
  };
  const objects = (file) => application.dependencies.objectsAt(project.id).filter((object) => object.path === file);
  return { application, project, root, save, objects };
}

const tableCells = (objects) => objects.filter((object) => object.anchor?.kind === 'table-cell');
const idsByLabel = (objects) => new Map(objects.map((object) => [object.label, object.id]));
/** A cell of a table without row names, by its row's values and its column. */
const cellsByContent = (objects) => {
  const rows = new Map();
  for (const cell of tableCells(objects)) {
    const row = rows.get(cell.anchor.rowIndex) ?? [];
    rows.set(cell.anchor.rowIndex, [...row, cell]);
  }
  const output = new Map();
  for (const cells of rows.values()) {
    const content = cells.map((cell) => `${cell.anchor.column}=${cell.valueText}`).sort().join(',');
    for (const cell of cells) output.set(`${content} · ${cell.anchor.column}`, cell.id);
  }
  return output;
};
/** An object's key without its file id, which differs from one import to the next. */
const localKey = (object) => object.objectKey.slice(object.objectKey.indexOf(':') + 1);

function spanAnchor(content, text) {
  const blocks = diffInternals.markdownBlocks(content);
  const blockIndex = blocks.findIndex((block) => block.text.includes(text));
  const block = blocks[blockIndex];
  const start = block.text.indexOf(text);
  return anchorForSpan(blockIndex, block.type, block.text, start, start + text.length);
}

test('A cell keeps its identity when a row is inserted above it', (t) => {
  // Arrange
  const { save, objects } = workspace(t, { 'ledger.csv': LEDGER });
  const before = idsByLabel(tableCells(objects('ledger.csv')));

  // Act
  save('ledger.csv', 'Account,2026\nInsurance,450\nAdvertising,1200\nBad debt,300\nRent,900\n');

  // Assert
  const after = idsByLabel(tableCells(objects('ledger.csv')));
  assert.equal(before.size, 3);
  for (const [label, id] of before) assert.equal(after.get(label), id, label);
  assert.ok(after.has('Insurance · 2026'));
});

test('A cell keeps its identity when rows are sorted', (t) => {
  // Arrange
  const { save, objects } = workspace(t, { 'ledger.csv': LEDGER });
  const before = idsByLabel(tableCells(objects('ledger.csv')));

  // Act
  save('ledger.csv', 'Account,2026\nRent,900\nBad debt,300\nAdvertising,1200\n');

  // Assert
  assert.deepEqual(idsByLabel(tableCells(objects('ledger.csv'))), before);
});

test('Repeated row labels keep their order-based identity', (t) => {
  // Arrange
  const { save, objects } = workspace(t, { 'ledger.csv': 'Account,Q1,Q2\nRent,10,20\nPower,5,6\nRent,30,40\n' });
  const rowKeys = () => objects('ledger.csv').filter((object) => object.objectType === 'DATASET_ROW')
    .map((object) => [localKey(object), object.anchor.rowIndex]).sort((left, right) => left[1] - right[1]);
  const before = new Map(tableCells(objects('ledger.csv')).map((object) => [object.valueText, object.id]));

  // Act
  save('ledger.csv', 'Account,Q1,Q2\nWater,1,2\nRent,10,20\nPower,5,6\nRent,30,40\n');

  // Assert
  assert.deepEqual(rowKeys(), [['row:water', 1], ['row:rent', 2], ['row:power', 3], ['row:rent#2', 4]]);
  const after = new Map(tableCells(objects('ledger.csv')).map((object) => [object.valueText, object.id]));
  for (const value of ['10', '20', '30', '40']) assert.equal(after.get(value), before.get(value), value);
  assert.ok(tableCells(objects('ledger.csv')).some((object) => localKey(object) === 'cell:rent#2:Q1'));
});

test('A link to a moved row stays linked', (t) => {
  // Arrange
  const notes = '# Notes\n\nRent came to 900 dollars.\n';
  const { application, project, save, objects } = workspace(t, { 'ledger.csv': LEDGER, 'notes.md': notes });
  const rent = objects('ledger.csv').find((object) => object.label === 'Rent · 2026');
  const linked = application.dependencies.link(project.id, {
    documentPath: 'notes.md', anchor: spanAnchor(notes, '900 dollars'), spanText: '900 dollars',
    sourceObjectId: rent.id, sourceSnapshotId: rent.snapshotId, selectionMethod: 'MANUAL',
  }, writer).dependency;

  // Act
  save('ledger.csv', 'Account,2026\nInsurance,450\nAdvertising,1200\nBad debt,300\nRent,900\n');

  // Assert
  const dependency = application.dependencies.getDependency(linked.id);
  assert.equal(dependency.status, 'LINKED');
  assert.equal(dependency.source.id, rent.id);
  assert.match(dependency.statusDetails.sourceMoved, /moved to row 5/i);
  const events = application.timeline.listEvents(project.id);
  assert.ok(events.some((event) => /moved to row 5/i.test(event.title)), 'history records the move');
  assert.ok(!events.some((event) => /broken|needs review/i.test(event.title)));

  // A second pass over the same version records nothing more.
  const count = events.length;
  application.dependencies.reconcileProject(project.id);
  assert.equal(application.timeline.listEvents(project.id).length, count);
});

test('A stale link to a moved row records its move once', (t) => {
  // Arrange
  const notes = '# Notes\n\nRent came to 900 dollars.\n';
  const { application, project, save, objects } = workspace(t, { 'ledger.csv': LEDGER, 'notes.md': notes });
  const rent = objects('ledger.csv').find((object) => object.label === 'Rent · 2026');
  const linked = application.dependencies.link(project.id, {
    documentPath: 'notes.md', anchor: spanAnchor(notes, '900 dollars'), spanText: '900 dollars',
    sourceObjectId: rent.id, sourceSnapshotId: rent.snapshotId, selectionMethod: 'MANUAL',
  }, writer).dependency;

  // Act: the row moves and its value changes.
  save('ledger.csv', 'Account,2026\nInsurance,450\nAdvertising,1200\nBad debt,300\nRent,950\n');
  const count = application.timeline.listEvents(project.id).length;
  application.dependencies.reconcileProject(project.id);

  // Assert
  const dependency = application.dependencies.getDependency(linked.id);
  assert.equal(dependency.status, 'STALE');
  assert.match(dependency.statusDetails.sourceMoved, /moved to row 5/i);
  assert.equal(application.timeline.listEvents(project.id).length, count, 'a second pass records nothing more');
});

test('A link to a cell among the last rows the indexer reads stays linked when rows are inserted above it', (t) => {
  // Arrange: twenty value columns, so the indexer reads only the first rows
  // of a hundred and the table index answers for the rest.
  const header = ['Name', ...Array.from({ length: 20 }, (_, column) => `C${column}`)].join(',');
  const ward = (row) => [`Hospital ward ${row}`, ...Array.from({ length: 20 }, (_, column) => row * 100 + column)].join(',');
  const wards = Array.from({ length: 100 }, (_, row) => ward(row));
  const clinics = Array.from({ length: 10 }, (_, row) => `Clinic ${row},${Array.from({ length: 20 }, () => row).join(',')}`);
  const notes = '# Notes\n\nWard 70 counted 7000 patients.\n';
  const { application, project, save, objects } = workspace(t, { 'wards.csv': `${header}\n${wards.join('\n')}\n`, 'notes.md': notes });
  const cell = objects('wards.csv').find((object) => object.label === 'Hospital ward 70 · C0');
  assert.ok(cell, 'the cell is among the rows the indexer reads');
  const linked = application.dependencies.link(project.id, {
    documentPath: 'notes.md', anchor: spanAnchor(notes, '7000 patients'), spanText: '7000 patients',
    sourceObjectId: cell.id, sourceSnapshotId: cell.snapshotId, selectionMethod: 'MANUAL',
  }, writer).dependency;

  // Act
  save('wards.csv', `${header}\n${[...clinics, ...wards].join('\n')}\n`);

  // Assert
  const dependency = application.dependencies.getDependency(linked.id);
  assert.equal(dependency.status, 'LINKED', JSON.stringify(dependency.statusDetails));
  assert.equal(dependency.source.id, cell.id);
  const current = objects('wards.csv').find((object) => object.id === cell.id);
  assert.equal(current?.anchor.rowIndex, 81);
  assert.equal(current.valueText, '7000');
});

test('A link to one of a large table\'s first rows stays linked when rows inserted above push it past them', (t) => {
  // Arrange
  const wards = Array.from({ length: 3_000 }, (_, row) => `Hospital ward ${row},${row * 3}`);
  const clinics = Array.from({ length: 1_200 }, (_, row) => `Clinic ${row},${row}`);
  const notes = '# Notes\n\nWard 7 counted 21 patients.\n';
  const { application, project, save, objects } = workspace(t, { 'wards.csv': `Name,Patients\n${wards.join('\n')}\n`, 'notes.md': notes });
  const cell = objects('wards.csv').find((object) => object.label === 'Hospital ward 7 · Patients');
  const linked = application.dependencies.link(project.id, {
    documentPath: 'notes.md', anchor: spanAnchor(notes, '21 patients'), spanText: '21 patients',
    sourceObjectId: cell.id, sourceSnapshotId: cell.snapshotId, selectionMethod: 'MANUAL',
  }, writer).dependency;

  // Act
  save('wards.csv', `Name,Patients\n${[...clinics, ...wards].join('\n')}\n`);

  // Assert
  const dependency = application.dependencies.getDependency(linked.id);
  assert.equal(dependency.status, 'LINKED', JSON.stringify(dependency.statusDetails));
  assert.equal(dependency.source.id, cell.id);
  assert.equal(objects('wards.csv').find((object) => object.id === cell.id)?.anchor.rowIndex, 1_208);
});

test('A cell in a table without row names keeps its identity when a row is inserted above it', (t) => {
  // Arrange
  const { save, objects } = workspace(t, { 'readings.csv': `${READINGS.join('\n')}\n` });
  const before = cellsByContent(objects('readings.csv'));
  assert.ok(before.size >= 18, 'every reading is a cell');

  // Act
  save('readings.csv', `${[READINGS[0], '1989,30,3', ...READINGS.slice(1)].join('\n')}\n`);

  // Assert
  const after = cellsByContent(objects('readings.csv'));
  for (const [cell, id] of before) assert.equal(after.get(cell), id, cell);
});

test('A cell in a table without row names keeps its identity when its row is edited', (t) => {
  // Arrange
  const { save, objects } = workspace(t, { 'readings.csv': `${READINGS.join('\n')}\n` });
  const at = (cells) => new Map(tableCells(cells).map((cell) => [`${cell.anchor.rowIndex}:${cell.anchor.column}`, cell]));
  const before = at(objects('readings.csv'));

  // Act: one death more among 40-year-olds in 1991.
  save('readings.csv', `${READINGS.map((line) => (line === '1991,40,9' ? '1991,40,10' : line)).join('\n')}\n`);

  // Assert
  const after = at(objects('readings.csv'));
  for (const [place, cell] of before) assert.equal(after.get(place)?.id, cell.id, place);
  assert.equal(after.get('4:Deaths').valueText, '10');
});

test('A cell in a table without row names keeps its identity when rows are sorted', (t) => {
  // Arrange
  const { save, objects } = workspace(t, { 'readings.csv': `${READINGS.join('\n')}\n` });
  const before = cellsByContent(objects('readings.csv'));

  // Act
  save('readings.csv', `${[READINGS[0], ...READINGS.slice(1).reverse()].join('\n')}\n`);

  // Assert
  assert.deepEqual(cellsByContent(objects('readings.csv')), before);
});

test('A column keeps its identity when a column is inserted before it', (t) => {
  // Arrange
  const { save, objects } = workspace(t, { 'ledger.csv': 'Account,Budget,Actual\nRent,900,950\nPower,80,70\n' });
  const columns = () => new Map(objects('ledger.csv').filter((object) => object.objectType === 'VARIABLE')
    .map((object) => [object.label, object]));
  const before = columns();

  // Act
  save('ledger.csv', 'Account,Department,Budget,Actual\nRent,Facilities,900,950\nPower,Facilities,80,70\n');

  // Assert
  const after = columns();
  for (const label of ['Budget', 'Actual']) {
    assert.equal(after.get(label).id, before.get(label).id, label);
    assert.equal(after.get(label).anchor.columnIndex, before.get(label).anchor.columnIndex + 1);
  }
  assert.equal(localKey(after.get('Budget')), 'variable:budget');
});

test('A row far down a large table has the same key as it would among the first rows', async (t) => {
  // Arrange: "Hospital ward 7" names two rows, the second among the rows the
  // indexer reads. Rows inserted at the top then push both past them.
  const wards = Array.from({ length: 3_000 }, (_, row) => `Hospital ward ${row === 500 ? 7 : row},${row % 90},${row % 7}`);
  const clinics = Array.from({ length: 2_000 }, (_, row) => `Clinic ${row},${row % 50},${row % 5}`);
  const { application, project, save, objects } = workspace(t, { 'wards.csv': `Name,Glucose,Lactate\n${wards.join('\n')}\n` });
  const firstRowKeys = objects('wards.csv').filter((object) => object.label === 'Hospital ward 7')
    .map((object) => [localKey(object), object.valueText]);
  assert.deepEqual(firstRowKeys.map(([key]) => key).sort(), ['row:hospitalward7', 'row:hospitalward7#2']);

  // Act
  save('wards.csv', `Name,Glucose,Lactate\n${[...clinics, ...wards].join('\n')}\n`);

  // Assert
  const snapshotId = application.timeline.getProject(project.id).currentSnapshotId;
  const [table] = application.dependencies.snapshotTables(project.id, snapshotId);
  const deep = application.dependencies.tables.search(table.meta.id, 'Hospital ward 7', 12)
    .filter((row) => row.cells[0] === 'Hospital ward 7')
    .map((row) => application.dependencies.indexedRowObjects(table, row).find((object) => object.type === 'DATASET_ROW'));
  assert.equal(deep.length, 2);
  assert.ok(deep.every((row) => row.anchor.rowIndex > 2_000), 'both rows are past the rows the indexer reads');
  assert.deepEqual(deep.map((row) => row.key.slice(row.key.indexOf(':') + 1)).sort(),
    firstRowKeys.map(([key]) => key).sort());
  const second = deep.find((row) => row.key.endsWith('#2'));
  assert.equal(second.anchor.rowIndex, 2_501);
});

test('The identity step gives an edited row the token its row had, and a new row a token of its own', () => {
  // Arrange: a row's provisional token is made from its cells; the recorded
  // rows are what the previous version of the file recorded.
  const cell = (token, column, value, rowIndex) => ({ key: `file:cell:${token}:${column}`, value,
    anchor: { kind: 'table-cell', rowIndex, column } });
  const recorded = [cell('~aaaaaaaaaaaa', 'Year', '1990', 1), cell('~aaaaaaaaaaaa', 'Deaths', '5', 1),
    cell('~bbbbbbbbbbbb', 'Year', '1991', 2), cell('~bbbbbbbbbbbb', 'Deaths', '6', 2)];
  const fresh = [cell('~cccccccccccc', 'Year', '1989', 1), cell('~cccccccccccc', 'Deaths', '3', 1),
    cell('~dddddddddddd', 'Year', '1990', 2), cell('~dddddddddddd', 'Deaths', '5', 2),
    cell('~eeeeeeeeeeee', 'Year', '1991', 3), cell('~eeeeeeeeeeee', 'Deaths', '7', 3)];

  // Act
  const keys = stableRowIdentities(fresh, recorded).map((descriptor) => descriptor.key);

  // Assert
  assert.deepEqual(keys, ['file:cell:~cccccccccccc:Year', 'file:cell:~cccccccccccc:Deaths',
    'file:cell:~aaaaaaaaaaaa:Year', 'file:cell:~aaaaaaaaaaaa:Deaths',
    'file:cell:~bbbbbbbbbbbb:Year', 'file:cell:~bbbbbbbbbbbb:Deaths']);
});

test('An edited row keeps its token when a row sharing fewer of its cells is inserted above it', () => {
  // Arrange
  const row = (token, rowIndex, values) => ['Site', 'Year', 'Age', 'Deaths'].map((column, at) => ({
    key: `file:cell:${token}:${column}`, value: values[at], anchor: { kind: 'table-cell', rowIndex, column } }));
  const recorded = [...row('~aaaaaaaaaaaa', 1, ['North', '1990', '30', '5']), ...row('~bbbbbbbbbbbb', 2, ['North', '1990', '40', '7']),
    ...row('~cccccccccccc', 3, ['South', '1991', '30', '5']), ...row('~dddddddddddd', 4, ['South', '1991', '40', '9'])];
  const fresh = [...row('~111111111111', 1, ['North', '1990', '30', '5']), ...row('~222222222222', 2, ['North', '1990', '40', '7']),
    ...row('~333333333333', 3, ['South', '1991', '50', '1']), ...row('~444444444444', 4, ['South', '1991', '30', '6']),
    ...row('~555555555555', 5, ['South', '1991', '40', '9'])];

  // Act
  const tokens = [...new Set(stableRowIdentities(fresh, recorded).map((descriptor) => descriptor.key.split(':')[2]))];

  // Assert
  assert.deepEqual(tokens, ['~aaaaaaaaaaaa', '~bbbbbbbbbbbb', '~333333333333', '~cccccccccccc', '~dddddddddddd']);
});
