// An object version is written only when the object itself changes, and each
// change an index makes is recorded. Saving one cell of a table leaves every
// other cell with the version it had; the file's bytes are found through the
// snapshot an object is read at, so previews and shares still show the file
// they were made from.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApplication } from '../src/server.js';
import { openDatabase, transaction } from '../src/db.js';
import { anchorForSpan } from '../src/dependencies/service.js';
import { diffInternals } from '../src/history/diff.js';

// Migration 027 is reserved for blob storage, built alongside this one.
const CHANGE_RECORDS_MIGRATION = 28;

const writer = { id: 'human:writer', displayName: 'Writer', actorType: 'HUMAN_SELF' };

const ROWS = 20;
const COLUMNS = ['Q1', 'Q2', 'Q3', 'Q4'];
const EDITED = '777777';
const cellValue = (row, column) => String(row * 1000 + column + 1);

/** A table of items by quarter; `edits` maps "row:column" to a new value. */
function ledger(edits = new Map()) {
  const rows = Array.from({ length: ROWS }, (_, index) => {
    const row = index + 1;
    return [`Item ${row}`, ...COLUMNS.map((_, column) => edits.get(`${row}:${column}`) ?? cellValue(row, column))];
  });
  return [['Item', ...COLUMNS], ...rows].map((cells) => cells.join(',')).join('\n') + '\n';
}

function workspace(t, files) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-object-changes-')));
  const root = path.join(sandbox, 'Ledger');
  fs.mkdirSync(root);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
  const application = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false, port: 0 });
  t.after(async () => {
    await application.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const project = application.timeline.importProject(root, writer, { watch: false }).project;
  application.dependencies.ensureIndex(project.id);
  const save = (name, content) => {
    fs.writeFileSync(path.join(root, name), content);
    const capture = application.timeline.capture(project.id, writer);
    application.dependencies.ensureIndex(project.id);
    return capture;
  };
  const current = () => application.timeline.getProject(project.id).currentSnapshotId;
  const object = (label) => application.dependencies.objectsAt(project.id).find((item) => item.label === label);
  const listen = async () => {
    application.server.listen(0, '127.0.0.1');
    await new Promise((resolve) => application.server.once('listening', resolve));
    return `http://127.0.0.1:${application.server.address().port}`;
  };
  return { application, project, root, save, current, object, listen };
}

const versionCount = (application, objectId) => application.db
  .prepare('SELECT COUNT(*) AS count FROM scientific_object_versions WHERE object_id = ?').get(objectId).count;

function spanAnchor(content, text) {
  const blocks = diffInternals.markdownBlocks(content);
  const blockIndex = blocks.findIndex((block) => block.text.includes(text));
  const block = blocks[blockIndex];
  const start = block.text.indexOf(text);
  return anchorForSpan(blockIndex, block.type, block.text, start, start + text.length);
}

function link(application, project, notes, text, source) {
  return application.dependencies.link(project.id, {
    documentPath: 'notes.md', anchor: spanAnchor(notes, text), spanText: text,
    sourceObjectId: source.id, sourceSnapshotId: source.snapshotId, selectionMethod: 'MANUAL',
  }, writer).dependency;
}

test('An untouched cell keeps one version across edits', (t) => {
  // Arrange
  const { application, save, object } = workspace(t, { 'ledger.csv': ledger() });
  const untouched = object('Item 7 · Q4');
  const edits = [[2, 0], [4, 1], [9, 2], [12, 3], [15, 0]];

  // Act
  edits.forEach((_, index) => save('ledger.csv', ledger(new Map(edits.slice(0, index + 1)
    .map(([row, column]) => [`${row}:${column}`, `${EDITED}${index}`])))));

  // Assert
  assert.equal(versionCount(application, untouched.id), 1);
  assert.equal(object('Item 7 · Q4').versionId, untouched.versionId);
  assert.equal(object('Item 15 · Q1').valueText, `${EDITED}4`);
});

test('A one-cell edit records one modified change with the old and new value', (t) => {
  // Arrange
  const { application, save, current, object } = workspace(t, { 'ledger.csv': ledger() });
  const edited = object('Item 5 · Q1');

  // Act
  save('ledger.csv', ledger(new Map([['5:0', EDITED]])));

  // Assert
  const changes = application.dependencies.snapshotChanges(current());
  const cells = changes.filter((change) => change.anchor?.kind === 'table-cell');
  assert.deepEqual(cells.map(({ objectId, label, kind, before, after, path: filePath }) => ({ objectId, label, kind, before, after, filePath })),
    [{ objectId: edited.id, label: 'Item 5 · Q1', kind: 'modified', before: cellValue(5, 0), after: EDITED, filePath: 'ledger.csv' }]);
  const history = application.dependencies.objectHistory(edited.id);
  assert.deepEqual(history.map(({ value, kind, cause }) => ({ value, kind, cause })).slice(0, 1),
    [{ value: EDITED, kind: 'modified', cause: 'edit' }]);
  assert.equal(history[0].snapshotId, current());
  assert.equal(history.length, 2);
});

test('A row inserted above a cell records the cell as moved, and a deleted row as removed', (t) => {
  // Arrange
  const original = ledger();
  const { application, save, current, object } = workspace(t, { 'ledger.csv': original });
  const first = current();
  const cell = object('Item 7 · Q4');
  const [header, ...rows] = original.trimEnd().split('\n');

  // Act
  save('ledger.csv', [header, 'Item 0,1,2,3,4', ...rows].join('\n') + '\n');
  const inserted = current();
  save('ledger.csv', [header, 'Item 0,1,2,3,4', ...rows.slice(0, -1)].join('\n') + '\n');
  const deleted = current();

  // Assert
  assert.deepEqual(application.dependencies.snapshotChanges(first), [], 'a first index records no changes');
  const kinds = (snapshotId, path) => application.dependencies.snapshotChanges(snapshotId)
    .filter((change) => change.path === path);
  const movedCell = kinds(inserted, 'ledger.csv').find((change) => change.objectId === cell.id);
  assert.equal(movedCell.kind, 'moved');
  assert.equal(movedCell.before, movedCell.after);
  assert.equal(movedCell.anchor.rowIndex, cell.anchor.rowIndex + 1);
  assert.ok(kinds(inserted, 'ledger.csv').some((change) => change.label === 'Item 0 · Q1' && change.kind === 'added'));
  assert.ok(kinds(inserted, 'ledger.csv').some((change) => change.objectType === 'DATASET' && change.kind === 'modified'),
    'the whole table changed');
  const removed = kinds(deleted, 'ledger.csv').filter((change) => change.kind === 'removed');
  assert.ok(removed.some((change) => change.label === `Item ${ROWS} · Q4` && change.before === cellValue(ROWS, 3)
    && change.after === null));
  assert.equal(versionCount(application, cell.id), 2, 'one version as read first, one where it moved to');
});

test('A historical share still renders the bytes it was made from', async (t) => {
  // Arrange
  const original = ledger();
  const { application, project, save, object, listen } = workspace(t, { 'ledger.csv': original });
  const cited = object('Item 3 · Q4');
  // Nearby rows put the edited cell, on the cited row, on the shared page.
  const share = application.objectShares.createShare({ projectId: project.id, objectId: cited.id,
    versionId: cited.versionId, actor: writer, nearbyRows: true });

  // Act
  save('ledger.csv', ledger(new Map([['3:0', EDITED]])));
  const base = await listen();
  const page = await (await fetch(`${base}/d/${share.token}`)).text();

  // Assert
  assert.equal(application.objectShares.sourceFile(share.token).content.toString('utf8'), original);
  assert.ok(page.includes(cellValue(3, 0)), 'the shared page shows the row as it was');
  assert.ok(!page.includes(EDITED), 'and not the edit made after it was shared');
});

test('A share made from a link\'s snapshot shares that snapshot\'s file', (t) => {
  // Arrange: the cell is linked, then another cell of its file changes.
  const original = ledger();
  const { application, project, save, current, object } = workspace(t, { 'ledger.csv': original });
  const cited = object('Item 3 · Q4');
  const linkedAt = current();
  save('ledger.csv', ledger(new Map([['3:0', EDITED]])));

  // Act
  const share = application.objectShares.createShare({ projectId: project.id, objectId: cited.id,
    versionId: cited.versionId, snapshotId: linkedAt, actor: writer });

  // Assert
  assert.equal(application.objectShares.sourceFile(share.token).content.toString('utf8'), original);
});

test('A preview at an older snapshot shows that snapshot\'s file', async (t) => {
  // Arrange
  const { save, current, object, listen } = workspace(t, { 'ledger.csv': ledger() });
  const cited = object('Item 3 · Q4');
  const older = current();
  save('ledger.csv', ledger(new Map([['3:0', EDITED]])));
  const base = await listen();
  const preview = async (query) => JSON.stringify((await (await fetch(
    `${base}/api/dependency-objects/${cited.id}/preview?version=${cited.versionId}${query}`)).json()).preview);

  // Act
  const atOlder = await preview(`&snapshot=${older}`);
  const atCurrent = await preview('');

  // Assert
  assert.equal(object('Item 3 · Q4').versionId, cited.versionId, 'the version is still current');
  assert.ok(atOlder.includes(cellValue(3, 0)) && !atOlder.includes(EDITED), 'the older snapshot shows its own file');
  assert.ok(atCurrent.includes(EDITED), 'the current snapshot shows the file as it is now');
});

test('A link to an untouched cell stays linked when another cell changes', (t) => {
  // Arrange
  const notes = '# Notes\n\nItem 3 came to 3004 in the fourth quarter.\n';
  const { application, project, save, object } = workspace(t, { 'ledger.csv': ledger(), 'notes.md': notes });
  const linked = link(application, project, notes, '3004', object('Item 3 · Q4'));

  // Act
  save('ledger.csv', ledger(new Map([['5:0', EDITED]])));
  application.dependencies.reconcileProject(project.id);

  // Assert
  assert.equal(application.dependencies.getDependency(linked.id).status, 'LINKED');
});

test('A stale link to a cell is not marked stale again when another cell changes', (t) => {
  // Arrange: the linked cell itself changed, so the link is stale.
  const notes = '# Notes\n\nItem 3 came to 3004 in the fourth quarter.\n';
  const { application, project, save, object } = workspace(t, { 'ledger.csv': ledger(), 'notes.md': notes });
  const linked = link(application, project, notes, '3004', object('Item 3 · Q4'));
  const cited = ['3:3', EDITED];
  save('ledger.csv', ledger(new Map([cited])));
  application.dependencies.reconcileProject(project.id);
  assert.equal(application.dependencies.getDependency(linked.id).status, 'STALE');
  const linkVersions = () => application.db
    .prepare('SELECT COUNT(*) AS count FROM claim_dependency_versions WHERE dependency_id = ?').get(linked.id).count;
  const staleEvents = () => application.db
    .prepare("SELECT COUNT(*) AS count FROM timeline_events WHERE source = 'DEPENDENCY_STALE'").get().count;
  const versionsWhenStale = linkVersions();
  const eventsWhenStale = staleEvents();

  // Act: two edits to other cells of the same file.
  save('ledger.csv', ledger(new Map([cited, ['5:0', '111']])));
  application.dependencies.reconcileProject(project.id);
  save('ledger.csv', ledger(new Map([cited, ['5:0', '111'], ['6:1', '222']])));
  application.dependencies.reconcileProject(project.id);

  // Assert
  assert.equal(application.dependencies.getDependency(linked.id).status, 'STALE');
  assert.equal(linkVersions(), versionsWhenStale, 'the link records no new version');
  assert.equal(staleEvents(), eventsWhenStale, 'and the timeline no new stale event');
});

test('A preview of a replaced version shows the last file it was current in', async (t) => {
  // Arrange: another cell of the row changes, then the cited cell itself.
  const { save, object, listen } = workspace(t, { 'ledger.csv': ledger() });
  const cited = object('Item 3 · Q4');
  save('ledger.csv', ledger(new Map([['3:0', EDITED]])));
  save('ledger.csv', ledger(new Map([['3:0', EDITED], ['3:3', '424242']])));
  const base = await listen();

  // Act
  const preview = JSON.stringify((await (await fetch(
    `${base}/api/dependency-objects/${cited.id}/preview?version=${cited.versionId}`)).json()).preview);

  // Assert
  assert.notEqual(object('Item 3 · Q4').versionId, cited.versionId, 'the cited version was replaced');
  assert.ok(preview.includes(cellValue(3, 3)), 'the preview shows the cited value');
  assert.ok(preview.includes(EDITED), 'in the file as it last read that value');
  assert.ok(!preview.includes('424242'), 'not the file that replaced it');
});

test('Deleting most of a folder records its removals and the edits saved with them', (t) => {
  // Arrange: a large table beside a small results file.
  const { application, project, root, current, object } = workspace(t, {
    'ledger.csv': ledger(), 'summary.json': '{"results":{"auc":1}}\n' });
  const auc = application.dependencies.objectsAt(project.id)
    .find((item) => item.path === 'summary.json' && item.valueText === '1');
  const cell = object('Item 3 · Q4');

  // Act: one save deletes the table and changes the result.
  fs.rmSync(path.join(root, 'ledger.csv'));
  fs.writeFileSync(path.join(root, 'summary.json'), '{"results":{"auc":2}}\n');
  application.timeline.capture(project.id, writer);
  application.dependencies.ensureIndex(project.id);

  // Assert
  const changes = application.dependencies.snapshotChanges(current());
  assert.ok(changes.some((change) => change.objectId === cell.id && change.kind === 'removed'
    && change.before === cellValue(3, 3)), 'the table\'s cells are recorded as removed');
  assert.ok(changes.some((change) => change.objectId === auc.id && change.kind === 'modified'
    && change.before === '1' && change.after === '2'), 'the result is recorded as modified');
  assert.ok(!changes.some((change) => change.path === 'summary.json' && change.objectId !== auc.id
    && change.kind === 'modified' && change.before === change.after && change.anchor),
    'unchanged parts of the results file are not recorded');
  const [latest] = application.dependencies.objectHistory(auc.id);
  assert.deepEqual({ value: latest.value, kind: latest.kind }, { value: '2', kind: 'modified' });
});

test('A link to an untouched passage stays linked when another paragraph changes', (t) => {
  // Arrange
  const findings = '# Findings\n\nThe pump ran for forty hours without a fault.\n\nThe valve was replaced in March.\n';
  const notes = '# Notes\n\nThe pump ran for forty hours.\n';
  const { application, project, save } = workspace(t, { 'findings.md': findings, 'notes.md': notes });
  const passage = application.dependencies.objectsAt(project.id).find((item) => item.path === 'findings.md'
    && item.metadata.componentType === 'TEXT_EXCERPT' && item.valueText?.includes('forty hours'));
  const linked = link(application, project, notes, 'forty hours', passage);

  // Act
  save('findings.md', findings.replace('in March', 'in April'));
  application.dependencies.reconcileProject(project.id);

  // Assert
  assert.equal(application.dependencies.getDependency(linked.id).status, 'LINKED');
});

test('A link to a whole document goes stale when the document changes', (t) => {
  // Arrange
  const findings = '# Findings\n\nThe pump ran for forty hours without a fault.\n\nThe valve was replaced in March.\n';
  const notes = '# Notes\n\nSee the Findings for the pump.\n';
  const { application, project, save } = workspace(t, { 'findings.md': findings, 'notes.md': notes });
  const document = application.dependencies.objectsAt(project.id).find((item) => item.path === 'findings.md'
    && item.objectType === 'DOCUMENT' && !item.anchor);
  const linked = link(application, project, notes, 'Findings', document);

  // Act
  save('findings.md', findings.replace('in March', 'in April'));
  application.dependencies.reconcileProject(project.id);

  // Assert
  assert.equal(document.valueText, 'Findings', 'the document is known by its heading, which did not change');
  assert.equal(application.dependencies.getDependency(linked.id).status, 'STALE');
});

test('A re-read by a newer reader is recorded as a re-read, not an edit', (t) => {
  // Arrange: an older build read the saved version, labelling one cell
  // differently from the current reader, before anything else could read it.
  const { application, project, root, object } = workspace(t, { 'ledger.csv': ledger() });
  const cell = object('Item 3 · Q4');
  fs.writeFileSync(path.join(root, 'ledger.csv'), ledger(new Map([['5:0', EDITED]])));
  application.timeline.capture(project.id, writer, {
    * prepare({ snapshot }) {
      const older = application.dependencies.extractDescriptors(snapshot)
        .map((descriptor) => (descriptor.key === cell.objectKey ? { ...descriptor, label: 'Row 4 · Q4' } : descriptor));
      transaction(application.db, () => {
        application.dependencies.writeObjectIndex(project.id, snapshot.id, older);
        application.db.prepare('UPDATE snapshot_object_indexes SET extractor_version = 0 WHERE snapshot_id = ?').run(snapshot.id);
      });
    },
  });
  assert.equal(application.dependencies.objectHistory(cell.id)[0].label, 'Row 4 · Q4', 'the older reading is recorded');

  // Act
  const result = application.dependencies.reindex(project.id, writer);

  // Assert
  assert.equal(result.changed, true);
  const [latest] = application.dependencies.objectHistory(cell.id);
  assert.equal(latest.snapshotId, result.snapshot.id);
  assert.equal(latest.label, 'Item 3 · Q4');
  assert.equal(latest.kind, 'modified');
  assert.equal(latest.cause, 'reread');
  assert.equal(latest.source, 'REINDEX');
});

test('A re-read of unchanged files is still identical', (t) => {
  // Arrange: cells untouched by the edit keep versions recorded before it.
  const { application, project, save } = workspace(t, { 'ledger.csv': ledger() });
  save('ledger.csv', ledger(new Map([['5:0', EDITED]])));
  const version = application.timeline.getProject(project.id).currentVersion;

  // Act
  const result = application.dependencies.reindex(project.id, writer);

  // Assert
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'IDENTICAL_READING');
  assert.equal(application.timeline.getProject(project.id).currentVersion, version);
});

test('A store from before change records upgrades cleanly', () => {
  // Arrange: a store at every migration before change records.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-object-changes-migration-'));
  const databasePath = path.join(root, 'test.sqlite');
  const legacy = new DatabaseSync(databasePath);
  for (const name of fs.readdirSync('migrations').sort().filter((name) => Number(name.split('_')[0]) < CHANGE_RECORDS_MIGRATION)) {
    legacy.exec(fs.readFileSync(path.join('migrations', name), 'utf8'));
  }
  legacy.close();

  try {
    // Act: open it twice, as two launches would.
    openDatabase({ databasePath }).close();
    const db = openDatabase({ databasePath });

    // Assert
    const columns = db.prepare('PRAGMA table_info(object_changes)').all().map((column) => column.name);
    assert.deepEqual(columns, ['snapshot_id', 'object_id', 'kind', 'before_version_id', 'after_version_id']);
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'object_changes'").get().sql;
    assert.match(table, /WITHOUT ROWID/i);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'object_changes_snapshot_idx'").get());
    assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(CHANGE_RECORDS_MIGRATION));
    assert.throws(() => db.prepare(`INSERT INTO object_changes(snapshot_id, object_id, kind) VALUES ('s', 'o', 'renamed')`).run(),
      /CHECK constraint/);
    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
