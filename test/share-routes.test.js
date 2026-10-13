import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';

const maya = { id: 'human:maya', displayName: 'Maya Chen', actorType: 'HUMAN_SELF' };

test('public share routes', async (suite) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-share-http-'));
  const projectRoot = path.join(sandbox, 'Accounting');
  fs.mkdirSync(path.join(projectRoot, 'Finance'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'Finance', 'Income-Statement.csv'),
    'Account,Current Period,Prior Period\nOffice Supplies,400,384\nPayroll taxes,225,218\n');

  const application = createApplication({
    dataDir: path.join(sandbox, 'history'), watchProjects: false, port: 0,
  });
  const { project } = application.timeline.importProject(projectRoot, maya, { watch: false });
  application.dependencies.ensureIndex(project.id);
  const object = application.db.prepare(`
    SELECT v.id AS version_id, v.object_id FROM scientific_object_versions v
    JOIN scientific_objects o ON o.id = v.object_id
    WHERE o.project_id = ? AND o.object_type = 'DATASET_ROW' ORDER BY v.label LIMIT 1
  `).get(project.id);

  await new Promise((resolve) => application.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${application.server.address().port}`;

  await suite.test('local sharing is identified before a link is created', async () => {
    const response = await fetch(`${base}/api/sharing/status`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).localOnly, true);
  });

  await suite.test('the native overlay resolves an indexed object to its owning file', async () => {
    const response = await fetch(`${base}/api/dependency-objects/${object.object_id}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.object.id, object.object_id);
    assert.equal(body.object.path, 'Finance/Income-Statement.csv');
    assert.equal((await fetch(`${base}/api/dependency-objects/not-real`)).status, 404);
  });

  await suite.test('the native overlay previews the selected source document', async () => {
    const response = await fetch(
      `${base}/api/dependency-objects/${object.object_id}/preview?version=${object.version_id}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.source.filename, 'Income-Statement.csv');
    assert.equal(body.path, 'Finance/Income-Statement.csv');
    assert.deepEqual(body.preview.columns, ['A', 'B', 'C']);
    assert.deepEqual(body.preview.headers, ['Account', 'Current Period', 'Prior Period']);
    assert.ok(body.preview.rows.some((row) => row.cells.some((cell) => cell.cited)));
    assert.equal((await fetch(`${base}/api/dependency-objects/not-real/preview`)).status, 404);
  });

  await suite.test('select and redact loads the complete source document', async () => {
    const response = await fetch(
      `${base}/api/dependency-objects/${object.object_id}/document?version=${object.version_id}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.document.kind, 'table');
    assert.equal(body.document.sheets.length, 1);
    assert.equal(body.document.sheets[0].rows.length, 3);
    assert.deepEqual(body.document.sheets[0].rows[0],
      ['Account', 'Current Period', 'Prior Period']);
    assert.ok(body.document.sheets[0].rows.flat().includes('Payroll taxes'));
    assert.equal((await fetch(`${base}/api/dependency-objects/not-real/document`)).status, 404);
  });

  let token;
  await suite.test('the overlay creates a share through the API', async () => {
    const response = await fetch(`${base}/api/projects/${project.id}/object-shares`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objectId: object.object_id, versionId: object.version_id, actor: maya }),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    token = body.share.token;
    assert.match(body.share.url, /\/d\/[A-Za-z0-9_-]{32}$/);
  });

  await suite.test('the share page renders provenance', async () => {
    const response = await fetch(`${base}/d/${token}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const html = await response.text();
    assert.match(html, /Income-Statement\.csv/);
    assert.match(html, /Shared/);
    // The recipient never sees where the file lives.
    assert.ok(!html.includes(sandbox));
  });

  await suite.test('download returns the workbook as an attachment', async () => {
    const response = await fetch(`${base}/d/${token}/download`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-disposition'),
      'attachment; filename="Income-Statement.csv"');
    assert.match(await response.text(), /Office Supplies,400/);
  });

  await suite.test('indexed-only links cannot download the original document', async () => {
    const created = await fetch(`${base}/api/projects/${project.id}/object-shares`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        objectId: object.object_id, versionId: object.version_id, actor: maya,
        accessScope: 'INDEXED',
      }),
    });
    const share = (await created.json()).share;
    const page = await fetch(`${base}/d/${share.token}`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Indexed part only/);
    assert.doesNotMatch(html, /Download original/);
    assert.equal((await fetch(`${base}/d/${share.token}/download`)).status, 403);
  });

  await suite.test('redacted links omit masked values and block the original', async () => {
    const created = await fetch(`${base}/api/projects/${project.id}/object-shares`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        objectId: object.object_id, versionId: object.version_id, actor: maya,
        accessScope: 'REDACTED',
        redactions: [{ kind: 'CELL', sheet: 0, row: 1, column: 1, effect: 'BLUR' }],
      }),
    });
    assert.equal(created.status, 201);
    const share = (await created.json()).share;
    const page = await fetch(`${base}/d/${share.token}`);
    const html = await page.text();
    assert.match(html, /Complete document with redactions/);
    assert.match(html, /aria-label="Redacted"/);
    assert.match(html, />225</);
    assert.doesNotMatch(html, />400</);
    assert.doesNotMatch(html, /Download original/);
    assert.equal((await fetch(`${base}/d/${share.token}/download`)).status, 403);
  });

  await suite.test('unknown and malformed tokens do not leak anything', async () => {
    const unknown = await fetch(`${base}/d/${'a'.repeat(32)}`);
    assert.equal(unknown.status, 404);
    assert.match(await unknown.text(), /invalid or no longer available/);
    // Traversal attempts never reach the share handler.
    for (const attempt of ['/d/..%2F..%2Fetc%2Fpasswd', '/d/../../../../etc/passwd', '/d/short']) {
      const response = await fetch(`${base}${attempt}`);
      assert.ok(response.status === 404 || response.status === 400, `${attempt} -> ${response.status}`);
      const body = await response.text();
      assert.ok(!body.includes('root:'), 'must never serve a system file');
    }
  });

  await suite.test('revoking closes access immediately', async () => {
    const revoke = await fetch(`${base}/api/object-shares/${token}/revoke`, { method: 'POST' });
    assert.equal(revoke.status, 200);
    const page = await fetch(`${base}/d/${token}`);
    assert.equal(page.status, 410);
    assert.match(await page.text(), /revoked/i);
    const download = await fetch(`${base}/d/${token}/download`);
    assert.equal(download.status, 410);
    assert.ok(!(await download.text()).includes('Office Supplies,400'));
  });

  await suite.test('expired shares are refused by both routes', async () => {
    const share = application.objectShares.createShare({
      projectId: project.id, objectId: object.object_id, versionId: object.version_id,
      actor: maya, expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    assert.equal((await fetch(`${base}/d/${share.token}`)).status, 410);
    assert.equal((await fetch(`${base}/d/${share.token}/download`)).status, 410);
  });

  await application.close();
  fs.rmSync(sandbox, { recursive: true, force: true });
});
