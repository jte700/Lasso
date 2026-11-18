// The Ranch's Recent Changes opens a change like an audit log entry: who and
// what recorded it, the versions it went between, and what changed inside the
// file, line by line for text, cell by cell for tables, and value by value for
// the files Lasso reads into objects.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { storedZip } from './fixtures/workbook.js';

const actor = { id: 'human:writer', displayName: 'Sam Turner', actorType: 'HUMAN_SELF' };

const book = (payroll) => storedZip({
  'xl/workbook.xml': '<workbook><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml': `<worksheet><sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>Line</t></is></c><c r="B1" t="inlineStr"><is><t>Amount</t></is></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>Payroll</t></is></c><c r="B2"><v>${payroll}</v></c></row>
  </sheetData></worksheet>`,
});

const NOTES = ['# Field notes', '', 'Site visit on Monday.', 'Soil was dry.', 'Crew of four.', 'Lunch at noon.',
  'Left at five.', 'Next visit Friday.', ''].join('\n');

function folder(t) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-ranch-change-')));
  const root = path.join(sandbox, 'Site');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'notes.md'), NOTES);
  fs.writeFileSync(path.join(root, 'budget.xlsx'), book(18400));
  fs.writeFileSync(path.join(root, 'crew.csv'), 'Name,Role,Hours\nAda,Lead,8\nBo,Survey,6\n');
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const project = app.timeline.importProject(root, actor, { watch: false }).project;
  app.dependencies.ensureIndex(project.id);
  const capture = () => {
    app.timeline.capture(project.id, actor);
    app.dependencies.ensureIndex(project.id);
  };
  const entry = (filePath) => app.ranch.overview().history.find((item) => item.path === filePath);
  return { app, project, root, capture, entry };
}

test('An edited text file shows who saved it, the versions and the changed lines with a little around them', (t) => {
  // Arrange
  const { app, project, root, capture, entry } = folder(t);
  fs.writeFileSync(path.join(root, 'notes.md'), NOTES.replace('Soil was dry.', 'Soil was damp after rain.'));
  capture();

  // Act
  const detail = app.ranch.change({ id: entry('notes.md').id });

  // Assert
  assert.equal(detail.change, 'edited');
  assert.equal(detail.path, 'notes.md');
  assert.equal(detail.directoryId, project.id);
  assert.deepEqual(detail.actor, { name: 'Sam Turner', type: 'HUMAN_SELF' });
  assert.equal(detail.source, 'WATCHER');
  assert.equal(detail.version.after, detail.version.before + 1);
  assert.equal(detail.file.before.size, Buffer.byteLength(NOTES));
  assert.ok(detail.file.after.size > detail.file.before.size);
  assert.deepEqual([detail.lines.added, detail.lines.removed], [1, 1]);
  const shown = detail.lines.hunks.flatMap((hunk) => hunk.lines.map((line) => [line.kind, line.text]));
  assert.deepEqual(shown, [
    ['same', '# Field notes'], ['same', ''], ['same', 'Site visit on Monday.'],
    ['remove', 'Soil was dry.'], ['add', 'Soil was damp after rain.'],
    ['same', 'Crew of four.'], ['same', 'Lunch at noon.'], ['same', 'Left at five.'],
  ], 'three lines of context on each side, no more');
  const removed = detail.lines.hunks[0].lines.find((line) => line.kind === 'remove');
  assert.equal(removed.before, 4, 'lines carry their numbers in the version they come from');
});

test('An edited workbook lists the value it changed, where it sits and what it was', (t) => {
  // Arrange
  const { app, root, capture, entry } = folder(t);
  fs.writeFileSync(path.join(root, 'budget.xlsx'), book(19250));
  capture();

  // Act
  const detail = app.ranch.change({ id: entry('budget.xlsx').id });

  // Assert
  assert.equal(detail.lines, null, 'a workbook is not compared line by line');
  const changed = detail.values.filter((value) => value.kind === 'modified');
  assert.deepEqual(changed.map(({ place, before, after }) => [place, before, after]), [['Budget!B2', '18400', '19250']]);
  assert.equal(detail.valueCount, detail.values.length);
});

test('A stored value with floating-point residue is shown as the sheet shows it', (t) => {
  // Arrange
  const { app, root, capture, entry } = folder(t);
  fs.writeFileSync(path.join(root, 'budget.xlsx'), book('18853.199999999997'));
  capture();
  fs.writeFileSync(path.join(root, 'budget.xlsx'), book('18066.199999999997'));
  capture();

  // Act
  const row = entry('budget.xlsx');
  const detail = app.ranch.change({ id: row.id });

  // Assert
  const [changed] = detail.values.filter((value) => value.kind === 'modified');
  assert.deepEqual([changed.beforeDisplay, changed.afterDisplay], ['18853.2', '18066.2']);
  assert.equal(changed.before, '18853.199999999997', 'the stored value is kept as recorded');
  assert.deepEqual([row.valueChanges.first.beforeDisplay, row.valueChanges.first.afterDisplay], ['18853.2', '18066.2'],
    'the row\'s caption says the same');
});

test('An edited table lists the cells that changed by row and column', (t) => {
  // Arrange
  const { app, root, capture, entry } = folder(t);
  fs.writeFileSync(path.join(root, 'crew.csv'), 'Name,Role,Hours\nAda,Lead,9\nBo,Survey,6\nCy,Driver,4\n');
  capture();

  // Act
  const detail = app.ranch.change({ id: entry('crew.csv').id });

  // Assert
  assert.deepEqual(detail.table.cells, [{ row: 'Ada', column: 'Hours', before: '8', after: '9' }]);
  assert.deepEqual(detail.table.rowsAdded, ['Cy']);
  assert.deepEqual(detail.table.rowsRemoved, []);
});

test('A renamed file names where it was, and a new text file shows its first lines as added', (t) => {
  // Arrange
  const { app, root, capture, entry } = folder(t);
  fs.renameSync(path.join(root, 'crew.csv'), path.join(root, 'crew-2026.csv'));
  fs.writeFileSync(path.join(root, 'todo.txt'), 'Order rebar\nCall the surveyor\n');
  capture();

  // Act
  const renamed = app.ranch.change({ id: entry('crew-2026.csv').id });
  const added = app.ranch.change({ id: entry('todo.txt').id });

  // Assert
  assert.equal(renamed.change, 'renamed');
  assert.equal(renamed.previousPath, 'crew.csv');
  assert.equal(renamed.file.before.hash, renamed.file.after.hash, 'the bytes stayed the same');
  assert.deepEqual(renamed.values, [], 'nothing inside changed, so nothing is listed as changed');
  assert.equal(added.file.before, null);
  assert.deepEqual(added.lines.hunks[0].lines.map((line) => [line.kind, line.text]),
    [['add', 'Order rebar'], ['add', 'Call the surveyor']]);
});

test('A directory\'s first reading lists the files it found, and history rows say who recorded them', (t) => {
  // Arrange
  const { app } = folder(t);
  const first = app.ranch.overview().history.find((item) => item.change === 'directory-added');

  // Act
  const detail = app.ranch.change({ id: first.id });

  // Assert
  assert.deepEqual(first.actor, { name: 'Sam Turner', type: 'HUMAN_SELF' });
  assert.equal(first.source, 'IMPORT');
  assert.equal(detail.change, 'directory-added');
  assert.equal(detail.fileCount, 3);
  assert.deepEqual(detail.files.map((file) => [file.change, file.path]),
    [['added', 'budget.xlsx'], ['added', 'crew.csv'], ['added', 'notes.md']]);
});

test('A change Lasso has no record of is answered as not found', (t) => {
  const { app } = folder(t);
  assert.throws(() => app.ranch.change({ id: 'nothing-like-it' }), (error) => error.status === 404);
  assert.throws(() => app.ranch.change({}), (error) => error.status === 400);
});
