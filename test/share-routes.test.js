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
    assert.equal(body.source.absolutePath, fs.realpathSync(path.join(projectRoot, 'Finance', 'Income-Statement.csv')));
    assert.equal(body.path, 'Finance/Income-Statement.csv');
    assert.deepEqual(body.preview.columns, ['A', 'B', 'C']);
    assert.deepEqual(body.preview.headers, ['Account', 'Current Period', 'Prior Period']);
    assert.ok(body.preview.rows.some((row) => row.cells.some((cell) => cell.cited)));
    assert.equal((await fetch(`${base}/api/dependency-objects/not-real/preview`)).status, 404);
  });

  await suite.test('the private inspector shows the real file location and a source viewport', async () => {
    const response = await fetch(`${base}/inspect?object=${object.object_id}&version=${object.version_id}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes(path.join(projectRoot, 'Finance', 'Income-Statement.csv')));
    assert.match(html, /aria-label="Source worksheet"/);
    assert.match(html, /scope="col">B</);
    assert.match(html, /scope="row">2</);
    assert.match(html, />400</);
    assert.match(html, /Share Link <kbd>Tab<\/kbd>/);
    assert.doesNotMatch(html, /Cited value|Version 1|inspector-topbar|source-type/);
    assert.equal((await fetch(`${base}/api/dependency-objects/${object.object_id}/source`)).status, 415);
    assert.equal((await fetch(`${base}/api/dependency-objects/not-real/source`)).status, 404);
  });

  await suite.test('a local variable selects its header while its indexed share retains column data', async () => {
    const variable = application.dependencies.objectsAt(project.id)
      .find(source => source.objectType === 'VARIABLE' && source.label === 'Current Period');
    assert.ok(variable);
    const body = await (await fetch(`${base}/api/dependency-objects/${variable.id}/preview?version=${variable.versionId}`)).json();
    assert.equal(body.source.objectType, 'VARIABLE');
    assert.equal(body.source.anchor.kind, 'table-column');
    assert.equal(body.preview.location, 'B1 (column header)');
    assert.deepEqual(body.preview.rows.flatMap(row => row.cells.filter(cell => cell.cited).map(cell => cell.value)), ['Current Period']);
    const html = await (await fetch(`${base}/inspect?object=${variable.id}&version=${variable.versionId}`)).text();
    assert.match(html, /B1 \(column header\)/);
    assert.equal((html.match(/<td class="cited"/g) ?? []).length, 1);
    assert.match(html, /<th scope="col" class="cited">B<\/th>/, 'its column letter is marked beside it');
    assert.match(html, /class="cited"[^>]*>Current Period<\/td>/);
    const share = application.objectShares.createShare({ projectId: project.id, objectId: variable.id,
      versionId: variable.versionId, actor: maya, accessScope: 'INDEXED' });
    const shared = await (await fetch(`${base}/d/${share.token}`)).text();
    assert.match(shared, /class="cited">400<\/td>/);
    assert.match(shared, /class="cited">225<\/td>/);
    assert.doesNotMatch(shared, /class="cited">Current Period<\/td>/);
    // The cited part of a column is that column alone: no account names, no other period.
    for (const other of ['Office Supplies', 'Payroll taxes', 'Prior Period', '384', '218']) {
      assert.ok(!shared.includes(other), `${other} is not shared with the Current Period column`);
    }
    const excerpt = await (await fetch(`${base}/d/${share.token}/excerpt`)).text();
    assert.match(excerpt, /Current Period/);
    assert.match(excerpt, /400/);
    assert.ok(!/Office Supplies|Prior Period|384/.test(excerpt), `the downloaded excerpt holds the column alone: ${excerpt}`);
    const composer = await (await fetch(`${base}/api/dependency-objects/${variable.id}/preview?version=${variable.versionId}&shared=1`)).json();
    assert.deepEqual(composer.sharedExcerpt.headers, ['Current Period'], 'the share composer is shown the same column');
    assert.deepEqual(composer.sharedExcerpt.rows.map((row) => row.cells.map((cell) => cell.value)), [['400'], ['225']]);
  });

  await suite.test('a cited cell is shared with the sentence it backs, alone or with its nearby rows', async () => {
    const cell = application.dependencies.objectsAt(project.id).find(source => source.anchor?.kind === 'table-cell'
      && source.anchor.rowKey === 'Payroll taxes' && source.anchor.column === 'Current Period');
    assert.ok(cell);
    const sentence = 'Payroll taxes came to 225 this period.';
    const alone = application.objectShares.createShare({ projectId: project.id, objectId: cell.id,
      versionId: cell.versionId, actor: maya, accessScope: 'INDEXED', citedIn: sentence });
    const page = await (await fetch(`${base}/d/${alone.token}`)).text();
    assert.match(page, /Cited in/);
    assert.match(page, /Payroll taxes came to 225 this period\./);
    assert.match(page, /class="cited">225<\/td>/);
    assert.ok(!page.includes('Office Supplies') && !page.includes('218'), 'the cell comes with its row label and heading only');
    const nearby = application.objectShares.createShare({ projectId: project.id, objectId: cell.id,
      versionId: cell.versionId, actor: maya, accessScope: 'INDEXED', citedIn: sentence, nearbyRows: true });
    const wide = await (await fetch(`${base}/d/${nearby.token}`)).text();
    assert.ok(wide.includes('Office Supplies') && wide.includes('218'), 'nearby rows come when the sharer asks for them');
    assert.equal(application.objectShares.resolveShare(nearby.token).share.context.nearbyRows, true);
    const composer = await (await fetch(`${base}/api/dependency-objects/${cell.id}/preview?version=${cell.versionId}&shared=1`)).json();
    assert.deepEqual(composer.sharedExcerpt.headers, ['Account', 'Current Period'], 'the composer shows the cell as shared');
    assert.ok(composer.nearbyExcerpt.rows.length > 1, 'and the nearby rows its switch would add');
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
        redactions: [
          { kind: 'CELL', sheet: 0, row: 1, column: 0, effect: 'BLUR' },
          { kind: 'CELL', sheet: 0, row: 1, column: 1, effect: 'BLUR' },
        ],
      }),
    });
    assert.equal(created.status, 201);
    const share = (await created.json()).share;
    const page = await fetch(`${base}/d/${share.token}`);
    const html = await page.text();
    assert.match(html, /Complete document with redactions/);
    assert.match(html, /aria-label="Redacted"/);
    assert.match(html, /class="redaction blur" role="img"/);
    assert.doesNotMatch(html, /Office Supplies/);
    assert.match(html, />225</);
    assert.doesNotMatch(html, />400</);
    assert.doesNotMatch(html, /Download original/);
    assert.equal((await fetch(`${base}/d/${share.token}/download`)).status, 403);
  });

  await suite.test('redacting an indexed row label also removes it from the page title and heading', async () => {
    const share = application.objectShares.createShare({
      projectId: project.id, objectId: object.object_id, versionId: object.version_id, actor: maya,
      accessScope: 'REDACTED',
      redactions: [{ kind: 'CELL', sheet: 0, row: 1, column: 0, effect: 'BLANK' }],
    });
    const page = await fetch(`${base}/d/${share.token}`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.doesNotMatch(html, /Office Supplies/);
    assert.match(html, /class="redaction blank" role="img"/);
    assert.match(html, /<h1>Income-Statement\.csv<\/h1>/);
    assert.match(html, /Payroll taxes/);
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
      actor: maya, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    // The link lapses: its stored expiry passes.
    application.db.prepare('UPDATE object_share_grants SET expires_at = ? WHERE token = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), share.token);
    assert.equal((await fetch(`${base}/d/${share.token}`)).status, 410);
    assert.equal((await fetch(`${base}/d/${share.token}/download`)).status, 410);
  });

  await application.close();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('the old browser workbench is shown only to the Windows app; a Mac browser is pointed to the menu bar', async t => {
  // Arrange
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-home-'));
  const application = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false, port: 0 });
  t.after(async () => { await application.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  await new Promise((resolve) => application.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${application.server.address().port}`;

  // Act
  const home = await (await fetch(`${base}/`)).text();
  const index = await (await fetch(`${base}/index.html`)).text();
  const windows = await (await fetch(`${base}/?app=1&platform=windows`)).text();
  const viewer = await fetch(`${base}/model-preview.js`);

  // Assert
  if (process.platform !== 'win32') {
    for (const page of [home, index]) {
      assert.match(page, /Lasso runs from the menu bar/);
      assert.ok(!page.includes('/app.js'), 'the workbench is not loaded on a Mac');
    }
  }
  assert.match(windows, /\/app\.js/, 'the Windows app still opens its workbench');
  assert.equal(viewer.status, 200, 'share pages keep their scripts');
});
