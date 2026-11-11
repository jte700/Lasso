// What a later index needs to carry a folder's unchanged files forward (how
// many objects each file had, its reading problems, the folder's data
// dictionary) is kept in the database, so the first edit after a restart
// reads only the file that changed, as every later edit does.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';

const writer = { id: 'human:writer', displayName: 'Writer', actorType: 'HUMAN_SELF' };

const table = (name, rows, edited = null) => ['Item,Q1,Q2', ...Array.from({ length: rows }, (_, index) =>
  `${name} ${index + 1},${edited === index ? 999 : index * 10},${index * 20}`)].join('\n') + '\n';

function folder(t) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-index-summaries-')));
  const root = path.join(sandbox, 'Accounts');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'north.csv'), table('North', 40));
  fs.writeFileSync(path.join(root, 'south.csv'), table('South', 40));
  fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\n\nNorth 3 came to 20 dollars.\n');
  const dataDir = path.join(sandbox, 'history');
  const open = () => createApplication({ dataDir, watchProjects: false, port: 0 });
  const opened = [];
  t.after(async () => {
    for (const application of opened) await application.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  return { root, open: () => { const application = open(); opened.push(application); return application; } };
}

/** The paths of the files an application reads objects out of from now on. */
function readsOf(application) {
  const paths = [];
  const read = application.dependencies.extractedObjectSteps;
  application.dependencies.extractedObjectSteps = function* readFile(file) {
    paths.push(file.path);
    return yield* read.call(this, file);
  };
  return paths;
}

test('After a restart, editing one file re-reads only that file', async (t) => {
  // Arrange
  const { root, open } = folder(t);
  const first = open();
  const project = first.timeline.importProject(root, writer, { watch: false }).project;
  first.dependencies.ensureIndex(project.id);
  fs.writeFileSync(path.join(root, 'north.csv'), table('North', 40, 2));
  first.timeline.capture(project.id, writer);
  first.dependencies.ensureIndex(project.id);
  await first.close();

  // Act
  const second = open();
  const reads = readsOf(second);
  fs.writeFileSync(path.join(root, 'south.csv'), table('South', 40, 5));
  second.timeline.capture(project.id, writer);
  second.dependencies.ensureIndex(project.id);

  // Assert
  assert.deepEqual([...new Set(reads)], ['south.csv']);
  const labels = second.dependencies.objectsAt(project.id).map((object) => object.label);
  assert.ok(labels.includes('North 3 · Q1'), 'the carried file keeps its objects');
  assert.equal(second.dependencies.objectsAt(project.id).find((object) => object.label === 'South 6 · Q1')?.valueText, '999');
});

test('A carried index after a restart keeps the problems recorded for unchanged files', async (t) => {
  // Arrange
  const { root, open } = folder(t);
  fs.writeFileSync(path.join(root, 'broken.xlsx'), 'not a workbook');
  const first = open();
  const project = first.timeline.importProject(root, writer, { watch: false }).project;
  first.dependencies.ensureIndex(project.id);
  await first.close();

  // Act
  const second = open();
  const known = second.dependencies.loadIndexSummary(second.timeline.getProject(project.id).currentSnapshotId);

  // Assert
  assert.ok(known, 'the summary is read back from the database');
  assert.equal(known.counts.get('north.csv') > 0, true);
  assert.equal(known.problems.get('broken.xlsx')?.[0]?.code, 'UNREADABLE_CONTENT');
});

test('An index summary is stored as the difference from the one before it', async (t) => {
  // Arrange
  const { root, open } = folder(t);
  const application = open();
  const project = application.timeline.importProject(root, writer, { watch: false }).project;
  application.dependencies.ensureIndex(project.id);
  const rows = () => application.db.prepare('SELECT COUNT(*) AS count FROM snapshot_index_files').get().count;
  const before = rows();

  // Act
  fs.writeFileSync(path.join(root, 'north.csv'), table('North', 40, 7));
  application.timeline.capture(project.id, writer);
  application.dependencies.ensureIndex(project.id);
  const afterEdit = rows();
  fs.writeFileSync(path.join(root, 'north.csv'), table('North', 41, 7));
  application.timeline.capture(project.id, writer);
  application.dependencies.ensureIndex(project.id);

  // Assert
  assert.equal(before, 3);
  assert.equal(afterEdit - before, 0, 'an edit that keeps every count stores no file entry');
  assert.equal(rows() - afterEdit, 1, 'a file whose count changed stores one entry');
});

test('A store from before index summaries were kept upgrades cleanly', async (t) => {
  // Arrange
  const { root, open } = folder(t);
  const first = open();
  const project = first.timeline.importProject(root, writer, { watch: false }).project;
  first.dependencies.ensureIndex(project.id);
  first.db.exec("DROP TABLE snapshot_index_files; DROP TABLE snapshot_index_summaries; DELETE FROM schema_migrations WHERE version = 29;");
  await first.close();

  // Act
  const second = open();
  const reads = readsOf(second);
  fs.writeFileSync(path.join(root, 'south.csv'), table('South', 40, 1));
  second.timeline.capture(project.id, writer);
  second.dependencies.ensureIndex(project.id);

  // Assert
  assert.ok(second.db.prepare('SELECT 1 FROM schema_migrations WHERE version = 29').get());
  assert.deepEqual([...new Set(reads)].sort(), ['north.csv', 'notes.md', 'south.csv'], 'with no stored summary the folder is read whole once');
  assert.ok(second.dependencies.loadIndexSummary(second.timeline.getProject(project.id).currentSnapshotId));
});
