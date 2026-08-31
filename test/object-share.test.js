import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { buildSharePreview } from '../src/sharing/share-preview.js';

const maya = { id: 'human:maya', displayName: 'Maya Chen', actorType: 'HUMAN_SELF' };

/// Minimal CSV workbook so the indexer produces addressable table objects.
function seedProject(root) {
  fs.mkdirSync(path.join(root, 'Finance'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Finance', 'Income-Statement.csv'),
    'Account,Current Period,Prior Period\nOffice Supplies,400,384\nPayroll taxes,225,218\n');
}

function firstTableObject(application, projectId) {
  return application.db.prepare(`
    SELECT v.id AS version_id, v.object_id, v.label
    FROM scientific_object_versions v
    JOIN scientific_objects o ON o.id = v.object_id
    WHERE o.project_id = ? AND o.object_type IN ('DATASET_ROW', 'DATASET_CELL')
    ORDER BY v.label LIMIT 1
  `).get(projectId);
}

test('externally shared dependencies', async (suite) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'colab-share-test-'));
  const projectRoot = path.join(sandbox, 'Accounting');
  seedProject(projectRoot);

  const application = createApplication({
    dataDir: path.join(sandbox, 'history'),
    watchProjects: false,
    shareBaseUrl: 'http://localhost:4319',
  });
  const shares = application.objectShares;
  const { project } = application.timeline.importProject(projectRoot, maya, { watch: false });
  // Indexing is lazy; the workspace triggers it the same way before predicting.
  application.dependencies.ensureIndex(project.id);
  const object = firstTableObject(application, project.id);
  assert.ok(object, 'the workbook should produce an indexed table object');

  await suite.test('creating a share generates an unguessable token', () => {
    const share = shares.createShare({ projectId: project.id, objectId: object.object_id, versionId: object.version_id, actor: maya });
    // 24 random bytes, URL-safe base64: 192 bits of entropy, no padding.
    assert.match(share.token, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(share.url, `http://localhost:4319/d/${share.token}`);
    // The internal identifier is never the public one.
    assert.notEqual(share.token, share.id);
  });

  await suite.test('two shares never reuse the same token', () => {
    const tokens = new Set();
    for (let index = 0; index < 25; index += 1) {
      tokens.add(shares.createShare({ projectId: project.id, objectId: object.object_id, versionId: object.version_id, actor: maya }).token);
    }
    assert.equal(tokens.size, 25);
  });

  await suite.test('a valid token resolves to exactly one dependency', () => {
    const share = shares.createShare({ projectId: project.id, objectId: object.object_id, versionId: object.version_id, actor: maya });
    const resolved = shares.resolveShare(share.token);
    assert.equal(resolved.status, 'OK');
    assert.equal(resolved.source.label, object.label);
    assert.equal(resolved.source.filename, 'Income-Statement.csv');
  });

  await suite.test('an invalid token returns not found without leaking neighbours', () => {
    assert.equal(shares.resolveShare('not-a-real-token-value-000').status, 'NOT_FOUND');
    assert.equal(shares.resolveShare('').status, 'NOT_FOUND');
    assert.equal(shares.resolveShare(null).status, 'NOT_FOUND');
  });

  await suite.test('a revoked token cannot reach the source', () => {
    const share = shares.createShare({ projectId: project.id, objectId: object.object_id, versionId: object.version_id, actor: maya });
    assert.equal(shares.sourceFile(share.token).status, 'OK');
    shares.revokeShare(share.token);
    assert.equal(shares.resolveShare(share.token).status, 'REVOKED');
    assert.equal(shares.sourceFile(share.token).status, 'REVOKED');
    // Revocation preserves the record rather than deleting it.
    assert.ok(application.db.prepare('SELECT revoked_at FROM object_share_grants WHERE token = ?').get(share.token).revoked_at);
  });

  await suite.test('an expired token cannot reach the source', () => {
    const share = shares.createShare({
      projectId: project.id, objectId: object.object_id, versionId: object.version_id,
      actor: maya, expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    assert.equal(shares.resolveShare(share.token).status, 'EXPIRED');
    assert.equal(shares.sourceFile(share.token).status, 'EXPIRED');
  });

  await suite.test('download returns the exact registered file', () => {
    const share = shares.createShare({ projectId: project.id, objectId: object.object_id, versionId: object.version_id, actor: maya });
    const file = shares.sourceFile(share.token);
    assert.equal(file.status, 'OK');
    assert.equal(file.filename, 'Income-Statement.csv');
    assert.match(file.content.toString('utf8'), /Office Supplies,400/);
  });

  await suite.test('nothing published exposes a filesystem path', () => {
    const share = shares.createShare({ projectId: project.id, objectId: object.object_id, versionId: object.version_id, actor: maya });
    const resolved = shares.resolveShare(share.token);
    const published = JSON.stringify({ share: resolved.share, source: resolved.source });
    assert.ok(!published.includes(sandbox));
    assert.ok(!published.includes('/Finance/'));
    assert.ok(!share.url.includes(projectRoot));
    // The real path stays on the internal side of the boundary only.
    assert.ok(resolved.internal.filePath.includes('Finance'));
  });

  await suite.test('a share pins the version it was created from', () => {
    const share = shares.createShare({ projectId: project.id, objectId: object.object_id, versionId: object.version_id, actor: maya });
    const before = shares.resolveShare(share.token).source.snapshotVersion;
    fs.writeFileSync(path.join(projectRoot, 'Finance', 'Income-Statement.csv'),
      'Account,Current Period,Prior Period\nOffice Supplies,999,384\n');
    application.timeline.capture(project.id, maya);
    const after = shares.resolveShare(share.token);
    assert.equal(after.source.snapshotVersion, before);
    // The recipient still receives the file as it was when shared.
    assert.match(shares.sourceFile(share.token).content.toString('utf8'), /Office Supplies,400/);
  });

  await suite.test('sharing is opt-in: predicting suggestions creates no share record', () => {
    const countBefore = application.db.prepare('SELECT COUNT(*) AS total FROM object_share_grants').get().total;
    application.dependencies.predict(project.id, { text: 'The cost of office sup', cursor: 22 });
    const countAfter = application.db.prepare('SELECT COUNT(*) AS total FROM object_share_grants').get().total;
    assert.equal(countAfter, countBefore);
  });

  await suite.test('the preview keeps label columns, drops spacers, and marks the cited row', () => {
    const share = shares.createShare({ projectId: project.id, objectId: object.object_id, versionId: object.version_id, actor: maya });
    const resolved = shares.resolveShare(share.token);
    const file = application.timeline.snapshotFile(resolved.internal.snapshotId, resolved.internal.filePath);
    const preview = buildSharePreview(
      { path: file.path, content: application.timeline.blobs.get(file.contentHash) },
      resolved.source.anchor, resolved.source.metadata);
    assert.ok(preview, 'a tabular source should preview');
    // The row-label column has no header but must survive.
    const labels = preview.rows.map((row) => row.cells[0].value);
    assert.ok(labels.includes('Office Supplies'), `expected a label column, got ${JSON.stringify(labels)}`);
    // Exactly one row is highlighted, and it is the cited one.
    const citedRows = preview.rows.filter((row) => row.cells.some((cell) => cell.cited));
    assert.equal(citedRows.length, 1);
    assert.equal(citedRows[0].cells[0].value, 'Office Supplies');
    // No column is entirely empty.
    preview.headers.forEach((_, column) => {
      const populated = preview.headers[column] || preview.rows.some((row) => row.cells[column].value);
      assert.ok(populated, `column ${column} should carry a header or values`);
    });
  });

  await suite.test('a token for an unknown object is refused', () => {
    assert.throws(() => shares.createShare({ projectId: project.id, objectId: 'does-not-exist', actor: maya }), /not found/i);
  });

  await application.close();
  fs.rmSync(sandbox, { recursive: true, force: true });
});
