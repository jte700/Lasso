import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';

const actor = { id: 'human:capture', displayName: 'Capture', actorType: 'HUMAN_SELF' };

function project(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-unreadable-'));
  const root = path.join(sandbox, 'Matter');
  fs.mkdirSync(path.join(root, 'Exhibits'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Notes.md'), '# Notes\nThe settlement is 4,500.\n');
  fs.writeFileSync(path.join(root, 'Exhibits', 'A.md'), '# Exhibit A\n');
  const app = createApplication({ dataDir: path.join(sandbox, 'data'), watchProjects: false, port: 0 });
  t.after(async () => {
    for (const target of [path.join(root, 'Notes.md'), path.join(root, 'Exhibits')]) {
      if (fs.existsSync(target)) fs.chmodSync(target, 0o755);
    }
    await app.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const { project: imported } = app.timeline.importProject(root, actor, { watch: false });
  return { app, root, projectId: imported.id };
}

const fileIdOf = (app, projectId, filePath) => {
  const snapshot = app.timeline.getSnapshot(app.timeline.getProject(projectId).currentSnapshotId);
  return snapshot.files.find((file) => file.path === filePath)?.projectFileId;
};

test('a file that cannot be read for a moment is not recorded as deleted', (t) => {
  // Arrange
  const { app, root, projectId } = project(t);
  const originalId = fileIdOf(app, projectId, 'Notes.md');

  // Act: the file is locked, then readable again.
  fs.chmodSync(path.join(root, 'Notes.md'), 0o000);
  const whileLocked = app.timeline.capture(projectId, actor);
  fs.chmodSync(path.join(root, 'Notes.md'), 0o644);
  app.timeline.capture(projectId, actor);

  // Assert
  assert.equal(whileLocked.changed, false, 'no deletion is recorded while the file is unreadable');
  assert.equal(fileIdOf(app, projectId, 'Notes.md'), originalId, 'links keep the same file identity');
});

test('a folder that cannot be listed keeps its files', (t) => {
  const { app, root, projectId } = project(t);
  const originalId = fileIdOf(app, projectId, 'Exhibits/A.md');
  fs.chmodSync(path.join(root, 'Exhibits'), 0o000);
  const whileLocked = app.timeline.capture(projectId, actor);
  fs.chmodSync(path.join(root, 'Exhibits'), 0o755);
  assert.equal(whileLocked.changed, false);
  assert.equal(fileIdOf(app, projectId, 'Exhibits/A.md'), originalId);
});

test('a file that is really deleted is still recorded as deleted', (t) => {
  const { app, root, projectId } = project(t);
  fs.rmSync(path.join(root, 'Notes.md'));
  const capture = app.timeline.capture(projectId, actor);
  assert.equal(capture.changed, true);
  assert.equal(fileIdOf(app, projectId, 'Notes.md'), undefined);
});
