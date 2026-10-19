import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApplication } from '../src/server.js';
import { openDatabase } from '../src/db.js';
import { createStructuredDiff, diffInternals } from '../src/history/diff.js';
import { anchorForSpan, detectClaimSpans } from '../src/dependencies/service.js';

const actor = { id: 'human:storage-test', displayName: 'Storage test', actorType: 'HUMAN_SELF' };
const CSV_FILES = 4;
const CSV_ROWS = 40;

function ledger(file, rows = CSV_ROWS, changedRow = null) {
  const lines = ['site,metric,amount'];
  for (let row = 0; row < rows; row += 1) {
    const amount = row === changedRow ? 999_999 : (file + 1) * 1000 + row;
    lines.push(`site-${file}-${row},metric-${row % 3},${amount}`);
  }
  return `${lines.join('\n')}\n`;
}

const NOTE = '# Site notes\n\nThe clinic capacity is reviewed each quarter.\n\nRevision 0.\n';

function fixture(t) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-storage-test-')));
  const root = path.join(sandbox, 'project');
  const dataDir = path.join(sandbox, 'history');
  fs.mkdirSync(root);
  for (let file = 0; file < CSV_FILES; file += 1) fs.writeFileSync(path.join(root, `ledger-${file}.csv`), ledger(file));
  fs.writeFileSync(path.join(root, 'notes.md'), NOTE);
  const state = { sandbox, root, dataDir, app: createApplication({ dataDir, watchProjects: false }) };
  state.project = state.app.timeline.importProject(root, actor).project;
  state.app.dependencies.ensureIndex(state.project.id);
  state.reopen = async () => {
    await state.app.close();
    state.app = createApplication({ dataDir, watchProjects: false });
    return state.app;
  };
  t.after(async () => {
    await state.app.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  return state;
}

function capture(state, dirtyPaths = null) {
  const result = state.app.timeline.capture(state.project.id, actor, { source: 'WATCHER', dirtyPaths });
  assert.equal(result.changed, true, 'the edit should be captured');
  return result;
}

function rows(app, table) {
  return app.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

/** What a snapshot's objects say, without the ids of the rows that store them. */
function objectView(app, projectId, snapshotId) {
  const version = app.timeline.getSnapshot(snapshotId).version;
  return app.dependencies.objectsAt(projectId, snapshotId).map((object) => {
    assert.equal(object.snapshotId, snapshotId, 'objects report the snapshot they were resolved at');
    assert.equal(object.snapshotVersion, version, 'objects report the version they were resolved at');
    return {
      id: object.id, objectKey: object.objectKey, objectType: object.objectType, path: object.path,
      anchor: object.anchor, label: object.label, valueText: object.valueText,
      contentHash: object.contentHash, metadata: object.metadata, searchText: object.searchText,
    };
  }).sort((left, right) => left.objectKey.localeCompare(right.objectKey));
}

function fileView(app, snapshotId) {
  return app.timeline.getSnapshot(snapshotId).files.map((file) => {
    assert.equal(file.snapshotId, snapshotId, 'files report the snapshot they were resolved at');
    return { ...file };
  });
}

function manuscriptAnchor(content, text) {
  const blocks = diffInternals.markdownBlocks(content);
  const blockIndex = blocks.findIndex((block) => block.text.includes(text));
  const block = blocks[blockIndex];
  const claim = detectClaimSpans(block.text).find((item) => item.text.includes(text) || text.includes(item.text));
  assert.ok(claim, `Expected a detected claim for ${text}`);
  return { claim, anchor: anchorForSpan(blockIndex, block.type, block.text, claim.start, claim.end) };
}

test('a one-line save stores new rows only for the file that changed', (t) => {
  const state = fixture(t);
  const { app, project } = state;
  const before = objectView(app, project.id, project.currentSnapshotId);
  assert.ok(before.length > CSV_FILES * CSV_ROWS, 'the folder should index hundreds of objects');
  const versionRows = rows(app, 'scientific_object_versions');
  const fileRows = rows(app, 'snapshot_files');

  fs.writeFileSync(path.join(state.root, 'notes.md'), NOTE.replace('Revision 0.', 'Revision 1.'));
  const result = capture(state, ['notes.md']);
  const after = objectView(app, project.id, result.snapshot.id);

  const noteObjects = after.filter((object) => object.path === 'notes.md').length;
  assert.ok(rows(app, 'scientific_object_versions') - versionRows <= noteObjects,
    'only the edited file\'s objects get new versions');
  assert.equal(rows(app, 'snapshot_files') - fileRows, 1, 'only the edited file gets a new file row');
  const unchanged = (objects) => objects.filter((object) => object.path !== 'notes.md');
  assert.deepEqual(unchanged(after), unchanged(before), 'objects of unchanged files carry forward as they were');
  const noteHash = result.snapshot.files.find((file) => file.path === 'notes.md').contentHash;
  assert.ok(after.filter((object) => object.path === 'notes.md').every((object) => object.contentHash === noteHash),
    'the edited file\'s objects describe its new content');
});

test('every recorded snapshot keeps resolving to exactly the files and objects it had', async (t) => {
  const state = fixture(t);
  const recorded = [];
  const record = (snapshotId) => recorded.push({
    snapshotId, files: fileView(state.app, snapshotId), objects: objectView(state.app, state.project.id, snapshotId),
    order: state.app.dependencies.objectsAt(state.project.id, snapshotId).map((object) => object.id),
  });
  record(state.project.currentSnapshotId);

  fs.writeFileSync(path.join(state.root, 'ledger-0.csv'), ledger(0, CSV_ROWS, 3));
  record(capture(state, ['ledger-0.csv']).snapshot.id);
  fs.unlinkSync(path.join(state.root, 'ledger-1.csv'));
  record(capture(state, ['ledger-1.csv']).snapshot.id);
  fs.writeFileSync(path.join(state.root, 'added.md'), '# Added\n\nA new paragraph about quarterly capacity.\n');
  record(capture(state, ['added.md']).snapshot.id);
  fs.renameSync(path.join(state.root, 'ledger-2.csv'), path.join(state.root, 'ledger-renamed.csv'));
  record(capture(state, ['ledger-2.csv', 'ledger-renamed.csv']).snapshot.id);
  fs.writeFileSync(path.join(state.root, 'ledger-1.csv'), ledger(1));
  record(capture(state, ['ledger-1.csv']).snapshot.id);
  fs.writeFileSync(path.join(state.root, 'ledger-0.csv'), ledger(0));
  record(capture(state, ['ledger-0.csv']).snapshot.id);

  assert.ok(!recorded[2].files.some((file) => file.path === 'ledger-1.csv'), 'a deleted file is gone from its snapshot');
  assert.ok(!recorded[2].objects.some((object) => object.path === 'ledger-1.csv'), 'a deleted file\'s objects are gone');
  const renamedBefore = recorded[3].files.find((file) => file.path === 'ledger-2.csv');
  const renamedAfter = recorded[4].files.find((file) => file.path === 'ledger-renamed.csv');
  assert.equal(renamedAfter.projectFileId, renamedBefore.projectFileId, 'a renamed file keeps its identity');

  const app = await state.reopen();
  for (const snapshot of recorded) {
    assert.deepEqual(fileView(app, snapshot.snapshotId), snapshot.files, `files at ${snapshot.snapshotId}`);
    assert.deepEqual(objectView(app, state.project.id, snapshot.snapshotId), snapshot.objects, `objects at ${snapshot.snapshotId}`);
    assert.deepEqual(app.dependencies.objectsAt(state.project.id, snapshot.snapshotId).map((object) => object.id), snapshot.order,
      'an index built in memory lists objects in the order the database returns');
  }
});

test('linking a source does not copy the folder\'s files or objects', (t) => {
  const state = fixture(t);
  const { app, project } = state;
  const manuscript = '# Report\n\nNorth site amount was 1003.\n';
  fs.writeFileSync(path.join(state.root, 'report.md'), manuscript);
  const added = capture(state, ['report.md']);
  const source = app.dependencies.objectsAt(project.id, added.snapshot.id)
    .find((object) => object.objectType === 'DATASET_VALUE' && object.valueText === '1003');
  assert.ok(source, 'the ledger value should be indexed');
  const versionRows = rows(app, 'scientific_object_versions');
  const fileRows = rows(app, 'snapshot_files');
  const filesBefore = fileView(app, added.snapshot.id).map(({ snapshotId, ...file }) => file);
  const objectsBefore = objectView(app, project.id, added.snapshot.id);

  const located = manuscriptAnchor(manuscript, '1003');
  const linked = app.dependencies.link(project.id, {
    documentPath: 'report.md', anchor: located.anchor, spanText: located.claim.text,
    sourceObjectId: source.id, sourceSnapshotId: source.snapshotId, selectionMethod: 'MANUAL',
    expectedSnapshotId: added.snapshot.id,
  }, actor);
  const linkedSnapshot = linked.event.resultingSnapshotId;
  assert.notEqual(linkedSnapshot, added.snapshot.id);

  assert.deepEqual(fileView(app, linkedSnapshot).map(({ snapshotId, ...file }) => file), filesBefore);
  assert.deepEqual(objectView(app, project.id, linkedSnapshot), objectsBefore);
  assert.equal(rows(app, 'snapshot_files'), fileRows, 'a link adds no file rows');
  assert.equal(rows(app, 'scientific_object_versions'), versionRows, 'a link adds no object versions');
  assert.equal(linked.dependency.source.valueText, '1003');
});

test('a snapshot indexed after later ones does not change them', (t) => {
  const state = fixture(t);
  const { app, project } = state;
  const manuscript = '# Report\n\nNorth site amount was 1003.\n';
  fs.writeFileSync(path.join(state.root, 'report.md'), manuscript);
  const added = capture(state, ['report.md']);
  const source = app.dependencies.objectsAt(project.id, added.snapshot.id)
    .find((object) => object.objectType === 'DATASET_VALUE' && object.valueText === '1003');
  const located = manuscriptAnchor(manuscript, '1003');
  const linked = app.dependencies.link(project.id, {
    documentPath: 'report.md', anchor: located.anchor, spanText: located.claim.text,
    sourceObjectId: source.id, sourceSnapshotId: source.snapshotId, selectionMethod: 'MANUAL',
  }, actor);
  const transition = linked.event.resultingSnapshotId;
  const indexedTransition = app.db.prepare('SELECT 1 FROM snapshot_object_indexes WHERE snapshot_id = ?').get(transition);

  fs.writeFileSync(path.join(state.root, 'ledger-0.csv'), ledger(0, CSV_ROWS, 3));
  const later = capture(state, ['ledger-0.csv']).snapshot.id;
  const laterObjects = objectView(app, project.id, later);
  const transitionObjects = objectView(app, project.id, transition);
  assert.ok(indexedTransition || transitionObjects.length, 'the transition resolves once indexed');
  assert.deepEqual(transitionObjects, objectView(app, project.id, added.snapshot.id));
  assert.deepEqual(objectView(app, project.id, later), laterObjects, 'indexing an earlier snapshot leaves later ones alone');
});

test('an upgrade pass that adds objects to an earlier snapshot leaves later snapshots unchanged', (t) => {
  const state = fixture(t);
  const { app, project } = state;
  const first = project.currentSnapshotId;
  // Simulate an index written by an earlier release that lacked the note's
  // passages: remove them from the first snapshot and mark it out of date.
  const guard = app.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='scientific_object_versions_immutable_delete'").get().sql;
  app.db.exec('DROP TRIGGER scientific_object_versions_immutable_delete');
  const removed = app.db.prepare(`DELETE FROM scientific_object_versions WHERE snapshot_id = ? AND path = 'notes.md'
    AND object_id IN (SELECT id FROM scientific_objects WHERE object_key LIKE '%:text-excerpt:%')`).run(first).changes;
  app.db.exec(guard);
  assert.ok(removed > 0);
  app.db.prepare('UPDATE snapshot_object_indexes SET drawing_index_version = 2 WHERE snapshot_id = ?').run(first);

  // The next version, indexed against that older index, no longer has the note.
  fs.unlinkSync(path.join(state.root, 'notes.md'));
  const second = capture(state, ['notes.md']).snapshot.id;
  const secondObjects = objectView(app, project.id, second);
  assert.ok(!secondObjects.some((object) => object.path === 'notes.md'));

  const upgradedFirst = objectView(app, project.id, first);
  assert.ok(upgradedFirst.some((object) => object.path === 'notes.md' && object.objectKey.includes(':text-excerpt:')),
    'the upgrade pass restores the passages to the first snapshot');
  const fresh = createApplication({ dataDir: state.dataDir, watchProjects: false });
  t.after(() => fresh.close());
  assert.deepEqual(objectView(fresh, project.id, second), secondObjects, 'the deleted note does not come back');
});

test('carried-forward records stay immutable', (t) => {
  const state = fixture(t);
  fs.unlinkSync(path.join(state.root, 'notes.md'));
  const result = capture(state, ['notes.md']);
  const { db } = state.app;
  assert.ok(rows(state.app, 'snapshot_file_removals') > 0);
  assert.ok(rows(state.app, 'scientific_object_removals') > 0);
  assert.ok(rows(state.app, 'object_index_bases') > 0);
  for (const table of ['snapshot_file_removals', 'scientific_object_removals', 'object_index_bases']) {
    assert.throws(() => db.prepare(`DELETE FROM ${table}`).run(), /immutable/, `${table} rows cannot be deleted`);
    assert.throws(() => db.prepare(`UPDATE ${table} SET snapshot_id = snapshot_id`).run(), /immutable/, `${table} rows cannot change`);
  }
  assert.throws(() => db.prepare('UPDATE snapshots SET files_base_snapshot_id = NULL WHERE id = ?').run(result.snapshot.id), /immutable/);
});

test('a database written with full copies upgrades in place and keeps its history', async (t) => {
  const state = fixture(t);
  const { app, project } = state;
  // Write the next version the way earlier releases did: every file and every
  // object copied into the new snapshot, with no base to resolve through.
  const legacy = app.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(project.currentSnapshotId);
  const legacyId = 'legacy-snapshot';
  const timestamp = new Date().toISOString();
  app.db.exec('BEGIN');
  app.db.prepare(`INSERT INTO snapshots(id, project_id, version, parent_snapshot_id, manifest_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(legacyId, project.id, legacy.version + 1, legacy.id, legacy.manifest_hash, timestamp);
  app.db.prepare(`INSERT INTO snapshot_files(snapshot_id, project_file_id, path, content_hash, size, mtime_ms, file_type, device, inode, metadata_json, ctime_ms)
    SELECT ?, project_file_id, path, content_hash, size, mtime_ms, file_type, device, inode, metadata_json, ctime_ms
    FROM snapshot_files WHERE snapshot_id = ?`).run(legacyId, legacy.id);
  app.db.prepare(`INSERT INTO scientific_object_versions(id, object_id, snapshot_id, path, anchor_json, label, value_text, search_text, content_hash, metadata_json, created_at)
    SELECT 'legacy-' || id, object_id, ?, path, anchor_json, label, value_text, search_text, content_hash, metadata_json, created_at
    FROM scientific_object_versions WHERE snapshot_id = ?`).run(legacyId, legacy.id);
  app.db.prepare(`INSERT INTO snapshot_object_indexes(snapshot_id, indexed_at, object_count, drawing_index_version)
    SELECT ?, indexed_at, object_count, drawing_index_version FROM snapshot_object_indexes WHERE snapshot_id = ?`).run(legacyId, legacy.id);
  app.db.prepare(`INSERT INTO timeline_events(id, project_id, previous_snapshot_id, resulting_snapshot_id, actor_id, occurred_at, source, title)
    VALUES ('legacy-event', ?, ?, ?, ?, ?, 'SYSTEM', 'Legacy copy')`).run(project.id, legacy.id, legacyId, actor.id, timestamp);
  app.db.prepare('UPDATE projects SET current_snapshot_id = ? WHERE id = ?').run(legacyId, project.id);
  app.db.exec('COMMIT');

  const reopened = await state.reopen();
  const legacyFiles = fileView(reopened, legacyId);
  const legacyObjects = objectView(reopened, project.id, legacyId);
  assert.ok(reopened.dependencies.objectsAt(project.id, legacyId).every((object) => object.versionId.startsWith('legacy-')),
    'a full-copy snapshot resolves to its own rows');

  fs.writeFileSync(path.join(state.root, 'notes.md'), NOTE.replace('Revision 0.', 'Revision 1.'));
  const versionRows = rows(reopened, 'scientific_object_versions');
  const next = capture(state, ['notes.md']).snapshot.id;
  const nextObjects = objectView(reopened, project.id, next);
  assert.ok(rows(reopened, 'scientific_object_versions') - versionRows
    <= nextObjects.filter((object) => object.path === 'notes.md').length);
  const unchanged = (objects) => objects.filter((object) => object.path !== 'notes.md');
  assert.deepEqual(unchanged(nextObjects), unchanged(legacyObjects));
  assert.deepEqual(fileView(reopened, legacyId), legacyFiles);
  assert.deepEqual(objectView(reopened, project.id, legacyId), legacyObjects);
});

test('an older schema gains the carry-forward tables and loses duplicate indexes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-storage-schema-'));
  const databasePath = path.join(root, 'test.sqlite');
  try {
    const legacy = new DatabaseSync(databasePath);
    for (const name of fs.readdirSync('migrations').sort().filter((item) => Number(item.split('_')[0]) <= 19)) {
      legacy.exec(fs.readFileSync(path.join('migrations', name), 'utf8'));
    }
    legacy.close();
    for (let open = 0; open < 2; open += 1) {
      const db = openDatabase({ databasePath });
      const names = (type) => new Set(db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type).map((row) => row.name));
      const tables = names('table');
      const indexes = names('index');
      for (const table of ['snapshot_file_removals', 'scientific_object_removals', 'object_index_bases']) assert.ok(tables.has(table), table);
      assert.ok(!indexes.has('snapshot_files_path_idx'), 'duplicates UNIQUE(snapshot_id, path)');
      assert.ok(!indexes.has('scientific_object_search_idx'), 'search text is never filtered in SQL');
      const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
      assert.ok(columns('snapshots').has('files_base_snapshot_id'));
      assert.ok(columns('object_share_grants').has('snapshot_id'));
      db.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stored text diffs keep only changed lines and events still show the whole comparison', (t) => {
  const state = fixture(t);
  const lines = Array.from({ length: 900 }, (_, index) => `log line ${index} with steady content`);
  fs.writeFileSync(path.join(state.root, 'run.txt'), `${lines.join('\n')}\n`);
  const longNote = `# Long note\n\n${Array.from({ length: 400 }, (_, index) => `Paragraph ${index} stays the same.`).join('\n\n')}\n`;
  fs.writeFileSync(path.join(state.root, 'long.md'), longNote);
  capture(state, ['run.txt', 'long.md']);
  const beforeText = fs.readFileSync(path.join(state.root, 'run.txt'));
  const beforeNote = fs.readFileSync(path.join(state.root, 'long.md'));
  lines[450] = 'log line 450 was rewritten';
  fs.writeFileSync(path.join(state.root, 'run.txt'), `${lines.join('\n')}\n`);
  fs.writeFileSync(path.join(state.root, 'long.md'), longNote.replace('Paragraph 200 stays', 'Paragraph 200 changed'));
  const result = capture(state, ['run.txt', 'long.md']);

  for (const [filePath, fileType, beforeBuffer] of [['run.txt', 'text', beforeText], ['long.md', 'markdown', beforeNote]]) {
    const stored = state.app.db.prepare('SELECT structured_diff_json FROM file_changes WHERE event_id = ? AND path_after = ?')
      .get(result.event.id, filePath).structured_diff_json;
    assert.ok(stored.length < 2048, `${filePath} stores ${stored.length} bytes for a one-line change`);
    const expected = createStructuredDiff({
      fileType, filePath, beforeBuffer, afterBuffer: fs.readFileSync(path.join(state.root, filePath)), changeType: 'MODIFIED',
    });
    const change = state.app.timeline.getEvent(result.event.id).changes.find((item) => item.pathAfter === filePath);
    assert.deepEqual(change.structuredDiff, expected);
  }
});

test('events are listed newest first one page at a time', (t) => {
  const state = fixture(t);
  for (let revision = 1; revision <= 4; revision += 1) {
    fs.writeFileSync(path.join(state.root, 'notes.md'), NOTE.replace('Revision 0.', `Revision ${revision}.`));
    capture(state, ['notes.md']);
  }
  const everything = state.app.timeline.listEvents(state.project.id);
  assert.equal(everything.length, 5);
  const first = state.app.timeline.listEvents(state.project.id, { limit: 2 });
  assert.deepEqual(first.map((event) => event.resultingVersion), [5, 4]);
  const second = state.app.timeline.listEvents(state.project.id, { limit: 2, before: 4 });
  assert.deepEqual(second.map((event) => event.resultingVersion), [3, 2]);
  assert.deepEqual(everything.map((event) => event.id), [...first, ...second, ...state.app.timeline.listEvents(state.project.id, { before: 2 })]
    .map((event) => event.id));
  assert.throws(() => state.app.timeline.listEvents(state.project.id, { limit: 0 }), /limit/i);
  assert.throws(() => state.app.timeline.listEvents(state.project.id, { before: 'x' }), /before/i);
});

test('the events route returns a page and the cursor for the next one', async (t) => {
  const state = fixture(t);
  for (let revision = 1; revision <= 2; revision += 1) {
    fs.writeFileSync(path.join(state.root, 'notes.md'), NOTE.replace('Revision 0.', `Revision ${revision}.`));
    capture(state, ['notes.md']);
  }
  await new Promise((resolve) => state.app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${state.app.server.address().port}/api/projects/${state.project.id}/events`;
  const first = await (await fetch(`${base}?limit=2`)).json();
  assert.deepEqual(first.events.map((event) => event.resultingVersion), [3, 2]);
  assert.equal(first.nextBefore, 2);
  const rest = await (await fetch(`${base}?limit=2&before=${first.nextBefore}`)).json();
  assert.deepEqual(rest.events.map((event) => event.resultingVersion), [1]);
  assert.equal(rest.nextBefore, null);
  assert.equal((await fetch(`${base}?limit=nope`)).status, 400);
});

/** What a full index of a snapshot would store for each object key. */
function fullIndex(app, snapshotId) {
  const files = app.dependencies.indexableFiles(app.timeline.getSnapshot(snapshotId), { indexed: null });
  return new Map(app.dependencies.indexDescriptors(files).descriptors.map((descriptor) => [descriptor.key, {
    path: descriptor.path, anchor: descriptor.anchor ?? null, label: descriptor.label, valueText: descriptor.value ?? null,
    searchText: descriptor.searchText, contentHash: descriptor.contentHash, metadata: descriptor.metadata,
  }]));
}

function storedIndex(app, snapshotId) {
  return new Map(app.timeline.objectVersions.resolved(snapshotId).rows.map((row) => [row.object_key, {
    path: row.path, anchor: JSON.parse(row.anchor_json ?? 'null'), label: row.label, valueText: row.value_text,
    searchText: row.search_text, contentHash: row.content_hash, metadata: JSON.parse(row.metadata_json),
  }]));
}

test('carrying unchanged files forward records exactly what a full index would', (t) => {
  const state = fixture(t);
  const carried = t.mock.method(state.app.dependencies, 'carriedDescriptors');
  const snapshots = [];
  const step = (write, dirty) => {
    write();
    snapshots.push(capture(state, dirty).snapshot.id);
  };
  const dictionary = (description) => `variable,description,units\namount,${description},USD\n`;
  step(() => fs.writeFileSync(path.join(state.root, 'notes.md'), NOTE.replace('Revision 0.', 'Revision 1.')), ['notes.md']);
  step(() => fs.writeFileSync(path.join(state.root, 'ledger-0.csv'), ledger(0, CSV_ROWS, 5)), ['ledger-0.csv']);
  step(() => fs.writeFileSync(path.join(state.root, 'data_dictionary.csv'), dictionary('Amount billed')), ['data_dictionary.csv']);
  step(() => fs.writeFileSync(path.join(state.root, 'notes.md'), NOTE.replace('Revision 0.', 'Revision 2.')), ['notes.md']);
  step(() => fs.writeFileSync(path.join(state.root, 'data_dictionary.csv'), dictionary('Amount paid')), ['data_dictionary.csv']);
  step(() => fs.unlinkSync(path.join(state.root, 'ledger-3.csv')), ['ledger-3.csv']);
  step(() => fs.renameSync(path.join(state.root, 'ledger-2.csv'), path.join(state.root, 'moved.csv')), ['ledger-2.csv', 'moved.csv']);

  assert.ok(carried.mock.callCount() >= 4, 'unchanged files were carried forward');
  const enriched = storedIndex(state.app, snapshots.at(-1));
  assert.ok([...enriched.values()].some((object) => object.metadata.definition === 'Amount paid'),
    'a changed dictionary still reaches the files it describes');
  for (const snapshotId of snapshots) {
    assert.deepEqual(storedIndex(state.app, snapshotId), fullIndex(state.app, snapshotId), `index at ${snapshotId}`);
  }
});
