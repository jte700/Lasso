import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createApplication } from '../src/server.js';
import { createConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { BlobReleasedError } from '../src/history/errors.js';
import { anchorForSpan } from '../src/dependencies/service.js';

const actor = { id: 'human:retention', displayName: 'Retention', actorType: 'HUMAN_SELF' };
const agent = { id: 'agent:retention', displayName: 'Retention agent', actorType: 'AI_AGENT' };
const DAY = 86_400_000;
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
/** A time past the default window of 30 days, when every version here is old. */
const later = () => Date.now() + 40 * DAY;

/** The ward table at a revision: that revision's ward has its beds changed. */
function wards(revision) {
  const rows = Array.from({ length: 30 }, (_, row) => `Ward ${row},${row === revision ? 900 + row : 20 + row},${5 + row}`);
  return `Ward,Beds,Nurses\n${rows.join('\n')}\n`;
}

function notes(revision) {
  return `# Ward notes\n\nBed counts are reviewed each quarter by the charge nurse.\n\nThis is revision ${revision} of the notes.\n`;
}

/** A folder with a table and notes, recorded and indexed. `save(n)` records revision n of both. */
function library(t, overrides = {}) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-blob-retention-')));
  const folder = path.join(sandbox, 'Clinic');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'wards.csv'), wards(0));
  fs.writeFileSync(path.join(folder, 'notes.md'), notes(0));
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false, ...overrides });
  t.after(async () => {
    await app.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const imported = app.timeline.importProject(folder, actor, { watch: false });
  app.dependencies.ensureIndex(imported.project.id);
  const state = { app, sandbox, folder, project: imported.project, snapshots: [imported.project.currentSnapshotId], events: [imported.event.id] };
  state.save = (revision) => {
    fs.writeFileSync(path.join(folder, 'wards.csv'), wards(revision));
    fs.writeFileSync(path.join(folder, 'notes.md'), notes(revision));
    const capture = app.timeline.capture(state.project.id, actor, { source: 'WATCHER', dirtyPaths: ['wards.csv', 'notes.md'] });
    assert.equal(capture.changed, true, `revision ${revision} should be recorded`);
    app.dependencies.ensureIndex(state.project.id);
    state.snapshots[revision] = capture.snapshot.id;
    state.events[revision] = capture.event.id;
    return capture;
  };
  state.saveThrough = (last) => {
    for (let revision = state.snapshots.length; revision <= last; revision += 1) state.save(revision);
  };
  return state;
}

/** Runs cleanup batch after batch until a whole pass is done, and returns the hashes it released. */
function drain(app, now) {
  const released = [];
  for (let batches = 0; batches < 1_000; batches += 1) {
    const batch = app.retention.releaseBatch({ now });
    released.push(...batch.released.map((entry) => entry.contentHash));
    if (batch.done) return released.sort();
  }
  throw new Error('Cleanup did not finish.');
}

const hashesOf = (revisions, ...contents) => revisions.flatMap((revision) => contents.map((content) => sha256(content(revision)))).sort();

test('Nothing is released while retention is off', (t) => {
  // Arrange
  const { app, saveThrough } = library(t);
  saveThrough(12);

  // Act
  const batch = app.retention.releaseBatch({ now: later() });
  const released = drain(app, later());

  // Assert
  assert.equal(createConfig({ dataDir: app.config.dataDir }).blobRetentionEnabled, false, 'retention is off unless switched on');
  assert.equal(batch.enabled, false);
  assert.deepEqual(released, []);
  for (let revision = 0; revision <= 12; revision += 1) {
    assert.equal(app.timeline.blobs.has(sha256(wards(revision))), true, `revision ${revision} of the table`);
    assert.equal(app.timeline.blobs.has(sha256(notes(revision))), true, `revision ${revision} of the notes`);
  }
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM released_blobs').get().count, 0);
  assert.equal(app.retention.timer, null, 'no timer runs for a switch that is off');
});

test('A version inside the retention window keeps its bytes, however many newer versions there are', (t) => {
  const { app, saveThrough } = library(t, { blobRetentionEnabled: true });
  saveThrough(12);

  const released = drain(app, Date.now());

  assert.deepEqual(released, [], 'thirteen saves in one sitting are all newer than the window');
  assert.equal(app.timeline.blobs.has(sha256(wards(0))), true);
});

test('An old unpinned version keeps its values after its bytes are released', async (t) => {
  // Arrange
  const { app, project, snapshots, events, saveThrough } = library(t, { blobRetentionEnabled: true });
  saveThrough(12);
  const blobs = app.timeline.blobs;
  const changed = app.dependencies.objectsAt(project.id, snapshots[1]).find((object) => object.valueText === '901');
  assert.ok(changed, 'revision 1 recorded the changed bed count');
  const expandedBefore = app.timeline.getEvent(events[1]).changes.find((change) => change.pathAfter === 'notes.md').structuredDiff;
  assert.ok(expandedBefore.operations?.length, 'the notes diff is read from both versions while they are kept');

  // Act
  const released = drain(app, later());

  // Assert: the three oldest of thirteen versions of each file lost their bytes.
  assert.deepEqual(released, hashesOf([0, 1, 2], wards, notes));
  for (const revision of [0, 1, 2]) assert.equal(blobs.has(sha256(wards(revision))), false, `revision ${revision}`);
  for (let revision = 3; revision <= 12; revision += 1) {
    assert.equal(blobs.get(sha256(wards(revision))).toString(), wards(revision), `revision ${revision} is among the newest ten`);
  }
  assert.throws(() => blobs.get(sha256(wards(1))), (error) => error instanceof BlobReleasedError
    && error.code === 'BLOB_RELEASED' && /not kept/.test(error.message) && Boolean(error.releasedAt));
  assert.throws(() => blobs.rawPath(sha256(wards(1))), BlobReleasedError);
  const recorded = app.db.prepare('SELECT content_hash, released_at, stored_bytes FROM released_blobs ORDER BY content_hash').all();
  assert.deepEqual(recorded.map((row) => row.content_hash), released);
  assert.ok(recorded.every((row) => row.stored_bytes > 0 && !Number.isNaN(Date.parse(row.released_at))));

  // Its values, its event and its place in the value history are all still there.
  const kept = app.dependencies.objectsAt(project.id, snapshots[1]).find((object) => object.id === changed.id);
  assert.equal(kept.valueText, '901');
  assert.equal(kept.versionId, changed.versionId);
  const event = app.timeline.getEvent(events[1]);
  assert.deepEqual(event.changes.find((change) => change.pathAfter === 'wards.csv').structuredDiff.cellsChanged,
    [{ rowKey: 'Ward 0', column: 'Beds', before: '900', after: '20' }, { rowKey: 'Ward 1', column: 'Beds', before: '21', after: '901' }]);
  const fallback = event.changes.find((change) => change.pathAfter === 'notes.md').structuredDiff;
  assert.ok(Array.isArray(fallback.operationRuns), 'the notes diff falls back to what was stored');
  assert.equal(fallback.bytesReleased, true);
  const history = app.rfi.request(project.id, { path: 'wards.csv',
    anchor: { kind: 'table-cell', rowKey: 'Ward 1', column: 'Beds' } });
  assert.equal(history.selection.value, '21');
  assert.equal(history.versionsWithoutBytes, 3);
  const terminalPreview = app.terminal.graph.preview(project.id, kept);
  assert.equal(terminalPreview.kind, 'meta');
  assert.equal(terminalPreview.value, '901');
  assert.match(terminalPreview.bytesReleased.message, /not kept/);

  // The card is shown the recorded values, and told plainly that the file itself was not kept.
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/dependency-objects/${changed.id}/preview?version=${changed.versionId}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.source.valueText, '901');
  assert.equal(body.source.label, 'Ward 1 · Beds');
  assert.equal(body.preview, null);
  assert.equal(body.bytesReleased.contentHash, sha256(wards(1)));
  assert.match(body.bytesReleased.message, /not kept/);
  assert.ok(body.bytesReleased.releasedAt);
  const current = app.dependencies.objectsAt(project.id).find((object) => object.valueText === '912');
  const live = await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/dependency-objects/${current.id}/preview?version=${current.versionId}`)).json();
  assert.ok(live.preview, 'a version whose bytes are kept previews as before');
  assert.equal('bytesReleased' in live, false);
});

test('A pinned share keeps its bytes past the retention window', (t) => {
  // Arrange: a link is made to a value while revision 1 is the folder's content.
  const { app, project, saveThrough } = library(t, { blobRetentionEnabled: true });
  saveThrough(1);
  const cited = app.dependencies.objectsAt(project.id).find((object) => object.valueText === '901');
  const share = app.objectShares.createShare({ projectId: project.id, objectId: cited.id, versionId: cited.versionId, actor });
  saveThrough(12);

  // Act
  const released = drain(app, later());

  // Assert: revisions 0 and 2 are released; everything in the shared revision stays.
  assert.deepEqual(released, hashesOf([0, 2], wards, notes));
  assert.equal(app.timeline.blobs.get(sha256(wards(1))).toString(), wards(1));
  assert.equal(app.timeline.blobs.has(sha256(notes(1))), true);
  const resolved = app.objectShares.resolveShare(share.token);
  assert.equal(resolved.status, 'OK');
  assert.equal(resolved.source.valueText, '901');
});

test('A share made before shares recorded their snapshot pins the snapshot of its version', (t) => {
  const { app, project, saveThrough } = library(t, { blobRetentionEnabled: true });
  saveThrough(1);
  const cited = app.dependencies.objectsAt(project.id).find((object) => object.valueText === '901');
  const share = app.objectShares.createShare({ projectId: project.id, objectId: cited.id, versionId: cited.versionId, actor });
  app.db.prepare('UPDATE object_share_grants SET snapshot_id = NULL WHERE token = ?').run(share.token);
  saveThrough(12);

  const released = drain(app, later());

  assert.equal(released.includes(sha256(wards(1))), false);
  assert.equal(app.timeline.blobs.has(sha256(wards(1))), true);
});

test('A pending proposal, recorded evidence and a provenance link keep the bytes they name', (t) => {
  // Arrange: fifteen versions, of which revisions 0 to 4 are old enough to release.
  const { app, project, snapshots, saveThrough } = library(t, { blobRetentionEnabled: true });
  saveThrough(14);
  // A proposal to put the notes back as they first were names that content.
  const proposal = app.timeline.proposeAgentEdit(project.id, { agent, initiatedBy: actor, path: 'notes.md', content: notes(0), request: 'Restore the first notes.' });
  assert.equal(proposal.proposal.contentHashAfter, sha256(notes(0)));
  // An agent was shown the table as it stood at revision 1.
  const table = app.timeline.snapshotFile(snapshots[1], 'wards.csv');
  app.db.prepare(`INSERT INTO agent_evidence(handle, project_id, snapshot_id, project_file_id, path, content_hash, created_at, last_used_at)
    VALUES ('E1', ?, ?, ?, 'wards.csv', ?, ?, ?)`).run(project.id, snapshots[1], table.projectFileId, table.contentHash,
    new Date().toISOString(), new Date().toISOString());
  // The notes were recorded as derived from revision 2.
  app.timeline.addProvenanceLink(project.id, { fromSnapshotId: snapshots[14], fromPath: 'notes.md', relation: 'DERIVED_FROM',
    toSnapshotId: snapshots[2], toPath: 'wards.csv' });

  // Act
  const released = drain(app, later());

  // Assert
  assert.deepEqual(released, [sha256(wards(0)), sha256(wards(3)), sha256(wards(4)),
    sha256(notes(1)), sha256(notes(3)), sha256(notes(4))].sort());
  assert.equal(app.timeline.blobs.has(sha256(notes(0))), true, 'the proposal can still be applied');
  assert.equal(app.timeline.blobs.has(sha256(wards(1))), true, 'the evidence can still be read');
  assert.equal(app.timeline.blobs.has(sha256(wards(2))), true, 'the linked version can still be read');
});

test('A linked source keeps the bytes of the version it was linked at', (t) => {
  // Arrange: a draft cites a value recorded in the table's first version.
  const { app, sandbox, project, snapshots, saveThrough } = library(t, { blobRetentionEnabled: true });
  const drafts = path.join(sandbox, 'Drafts');
  fs.mkdirSync(drafts);
  fs.writeFileSync(path.join(drafts, 'report.md'), '# Report\n\nWard 29 has 49 beds.\n');
  const draftProject = app.timeline.importProject(drafts, actor, { watch: false }).project;
  const source = app.dependencies.objectsAt(project.id).find((object) => object.label === 'Ward 29 · Beds');
  assert.equal(source.snapshotId, snapshots[0]);
  app.dependencies.link(draftProject.id, { documentPath: 'report.md', anchor: anchorForSpan(1, 'paragraph', 'Ward 29 has 49 beds.', 12, 14),
    spanText: '49', sourceObjectId: source.id, sourceSnapshotId: source.snapshotId, selectionMethod: 'AUTOCOMPLETE' }, actor);
  saveThrough(12);

  // Act
  const released = drain(app, later());

  // Assert
  assert.deepEqual(released, hashesOf([1, 2], wards, notes));
  assert.equal(app.timeline.blobs.get(sha256(wards(0))).toString(), wards(0));
});

test('A version whose values were never recorded keeps its bytes', (t) => {
  // Arrange: revisions 1 and 2 were never indexed, as when a store's reader
  // failed or Lasso closed first, so their bytes are all there is of them.
  const { app, snapshots, saveThrough } = library(t, { blobRetentionEnabled: true });
  saveThrough(12);
  app.db.prepare('DELETE FROM snapshot_object_indexes WHERE snapshot_id IN (?, ?)').run(snapshots[1], snapshots[2]);

  // Act
  const released = drain(app, later());

  // Assert: only the indexed first revision is released.
  assert.deepEqual(released, hashesOf([0], wards, notes));
  for (const revision of [1, 2]) assert.equal(app.timeline.blobs.has(sha256(wards(revision))), true, `revision ${revision}`);
});

test('A version held by a snapshot without an index keeps its bytes', (t) => {
  // Arrange: revision 1 is held by two snapshots, and one of them has lost its index.
  const { app, folder, project, saveThrough } = library(t, { blobRetentionEnabled: true });
  saveThrough(1);
  fs.writeFileSync(path.join(folder, 'extra.txt'), 'An extra page of notes.\n');
  const held = app.timeline.capture(project.id, actor, { source: 'WATCHER', dirtyPaths: ['extra.txt'] }).snapshot.id;
  saveThrough(12);
  app.db.prepare('DELETE FROM snapshot_object_indexes WHERE snapshot_id = ?').run(held);

  // Act
  const released = drain(app, later());

  // Assert
  assert.deepEqual(released, hashesOf([0, 2], wards, notes));
  assert.equal(app.timeline.blobs.has(sha256(wards(1))), true);
});

test('An old version read by an earlier reader keeps its values after its bytes are released', async (t) => {
  // Arrange: the first version's index is marked as written before Markdown
  // passages were read, as an earlier build would have left it.
  const { app, sandbox, project, snapshots, saveThrough } = library(t, { blobRetentionEnabled: true });
  saveThrough(12);
  const valuesOf = (objects) => objects.map((object) => `${object.id} ${object.valueText ?? ''}`).sort();
  const before = valuesOf(app.dependencies.objectsAt(project.id, snapshots[0]));
  app.db.prepare('UPDATE snapshot_object_indexes SET drawing_index_version = 2 WHERE snapshot_id = ?').run(snapshots[0]);
  assert.ok(drain(app, later()).includes(sha256(notes(0))), 'the first notes are released');
  await app.close();

  // Act: a restarted Lasso, with nothing read into memory, is asked for that version's objects.
  const reopened = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false, blobRetentionEnabled: true });
  t.after(() => reopened.close());
  const after = valuesOf(reopened.dependencies.objectsAt(project.id, snapshots[0]));

  // Assert
  assert.deepEqual(after, before);
  assert.equal(reopened.dependencies.isIndexed(snapshots[0]), true, 'the pass is not tried again on every read');
});

/** Takes a version's bytes away and records it, as cleanup does. */
function releaseNow(app, hash) {
  app.timeline.blobs.remove(hash);
  app.db.prepare('INSERT INTO released_blobs(content_hash, released_at, stored_bytes) VALUES (?, ?, 1)')
    .run(hash, new Date().toISOString());
}

test('An old version whose index is behind still reads after its bytes are released and Lasso restarts', async (t) => {
  // Arrange: the first version's index is marked as written by the oldest
  // reader of every kind, and both of its files lose their bytes.
  const { app, sandbox, project, snapshots, saveThrough } = library(t);
  saveThrough(3);
  const valuesOf = (objects) => objects.map((object) => `${object.id} ${object.valueText ?? ''}`).sort();
  const before = valuesOf(app.dependencies.objectsAt(project.id, snapshots[0]));
  assert.ok(before.length > 0);
  app.db.prepare('UPDATE snapshot_object_indexes SET drawing_index_version = 0, spreadsheet_index_version = 1 WHERE snapshot_id = ?')
    .run(snapshots[0]);
  releaseNow(app, sha256(wards(0)));
  releaseNow(app, sha256(notes(0)));
  await app.close();

  // Act
  const reopened = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  t.after(() => reopened.close());
  const after = valuesOf(reopened.dependencies.objectsAt(project.id, snapshots[0]));
  const one = reopened.dependencies.objectAt(project.id, snapshots[0], after[0].split(' ')[0]);

  // Assert
  assert.deepEqual(after, before);
  assert.ok(one, 'one object is read at that version too');
  assert.equal(reopened.dependencies.isIndexed(snapshots[0]), true, 'the pass completes and is not tried again');
});

test('A version never indexed whose bytes are released records what it can read', async (t) => {
  // Arrange: revision 1 was recorded but never indexed, and its table lost its bytes.
  const { app, sandbox, folder, project } = library(t);
  // Captures here leave their versions unread, as when Lasso closes before indexing them.
  app.timeline.captureListeners.clear();
  fs.writeFileSync(path.join(folder, 'wards.csv'), wards(1));
  fs.writeFileSync(path.join(folder, 'notes.md'), notes(1));
  const unindexed = app.timeline.capture(project.id, actor, { source: 'WATCHER', dirtyPaths: ['wards.csv', 'notes.md'] }).snapshot.id;
  fs.writeFileSync(path.join(folder, 'notes.md'), notes(2));
  app.timeline.capture(project.id, actor, { source: 'WATCHER', dirtyPaths: ['notes.md'] });
  releaseNow(app, sha256(wards(1)));
  assert.equal(app.dependencies.isIndexed(unindexed), false);
  await app.close();

  // Act
  const reopened = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  t.after(() => reopened.close());
  const objects = reopened.dependencies.objectsAt(project.id, unindexed);

  // Assert
  assert.ok(objects.some((object) => object.path === 'notes.md'), 'the notes, whose bytes are kept, are read');
  assert.equal(reopened.dependencies.isIndexed(unindexed), true);
});

/** Makes every stored blob look as if nothing had touched it for `ageMs`. */
function ageBlobs(app, ageMs) {
  const then = new Date(Date.now() - ageMs);
  for (const entry of fs.readdirSync(app.timeline.blobs.root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) fs.utimesSync(path.join(entry.parentPath, entry.name), then, then);
  }
}

/** Starts a capture of the table and stops it once the table has been read. */
function readWithoutRecording(app, project) {
  const steps = app.timeline.captureSteps(project.id, actor, { source: 'WATCHER', dirtyPaths: ['wards.csv'] });
  let step = steps.next();
  while (!step.done && step.value?.phase !== 'reading') step = steps.next();
  return () => {
    while (!step.done) step = steps.next();
    return step.value;
  };
}

test('Bytes another Lasso has just found again are not released under it', async (t) => {
  // Arrange: a second Lasso on the same data folder keeps only the newest version.
  const { app, sandbox, folder, project, saveThrough } = library(t);
  saveThrough(3);
  const cleaner = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false,
    blobRetentionEnabled: true, blobRetentionVersions: 1, blobRetentionDays: 0 });
  t.after(() => cleaner.close());
  ageBlobs(app, 2 * DAY);
  // The table goes back to its first content, which this Lasso has read but not yet recorded.
  fs.writeFileSync(path.join(folder, 'wards.csv'), wards(0));
  const finish = readWithoutRecording(app, project);

  // Act
  const released = drain(cleaner, Date.now());
  const capture = finish();

  // Assert
  assert.equal(released.includes(sha256(wards(0))), false, 'bytes a capture has just found are kept');
  assert.ok(released.includes(sha256(wards(1))), 'versions nobody has found again still go');
  assert.equal(capture.changed, true);
  assert.equal(app.timeline.blobs.get(sha256(wards(0))).toString(), wards(0));
  await cleaner.close();
});

test('A capture that meets released bytes reads the folder again next time', (t) => {
  // Arrange: the bytes the table went back to are released while a capture is reading it.
  const { app, folder, project, saveThrough } = library(t);
  saveThrough(3);
  fs.writeFileSync(path.join(folder, 'wards.csv'), wards(0));
  const finish = readWithoutRecording(app, project);
  app.timeline.blobs.remove(sha256(wards(0)));
  app.db.prepare('INSERT INTO released_blobs(content_hash, released_at, stored_bytes) VALUES (?, ?, 1)')
    .run(sha256(wards(0)), new Date().toISOString());
  assert.throws(finish, BlobReleasedError);

  // Act
  fs.writeFileSync(path.join(folder, 'extra.txt'), 'An extra page of notes.\n');
  const next = app.timeline.capture(project.id, actor, { source: 'WATCHER', dirtyPaths: ['extra.txt'] });
  app.timeline.capture(project.id, actor, { source: 'WATCHER' });

  // Assert
  assert.equal(next.changed, true, 'a later capture of another file is recorded');
  const current = app.timeline.getProject(project.id).currentSnapshotId;
  assert.equal(app.timeline.snapshotFile(current, 'wards.csv').contentHash, sha256(wards(0)));
  assert.equal(app.timeline.blobs.get(sha256(wards(0))).toString(), wards(0), 'reading the table again stores its bytes again');
});

test('A linked source whose bytes are gone previews its recorded value', (t) => {
  // Arrange: a draft cites a bed count, and the bytes it was read from are taken away as cleanup would.
  const { app, sandbox, project } = library(t, { blobRetentionEnabled: true });
  const drafts = path.join(sandbox, 'Drafts');
  fs.mkdirSync(drafts);
  fs.writeFileSync(path.join(drafts, 'report.md'), '# Report\n\nWard 29 has 49 beds.\n');
  const draftProject = app.timeline.importProject(drafts, actor, { watch: false }).project;
  const source = app.dependencies.objectsAt(project.id).find((object) => object.label === 'Ward 29 · Beds');
  const { dependency } = app.dependencies.link(draftProject.id, { documentPath: 'report.md',
    anchor: anchorForSpan(1, 'paragraph', 'Ward 29 has 49 beds.', 12, 14), spanText: '49',
    sourceObjectId: source.id, sourceSnapshotId: source.snapshotId, selectionMethod: 'AUTOCOMPLETE' }, actor);
  app.timeline.blobs.remove(sha256(wards(0)));
  app.db.prepare('INSERT INTO released_blobs(content_hash, released_at, stored_bytes) VALUES (?, ?, 1)')
    .run(sha256(wards(0)), new Date().toISOString());

  // Act
  const preview = app.dependencies.dependencyPreview(dependency.id);
  const viewer = app.dependencies.dependencySourceViewer(dependency.id);

  // Assert
  assert.equal(preview.content.text, '49');
  assert.match(preview.bytesReleased.message, /not kept/);
  assert.equal(preview.bytesReleased.contentHash, sha256(wards(0)));
  assert.equal(viewer.kind, 'binary');
  assert.equal(viewer.locationLabel, 'Ward 29 · Beds');
  assert.match(viewer.bytesReleased.message, /not kept/);
  assert.throws(() => app.dependencies.dependencySourceFile(dependency.id), { status: 410 }, 'the original cannot be downloaded');
});

test('Versions of a folder on a removable drive all keep their bytes', (t) => {
  const { app, project, saveThrough } = library(t, { blobRetentionEnabled: true });
  saveThrough(12);
  app.db.prepare("INSERT INTO removable_drives(id, name, root_path, connected, updated_at) VALUES ('drive', 'Field drive', '/Volumes/Field', 0, ?)")
    .run(new Date().toISOString());
  app.db.prepare("INSERT INTO drive_projects(project_id, drive_id, relative_path) VALUES (?, 'drive', '.')").run(project.id);

  const released = drain(app, later());

  assert.deepEqual(released, [], 'a disconnected drive cannot be read again, so its history stays whole');
});

test('Cleanup waits while a capture is being read', (t) => {
  // Arrange
  const { app, folder, project, saveThrough } = library(t, { blobRetentionEnabled: true });
  saveThrough(12);
  fs.writeFileSync(path.join(folder, 'wards.csv'), wards(0));
  const steps = app.timeline.captureSteps(project.id, actor, { source: 'WATCHER', dirtyPaths: ['wards.csv'] });
  steps.next();

  // Act: the capture has listed the folder and is about to read revision 0's content again.
  const during = app.retention.releaseBatch({ now: later() });
  let step = steps.next();
  while (!step.done) step = steps.next();
  const after = drain(app, later());

  // Assert
  assert.equal(during.waiting, 'capture');
  assert.deepEqual(during.released, []);
  assert.equal(during.done, false);
  assert.equal(step.value.changed, true);
  assert.equal(app.timeline.blobs.get(sha256(wards(0))).toString(), wards(0), 'the content the folder went back to is its current version');
  assert.equal(after.includes(sha256(wards(0))), false);
  assert.ok(after.includes(sha256(wards(1))));
});

test('A file that goes back to released content has its bytes stored again', (t) => {
  const { app, folder, project, saveThrough } = library(t, { blobRetentionEnabled: true });
  saveThrough(12);
  drain(app, later());
  assert.equal(app.timeline.blobs.has(sha256(wards(0))), false);

  fs.writeFileSync(path.join(folder, 'wards.csv'), wards(0));
  app.timeline.capture(project.id, actor, { source: 'WATCHER', dirtyPaths: ['wards.csv'] });

  assert.equal(app.timeline.blobs.get(sha256(wards(0))).toString(), wards(0));
  assert.equal(drain(app, later()).includes(sha256(wards(0))), false);
});

test('Cleanup runs in small batches', (t) => {
  const { app, saveThrough } = library(t, { blobRetentionEnabled: true });
  saveThrough(12);

  const batches = [];
  for (let count = 0; count < 100; count += 1) {
    const batch = app.retention.releaseBatch({ now: later(), limit: 4 });
    batches.push(batch);
    if (batch.done) break;
  }

  assert.ok(batches.length > 3, `twenty-six stored versions take several batches of four (${batches.length})`);
  assert.ok(batches.every((batch) => batch.examined <= 4));
  assert.equal(batches.reduce((total, batch) => total + batch.released.length, 0), 6);
  assert.ok(batches.reduce((total, batch) => total + batch.releasedBytes, 0) > 0);
});

test('Cleanup starts by itself once captures stop, and leaves no timer running', async (t) => {
  // Arrange: only the current version is kept, and cleanup starts a moment after a capture.
  const { app, save } = library(t, { blobRetentionEnabled: true, blobRetentionVersions: 1, blobRetentionDays: 0, blobRetentionIdleMs: 5,
    blobRetentionGraceMs: 0, blobTouchWindowMs: 0 });

  // Act
  save(1);
  save(2);
  for (let waited = 0; waited < 200 && (app.timeline.blobs.has(sha256(wards(1))) || app.retention.timer); waited += 1) await wait(10);

  // Assert
  assert.equal(app.timeline.blobs.has(sha256(wards(0))), false);
  assert.equal(app.timeline.blobs.has(sha256(wards(1))), false);
  assert.equal(app.timeline.blobs.has(sha256(wards(2))), true);
  assert.equal(app.retention.timer, null, 'nothing is scheduled once a pass is done');
});

test('Applying a proposal whose bytes are gone fails with a clear message', (t) => {
  // Arrange: the proposed content is taken away as cleanup would take an old version.
  const { app, project } = library(t, { blobRetentionEnabled: true });
  const proposal = app.timeline.proposeAgentEdit(project.id, { agent, initiatedBy: actor, path: 'notes.md', content: notes(7), request: 'Revise.' });
  app.timeline.blobs.remove(proposal.proposal.contentHashAfter);
  app.db.prepare('INSERT INTO released_blobs(content_hash, released_at, stored_bytes) VALUES (?, ?, 1)')
    .run(proposal.proposal.contentHashAfter, new Date().toISOString());

  // Act and assert
  assert.throws(() => app.timeline.approveAgentEdit(proposal.id), (error) => error instanceof BlobReleasedError
    && error.status === 410 && /original bytes of this version were not kept/.test(error.message));
  assert.equal(fs.readFileSync(path.join(app.timeline.getProject(project.id).rootPath, 'notes.md'), 'utf8'), notes(0), 'the file is left as it was');
});

test('A store from before released blobs were recorded upgrades cleanly', (t) => {
  // Arrange: a store at migration 26, holding a folder's history.
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-released-blobs-migration-')));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const databasePath = path.join(sandbox, 'timeline.sqlite');
  const legacy = new DatabaseSync(databasePath);
  for (const name of fs.readdirSync('migrations').sort().filter((name) => Number(name.split('_')[0]) < 27)) {
    legacy.exec(fs.readFileSync(path.join('migrations', name), 'utf8'));
  }
  legacy.exec(`INSERT INTO projects(id, name, root_path, created_at) VALUES ('project', 'Clinic', '/clinic', '2026-10-01T00:00:00.000Z');
    INSERT INTO snapshots(id, project_id, version, manifest_hash, created_at) VALUES ('snapshot', 'project', 1, 'manifest', '2026-10-01T00:00:00.000Z');`);
  assert.equal(legacy.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 26);
  legacy.close();

  // Act: opened by this build, twice.
  openDatabase({ databasePath }).close();
  const db = openDatabase({ databasePath });
  t.after(() => db.close());

  // Assert
  assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version >= 27, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 27').get().count, 1);
  assert.deepEqual(db.prepare('PRAGMA table_info(released_blobs)').all().map((column) => column.name),
    ['content_hash', 'released_at', 'stored_bytes']);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM released_blobs').get().count, 0, 'no version starts out released');
  assert.ok(db.prepare('PRAGMA index_list(file_changes)').all().some((index) => index.name === 'file_changes_file_idx'),
    "a file's versions are found without reading every change");
  assert.equal(db.prepare('SELECT name FROM projects').get().name, 'Clinic');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM snapshots').get().count, 1);
  // Applying the migration over a store that already has it changes nothing.
  db.prepare("INSERT INTO released_blobs(content_hash, released_at, stored_bytes) VALUES ('hash', '2026-11-01T00:00:00.000Z', 12)").run();
  db.exec(fs.readFileSync(path.join('migrations', '027_released_blobs.sql'), 'utf8'));
  assert.equal(db.prepare('SELECT stored_bytes FROM released_blobs').get().stored_bytes, 12);
});
