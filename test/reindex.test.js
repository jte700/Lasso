// Re-reading a project after the reader improves.
//
// The fixture reproduces the real case: a project whose current version was
// indexed by a build that named spreadsheet rows after their position. Those
// recorded objects must survive untouched, while the better reading arrives as
// a new version.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { transaction } from '../src/db.js';
import { anchorForSpan, EXTRACTOR_VERSION } from '../src/dependencies/service.js';
import { diffInternals } from '../src/history/diff.js';

const maya = { id: 'human:maya', displayName: 'Maya Chen', actorType: 'HUMAN_SELF' };

const LEDGER = 'Account,2026\nAdvertising,1200\nBad debt,300\n';
const NOTES = '# Notes\n\nAdvertising came to 1200 dollars.\n\nThe account list has 2 rows.\n';

/** The older reader named a row after its position rather than its label. */
function positional(descriptor) {
  const row = /^(.*):row:(\d+):.+$/.exec(descriptor.key);
  if (row) return { ...descriptor, key: `${row[1]}:row:${row[2]}`, label: `Row ${Number(row[2]) + 1}` };
  const cell = /^(.*):cell:(\d+):.+?:(.+)$/.exec(descriptor.key);
  if (cell) {
    return { ...descriptor, key: `${cell[1]}:cell:${cell[2]}:${cell[3]}`, label: `Row ${Number(cell[2]) + 1} · ${cell[3]}` };
  }
  return descriptor;
}

/**
 * Records the current version's objects the way the older build recorded them,
 * including that it left no extractor version behind.
 */
function recordOlderReading(application, projectId) {
  const project = application.timeline.getProject(projectId);
  const snapshot = application.timeline.getSnapshot(project.currentSnapshotId);
  const descriptors = application.dependencies.extractDescriptors(snapshot).map(positional);
  transaction(application.db, () => {
    application.dependencies.writeObjectIndex(projectId, snapshot.id, descriptors);
    application.db.prepare('UPDATE snapshot_object_indexes SET extractor_version = 0 WHERE snapshot_id = ?')
      .run(snapshot.id);
  });
  return snapshot.id;
}

function spanAnchor(content, text) {
  const blocks = diffInternals.markdownBlocks(content);
  const blockIndex = blocks.findIndex((block) => block.text.includes(text));
  assert.notEqual(blockIndex, -1, `Expected a block containing ${text}`);
  const block = blocks[blockIndex];
  const start = block.text.indexOf(text);
  return anchorForSpan(blockIndex, block.type, block.text, start, start + text.length);
}

function workspace(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-reindex-'));
  const root = path.join(sandbox, 'Accounting');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'ledger.csv'), LEDGER);
  fs.writeFileSync(path.join(root, 'notes.md'), NOTES);
  const application = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  t.after(async () => {
    await application.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const project = application.timeline.importProject(root, maya, { watch: false }).project;
  return { application, project, root, sandbox };
}

test('re-indexing records a better reading as a new version and leaves the recorded one alone', (t) => {
  const { application, project } = workspace(t);
  const olderSnapshotId = recordOlderReading(application, project.id);

  const before = application.dependencies.objectsAt(project.id);
  const olderRow = before.find((object) => object.label === 'Row 2');
  assert.ok(olderRow, 'the older build named rows after their position');
  assert.equal(application.dependencies.indexFreshness(project.id).stale, true);

  const result = application.dependencies.reindex(project.id, maya, { reason: 'spreadsheet row labels' });

  assert.equal(result.changed, true);
  const snapshot = application.timeline.getSnapshot(result.snapshot.id);
  const older = application.timeline.getSnapshot(olderSnapshotId);
  assert.equal(snapshot.parentSnapshotId, olderSnapshotId);
  assert.equal(snapshot.version, older.version + 1);

  // The files did not change: same identities, same content, same blobs.
  assert.deepEqual(
    snapshot.files.map((file) => [file.path, file.projectFileId, file.contentHash]),
    older.files.map((file) => [file.path, file.projectFileId, file.contentHash]),
  );
  assert.equal(snapshot.manifestHash, older.manifestHash);

  assert.equal(result.event.source, 'REINDEX');
  assert.match(result.event.title, /the files did not change/);
  assert.match(result.event.title, /spreadsheet row labels/);
  assert.equal(result.event.changes.length, 0, 'no file changed, so the event records no file change');

  // The new reading names the rows; the recorded one still does not.
  const after = application.dependencies.objectsAt(project.id, snapshot.id);
  assert.ok(after.some((object) => object.label === 'Advertising'));
  assert.ok(!after.some((object) => object.label === 'Row 2'));
  const recorded = application.dependencies.objectsAt(project.id, olderSnapshotId);
  const stillThere = recorded.find((object) => object.versionId === olderRow.versionId);
  assert.equal(stillThere.label, 'Row 2');
  assert.equal(stillThere.id, olderRow.id);

  // The reader that produced each version is recorded against that version.
  assert.equal(application.db.prepare('SELECT extractor_version AS version FROM snapshot_object_indexes WHERE snapshot_id = ?')
    .get(olderSnapshotId).version, 0);
  assert.equal(application.db.prepare('SELECT extractor_version AS version FROM snapshot_object_indexes WHERE snapshot_id = ?')
    .get(snapshot.id).version, EXTRACTOR_VERSION);
  assert.equal(application.dependencies.indexFreshness(project.id).stale, false);

  // An object the reader still keys and reads the same way keeps its identity,
  // and, because versions are carried forward, the very version it had, so
  // everything recorded against it keeps resolving.
  const variableBefore = before.find((object) => object.label === '2026');
  const variableAfter = after.find((object) => object.label === '2026');
  assert.equal(variableAfter.id, variableBefore.id);
  assert.equal(variableAfter.versionId, variableBefore.versionId);
});

test('re-indexing twice records nothing the second time', (t) => {
  const { application, project } = workspace(t);
  recordOlderReading(application, project.id);
  const first = application.dependencies.reindex(project.id, maya);
  assert.equal(first.changed, true);

  const version = application.timeline.getProject(project.id).currentVersion;
  const second = application.dependencies.reindex(project.id, maya);
  assert.equal(second.changed, false);
  assert.equal(second.reason, 'IDENTICAL_READING');
  assert.equal(application.timeline.getProject(project.id).currentVersion, version,
    'nothing changed, so nothing is recorded');
  assert.equal(application.timeline.listEvents(project.id).filter((event) => event.source === 'REINDEX').length, 1);
});

test('a share keeps resolving to the evidence it pinned', (t) => {
  const { application, project } = workspace(t);
  const olderSnapshotId = recordOlderReading(application, project.id);
  const olderRow = application.dependencies.objectsAt(project.id).find((object) => object.label === 'Row 2');

  const share = application.objectShares.createShare({
    projectId: project.id, objectId: olderRow.id, versionId: olderRow.versionId, actor: maya,
  });

  const result = application.dependencies.reindex(project.id, maya);
  assert.equal(result.changed, true);

  const resolved = application.objectShares.resolveShare(share.token);
  assert.equal(resolved.status, 'OK');
  assert.equal(resolved.source.label, 'Row 2', 'a share pins its evidence deliberately');
  assert.equal(resolved.internal.snapshotId, olderSnapshotId);
  const file = application.objectShares.sourceFile(share.token);
  assert.equal(file.status, 'OK');
  assert.equal(file.content.toString('utf8'), LEDGER);
});

test('recorded usage and document links survive the new reading', (t) => {
  const { application, project } = workspace(t);
  recordOlderReading(application, project.id);
  const notes = fs.readFileSync(path.join(project.rootPath, 'notes.md'), 'utf8');
  const objects = application.dependencies.objectsAt(project.id);
  const keptObject = objects.find((object) => object.label === '2026');
  const lostObject = objects.find((object) => object.label === 'Row 2');

  const kept = application.dependencies.link(project.id, {
    documentPath: 'notes.md',
    anchor: spanAnchor(notes, '2 rows'),
    spanText: '2 rows',
    sourceObjectId: keptObject.id,
    sourceSnapshotId: keptObject.snapshotId,
    selectionMethod: 'MANUAL',
  }, maya).dependency;
  const lost = application.dependencies.link(project.id, {
    documentPath: 'notes.md',
    anchor: spanAnchor(notes, '1200 dollars'),
    spanText: '1200 dollars',
    sourceObjectId: lostObject.id,
    sourceSnapshotId: lostObject.snapshotId,
    selectionMethod: 'MANUAL',
  }, maya).dependency;

  application.dependencies.recordRecommendationUsage(project.id, {
    objectId: keptObject.id, kind: 'accept', sessionId: 'session-1', documentPath: 'notes.md',
  });
  const usageBefore = application.dependencies.ranking
    .usageForProject(application.timeline.getProject(project.id))
    .find((entry) => entry.path === 'ledger.csv');
  assert.ok(usageBefore);

  // Linking cloned the version, so the current one carries the older reading
  // too — which is the state a project indexed by an older build is left in.
  recordOlderReading(application, project.id);
  assert.equal(application.dependencies.indexFreshness(project.id).stale, true);

  const result = application.dependencies.reindex(project.id, maya);
  assert.equal(result.changed, true);

  // Usage is keyed by file identity, which the new version reuses.
  const usageAfter = application.dependencies.ranking
    .usageForProject(application.timeline.getProject(project.id))
    .find((entry) => entry.path === 'ledger.csv');
  assert.ok(usageAfter, 'recorded usage still resolves');
  assert.equal(usageAfter.projectFileId, usageBefore.projectFileId);
  assert.equal(usageAfter.acceptedSessions, usageBefore.acceptedSessions);

  // A claim whose source the reader still produces is untouched.
  const keptNow = application.dependencies.getDependency(kept.id);
  assert.equal(keptNow.status, 'LINKED');
  assert.equal(keptNow.source.id, keptObject.id);

  // A claim whose source the new reader keys differently needs a person, not a
  // verdict that its evidence is gone.
  const lostNow = application.dependencies.getDependency(lost.id);
  assert.equal(lostNow.status, 'NEEDS_REVIEW');
  assert.equal(lostNow.removed, false);
  assert.match(lostNow.statusDetails.sourceIssue, /no longer produces this source object/);
  assert.equal(result.dependenciesNeedingReview, 1);

  // Its evidence is still exactly where it was recorded.
  const pinned = application.dependencies.objectAt(project.id, lostObject.snapshotId, lostObject.id);
  assert.equal(pinned.label, 'Row 2');
  assert.equal(pinned.versionId, lostObject.versionId);
});

test('recorded evidence stays immutable through a re-index', (t) => {
  const { application, project } = workspace(t);
  const olderSnapshotId = recordOlderReading(application, project.id);
  const olderRow = application.dependencies.objectsAt(project.id).find((object) => object.label === 'Row 2');

  application.dependencies.reindex(project.id, maya);

  for (const statement of [
    'DELETE FROM scientific_object_versions WHERE id = ?',
    "UPDATE scientific_object_versions SET label = 'Advertising' WHERE id = ?",
  ]) {
    assert.throws(() => application.db.prepare(statement).run(olderRow.versionId), /immutable/);
  }
  assert.throws(() => application.db.prepare('DELETE FROM snapshots WHERE id = ?').run(olderSnapshotId), /immutable/);
  assert.throws(() => application.db.prepare('DELETE FROM snapshot_files WHERE snapshot_id = ?').run(olderSnapshotId), /immutable/);
});

test('the terminal and the API offer the re-read beside the other index controls', async (t) => {
  const { application, project } = workspace(t);
  recordOlderReading(application, project.id);

  const status = application.terminal.executor.run(project.id, 'index status', maya);
  assert.match(JSON.stringify(status), /older build/);

  const reindexed = application.terminal.executor.run(project.id, 'index reindex', maya);
  assert.match(reindexed.headline, /recorded from a new reading/);
  assert.equal(reindexed.data.reindexed.event.source, 'REINDEX');

  const again = application.terminal.executor.run(project.id, 'index reindex', maya);
  assert.match(again.headline, /exactly as recorded/);

  const handler = application.server.listeners('request')[0];
  const freshness = await call(handler, 'GET', `/api/projects/${project.id}/reindex`);
  assert.equal(freshness.body.freshness.stale, false);
  const posted = await call(handler, 'POST', `/api/projects/${project.id}/reindex`, { actor: maya });
  assert.equal(posted.status, 200);
  assert.equal(posted.body.reindexed.changed, false);
});

/** Drives one request through the HTTP handler without binding a port. */
function call(handler, method, url, body = null) {
  return new Promise((resolve, reject) => {
    const request = body == null ? emptyRequest(method, url) : jsonRequest(method, url, body);
    const chunks = [];
    const response = {
      statusCode: 200,
      writeHead(status) { this.statusCode = status; },
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk));
        try {
          resolve({ status: this.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) { reject(error); }
      },
    };
    handler(request, response).catch(reject);
  });
}

// The request guard answers only requests addressed to this computer.
const LOCAL_HEADERS = { host: '127.0.0.1:4319' };

function emptyRequest(method, url) {
  return Object.assign(async function* () {}(), { method, url, headers: LOCAL_HEADERS });
}

function jsonRequest(method, url, body) {
  const payload = Buffer.from(JSON.stringify(body));
  return Object.assign(async function* () { yield payload; }(), { method, url, headers: LOCAL_HEADERS });
}

test('an identical re-read clears obsolete indexing failures without creating a version', t => {
  const { application, project } = workspace(t);
  application.dependencies.ensureIndex(project.id);
  const before = application.timeline.getProject(project.id).currentSnapshotId;
  application.terminal.indexing.recordIndexProblems(project.id, [{ path: 'ledger.csv', code: 'NOT_INDEXED_LIMIT',
    reason: 'An older folder-wide limit skipped this file.' }]);
  const result = application.dependencies.reindex(project.id, maya);
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'IDENTICAL_READING');
  assert.equal(application.timeline.getProject(project.id).currentSnapshotId, before);
  assert.ok(application.db.prepare('SELECT resolved_at FROM index_failures WHERE project_id = ? AND path = ?')
    .get(project.id, 'ledger.csv').resolved_at, 'successful rereading clears stale warnings even when the objects are identical');
});
