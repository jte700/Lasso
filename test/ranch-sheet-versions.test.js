// The Ranch's sheet view lists a workbook's versions for its version menu:
// one per change to the file's bytes, newest first, each saying whether Lasso
// still has its bytes to show.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { storedZip } from './fixtures/workbook.js';

const actor = { id: 'human:writer', displayName: 'Writer', actorType: 'HUMAN_SELF' };

const book = (payroll) => storedZip({
  'xl/workbook.xml': '<workbook><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml': `<worksheet><sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>Line</t></is></c><c r="B1" t="inlineStr"><is><t>Amount</t></is></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>Payroll</t></is></c><c r="B2"><v>${payroll}</v></c></row>
  </sheetData></worksheet>`,
});

function folder(t) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-ranch-versions-')));
  const root = path.join(sandbox, 'Budget');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'budget.xlsx'), book(18400));
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const project = app.timeline.importProject(root, actor, { watch: false }).project;
  app.dependencies.ensureIndex(project.id);
  const capture = () => {
    app.timeline.capture(project.id, actor);
    app.dependencies.ensureIndex(project.id);
  };
  const save = (payroll, name = 'budget.xlsx') => {
    fs.writeFileSync(path.join(root, name), book(payroll));
    capture();
  };
  return { app, project, root, save, capture };
}

test('A rename that keeps a workbook\'s bytes is not listed as a version of its own', (t) => {
  // Arrange
  const { app, project, root, save, capture } = folder(t);
  save(19250);

  // Act
  fs.renameSync(path.join(root, 'budget.xlsx'), path.join(root, 'budget 2026.xlsx'));
  capture();
  const view = app.ranch.sheet({ directoryId: project.id, path: 'budget 2026.xlsx' });

  // Assert
  assert.equal(view.versions.length, 2);
  assert.equal(view.sheets[0].rows[1][1], '19250');
  assert.deepEqual(view.changes.map(({ before, after }) => [before, after]), [['18400', '19250']],
    'the shown version is the save that made these bytes');
});

test('A version older than the menu lists can still be opened', (t) => {
  // Arrange
  const { app, project, save } = folder(t);
  for (let step = 1; step <= 21; step += 1) save(18400 + step);

  // Act
  const latest = app.ranch.sheet({ directoryId: project.id, path: 'budget.xlsx' });
  const imported = app.db.prepare(`SELECT e.resulting_snapshot_id AS id FROM timeline_events e
    WHERE e.project_id = ? ORDER BY e.occurred_at, e.rowid LIMIT 1`).get(project.id).id;
  const first = app.ranch.sheet({ directoryId: project.id, path: 'budget.xlsx', version: imported });

  // Assert
  assert.equal(latest.versions.length, 20);
  assert.ok(!latest.versions.some((version) => version.snapshotId === imported));
  assert.equal(first.sheets[0].rows[1][1], '18400');
  assert.equal(first.version, imported);
});

test('A version whose bytes were released is listed as unavailable, and opening it says why', (t) => {
  // Arrange
  const { app, project, save } = folder(t);
  save(19250);
  const older = app.ranch.sheet({ directoryId: project.id, path: 'budget.xlsx' }).versions.at(-1);
  const hash = app.timeline.snapshotFileById(older.snapshotId,
    app.timeline.getSnapshot(older.snapshotId).files.find((file) => file.path === 'budget.xlsx').projectFileId).contentHash;
  for (const stored of [app.timeline.blobs.rawLocation(hash), app.timeline.blobs.compressedLocation(hash)]) fs.rmSync(stored, { force: true });
  app.db.prepare('INSERT INTO released_blobs(content_hash, released_at, stored_bytes) VALUES (?, ?, 1)').run(hash, new Date().toISOString());

  // Act
  const view = app.ranch.sheet({ directoryId: project.id, path: 'budget.xlsx' });
  const opening = () => app.ranch.sheet({ directoryId: project.id, path: 'budget.xlsx', version: older.snapshotId });

  // Assert
  assert.deepEqual(view.versions.map((version) => version.available), [true, false]);
  assert.throws(opening, (error) => error.status === 410);
});
