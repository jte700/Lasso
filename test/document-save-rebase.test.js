import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';

const actor = { id: 'human:writer', displayName: 'Writer', actorType: 'HUMAN_SELF' };

function workspace(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-save-'));
  const root = path.join(sandbox, 'Engagement');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Memo.md'), '# Memo\nFees were 1200.\n');
  fs.writeFileSync(path.join(root, 'Fees.csv'), 'Item,Amount\nAudit,1200\n');
  const app = createApplication({ dataDir: path.join(sandbox, 'data'), watchProjects: false, port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const { project } = app.timeline.importProject(root, actor, { watch: false });
  return { app, root, projectId: project.id, openedAt: project.currentSnapshotId };
}

test('saving a document succeeds after another file in the folder changed', (t) => {
  // Arrange: the memo is open while a spreadsheet beside it is updated.
  const { app, root, projectId, openedAt } = workspace(t);
  fs.writeFileSync(path.join(root, 'Fees.csv'), 'Item,Amount\nAudit,1350\n');
  app.timeline.capture(projectId, actor);

  // Act
  app.dependencies.saveDocument(projectId, { path: 'Memo.md', content: '# Memo\nFees were 1350.\n', baseSnapshotId: openedAt }, actor);

  // Assert
  assert.equal(fs.readFileSync(path.join(root, 'Memo.md'), 'utf8'), '# Memo\nFees were 1350.\n');
});

test('saving still refuses to overwrite a document that changed since it was opened', (t) => {
  const { app, root, projectId, openedAt } = workspace(t);
  fs.writeFileSync(path.join(root, 'Memo.md'), '# Memo\nEdited elsewhere.\n');
  app.timeline.capture(projectId, actor);
  assert.throws(() => app.dependencies.saveDocument(projectId,
    { path: 'Memo.md', content: '# Memo\nMine.\n', baseSnapshotId: openedAt }, actor), { status: 409 });
  assert.equal(fs.readFileSync(path.join(root, 'Memo.md'), 'utf8'), '# Memo\nEdited elsewhere.\n');
});
