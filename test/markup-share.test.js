import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApplication } from '../src/server.js';
import { isMarkablePath, normalizeMarkup } from '../src/sharing/markup.js';
import { markedPdfRequest } from '../src/sharing/pdf-share.js';
import { shareDownloadOptions } from '../src/sharing/share-download.js';
import { renderSharePage } from '../src/sharing/share-page.js';
import { extractPdfFullText } from '../src/dependencies/document-extraction.js';

const native = process.platform === 'darwin';
const actor = { id: 'human:markup', displayName: 'Markup QA', actorType: 'HUMAN_SELF' };
const stroke = (overrides = {}) => ({ tool: 'pen', color: '#e5372b', page: 1, points: [0.1, 0.2, 0.30001, 0.4], ...overrides });

/** A one-page PDF with a private line of text, as the visual PDF tests make one. */
function letterPdf() {
  const content = 'BT /F1 12 Tf 50 740 Td (PRIVATE MARKUP TEXT LAYER) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  let value = '%PDF-1.4\n'; const offsets = [];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(value)); value += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(value);
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  return Buffer.from(`${value}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test('markings are checked and kept to four decimal places, only for a marked copy', () => {
  // Arrange
  const sent = [stroke(), stroke({ tool: 'Highlighter', color: '#FFD60A', page: 3, points: [0.5, 0.5] })];

  // Act
  const strokes = normalizeMarkup(sent, 'MARKED');

  // Assert
  assert.deepEqual(strokes, [
    { kind: 'MARK', tool: 'PEN', color: '#E5372B', page: 1, points: [0.1, 0.2, 0.3, 0.4] },
    { kind: 'MARK', tool: 'HIGHLIGHTER', color: '#FFD60A', page: 3, points: [0.5, 0.5] },
  ]);
  assert.deepEqual(normalizeMarkup(sent, 'REDACTED'), [], 'other scopes keep no strokes');
});

test('a marking that is not a pen, marker or highlighter stroke on a page is refused', () => {
  for (const bad of [{ tool: 'ERASER' }, { color: 'red' }, { color: '#12345' }, { page: 0 }, { page: 1001 }, { page: 1.5 },
    { points: [0.1] }, { points: [0.1, 0.2, 0.3] }, { points: [0.1, 1.2] }, { points: [-0.1, 0.2] }, { points: [0.1, Number.NaN] },
    { points: Array(4002).fill(0.5) }, { points: 'nope' }]) {
    assert.throws(() => normalizeMarkup([stroke(bad)], 'MARKED'), /Invalid marking/, JSON.stringify(bad).slice(0, 60));
  }
  assert.throws(() => normalizeMarkup([], 'MARKED'), /Draw on the document/);
  assert.throws(() => normalizeMarkup({}, 'MARKED'), /must be a list/);
  assert.throws(() => normalizeMarkup(Array(401).fill(stroke()), 'MARKED'), /no more than 400/);
  const long = stroke({ points: Array.from({ length: 4000 }, (_, index) => (index % 100) / 100) });
  assert.equal(normalizeMarkup(Array(60).fill(long), 'MARKED').length, 60);
  assert.throws(() => normalizeMarkup(Array(61).fill(long), 'MARKED'), /too detailed/, 'all the strokes together are bounded');
});

test('PDFs, Word documents and decks have pages to mark; other files do not', () => {
  assert.ok(['Plan.pdf', 'Notes/Memo.DOCX', 'Deck.pptx'].every(isMarkablePath));
  assert.ok(!['Budget.xlsx', 'notes.md', 'Model.step', '', null].some(isMarkablePath));
});

test('a marked copy is shown and downloaded as the marked PDF, never the original', () => {
  // Arrange
  const resolved = { internal: { filePath: 'Memo.docx' }, source: { filename: 'Memo.docx', label: 'PRIVATE_LABEL', snapshotVersion: 2,
    location: 'Paragraph 4', valueText: 'PRIVATE_CITED_TEXT' },
  share: { accessScope: 'MARKED', redactions: [{ kind: 'MARK', tool: 'PEN', color: '#000000', page: 1, points: [0, 0] }], createdAt: new Date().toISOString() } };
  const document = { kind: 'pdf', safe: true, marked: true, page: 1, location: '', fileUrl: '/d/token/source', content: Buffer.from('%PDF-1.4') };

  // Act
  const page = renderSharePage(resolved, 'a'.repeat(32), null, document);
  const download = shareDownloadOptions(resolved, null, document);

  // Assert
  assert.deepEqual(markedPdfRequest(resolved), { mode: 'MARKED', strokes: resolved.share.redactions });
  assert.match(page, /Marked-up copy/);
  assert.match(page, /<iframe class="shared-pdf" src="\/d\/token\/source#page=1/);
  assert.doesNotMatch(page, /Download original|PRIVATE_LABEL|PRIVATE_CITED_TEXT|Paragraph 4/);
  assert.equal(download.label, 'Download marked copy');
  assert.equal(download.format, 'PDF');
});

test('a marked copy that could not be drawn shows nothing of the document in its place', () => {
  // Arrange
  const resolved = { internal: { filePath: 'Memo.docx' }, source: { filename: 'Memo.docx', label: 'Memo', snapshotVersion: 2,
    location: 'Paragraph 4', valueText: 'PRIVATE_CITED_TEXT' }, share: { accessScope: 'MARKED', redactions: [], createdAt: new Date().toISOString() } };

  // Act
  const page = renderSharePage(resolved, 'a'.repeat(32), null, null);

  // Assert
  assert.equal(shareDownloadOptions(resolved, null, null), null, 'no download stands in for the marked copy');
  assert.match(page, /The marked copy couldn’t be prepared/);
  assert.doesNotMatch(page, /PRIVATE_CITED_TEXT|Download original|Paragraph 4/);
});

test('a marked share draws the strokes on a picture of each page and keeps the original out', { skip: !native }, async (t) => {
  // Arrange
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-markup-'));
  const root = path.join(temporary, 'Project');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Plan.pdf'), letterPdf());
  fs.writeFileSync(path.join(root, 'Budget.csv'), 'Department,Amount\nPeople,42\n');
  const app = createApplication({ shareBaseUrl: 'http://localhost:4317', dataDir: path.join(temporary, 'history'), watchProjects: false, port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  const { project } = app.timeline.importProject(root, actor, { watch: false });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const objects = app.dependencies.objectsAt(project.id);
  const plan = objects.find((object) => object.path === 'Plan.pdf');
  const budget = objects.find((object) => object.path === 'Budget.csv');
  const share = (object, markup) => fetch(`${base}/api/projects/${project.id}/object-shares`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ objectId: object.id, versionId: object.versionId, accessScope: 'MARKED', markup }) });

  // Act
  const created = await share(plan, [stroke({ tool: 'HIGHLIGHTER', color: '#FFD60A' }), stroke()]);
  const { share: grant } = await created.json();
  const pages = await fetch(`${base}/api/dependency-objects/${plan.id}/pages?version=${plan.versionId}`);
  const view = await fetch(`${base}/d/${grant.token}`);
  const copy = await fetch(`${base}/d/${grant.token}/source`);
  const original = await fetch(`${base}/d/${grant.token}/download`);
  const refused = await share(budget, [stroke()]);

  // Assert
  assert.equal(created.status, 201);
  assert.equal(grant.accessScope, 'MARKED');
  assert.equal(grant.redactions.length, 2);
  assert.equal(pages.status, 200);
  assert.equal(pages.headers.get('content-type'), 'application/pdf');
  assert.match(await view.text(), /Marked-up copy/);
  assert.equal(copy.status, 200);
  const bytes = Buffer.from(await copy.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.doesNotMatch(extractPdfFullText(bytes) ?? '', /PRIVATE/, 'the copy is a picture, without the original text layer');
  assert.equal(original.status, 403, 'the original file stays private');
  assert.equal(refused.status, 422);
  assert.match((await refused.json()).error.message, /Only PDFs, Word documents and presentations/);
});

test('a Word document is laid out on pages to mark up', { skip: !native }, async (t) => {
  // Arrange
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-markup-docx-'));
  const root = path.join(temporary, 'Project');
  fs.mkdirSync(root);
  const html = path.join(temporary, 'memo.html');
  fs.writeFileSync(html, `<h1>Site memo</h1>${'<p>The north wall needs another inspection before the pour.</p>'.repeat(120)}`);
  execFileSync('/usr/bin/textutil', ['-convert', 'docx', '-output', path.join(root, 'Memo.docx'), html]);
  const app = createApplication({ shareBaseUrl: 'http://localhost:4317', dataDir: path.join(temporary, 'history'), watchProjects: false, port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  const { project } = app.timeline.importProject(root, actor, { watch: false });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const memo = app.dependencies.objectsAt(project.id).find((object) => object.path === 'Memo.docx');

  // Act
  const pages = await fetch(`${base}/api/dependency-objects/${memo.id}/pages?version=${memo.versionId}`);
  const bytes = Buffer.from(await pages.arrayBuffer());

  // Assert
  assert.equal(pages.status, 200);
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok((bytes.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length >= 2, 'a long memo runs onto several pages');
});

test('a store made before marked copies keeps its shares and gains them', async (t) => {
  // Arrange
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-markup-store-'));
  const root = path.join(temporary, 'Project');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Plan.pdf'), letterPdf());
  const options = { dataDir: path.join(temporary, 'history'), watchProjects: false, port: 0 };
  let app = createApplication(options);
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  const { project } = app.timeline.importProject(root, actor, { watch: false });
  const plan = app.dependencies.objectsAt(project.id).find((object) => object.path === 'Plan.pdf');
  const earlier = app.objectShares.createShare({ projectId: project.id, objectId: plan.id, versionId: plan.versionId, actor });
  const tableSql = () => app.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'object_share_grants'").get().sql;
  // The table as it was made before marked copies.
  const older = tableSql().replace(", 'MARKED'", '').replace(/^CREATE TABLE\s+"?object_share_grants"?/, 'CREATE TABLE older_grants');
  app.db.exec('PRAGMA foreign_keys = OFF');
  app.db.exec(`${older}; INSERT INTO older_grants SELECT * FROM object_share_grants; DROP TABLE object_share_grants;
    ALTER TABLE older_grants RENAME TO object_share_grants;`);
  app.db.exec('PRAGMA foreign_keys = ON');
  assert.doesNotMatch(tableSql(), /MARKED/);
  await app.close();

  // Act
  app = createApplication(options);
  const marked = app.objectShares.createShare({ projectId: project.id, objectId: plan.id, versionId: plan.versionId, actor,
    accessScope: 'MARKED', markup: [stroke()] });

  // Assert
  assert.match(tableSql(), /'MARKED'/);
  assert.equal(app.objectShares.resolveShare(earlier.token).status, 'OK', 'a share made before still opens');
  assert.equal(app.objectShares.resolveShare(marked.token).share.accessScope, 'MARKED');
  assert.deepEqual(app.db.prepare('PRAGMA foreign_key_check').all(), []);
});
