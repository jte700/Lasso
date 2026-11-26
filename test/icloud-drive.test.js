import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { application, network, settled } from './fixtures/connections.js';
import { macPlaceholders } from '../src/history/cloud-placeholders.js';
import { scanDirectory } from '../src/history/scanner.js';

/** A folder standing in for iCloud Drive, holding the files given by name. */
function folderWith(t, files) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-icloud-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), text);
  }
  return folder;
}

/**
 * Placeholders by file name, as macOS marks a file kept only in iCloud. A
 * download makes the file local again; reading a placeholder fails the test,
 * since on a Mac that read would download it.
 */
function fakePlaceholders(names) {
  const remote = new Set(names);
  const downloaded = [];
  return {
    remote, downloaded,
    find: (files) => new Set(files.filter((file) => remote.has(path.basename(file.absolutePath))).map((file) => file.absolutePath)),
    materialize: async (absolutePath) => { remote.delete(path.basename(absolutePath)); downloaded.push(path.basename(absolutePath)); },
  };
}

const found = (app, words, projectId) => app.workspace.search(words, { limit: 20 }).some((object) => object.projectId === projectId);

test('iCloud Drive connects in one step as a cloud drive, read where its files already are', async (t) => {
  const icloud = folderWith(t, { 'Projects/Pour log.md': '# Pour log\n\nFormwork strikes after seven days.\n' });
  const { app } = await application(t, network([]).fetch, { icloudDrivePath: icloud, platform: 'darwin' });

  const offered = () => app.workspace.state().cloudDrives;
  assert.deepEqual(offered().map((drive) => drive.provider), ['google-drive', 'onedrive', 'dropbox', 'icloud']);
  const icloudOffer = offered().find((drive) => drive.provider === 'icloud');
  assert.equal(icloudOffer.connected, false);
  assert.equal(icloudOffer.available, true);
  assert.equal(icloudOffer.signIn, 'none', 'iCloud Drive needs no sign-in');
  assert.equal(offered().find((drive) => drive.provider === 'dropbox').signIn, 'setup', 'Dropbox needs its app registration first');

  const entry = app.connections.catalog().find((provider) => provider.id === 'icloud');
  assert.equal(entry.auth, 'folder');
  assert.equal(entry.cloud, true);

  const { connection } = await app.connections.create({ provider: 'icloud' });
  const ready = await settled(app, connection.id);
  assert.equal(ready.status, 'ready', ready.error ?? '');
  assert.equal(ready.kind, 'cloud');
  assert.equal(ready.name, 'iCloud Drive');
  assert.equal(ready.active, true);
  const state = app.workspace.state();
  assert.deepEqual(state.directories, [], 'iCloud Drive is never listed as a work directory');
  assert.ok(state.activeProjectIds.includes(ready.projectId));
  assert.ok(found(app, 'Formwork strikes', ready.projectId), 'its files are suggested from');
  assert.equal(fs.existsSync(path.join(app.config.dataDir, 'connected-apps', connection.id)), false, 'nothing is copied');
  assert.equal(offered().find((drive) => drive.provider === 'icloud').connected, true);
  await assert.rejects(app.connections.create({ provider: 'icloud' }), /already connected/);

  await app.connections.disconnect(connection.id);
  assert.equal(fs.readFileSync(path.join(icloud, 'Projects/Pour log.md'), 'utf8').includes('Formwork'), true,
    'disconnecting leaves the files in iCloud Drive');
  assert.deepEqual(app.workspace.state().connections, []);
  assert.deepEqual(app.workspace.state().directories, []);
});

test('iCloud Drive that was already a work directory moves to the cloud drives', async (t) => {
  const icloud = folderWith(t, { 'notes.md': '# Notes\n\nCrane lift is on Friday.\n' });
  const { app } = await application(t, network([]).fetch, { icloudDrivePath: icloud, platform: 'darwin' });
  await app.workspace.add([icloud]);
  const before = app.workspace.state().directories[0].id;
  const { connection } = await app.connections.create({ provider: 'icloud' });
  const ready = await settled(app, connection.id);
  assert.equal(ready.projectId, before, 'its history and index are kept');
  assert.deepEqual(app.workspace.state().directories, []);

  // Disconnecting gives the folder back as the work directory it was, history and all.
  const events = app.timeline.listEvents(before).length;
  await app.connections.disconnect(connection.id);
  const [directory] = app.workspace.state().directories;
  assert.equal(directory?.id, before);
  assert.equal(directory.name, path.basename(fs.realpathSync(icloud)));
  assert.equal(directory.active, true);
  assert.equal(app.timeline.listEvents(before).length, events);
  assert.ok(found(app, 'Crane lift', before));
});

test('two requests to download a folder’s cloud files share one download', async (t) => {
  const folder = folderWith(t, { 'Here.md': '# Here\n\nSlab pour on level two.\n', 'There.md': '# There\n\nRebar laps are forty diameters.\n' });
  const placeholders = fakePlaceholders(['There.md']);
  const { app } = await application(t, network([]).fetch, { cloudPlaceholders: placeholders });
  await app.workspace.add([folder]);
  const [directory] = app.workspace.state().directories;
  const first = app.workspace.startCloudDownload(directory.id);
  const second = app.workspace.startCloudDownload(directory.id);
  assert.equal(second.finished, first.finished);
  await first.finished;
  assert.deepEqual(placeholders.downloaded, ['There.md'], 'each file is downloaded once');
});

test('iCloud Drive is not offered where its folder is missing or off a Mac', async (t) => {
  const missing = path.join(os.tmpdir(), 'lasso-no-icloud-here');
  const { app } = await application(t, network([]).fetch, { icloudDrivePath: missing, platform: 'darwin' });
  assert.equal(app.workspace.state().cloudDrives.find((drive) => drive.provider === 'icloud').available, false);
  await assert.rejects(app.connections.create({ provider: 'icloud' }), /iCloud Drive/);
  const windows = await application(t, network([]).fetch, { icloudDrivePath: missing, platform: 'win32' });
  assert.equal(windows.app.workspace.state().cloudDrives.some((drive) => drive.provider === 'icloud'), false);
});

test('files kept only in iCloud are never read, are counted, and come in once downloaded on purpose', async (t) => {
  const icloud = folderWith(t, {
    'Local.md': '# Local\n\nSlab pour on level two.\n',
    'Remote.md': '# Remote\n\nRebar laps are forty diameters.\n',
  });
  const placeholders = fakePlaceholders(['Remote.md']);
  const { app } = await application(t, network([]).fetch, { icloudDrivePath: icloud, platform: 'darwin', cloudPlaceholders: placeholders });
  const { connection } = await app.connections.create({ provider: 'icloud' });
  const ready = await settled(app, connection.id);
  assert.ok(found(app, 'Slab pour', ready.projectId));
  assert.ok(!found(app, 'Rebar laps', ready.projectId), 'a file only in iCloud is not read');
  assert.equal(app.connections.connection(connection.id).onlyInCloud, 1);

  const answer = await app.workspace.downloadCloudFiles(ready.projectId);
  assert.equal(answer.requested, 1);
  assert.deepEqual(placeholders.downloaded, ['Remote.md']);
  assert.ok(found(app, 'Rebar laps', ready.projectId), 'a downloaded file is read');
  assert.equal(app.connections.connection(connection.id).onlyInCloud ?? 0, 0);

  // macOS may later keep a file in iCloud alone again to free space.
  placeholders.remote.add('Local.md');
  await app.timeline.capture(ready.projectId, { id: 'system:test', displayName: 'Test', actorType: 'SYSTEM' }, { source: 'SYSTEM' });
  assert.ok(found(app, 'Slab pour', ready.projectId), 'a file moved back to iCloud alone keeps its last version');
  assert.equal(app.connections.connection(connection.id).onlyInCloud, 1);
});

test('a folder from a cloud drive app added as a work directory skips its placeholders too', async (t) => {
  const folder = folderWith(t, { 'Here.md': '# Here\n\nSlab pour on level two.\n', 'There.md': '# There\n\nRebar laps are forty diameters.\n' });
  const placeholders = fakePlaceholders(['There.md']);
  const { app } = await application(t, network([]).fetch, { cloudPlaceholders: placeholders });
  await app.workspace.add([folder]);
  const [directory] = app.workspace.state().directories;
  assert.equal(directory.onlyInCloud, 1);
  assert.ok(found(app, 'Slab pour', directory.id));
  assert.ok(!found(app, 'Rebar laps', directory.id));
  await assert.rejects(app.workspace.downloadCloudFiles('no-such-folder'), /not found/);
});

test('on a Mac a sparse file is read as usual: only files marked dataless are placeholders', { skip: process.platform !== 'darwin' }, async (t) => {
  const folder = folderWith(t, { 'Plain.md': '# Plain\n\nA local file.\n' });
  const sparse = path.join(folder, 'Sparse.txt');
  fs.writeFileSync(sparse, '');
  fs.truncateSync(sparse, 1024 * 1024);
  const files = ['Plain.md', 'Sparse.txt'].map((name) => {
    const absolutePath = path.join(folder, name);
    return { absolutePath, stat: fs.statSync(absolutePath, { bigint: true }) };
  });
  assert.deepEqual([...macPlaceholders.find(files)], []);
  const blobs = { putFile: (file) => ({ contentHash: path.basename(file), head: null }) };
  assert.equal(scanDirectory(folder, blobs).length, 2);
});

test('the workspace route lists the cloud drives to offer, and a folder’s cloud files download on request', async (t) => {
  const folder = folderWith(t, { 'Here.md': '# Here\n\nSlab pour on level two.\n', 'There.md': '# There\n\nRebar laps are forty diameters.\n' });
  const placeholders = fakePlaceholders(['There.md']);
  const { app } = await application(t, network([]).fetch, { port: 0, cloudPlaceholders: placeholders, platform: 'darwin',
    icloudDrivePath: folder });
  await app.workspace.add([folder]);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const state = await (await fetch(`${base}/api/workspace`)).json();
  assert.deepEqual(state.cloudDrives.map((drive) => drive.provider), ['google-drive', 'onedrive', 'dropbox', 'icloud']);
  const [directory] = state.directories;
  assert.equal(directory.onlyInCloud, 1);
  const missing = await fetch(`${base}/api/workspace/directories/nothing/download`, { method: 'POST' });
  assert.equal(missing.status, 404);
  const answer = await fetch(`${base}/api/workspace/directories/${directory.id}/download`, { method: 'POST' });
  assert.equal(answer.status, 202);
  assert.deepEqual(await answer.json(), { requested: 1 });
  for (let attempt = 0; attempt < 200 && !found(app, 'Rebar laps', directory.id); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(found(app, 'Rebar laps', directory.id));
});
