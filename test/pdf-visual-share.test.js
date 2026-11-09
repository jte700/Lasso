import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApplication } from '../src/server.js';
import { buildSafePdf, pdfShareRequest } from '../src/sharing/pdf-share.js';
import { normalizeRedactions } from '../src/sharing/object-share.js';
import { extractPdfFullText } from '../src/dependencies/document-extraction.js';
import { shareDownloadOptions } from '../src/sharing/share-download.js';
import { renderSharePage } from '../src/sharing/share-page.js';
import { legacyCitedShare } from './fixtures/legacy-shares.js';

const native = process.platform === 'darwin';
const actor = { id: 'human:visual-pdf', displayName: 'PDF QA', actorType: 'HUMAN_SELF' };
function pdf({ rotated = false } = {}) {
  const pages = rotated
    ? [{ box: '/MediaBox [0 0 612 792] /CropBox [40 600 440 780] /Rotate 90',
      content: '0.1 0.5 0.8 rg 60 630 90 90 re f\nBT /F1 12 Tf 60 750 Td (PRIVATE CROPPED NOTE) Tj ET\nBT /F1 12 Tf 180 650 Td (PUBLIC BLUE PLAN) Tj ET' }]
    : [{ box: '/MediaBox [0 0 612 792]', content: 'BT /F1 12 Tf 50 740 Td (PRIVATE CUSTOMER ACCOUNT 72918) Tj ET\nBT /F1 12 Tf 50 650 Td (A public sentence is available to share.) Tj ET' },
      { box: '/MediaBox [0 0 612 792]', content: 'BT /F1 12 Tf 50 740 Td (PRIVATE SECOND PAGE) Tj ET' }];
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (const [i, page] of pages.entries()) {
    objects.push(`<< /Type /Page /Parent 2 0 R ${page.box} /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(page.content)} >>\nstream\n${page.content}\nendstream`);
  }
  let value = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(value)); value += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(value);
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  return Buffer.from(`${value}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test('PDF masks validate pages and top-left normalized regions, and older excerpts keep to what they selected', () => {
  assert.deepEqual(normalizeRedactions([{ kind: 'pdf', page: 2, x: .1, y: .2, width: .3, height: .4 }], 'REDACTED'),
    [{ kind: 'PDF', page: 2, x: .1, y: .2, width: .3, height: .4, effect: 'BLUR' }]);
  for (const value of [{ page: 0 }, { x: -1 }, { width: 1 }, { effect: 'CLEAR' }]) {
    assert.throws(() => normalizeRedactions([{ kind: 'PDF', page: 1, x: .1, y: .2, width: .3, height: .4, ...value }], 'REDACTED'));
  }
  const source = { internal: { filePath: 'source.pdf' }, share: { accessScope: 'INDEXED' },
    source: { anchor: { pageNumber: 1 }, metadata: {}, valueText: 'Whole-file summary' } };
  assert.equal(pdfShareRequest(source), null, 'a whole-file reference cannot become a full PDF excerpt');
  source.source.anchor.selectedText = 'A selected sentence.';
  assert.equal(pdfShareRequest(source).text, 'A selected sentence.');
  const failed = { ...source, source: { filename: 'source.pdf', label: 'PRIVATE_UNSELECTED_LABEL', valueText: 'PRIVATE_UNSELECTED_SUMMARY' } };
  assert.equal(shareDownloadOptions(failed, null, null), null);
  assert.doesNotMatch(renderSharePage(failed, 'a'.repeat(32), null, null), /PRIVATE_UNSELECTED/,
    'failed PDF selections do not disclose an unrelated source summary');
});

test('an existing version 18 workspace gains PDF excerpts without changing pinned grants', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-pdf-migration-'));
  const root = path.join(temporary, 'Project'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Budget.csv'), 'Department,Amount\nPeople,42\n');
  const options = { dataDir: path.join(temporary, 'history'), watchProjects: false, port: 0 };
  let app = createApplication(options);
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  const { project } = app.timeline.importProject(root, actor, { watch: false });
  const object = app.dependencies.objectsAt(project.id).find(value => value.objectType === 'DATASET_ROW');
  const grant = app.objectShares.createShare({ projectId: project.id, objectId: object.id,
    versionId: object.versionId, actor, accessScope: 'INDEXED' });
  app.db.exec('ALTER TABLE object_share_grants DROP COLUMN excerpt_json; DELETE FROM schema_migrations WHERE version>=19;');
  await app.close();
  app = createApplication(options);
  assert.ok(app.db.prepare('PRAGMA table_info(object_share_grants)').all().some(column => column.name === 'excerpt_json'));
  assert.equal(app.objectShares.resolveShare(grant.token).status, 'OK');
  assert.equal(app.objectShares.resolveShare(grant.token).share.excerpt, null);
  const latest = Math.max(...fs.readdirSync('migrations').map(name => Number(name.split('_')[0])).filter(Number.isFinite));
  assert.equal(app.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, latest);
});

test('visual PDF copies remove the original text layer and limit excerpts to selected pages', { skip: !native }, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-visual-pdf-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const bytes = pdf();
  const mask = { kind: 'PDF', page: 1, x: .05, y: .04, width: .7, height: .08, effect: 'BLANK' };
  const redacted = await buildSafePdf(bytes, { mode: 'REDACTED', regions: [mask] });
  assert.notDeepEqual(redacted, bytes);
  assert.doesNotMatch(redacted.toString('latin1'), /PRIVATE CUSTOMER|72918|PRIVATE SECOND PAGE|\/Annots|\/EmbeddedFiles/);
  assert.equal(extractPdfFullText(redacted).trim(), '', 'flattening removes every original selectable text object');
  assert.match(redacted.toString('latin1'), /\/Count\s+2\b/, 'redacted copies preserve all pages');
  const excerpt = await buildSafePdf(bytes, { mode: 'INDEXED', regions: [], text: 'A public sentence is available to share.', page: 1 });
  assert.equal(extractPdfFullText(excerpt).trim(), '');
  assert.match(excerpt.toString('latin1'), /\/Count\s+1\b/, 'excerpt contains only the selected page crop');
  assert.doesNotMatch(excerpt.toString('latin1'), /PRIVATE|72918/);
  await assert.rejects(buildSafePdf(bytes, { mode: 'INDEXED', regions: [], text: 'This sentence is not in the PDF.', page: 1 }));
  await assert.rejects(buildSafePdf(bytes, { mode: 'REDACTED', regions: [{ ...mask, page: 3 }] }));
  fs.writeFileSync(path.join(temporary, 'redacted.pdf'), redacted);
  fs.writeFileSync(path.join(temporary, 'excerpt.pdf'), excerpt);
  const dimensions = filename => execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path.join(temporary, filename)], { encoding: 'utf8' });
  assert.match(dimensions('redacted.pdf'), /pixelWidth: 612[\s\S]*pixelHeight: 792/);
  const excerptSize = dimensions('excerpt.pdf');
  assert.doesNotMatch(excerptSize, /pixelHeight: 792/, 'a selected sentence is cropped rather than sharing its page');
});

test('rotated cropped PDF preserves orientation and applies raw crop-box coordinates', { skip: !native }, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-rotated-pdf-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const result = await buildSafePdf(pdf({ rotated: true }), { mode: 'REDACTED',
    regions: [{ page: 1, x: 0, y: 0, width: 1, height: .25, effect: 'BLANK' }] });
  const filename = path.join(temporary, 'rotated.pdf'); fs.writeFileSync(filename, result);
  const dimensions = execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', filename], { encoding: 'utf8' });
  // The raw crop dimensions stay unchanged, with PDF /Rotate preserving its
  // displayed orientation. The image contains only the selected crop box.
  assert.match(dimensions, /pixelWidth: 400[\s\S]*pixelHeight: 180/);
  assert.match(result.toString('latin1'), /\/Rotate\s+90\b/);
  assert.equal(extractPdfFullText(result).trim(), '');
});

test('A PDF is no longer shared as a cited part, and its recipient view and downloads use identical pinned safe bytes', { skip: !native }, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-pdf-share-http-'));
  const root = path.join(temporary, 'Project'); fs.mkdirSync(root);
  const filename = path.join(root, 'Plan.pdf'); fs.writeFileSync(filename, pdf());
  const app = createApplication({ dataDir: path.join(temporary, 'history'), watchProjects: false, port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  const { project } = app.timeline.importProject(root, actor, { watch: false });
  app.dependencies.ensureIndex(project.id);
  const object = app.dependencies.objectsAt(project.id).find(value => value.path === 'Plan.pdf');
  assert.ok(object);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const excerpt = { kind: 'PDF', text: 'A public sentence is available to share.', page: 1, regions: [] };
  const create = (accessScope, payload = {}) => fetch(`${base}/api/projects/${project.id}/object-shares`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objectId: object.id, versionId: object.versionId, accessScope, ...payload, actor }) });
  assert.equal((await create('INDEXED', { excerpt })).status, 422, 'a cited part is no longer offered');
  const redactions = [{ kind: 'PDF', page: 1, x: .05, y: .04, width: .7, height: .08, effect: 'BLUR' }];
  const shares = [legacyCitedShare(app, { projectId: project.id, object, actor, excerpt }),
    (await (await create('REDACTED', { redactions })).json()).share];
  assert.deepEqual(app.objectShares.resolveShare(shares[0].token).share.excerpt, excerpt, 'an older link keeps its excerpt');
  for (const share of shares) {
    const url = `${base}/d/${share.token}`;
    const bytes = Buffer.from(await (await fetch(`${url}/source`)).arrayBuffer());
    assert.match(bytes.subarray(0, 5).toString('latin1'), /%PDF-/);
    const html = await (await fetch(url)).text();
    assert.match(html, /class="shared-pdf"/); assert.match(html, /<small>PDF<\/small>/);
    assert.doesNotMatch(html, /PRIVATE|72918|\/api\/dependency|Download original/);
    assert.equal((await fetch(`${url}/download`)).status, 403);
    for (const endpoint of ['source', 'excerpt']) {
      const response = await fetch(`${url}/${endpoint}`); assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/pdf');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    }
    fs.writeFileSync(filename, 'The original has changed.');
    assert.deepEqual(Buffer.from(await (await fetch(`${url}/source`)).arrayBuffer()), bytes);
    app.objectShares.revokeShare(share.token);
    assert.equal((await fetch(`${url}/source`)).status, 410);
  }
});
