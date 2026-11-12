import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';

const maya = { id: 'human:maya', displayName: 'Maya Chen', actorType: 'HUMAN_SELF' };

/** The inspector's preview box, without the details above it or the buttons below. */
function previewBox(html) {
  const start = html.indexOf('<div class="inspector-preview">');
  return html.slice(start, html.indexOf('<footer', start));
}

test('a word inserted with a share link previews it as the recipient sees it', async (suite) => {
  // Arrange
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-inspector-share-'));
  const projectRoot = path.join(sandbox, 'Accounting');
  fs.mkdirSync(path.join(projectRoot, 'Finance'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'Finance', 'Income-Statement.csv'),
    'Account,Current Period,Prior Period\nOffice Supplies,400,384\nPayroll taxes,225,218\n');
  const application = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false, port: 0 });
  const { project } = application.timeline.importProject(projectRoot, maya, { watch: false });
  application.dependencies.ensureIndex(project.id);
  const sources = application.dependencies.objectsAt(project.id);
  const cell = sources.find((source) => source.anchor?.kind === 'table-cell'
    && source.anchor.rowKey === 'Payroll taxes' && source.anchor.column === 'Current Period');
  const other = sources.find((source) => source.anchor?.kind === 'table-cell'
    && source.anchor.rowKey === 'Office Supplies' && source.anchor.column === 'Current Period');
  assert.ok(cell && other);
  const share = (accessScope, extra = {}) => application.objectShares.createShare({ projectId: project.id,
    objectId: cell.id, versionId: cell.versionId, actor: maya, accessScope, ...extra });
  const inspect = async (token, objectId = cell.id, versionId = cell.versionId) => {
    const response = await fetch(`${base}/inspect?object=${objectId}&version=${versionId}&reference=ref_1&share=${token}`);
    return { status: response.status, html: await response.text(), shareable: response.headers.get('x-lasso-shareable') };
  };
  await new Promise((resolve) => application.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${application.server.address().port}`;
  suite.after(() => application.server.close());

  await suite.test('a cited-part link shows only the cited part', async () => {
    // Act
    const { status, html } = await inspect(share('INDEXED').token);

    // Assert
    assert.equal(status, 200);
    assert.match(html, /<dt>Shared<\/dt><dd>Cited part only<\/dd>/);
    const box = previewBox(html);
    assert.match(box, /Shared excerpt/);
    assert.match(box, /class="cited">225<\/td>/);
    for (const unshared of ['Office Supplies', '384', '218']) {
      assert.ok(!box.includes(unshared), `${unshared} is not part of the cited part`);
    }
    assert.match(html, /Open Source/, 'the inspector keeps its other buttons');
  });

  await suite.test('a word inserted with a share link offers no other link, by button or Tab', async () => {
    // Act
    const linked = await inspect(share('INDEXED').token);
    const plain = await fetch(`${base}/inspect?object=${cell.id}&version=${cell.versionId}&reference=ref_2`);

    // Assert
    assert.doesNotMatch(linked.html, /data-action="share"/);
    assert.equal(linked.shareable, '0', 'Tab is left to the host app');
    assert.match(await plain.text(), /Share Link <kbd>Tab<\/kbd>/, 'a word inserted with Tab can still be shared');
    assert.equal(plain.headers.get('x-lasso-shareable'), '1');
  });

  await suite.test('a redacted link shows the document with its redactions', async () => {
    // Act
    const { html } = await inspect(share('REDACTED', {
      redactions: [{ kind: 'CELL', sheet: 0, row: 1, column: 1, effect: 'BLUR' }],
    }).token);

    // Assert
    assert.match(html, /<dt>Shared<\/dt><dd>Redacted copy<\/dd>/);
    const box = previewBox(html);
    assert.match(box, /Redacted document/);
    assert.match(box, /class="redacted-cell"/);
    assert.ok(!box.includes('>400<'), 'the redacted cell keeps its value hidden');
    assert.match(box, /Payroll taxes/);
  });

  await suite.test('an entire-document link shows the whole source', async () => {
    // Act
    const { html } = await inspect(share('DOCUMENT').token);

    // Assert
    assert.match(html, /<dt>Shared<\/dt><dd>Entire document<\/dd>/);
    const box = previewBox(html);
    assert.match(box, /aria-label="Source worksheet"/);
    assert.match(box, /Office Supplies/);
    assert.match(box, /class="cited"[^>]*>225<\/td>/);
  });

  await suite.test('a revoked link says so and shows the source', async () => {
    // Arrange
    const revoked = share('INDEXED');
    application.objectShares.revokeShare(revoked.token);

    // Act
    const { status, html } = await inspect(revoked.token);

    // Assert
    assert.equal(status, 200);
    assert.match(html, /<dt>Shared<\/dt><dd>Link revoked<\/dd>/);
    assert.match(previewBox(html), /aria-label="Source worksheet"/);
  });

  await suite.test('a link to another source is never shown for this one', async () => {
    // Arrange
    const elsewhere = share('INDEXED');

    // Act
    const { html } = await inspect(elsewhere.token, other.id, other.versionId);

    // Assert
    assert.doesNotMatch(html, /<dt>Shared<\/dt>/);
    assert.match(previewBox(html), /aria-label="Source worksheet"/);
  });
});
