import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';

const actor = { id: 'human:drive-test', displayName: 'Drive test', actorType: 'HUMAN_SELF' };
async function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-drives-'));
  const mount = path.join(root, 'USB');
  fs.mkdirSync(path.join(mount, 'Research', 'Nested'), { recursive: true });
  fs.mkdirSync(path.join(mount, 'Private'));
  fs.writeFileSync(path.join(mount, 'Research', 'notes.md'), '# Notes\nThe measured value is 42.');
  fs.writeFileSync(path.join(mount, 'Research', 'Nested', 'data.csv'), 'name,value\ntrial,42\n');
  fs.writeFileSync(path.join(mount, 'Private', 'secret.txt'), 'not selected');
  const config = { dataDir: path.join(root, 'history'), watchProjects: false, driveToken: 'test-token', ...overrides };
  const app = createApplication(config);
  t.after(async () => { await app.close(); fs.rmSync(root, { force: true, recursive: true }); });
  const volume = { id: 'macos-volume:test-uuid', name: 'Research USB', rootPath: mount };
  app.drives.sync([volume]);
  return { root, mount, config, app, volume };
}

test('mounting asks before indexing, folder selection is scoped, duplicate selections collapse', async t => {
  const { app, volume } = await fixture(t);
  assert.equal(app.timeline.listProjects().length, 0);
  assert.equal(app.drives.get(volume.id).pendingAction, 'connected');
  const result = app.drives.index(volume.id, ['Research', 'Research/Nested', 'Research'], actor);
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].availability, 'online');
  assert.equal(result.drive.pendingAction, null);
  assert.deepEqual(app.timeline.getSnapshot(result.projects[0].currentSnapshotId).files.map(file => file.path), ['Nested/data.csv', 'notes.md']);
  app.drives.sync([volume]);
  assert.equal(app.drives.get(volume.id).pendingAction, null);
});

test('disconnect keeps the snapshot searchable and blocks writes and capture', async t => {
  const { app, volume, mount } = await fixture(t);
  const project = app.drives.index(volume.id, ['.'], actor).projects[0];
  const snapshotId = project.currentSnapshotId;
  app.drives.sync([]);
  fs.renameSync(mount, `${mount}-removed`);
  assert.equal(app.drives.get(volume.id).pendingAction, 'disconnected');
  assert.equal(app.timeline.getProject(project.id).availability, 'offline');
  assert.throws(() => app.timeline.capture(project.id, actor), /offline/);
  assert.throws(() => app.dependencies.saveDocument(project.id, { path: 'Research/notes.md', content: 'bad' }, actor), /offline/);
  assert.equal(app.timeline.getProject(project.id).currentSnapshotId, snapshotId);
  assert.doesNotThrow(() => app.dependencies.ensureIndex(project.id));
  assert.ok(app.db.prepare('SELECT COUNT(*) AS count FROM scientific_object_versions WHERE snapshot_id = ?').get(snapshotId).count > 0);
  assert.equal(app.timeline.getSnapshot(snapshotId).files.length, 3);
  app.drives.decision(volume.id, 'keep');
  assert.equal(app.drives.get(volume.id).pendingAction, null);
  assert.equal(app.timeline.listProjects().length, 1);
});

test('disappearance before the native event cannot turn into file deletions', async t => {
  const { app, volume, mount } = await fixture(t);
  const project = app.drives.index(volume.id, ['Research'], actor).projects[0];
  fs.renameSync(mount, `${mount}-removed`);
  fs.mkdirSync(mount); // The old mount path can survive as an empty directory.
  assert.throws(() => app.timeline.capture(project.id, actor), /offline/);
  assert.equal(app.timeline.getProject(project.id).currentSnapshotId, project.currentSnapshotId);
});

test('retained project reconnects by volume identity at a new mount path', async t => {
  const { app, volume, mount } = await fixture(t);
  const project = app.drives.index(volume.id, ['Research'], actor).projects[0];
  app.drives.sync([]);
  const remount = `${mount} 1`;
  fs.renameSync(mount, remount);
  app.drives.sync([{ ...volume, rootPath: remount }]);
  assert.equal(app.timeline.getProject(project.id).rootPath, fs.realpathSync(path.join(remount, 'Research')));
  assert.equal(app.timeline.getProject(project.id).availability, 'online');
  assert.equal(app.timeline.listProjects().length, 1);
  fs.appendFileSync(path.join(remount, 'Research', 'notes.md'), '\nUpdated after reconnect.');
  assert.equal(app.timeline.capture(project.id, actor).changed, true);
});

test('another volume reusing a mount name cannot inherit retained indexes', async t => {
  const { app, volume } = await fixture(t);
  const project = app.drives.index(volume.id, ['.'], actor).projects[0];
  app.drives.sync([]);
  const other = { ...volume, id: 'different-volume' };
  app.drives.sync([other]);
  assert.equal(app.timeline.getProject(project.id).availability, 'offline');
  assert.throws(() => app.drives.index(other.id, ['.'], actor), /Another saved drive/);
  assert.equal(app.drives.get(other.id).projects.length, 0);
});

test('folder browsing rejects traversal and symlinks outside the selected drive', async t => {
  const { app, volume, root, mount } = await fixture(t);
  fs.symlinkSync(root, path.join(mount, 'escape'), 'dir');
  assert.throws(() => app.drives.folders(volume.id, '../'), /inside/);
  assert.throws(() => app.drives.index(volume.id, ['escape'], actor), /outside/);
  assert.deepEqual(app.drives.folders(volume.id).folders.map(folder => folder.name), ['Private', 'Research']);
});

test('explicit removal purges local drive history and unique blobs, preserving other projects and original files', async t => {
  const { app, volume, root, mount } = await fixture(t);
  const otherRoot = path.join(root, 'local');
  fs.mkdirSync(otherRoot);
  fs.copyFileSync(path.join(mount, 'Research', 'notes.md'), path.join(otherRoot, 'notes.md'));
  const other = app.timeline.importProject(otherRoot, actor).project;
  const project = app.drives.index(volume.id, ['.'], actor).projects[0];
  const sharedHash = app.timeline.snapshotFile(project.currentSnapshotId, 'Research/notes.md').contentHash;
  const uniqueHash = app.timeline.snapshotFile(project.currentSnapshotId, 'Private/secret.txt').contentHash;
  assert.throws(() => app.drives.decision(volume.id, 'remove'), /Disconnect/);
  app.drives.sync([]);
  const result = app.drives.decision(volume.id, 'remove');
  assert.deepEqual(result.removedProjectIds, [project.id]);
  assert.deepEqual(app.timeline.listProjects().map(project => project.id), [other.id]);
  assert.equal(app.timeline.blobs.has(sharedHash), true);
  assert.equal(app.timeline.blobs.has(uniqueHash), false);
  assert.equal(fs.readFileSync(path.join(mount, 'Private', 'secret.txt'), 'utf8'), 'not selected');
  assert.equal(app.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.throws(() => app.db.prepare('DELETE FROM snapshots WHERE id = ?').run(other.currentSnapshotId), /immutable/);
});

test('restart requires fresh native inventory before treating cached sources as online', async t => {
  const { app, volume, config } = await fixture(t);
  const project = app.drives.index(volume.id, ['Research'], actor).projects[0];
  // A second service instance models a fresh host session with persisted DB state.
  const restarted = createApplication(config);
  try {
    assert.equal(restarted.timeline.getProject(project.id).availability, 'offline');
    restarted.drives.sync([volume]);
    assert.equal(restarted.timeline.getProject(project.id).availability, 'online');
  } finally { await restarted.close(); }
});

test('HTTP inventory requires host token; offline open returns usable cached workspace', async t => {
  const { app, volume } = await fixture(t);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (url, body, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post('/api/drives/sync', { volumes: [] })).status, 403);
  assert.equal((await post('/api/drives/sync', { volumes: [] }, { 'x-lasso-drive-token': 'wrong' })).status, 403);
  assert.equal((await post('/api/drives/sync', { volumes: [volume] }, { 'x-lasso-drive-token': 'test-token' })).status, 200);
  const indexed = await post(`/api/drives/${encodeURIComponent(volume.id)}/index`, { paths: ['Research'], actor });
  assert.equal(indexed.status, 200);
  const project = (await indexed.json()).projects[0];
  await post('/api/drives/sync', { volumes: [] }, { 'x-lasso-drive-token': 'test-token' });
  const opened = await post(`/api/projects/${project.id}/open`, { actor });
  assert.equal(opened.status, 200);
  const result = await opened.json();
  assert.equal(result.capture.offline, true);
  assert.equal(result.project.availability, 'offline');
  assert.equal((await post(`/api/drives/${encodeURIComponent(volume.id)}/decision`, { action: 'remove' }, { origin: 'https://foreign.example' })).status, 403);
});


test('folder replaced by an escaping symlink while disconnected remains offline', async t => {
  const { app, volume, root, mount } = await fixture(t);
  const project = app.drives.index(volume.id, ['Research'], actor).projects[0];
  app.drives.sync([]);
  fs.renameSync(path.join(mount, 'Research'), path.join(root, 'moved-away'));
  fs.symlinkSync(path.join(root, 'moved-away'), path.join(mount, 'Research'), 'dir');
  app.drives.sync([volume]);
  assert.equal(app.timeline.getProject(project.id).availability, 'offline');
  assert.throws(() => app.timeline.capture(project.id, actor), /offline/);
  assert.equal(app.timeline.getProject(project.id).currentSnapshotId, project.currentSnapshotId);
});

test('reconnection reconciles edits made while the drive was detached', async t => {
  const { app, volume, mount } = await fixture(t);
  const project = app.drives.index(volume.id, ['Research'], actor).projects[0];
  app.drives.sync([]);
  fs.appendFileSync(path.join(mount, 'Research', 'notes.md'), '\nWritten on another computer.');
  app.drives.sync([volume]);
  assert.equal(app.timeline.getProject(project.id).currentVersion, 2);
});


test('removal rolls back referenced history and guards, then revokes shares after references are removed', async t => {
  const { app, volume, root, mount } = await fixture(t);
  const project = app.drives.index(volume.id, ['Research'], actor).projects[0];
  const localRoot = path.join(root, 'local');
  fs.mkdirSync(localRoot);
  fs.copyFileSync(path.join(mount, 'Research', 'notes.md'), path.join(localRoot, 'notes.md'));
  const local = app.timeline.importProject(localRoot, actor).project;
  const source = app.dependencies.objectsAt(project.id).find(source => source.path === 'Nested/data.csv');
  const share = app.objectShares.createShare({ projectId: project.id, objectId: source.id, versionId: source.versionId, actor });
  const reference = app.timeline.addProvenanceLink(local.id, {
    fromSnapshotId: local.currentSnapshotId, fromPath: 'notes.md', relation: 'DEPENDS_ON',
    toSnapshotId: project.currentSnapshotId, toPath: 'Nested/data.csv',
  });
  const guards = () => app.db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
  const originalGuards = guards();
  const sharedHash = app.timeline.snapshotFile(project.currentSnapshotId, 'notes.md').contentHash;
  const uniqueHash = app.timeline.snapshotFile(project.currentSnapshotId, 'Nested/data.csv').contentHash;
  app.terminal.graph.namedObjects(project.id);
  app.drives.sync([]);
  assert.throws(() => app.drives.decision(volume.id, 'remove'), /Other projects still reference/);
  assert.equal(app.objectShares.resolveShare(share.token).status, 'OK');
  assert.equal(app.timeline.getProject(project.id).currentSnapshotId, project.currentSnapshotId);
  assert.deepEqual(guards(), originalGuards);
  assert.throws(() => app.db.prepare('DELETE FROM snapshots WHERE id = ?').run(project.currentSnapshotId), /immutable/);
  app.db.prepare('DELETE FROM provenance_links WHERE id = ?').run(reference.id);
  app.drives.decision(volume.id, 'remove');
  assert.equal(app.objectShares.resolveShare(share.token).status, 'NOT_FOUND');
  assert.equal(app.timeline.blobs.has(sharedHash), true);
  assert.equal(app.timeline.blobs.has(uniqueHash), false);
  assert.equal(app.terminal.graph.namedObjectCache.size, 0);
  assert.deepEqual(guards(), originalGuards);
  assert.deepEqual(app.db.prepare('PRAGMA foreign_key_check').all(), []);
});
