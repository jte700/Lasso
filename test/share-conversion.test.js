import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApplication } from '../src/server.js';
import { readZip, zipBytes } from '../src/dependencies/zip-archive.js';
import { conversionFormat, shareConversions } from '../src/sharing/share-conversion.js';
import { renderSharePage } from '../src/sharing/share-page.js';
import { POWERPOINT_THEME, themedDeck } from './fixtures/presentations.js';
import { legacyCitedShare } from './fixtures/legacy-shares.js';

const native = process.platform === 'darwin';
const actor = { id: 'human:share-conversion', displayName: 'Conversion test', actorType: 'HUMAN_SELF' };
const WORD = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const resolved = (filename, accessScope) => ({
  source: { filename, label: filename, snapshotVersion: 2, valueText: 'A permitted passage.', metadata: {} },
  share: { accessScope, redactions: [], createdAt: '2026-10-31T01:00:00Z' },
});
const safePdf = { kind: 'pdf', safe: true, content: Buffer.from('%PDF-1.4'), page: 1, location: '' };
const slide = { kind: 'text', citedSlide: true, slide: 2, picture: Buffer.from([0xff, 0xd8, 0xff]) };
const formats = (list) => list.map(({ of, format }) => `${of}:${format}`);

/** Two pages of text, the first with one private line. */
function pdf(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'];
  for (const [i, lines] of pages.entries()) {
    const content = lines.map((line, row) => `BT /F1 14 Tf 50 ${740 - row * 30} Td (${line}) Tj ET`).join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  let value = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(value)); value += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(value);
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  return Buffer.from(`${value}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
const PLAN = pdf([['PRIVATE CUSTOMER ACCOUNT 72918', 'A public sentence is available to share.'], ['The second page closes the plan.']]);

/** A real Word document, written by macOS's own converter. */
function wordDocument(folder) {
  const html = path.join(folder, 'memo.html');
  fs.writeFileSync(html, '<h1>Site memo</h1><p>The crane arrives on Tuesday.</p>');
  execFileSync('/usr/bin/textutil', ['-convert', 'docx', html, '-output', path.join(folder, 'Memo.docx')]);
  fs.rmSync(html);
}

function partsOf(buffer) {
  return new Map([...readZip(buffer)].map(([name, entry]) => [name, zipBytes(entry, 50_000_000)]));
}

async function sharedFolder(t, write) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-share-conversion-'));
  const root = path.join(temporary, 'Project'); fs.mkdirSync(root);
  write(root);
  const app = createApplication({ shareBaseUrl: 'http://localhost:4317', dataDir: path.join(temporary, 'history'), watchProjects: false, port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  await app.workspace.add([fs.realpathSync(root)], actor);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const projectId = app.workspace.state().directories[0].id;
  const objects = app.dependencies.objectsAt(projectId);
  const share = async (object, accessScope, extra = {}) => {
    const response = await fetch(`${base}/api/projects/${projectId}/object-shares`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objectId: object.id, versionId: object.versionId, actor, accessScope, ...extra }) });
    assert.equal(response.status, 201, await response.clone().text());
    return `${base}/d/${(await response.json()).share.token}`;
  };
  return { app, base, projectId, objects, share };
}

test('a format is named by its usual extension or its name', () => {
  // Assert
  assert.equal(conversionFormat('jpg'), 'JPEG');
  assert.equal(conversionFormat('JPEG'), 'JPEG');
  assert.equal(conversionFormat('docx'), 'DOCX');
  assert.equal(conversionFormat('word'), 'DOCX');
  assert.equal(conversionFormat('pdf'), 'PDF');
  assert.equal(conversionFormat('exe'), null);
  assert.equal(conversionFormat(null), null);
});

test('a recipient may take a PDF as Word and Word as a PDF', () => {
  // Assert: what was cut out for the recipient
  assert.deepEqual(shareConversions(resolved('Deck.pptx', 'INDEXED'), null, slide), [], 'a cited slide already is a picture');
  assert.deepEqual(formats(shareConversions(resolved('Plan.pdf', 'INDEXED'), null, safePdf)), ['excerpt:DOCX']);
  assert.deepEqual(formats(shareConversions(resolved('Plan.pdf', 'REDACTED'), null, safePdf)), ['excerpt:DOCX']);
  assert.deepEqual(formats(shareConversions(resolved('Memo.docx', 'MARKED'), null, safePdf)), ['excerpt:DOCX'],
    'a marked copy arrives as a PDF, so it can be taken as Word too');

  // Assert: the whole document
  assert.deepEqual(formats(shareConversions(resolved('Plan.pdf', 'DOCUMENT'), null, { kind: 'pdf' })), ['original:DOCX']);
  assert.deepEqual(formats(shareConversions(resolved('Memo.docx', 'DOCUMENT'), null, null)), ['original:PDF']);
  const deck = (count) => ({ kind: 'text', slideCount: count, slidePicture: async () => null });
  assert.deepEqual(formats(shareConversions(resolved('Deck.pptx', 'DOCUMENT'), null, deck(1))), ['original:JPEG'],
    'a deck of one slide is one picture');
  assert.deepEqual(shareConversions(resolved('Deck.pptx', 'DOCUMENT'), null, deck(4)), [], 'several slides are not one picture');

  // Assert: nothing else converts
  assert.deepEqual(shareConversions(resolved('Notes.md', 'INDEXED'), null, null), []);
  assert.deepEqual(shareConversions(resolved('Budget.xlsx', 'DOCUMENT'), null, null), []);
  assert.deepEqual(shareConversions(resolved('Memo.docx', 'INDEXED'), null, null), [], 'an excerpt of Word is its text');
});

test('the recipient page offers each format beside the download it converts', () => {
  // Act
  const slidePage = renderSharePage(resolved('Deck.pptx', 'INDEXED'), 'a'.repeat(32), null, slide);
  const wordPage = renderSharePage(resolved('Memo.docx', 'DOCUMENT'), 'b'.repeat(32), null, null);

  // Assert
  assert.match(slidePage, /href="\/d\/a{32}\/excerpt" download>[\s\S]*?<small>JPEG<\/small>/);
  assert.match(wordPage, /href="\/d\/b{32}\/download" download>[\s\S]*?<small>DOCX<\/small>/);
  assert.match(wordPage, /href="\/d\/b{32}\/download\?as=pdf" download>[\s\S]*?Download as PDF[\s\S]*?<small>PDF<\/small>/);
});

test('a shared PDF downloads as a Word document with its text and styling', { skip: !native }, async (t) => {
  // Arrange
  const { objects, share } = await sharedFolder(t, (root) => fs.writeFileSync(path.join(root, 'Plan.pdf'), PLAN));
  const plan = objects.find(object => object.path === 'Plan.pdf');
  const url = await share(plan, 'DOCUMENT');

  // Act
  const page = await (await fetch(url)).text();
  const response = await fetch(`${url}/download?as=docx`);

  // Assert
  assert.match(page, /\/download\?as=docx" download>[\s\S]*?Download as Word/);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), WORD);
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="Plan.docx"');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const document = partsOf(Buffer.from(await response.arrayBuffer())).get('word/document.xml').toString('utf8');
  assert.match(document, /A public sentence is available to share\./);
  assert.match(document, /The second page closes the plan\./);
  assert.match(document, /<w:br w:type="page"\/>/, 'each page starts a page of its own');
  assert.match(document, /<w:b\/>/, 'bold text stays bold');
});

test('an older link’s PDF excerpt as Word is only its pictures, never the text it was cut from', { skip: !native }, async (t) => {
  // Arrange
  const { app, base, projectId, objects } = await sharedFolder(t, (root) => fs.writeFileSync(path.join(root, 'Plan.pdf'), PLAN));
  const plan = objects.find(object => object.path === 'Plan.pdf');
  const excerpt = { kind: 'PDF', text: 'A public sentence is available to share.', page: 1, regions: [] };
  const url = `${base}/d/${legacyCitedShare(app, { projectId, object: plan, actor, excerpt }).token}`;

  // Act
  const response = await fetch(`${url}/excerpt?as=docx`);
  const original = await fetch(`${url}/download?as=docx`);

  // Assert
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), WORD);
  assert.match(response.headers.get('content-disposition'), /Plan-excerpt-v\d+\.docx/);
  const parts = partsOf(Buffer.from(await response.arrayBuffer()));
  const document = parts.get('word/document.xml').toString('utf8');
  const pictures = [...parts.keys()].filter(name => /^word\/media\/.+\.jpg$/.test(name));
  assert.equal(pictures.length, 1, 'the one cropped page is one picture');
  assert.deepEqual([...parts.get(pictures[0]).subarray(0, 3)], [0xff, 0xd8, 0xff]);
  assert.match(document, /<w:drawing>[\s\S]*r:embed="rId[^"]+"/);
  assert.match(parts.get('word/_rels/document.xml.rels').toString('utf8'), /Target="media\/page-1\.jpg"/);
  assert.match(parts.get('[Content_Types].xml').toString('utf8'), /Extension="jpg" ContentType="image\/jpeg"/);
  assert.doesNotMatch(document, /PRIVATE|72918|public sentence|LassoPicture/);
  assert.equal(original.status, 403, 'the original stays private in every format');
});

test('a shared Word document downloads as a PDF of its pages', { skip: !native }, async (t) => {
  // Arrange
  const { objects, share } = await sharedFolder(t, wordDocument);
  const memo = objects.find(object => object.path === 'Memo.docx' && !object.anchor);
  const url = await share(memo, 'DOCUMENT');

  // Act
  const response = await fetch(`${url}/download?as=pdf`);
  const unknown = await fetch(`${url}/download?as=exe`);
  const unoffered = await fetch(`${url}/download?as=jpeg`);

  // Assert
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="Memo.pdf"');
  assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal(unknown.status, 422);
  assert.equal(unoffered.status, 422);
});

test('a shared slide, or a deck of one slide, downloads as a JPEG picture', { skip: !native || !POWERPOINT_THEME }, async (t) => {
  // Arrange: decks Quick Look can draw
  const slides = ['Kickoff', 'Revenue Growth', 'Next Steps'].map((title, index) => ({ title, lines: [`Item ${index + 1} of the ${title.toLowerCase()} is on track.`] }));
  const { objects, share } = await sharedFolder(t, (root) => {
    fs.writeFileSync(path.join(root, 'Review.pptx'), themedDeck(slides));
    fs.writeFileSync(path.join(root, 'Title.pptx'), themedDeck([{ title: 'Launch day', lines: ['Doors open at nine.'] }]));
  });
  const review = objects.find(object => object.path === 'Review.pptx' && !object.anchor);
  const title = objects.find(object => object.path === 'Title.pptx' && !object.anchor);
  const reviewUrl = await share(review, 'DOCUMENT');
  const titleUrl = await share(title, 'DOCUMENT');

  // Act
  const titlePicture = await fetch(`${titleUrl}/download?as=jpg`);
  const reviewPage = await (await fetch(reviewUrl)).text();

  // Assert
  assert.equal(titlePicture.status, 200);
  assert.equal(titlePicture.headers.get('content-disposition'), 'attachment; filename="Title.jpg"');
  assert.doesNotMatch(reviewPage, /as=jpeg/, 'a deck of three slides is not offered as one picture');
  assert.equal((await fetch(`${reviewUrl}/download?as=jpeg`)).status, 422);
});
