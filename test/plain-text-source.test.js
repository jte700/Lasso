import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';

test('plain-text notes are searchable sources with preserved content and ownership', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-text-source-'));
  const root = path.join(directory, 'Construction');
  fs.mkdirSync(root);
  const content = 'Fictional project notes.\n' + 'General background. '.repeat(20)
    + '\nRFI-004 roof drain relocation remains unapproved.\n';
  fs.writeFileSync(path.join(root, 'RFI-004-Roof-Drain.txt'), content);
  const config = { dataDir: path.join(directory, 'data'), watchProjects: false };
  let app = createApplication(config);
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await app.workspace.add([root], { id: 'human:test', displayName: 'Test', actorType: 'HUMAN_SELF' });
  const project = app.workspace.projects()[0];
  const exact = app.workspace.search('RFI-004');
  assert.equal(exact.length, 1);
  assert.equal(exact[0].objectType, 'DOCUMENT');
  assert.equal(exact[0].projectId, project.id);
  assert.equal(app.workspace.search('relocation')[0].id, exact[0].id, 'text beyond the short label is searchable');
  assert.ok(app.dependencies.sourceText(exact[0]).includes(content));
  const preview = app.terminal.executor.preview(project.id, { kind: 'object', objectId: exact[0].id });
  assert.ok(JSON.stringify(preview).includes('RFI-004 roof drain relocation'));
  assert.equal(app.dependencies.objectsAt(project.id).length, 1, 'warm index does not duplicate the source');
  const versionId = exact[0].versionId;
  app.db.exec('DELETE FROM schema_migrations WHERE version=18');
  await app.close();
  app = createApplication(config);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM snapshot_object_indexes WHERE snapshot_id=?')
    .get(project.currentSnapshotId).count, 0, 'upgrade schedules current text-containing snapshots for reindexing');
  const upgraded = app.dependencies.objectsAt(project.id);
  assert.equal(upgraded.length, 1);
  assert.equal(upgraded[0].versionId, versionId, 'reindexing preserves immutable source versions');
});
