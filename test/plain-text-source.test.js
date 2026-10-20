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
  const hits = app.workspace.search('RFI-004');
  const whole = hits.filter(object => object.metadata.componentType !== 'TEXT_EXCERPT');
  assert.equal(whole.length, 1);
  assert.equal(whole[0].objectType, 'DOCUMENT');
  assert.equal(whole[0].projectId, project.id);
  assert.ok(hits.some(object => object.metadata.componentType === 'TEXT_EXCERPT'
    && object.valueText === 'RFI-004 roof drain relocation remains unapproved.'), 'the note\'s own sentence is indexed');
  assert.ok(app.workspace.search('relocation').some(object => object.id === whole[0].id), 'text beyond the short label is searchable');
  assert.ok(app.dependencies.sourceText(whole[0]).includes(content));
  const preview = app.terminal.executor.preview(project.id, { kind: 'object', objectId: whole[0].id });
  assert.ok(JSON.stringify(preview).includes('RFI-004 roof drain relocation'));
  const indexedCount = app.dependencies.objectsAt(project.id).length;
  app.dependencies.ensureIndex(project.id);
  assert.equal(app.dependencies.objectsAt(project.id).length, indexedCount, 'warm index does not duplicate the source');
  const versionId = whole[0].versionId;
  app.db.exec('ALTER TABLE object_share_grants DROP COLUMN excerpt_json; DELETE FROM schema_migrations WHERE version>=18');
  await app.close();
  app = createApplication(config);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM snapshot_object_indexes WHERE snapshot_id=?')
    .get(project.currentSnapshotId).count, 0, 'upgrade schedules current text-containing snapshots for reindexing');
  const upgraded = app.dependencies.objectsAt(project.id);
  assert.equal(upgraded.length, indexedCount);
  assert.equal(upgraded.find(object => object.id === whole[0].id).versionId, versionId, 'reindexing preserves immutable source versions');
});
