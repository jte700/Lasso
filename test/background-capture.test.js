import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { scanDirectory } from '../src/history/scanner.js';
import { BlobStore } from '../src/history/blob-store.js';

const actor = { id: 'human:background-test', displayName: 'Background test', actorType: 'HUMAN_SELF' };

function fixture(t, options = {}) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-background-test-')));
  const root = path.join(sandbox, 'project');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'note.md'), 'Initial note.\n');
  fs.writeFileSync(path.join(root, 'data.csv'), 'metric,value\nrevenue,100\n');
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false, ...options });
  const { project } = app.timeline.importProject(root, actor);
  t.after(async () => {
    await app.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  return { sandbox, root, app, project };
}

function trackProjectReads(t, root) {
  const reads = [];
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    // Recorded as project-relative POSIX paths on every platform.
    if (typeof file === 'string' && file.startsWith(`${root}${path.sep}`)) reads.push(path.relative(root, file).split(path.sep).join('/'));
    return original.call(this, file, ...args);
  });
  return reads;
}

test('watcher captures reuse unchanged bytes and retain renamed, missing, and newly added files', (t) => {
  const { root, app, project } = fixture(t);
  const reads = trackProjectReads(t, root);
  fs.writeFileSync(path.join(root, 'note.md'), 'Changed note.\n');
  let capture = app.timeline.capture(project.id, actor, { source: 'WATCHER', dirtyPaths: ['note.md'] });
  assert.deepEqual(reads, ['note.md']);
  assert.equal(capture.event.changes.length, 1);
  assert.equal(app.timeline.blobs.get(capture.snapshot.files.find((file) => file.path === 'note.md').contentHash).toString(), 'Changed note.\n');

  reads.length = 0;
  fs.renameSync(path.join(root, 'data.csv'), path.join(root, 'renamed.csv'));
  fs.unlinkSync(path.join(root, 'note.md'));
  fs.writeFileSync(path.join(root, 'new.md'), 'A new file.');
  capture = app.timeline.capture(project.id, actor, { source: 'WATCHER', dirtyPaths: ['note.md'] });
  assert.deepEqual(capture.event.changes.map((change) => change.changeType).sort(), ['ADDED', 'DELETED', 'RENAMED']);
  assert.deepEqual(capture.snapshot.files.map((file) => file.path), ['new.md', 'renamed.csv']);
  assert.deepEqual(reads.sort(), ['new.md', 'renamed.csv']);
  assert.equal(app.timeline.scanCaches.get(project.id).has('data.csv'), false);
});

test('same-size edits are detected by ctime and dirty hints override equal stat fingerprints', (t) => {
  const { root, app, project } = fixture(t);
  const target = path.join(root, 'note.md');
  const beforeStat = fs.statSync(target, { bigint: true });
  fs.writeFileSync(target, 'Updated note.\n');
  fs.utimesSync(target, Number(beforeStat.atimeNs) / 1e9, Number(beforeStat.mtimeNs) / 1e9);
  let capture = app.timeline.capture(project.id, actor, { source: 'WATCHER', dirtyPaths: ['data.csv'] });
  assert.equal(capture.event.changes.find((change) => change.pathAfter === 'note.md')?.changeType, 'MODIFIED');

  const cachedStat = fs.statSync(target, { bigint: true });
  fs.writeFileSync(target, 'Another note.\n');
  const originalStat = fs.statSync;
  t.mock.method(fs, 'statSync', function (file, options) {
    return file === target && options?.bigint ? cachedStat : originalStat.call(this, file, options);
  });
  capture = app.timeline.capture(project.id, actor, { source: 'WATCHER', dirtyPaths: ['note.md'] });
  assert.equal(capture.event.changes.find((change) => change.pathAfter === 'note.md')?.changeType, 'MODIFIED');
  assert.equal(app.timeline.blobs.get(capture.snapshot.files.find((file) => file.path === 'note.md').contentHash).toString(), 'Another note.\n');
});

test('unknown events and explicit checkpoints fully verify bytes; exclusions remove stale cache entries', (t) => {
  const { root, app, project } = fixture(t);
  const reads = trackProjectReads(t, root);
  app.timeline.capture(project.id, actor, { source: 'WATCHER' });
  assert.deepEqual(reads.sort(), ['data.csv', 'note.md']);
  reads.length = 0;
  app.timeline.capture(project.id, actor, { source: 'EXPLICIT_CHECKPOINT', dirtyPaths: [] });
  assert.deepEqual(reads.sort(), ['data.csv', 'note.md']);
  app.terminal.indexing.exclude(project.id, 'data.csv');
  const capture = app.timeline.capture(project.id, actor, { source: 'WATCHER', dirtyPaths: ['note.md'] });
  assert.equal(capture.event.changes[0].changeType, 'DELETED');
  assert.equal(app.timeline.scanCaches.get(project.id).has('data.csv'), false);
  app.terminal.indexing.include(project.id, 'data.csv');
  assert.equal(app.timeline.capture(project.id, actor, { source: 'WATCHER', dirtyPaths: ['note.md'] }).event.changes[0].changeType, 'ADDED');
});

test('directory hints dirty descendants and changing a file during a read does not cache unstable bytes', (t) => {
  const { root, sandbox } = fixture(t);
  fs.mkdirSync(path.join(root, 'nested'));
  const target = path.join(root, 'nested', 'note.md');
  fs.writeFileSync(target, 'before');
  const fileCache = new Map();
  const blobs = new BlobStore(path.join(sandbox, 'scan-blobs'));
  scanDirectory(root, blobs, { fileCache });
  const reads = trackProjectReads(t, root);
  scanDirectory(root, blobs, { fileCache, reuseUnchanged: true, dirtyPaths: ['nested'] });
  assert.deepEqual(reads, ['nested/note.md']);
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    const bytes = original.call(this, file, ...args);
    if (file === target) fs.writeFileSync(target, 'a later write');
    return bytes;
  });
  scanDirectory(root, blobs, { fileCache, reuseUnchanged: true, dirtyPaths: ['nested'] });
  assert.equal(fileCache.has('nested/note.md'), false);
});

test('watcher filters ignored and excluded paths and batches dirty hints', async (t) => {
  let callback;
  t.mock.method(fs, 'watch', (_root, _options, listener) => {
    callback = listener;
    return { close() {}, on() {} };
  });
  const { app, project } = fixture(t, { watchProjects: true, watchDebounceMs: 5 });
  app.terminal.indexing.exclude(project.id, 'excluded');
  const captures = [];
  t.mock.method(app.timeline, 'capture', (...args) => captures.push(args));
  callback('change', '.git/config');
  callback('rename', 'nested/node_modules/file.js');
  callback('change', '.lasso-data/timeline.sqlite-wal');
  callback('change', 'excluded/note.md');
  callback('change', '.DS_Store');
  callback('change', '.~note.md');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(captures.length, 0);
  callback('change', 'note.md');
  callback('rename', Buffer.from('data.csv'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(captures[0][2].dirtyPaths.sort(), ['data.csv', 'note.md']);
  callback('change', null);
  callback('change', 'note.md');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(captures[1][2].dirtyPaths, null);
});

test('configured storage inside a project is excluded from captures and watcher events', async (t) => {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-storage-test-')));
  fs.writeFileSync(path.join(sandbox, 'note.md'), 'A document.');
  let callback;
  t.mock.method(fs, 'watch', (_root, _options, listener) => {
    callback = listener;
    return { close() {}, on() {} };
  });
  const app = createApplication({ dataDir: path.join(sandbox, 'custom-history'), watchDebounceMs: 5 });
  t.after(async () => {
    await app.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const { project } = app.timeline.importProject(sandbox, actor);
  assert.deepEqual(app.timeline.getSnapshot(project.currentSnapshotId).files.map((file) => file.path), ['note.md']);
  const captures = t.mock.method(app.timeline, 'capture');
  callback('change', 'custom-history/timeline.sqlite-wal');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(captures.mock.callCount(), 0);
});

test('an overridden SQLite database inside a project excludes its file and every sidecar', async (t) => {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-sqlite-test-')));
  const root = path.join(sandbox, 'project');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'note.md'), 'A document.');
  let callback;
  t.mock.method(fs, 'watch', (_root, _options, listener) => {
    callback = listener;
    return { close() {}, on() {} };
  });
  const app = createApplication({
    dataDir: path.join(sandbox, 'history'), databasePath: path.join(root, 'custom.sqlite'), watchDebounceMs: 5,
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const { project } = app.timeline.importProject(root, actor);
  assert.deepEqual(app.timeline.getSnapshot(project.currentSnapshotId).files.map((file) => file.path), ['note.md']);
  const captures = t.mock.method(app.timeline, 'capture');
  for (const suffix of ['', '-wal', '-shm', '-journal']) callback('change', `custom.sqlite${suffix}`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(captures.mock.callCount(), 0);
});

test('captures preserve indexed history without running rule history queries when no change rule is enabled', (t) => {
  const { root, app, project } = fixture(t);
  const queries = t.mock.method(app.terminal.graph, 'valueChanges', () => []);
  fs.writeFileSync(path.join(root, 'data.csv'), 'metric,value\nrevenue,200\n');
  const capture = app.timeline.capture(project.id, actor);
  assert.equal(queries.mock.callCount(), 0);
  assert.ok(app.db.prepare('SELECT 1 FROM snapshot_object_indexes WHERE snapshot_id = ?').get(capture.snapshot.id));
  app.terminal.rules.add(project.id, { sentence: 'when source path starts with data then exclude from autocomplete' }, actor);
  fs.writeFileSync(path.join(root, 'data.csv'), 'metric,value\nrevenue,300\n');
  app.timeline.capture(project.id, actor);
  assert.equal(queries.mock.callCount(), 0);
});

test('automatic rules only flag the current capture and still handle later source changes', (t) => {
  const { root, app, project } = fixture(t);
  fs.writeFileSync(path.join(root, 'data.csv'), 'metric,value\nrevenue,200\n');
  app.timeline.capture(project.id, actor);
  app.terminal.rules.add(project.id, { sentence: 'when source path starts with data.csv then flag affected dependencies' }, actor);
  fs.writeFileSync(path.join(root, 'note.md'), 'Unrelated edit.');
  app.timeline.capture(project.id, actor);
  assert.equal(app.terminal.rules.flags(project.id).length, 0, 'a new rule must not flag old source changes');
  fs.writeFileSync(path.join(root, 'data.csv'), 'metric,value\nrevenue,300\n');
  app.timeline.capture(project.id, actor);
  const flags = app.terminal.rules.flags(project.id);
  assert.ok(flags.some((flag) => flag.detail.previousValue === '200' && flag.detail.currentValue === '300'));
  assert.ok(app.terminal.graph.valueChanges(project.id, { latestPerObject: false }).some((change) => change.previousValue === '100' && change.currentValue === '200'));
});

test('capture rule comparisons retain renamed object identities and omit deleted sources', (t) => {
  const { root, app, project } = fixture(t);
  app.terminal.rules.add(project.id, { sentence: 'when source path starts with renamed.csv then flag affected dependencies' }, actor);
  fs.renameSync(path.join(root, 'data.csv'), path.join(root, 'renamed.csv'));
  const rename = app.timeline.capture(project.id, actor);
  const changes = app.terminal.graph.valueChanges(project.id, {
    snapshotId: rename.snapshot.id, previousSnapshotId: rename.event.previousSnapshotId,
  });
  assert.ok(changes.some((change) => change.path === 'renamed.csv' && change.previousPath === 'data.csv' && change.moved));
  assert.ok(app.terminal.rules.flags(project.id).length > 0);
  fs.unlinkSync(path.join(root, 'renamed.csv'));
  const deletion = app.timeline.capture(project.id, actor);
  assert.deepEqual(app.terminal.graph.valueChanges(project.id, {
    snapshotId: deletion.snapshot.id, previousSnapshotId: deletion.event.previousSnapshotId,
  }), []);
});

test('historical terminal object browsing evicts derived snapshots without changing answers', (t) => {
  const { root, app, project } = fixture(t);
  // Exercise eviction independently of the larger live multi-folder budget.
  app.terminal.graph.namedObjectCache.maxEntries = 3;
  const snapshots = [project.currentSnapshotId];
  for (const value of [200, 300, 400, 500]) {
    fs.writeFileSync(path.join(root, 'data.csv'), `metric,value\nrevenue,${value}\n`);
    snapshots.push(app.timeline.capture(project.id, actor).snapshot.id);
  }
  const first = app.terminal.graph.namedObjects(project.id, snapshots[0]);
  for (const snapshotId of snapshots.slice(1)) app.terminal.graph.namedObjects(project.id, snapshotId);
  assert.equal(app.terminal.graph.namedObjectCache.size, 3);
  assert.equal(app.terminal.graph.namedObjectCache.has(snapshots[0]), false);
  assert.deepEqual(app.terminal.graph.namedObjects(project.id, snapshots[0]), first);
  assert.equal(app.terminal.graph.namedObjectCache.size, 3);
});

function fakeWatcher(t) {
  const watcher = { listener: null, errorHandler: null, starts: 0 };
  t.mock.method(fs, 'watch', (_root, _options, listener) => {
    watcher.listener = listener;
    watcher.starts += 1;
    return { close() {}, on(event, handler) { if (event === 'error') watcher.errorHandler = handler; } };
  });
  return watcher;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a file saved continuously is still captured within the maximum wait', async (t) => {
  // Arrange
  const watcher = fakeWatcher(t);
  const { app } = fixture(t, { watchProjects: true, watchDebounceMs: 60, watchMaxWaitMs: 150 });
  const captures = [];
  t.mock.method(app.timeline, 'capture', (...args) => captures.push(args));

  // Act: a save every 25 ms keeps resetting the debounce.
  for (let index = 0; index < 16; index += 1) {
    watcher.listener('change', 'note.md');
    await pause(25);
  }

  // Assert
  assert.ok(captures.length >= 1, 'a capture ran while saves were still arriving');
});

test('a failed watcher capture keeps its changed paths and tries again', async (t) => {
  const watcher = fakeWatcher(t);
  const { app } = fixture(t, { watchProjects: true, watchDebounceMs: 5 });
  const captures = [];
  const errors = [];
  t.mock.method(console, 'error', (...values) => errors.push(values));
  t.mock.method(app.timeline, 'capture', (...args) => {
    captures.push(args);
    if (captures.length === 1) throw new Error('database is locked');
  });
  watcher.listener('change', 'data.csv');
  await pause(60);
  assert.equal(captures.length, 2);
  assert.deepEqual(captures[1][2].dirtyPaths, ['data.csv']);
});

test('a watcher that fails is restarted and the folder rescanned', async (t) => {
  const watcher = fakeWatcher(t);
  const { app } = fixture(t, { watchProjects: true, watchDebounceMs: 5 });
  const captures = [];
  t.mock.method(console, 'error', () => {});
  t.mock.method(app.timeline, 'capture', (...args) => captures.push(args));
  assert.equal(watcher.starts, 1);
  watcher.errorHandler(new Error('EMFILE: too many open files, watch'));
  await pause(60);
  assert.equal(watcher.starts, 2);
  assert.equal(captures.at(-1)[2].dirtyPaths, null, 'changes made while unwatched are found by a full rescan');
});

test('reopening a folder after a restart reads only the files that changed', async (t) => {
  // Arrange: Lasso restarts, and one file changed while it was closed.
  const { sandbox, root, app, project } = fixture(t);
  await app.close();
  const reopened = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  try {
    fs.writeFileSync(path.join(root, 'data.csv'), 'metric,value\nrevenue,250\n');
    const reads = trackProjectReads(t, root);

    // Act
    const result = reopened.timeline.capture(project.id, actor, { source: 'OPEN_RECONCILE' });

    // Assert
    assert.deepEqual(reads, ['data.csv'], 'the unchanged note is not read and hashed again');
    assert.equal(result.changed, true);
    assert.ok(result.snapshot.files.some((file) => file.path === 'note.md'), 'unchanged files stay in the snapshot');
  } finally {
    // Close the reopened database before the fixture removes its directory.
    await reopened.close();
  }
});
