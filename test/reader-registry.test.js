// Every kind of file is read by one reader from a registry, each with its own
// version. An index records the versions that read it, so when one reader
// improves, a re-read reads only that reader's files again.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { READERS, readerFor, readerVersions, readersChangedSince } from '../src/dependencies/readers.js';

const actor = { id: 'human:writer', displayName: 'Writer', actorType: 'HUMAN_SELF' };

function folder(t) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-readers-')));
  const root = path.join(sandbox, 'Project');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'ledger.csv'), 'Account,2026\nRent,1200\nPayroll,300\n');
  fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\n\nRent came to 1200 dollars.\n');
  fs.writeFileSync(path.join(root, 'model.py'), 'def fit(x):\n    return x\n');
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const project = app.timeline.importProject(root, actor, { watch: false }).project;
  app.dependencies.ensureIndex(project.id);
  return { app, project };
}

test('Every kind of file has exactly one reader', () => {
  // Arrange
  const files = [['a.csv', 'table'], ['a.xlsx', 'spreadsheet'], ['a.pdf', 'pdf'], ['a.docx', 'document'],
    ['a.pptx', 'presentation'], ['a.md', 'markdown'], ['a.txt', 'text'], ['a.py', 'code'], ['a.ipynb', 'notebook'],
    ['a.png', 'image'], ['a.json', 'json'], ['a.mp4', 'video'], ['a.dxf', 'drawing']];

  // Act
  const readers = files.map(([name, fileType]) => readerFor({ path: name, fileType }).id);

  // Assert
  assert.deepEqual(readers, ['table', 'table', 'pdf', 'document', 'presentation', 'text', 'text', 'code', 'notebook',
    'image', 'json', 'video', 'design']);
  assert.equal(new Set(READERS.map((reader) => reader.id)).size, READERS.length);
  assert.ok(READERS.every((reader) => Number.isInteger(reader.version) && reader.version > 0));
});

test('An index records the reader versions that read it', (t) => {
  // Arrange
  const { app, project } = folder(t);

  // Act
  const recorded = app.dependencies.readerVersionsAt(app.timeline.getProject(project.id).currentSnapshotId);

  // Assert
  assert.deepEqual(recorded, readerVersions());
});

test('Bumping one reader re-reads only its files', (t) => {
  // Arrange
  const { app, project } = folder(t);
  const snapshotId = app.timeline.getProject(project.id).currentSnapshotId;
  const older = { ...readerVersions(), table: readerVersions().table - 1 };
  app.db.prepare('UPDATE snapshot_object_indexes SET reader_versions_json = ? WHERE snapshot_id = ?')
    .run(JSON.stringify(older), snapshotId);
  const read = [];
  const original = app.dependencies.extractedObjectSteps;
  app.dependencies.extractedObjectSteps = function* readFile(file) {
    read.push(file.path);
    return yield* original.call(this, file);
  };

  // Act
  app.dependencies.reindex(project.id, actor);

  // Assert
  assert.deepEqual(readersChangedSince(older), new Set(['table']));
  assert.deepEqual([...new Set(read)], ['ledger.csv']);
  assert.equal(app.dependencies.indexFreshness(project.id).stale, false);
});

test('A reader change makes the folder offer a re-read', (t) => {
  // Arrange
  const { app, project } = folder(t);
  const snapshotId = app.timeline.getProject(project.id).currentSnapshotId;

  // Act
  app.db.prepare('UPDATE snapshot_object_indexes SET reader_versions_json = ? WHERE snapshot_id = ?')
    .run(JSON.stringify({ ...readerVersions(), code: 0 }), snapshotId);

  // Assert
  assert.equal(app.dependencies.indexFreshness(project.id).stale, true);
  assert.equal(readersChangedSince(null), null, 'an index from before reader versions says nothing');
});
