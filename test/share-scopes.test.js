import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { offeredShareScopes } from '../src/sharing/object-share.js';
import { shareConversions } from '../src/sharing/share-conversion.js';
import { buildShareDownload, shareDownloadOptions } from '../src/sharing/share-download.js';
import { renderSharePage } from '../src/sharing/share-page.js';
import { legacyCitedShare } from './fixtures/legacy-shares.js';
import { POWERPOINT_THEME, themedDeck } from './fixtures/presentations.js';

const actor = { id: 'human:share-scopes', displayName: 'Scope test', actorType: 'HUMAN_SELF' };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const token = 'a'.repeat(32);

const citedSlide = (filename = 'Review.pptx') => ({
  source: { filename, label: 'Churn fell to 3 percent.', snapshotVersion: 2, valueText: 'Churn fell to 3 percent.', metadata: {} },
  share: { accessScope: 'INDEXED', redactions: [], createdAt: '2026-11-08T12:00:00Z' },
});
const slideDocument = (picture) => ({ kind: 'text', format: 'markdown', citedSlide: true, slide: 2, location: 'Slide 2 · Revenue Growth',
  blocks: ['Revenue Growth', 'WORDS_ONLY_ON_THE_SLIDE'],
  styles: [{ type: 'heading', level: 2, text: 'Revenue Growth' }, { type: 'paragraph', text: 'WORDS_ONLY_ON_THE_SLIDE', cited: true }], picture });

async function sharedFolder(t, write) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-share-scopes-'));
  const root = path.join(temporary, 'Project'); fs.mkdirSync(root);
  write(root);
  const app = createApplication({ shareBaseUrl: 'http://localhost:4317', dataDir: path.join(temporary, 'history'), watchProjects: false, port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  const { project } = app.timeline.importProject(root, actor, { watch: false });
  app.dependencies.ensureIndex(project.id);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const share = (object, accessScope) => fetch(`${base}/api/projects/${project.id}/object-shares`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ objectId: object.id, versionId: object.versionId, accessScope, actor }),
  });
  return { app, project, base, share, objects: app.dependencies.objectsAt(project.id) };
}

test('PDFs, Word documents and text files offer no cited part', () => {
  // Act
  const scopes = (filename) => offeredShareScopes(filename, { kind: 'text-span', selectedText: 'A sentence.' });

  // Assert
  assert.deepEqual(scopes('Plan.PDF'), ['DOCUMENT', 'REDACTED', 'MARKED']);
  assert.deepEqual(scopes('Memo.docx'), ['DOCUMENT', 'REDACTED', 'MARKED']);
  for (const filename of ['Notes.txt', 'Close.md', 'Paper.tex', 'Guide.rst', 'run.log']) {
    assert.deepEqual(scopes(filename), ['DOCUMENT', 'REDACTED'], filename);
  }
});

test('Tables, CAD models and a cited slide keep their cited part', () => {
  // Assert
  assert.ok(offeredShareScopes('Budget.xlsx', {}).includes('INDEXED'));
  assert.ok(offeredShareScopes('Budget.csv', {}).includes('INDEXED'));
  assert.ok(offeredShareScopes('Bracket.step', {}).includes('INDEXED'));
  assert.ok(offeredShareScopes('Review.pptx', { slideNumber: 2 }).includes('INDEXED'));
});

test('Asking for a cited part of a text file is refused, and the whole file is still shared', async (t) => {
  // Arrange
  const { objects, share } = await sharedFolder(t, (root) => fs.writeFileSync(path.join(root, 'Close.md'),
    '# Month-end close\n\nCash was reconciled on Friday. The ledger agrees with the bank.\n'));
  const note = objects.find((object) => object.path === 'Close.md');

  // Act
  const refused = await share(note, 'INDEXED');
  const whole = await share(note, 'DOCUMENT');

  // Assert
  assert.equal(refused.status, 422);
  assert.match((await refused.json()).error.message, /shared whole, redacted or marked up|shared whole or redacted/);
  assert.equal(whole.status, 201);
});

test('A link made before text files lost their cited part still shows its passage', async (t) => {
  // Arrange
  const { app, project, base, objects } = await sharedFolder(t, (root) => fs.writeFileSync(path.join(root, 'Close.md'),
    '# Month-end close\n\nCash was reconciled on Friday. The ledger agrees with the bank.\n\nA later paragraph that is not shared.\n'));
  const sentence = objects.find((object) => object.path === 'Close.md' && /ledger agrees/.test(object.valueText ?? '')
    && object.metadata?.excerptType === 'sentence') ?? objects.find((object) => object.path === 'Close.md' && /ledger agrees/.test(object.valueText ?? ''));
  const old = legacyCitedShare(app, { projectId: project.id, object: sentence, actor });

  // Act
  const response = await fetch(`${base}/d/${old.token}`);
  const page = await response.text();

  // Assert
  assert.equal(response.status, 200);
  assert.match(page, /ledger agrees with the bank/);
  assert.doesNotMatch(page, /later paragraph/);
  assert.equal((await fetch(`${base}/d/${old.token}/download`)).status, 403, 'it never included the file');
});

test('A cited slide is shown as a picture of the slide, without its words in the page', () => {
  // Act
  const html = renderSharePage(citedSlide(), token, null, slideDocument(JPEG));

  // Assert
  assert.match(html, new RegExp(`<img src="/d/${token}/slide" alt="Slide 2 · Revenue Growth">`));
  assert.doesNotMatch(html, /WORDS_ONLY_ON_THE_SLIDE/);
  assert.match(html, /Only a picture of this slide is shared\./);
});

test('The picture is the only download of a cited slide', () => {
  // Act
  const html = renderSharePage(citedSlide(), token, null, slideDocument(JPEG));
  const download = buildShareDownload(citedSlide(), null, slideDocument(JPEG));
  const toolbar = html.slice(html.indexOf('<header class="shared-toolbar">'), html.indexOf('</header>'));

  // Assert
  assert.equal(download.content, JPEG);
  assert.equal(download.contentType, 'image/jpeg');
  assert.equal(download.filename, 'Review-slide-2-v2.jpg');
  assert.deepEqual(shareConversions(citedSlide(), null, slideDocument(JPEG)), []);
  assert.equal(toolbar.match(/class="action[ "]/g).length, 1);
  assert.match(toolbar, new RegExp(`href="/d/${token}/excerpt" download>[\\s\\S]*?Download slide[\\s\\S]*?<small>JPEG</small>`));
  assert.doesNotMatch(toolbar, /PPTX/);
});

test('A slide that cannot be drawn shows its words and offers no picture', () => {
  // Act
  const html = renderSharePage(citedSlide(), token, null, slideDocument(null));
  const options = shareDownloadOptions(citedSlide(), null, slideDocument(null));

  // Assert
  assert.match(html, /WORDS_ONLY_ON_THE_SLIDE/);
  assert.doesNotMatch(html, /\/slide"/);
  assert.equal(options.format, 'TXT');
});

test('A cited slide’s link serves that slide’s picture until it is revoked', { skip: !POWERPOINT_THEME }, async (t) => {
  // Arrange
  const slides = ['Kickoff', 'Revenue Growth', 'Next Steps'].map((title, index) => ({ title, lines: [`Item ${index + 1} of the ${title.toLowerCase()} is on track.`] }));
  const { app, base, objects, share } = await sharedFolder(t, (root) => fs.writeFileSync(path.join(root, 'Review.pptx'), themedDeck(slides)));
  const cited = objects.find((object) => object.anchor?.slideNumber === 2 && object.metadata.excerptType === 'sentence');
  const { share: created } = await (await share(cited, 'INDEXED')).json();
  const url = `${base}/d/${created.token}`;

  // Act
  const page = await (await fetch(url)).text();
  const picture = await fetch(`${url}/slide`);
  const bytes = Buffer.from(await picture.arrayBuffer());
  const download = await fetch(`${url}/excerpt`);

  // Assert: the page shows the picture, and nothing of the other slides
  assert.match(page, new RegExp(`<img src="/d/${created.token}/slide"`));
  assert.doesNotMatch(page, /Kickoff|Next Steps|<small>PPTX/);
  assert.equal(picture.status, 200);
  assert.equal(picture.headers.get('content-type'), 'image/jpeg');
  assert.equal(picture.headers.get('content-disposition'), null, 'it opens in the page');
  assert.equal(picture.headers.get('cache-control'), 'no-store');
  assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);

  // Assert: the download is the same picture
  assert.equal(download.headers.get('content-type'), 'image/jpeg');
  assert.match(download.headers.get('content-disposition'), /Review-slide-2-v\d+\.jpg/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  assert.equal((await fetch(`${url}/download`)).status, 403, 'the deck itself stays private');

  // Assert: a revoked link draws nothing
  app.objectShares.revokeShare(created.token);
  assert.equal((await fetch(`${url}/slide`)).status, 410);
});

test('Only a cited slide’s link serves a slide picture', async (t) => {
  // Arrange
  const { base, objects, share } = await sharedFolder(t, (root) => {
    fs.writeFileSync(path.join(root, 'Budget.csv'), 'Account,Actual\nRent,1800\n');
    fs.writeFileSync(path.join(root, 'Close.md'), '# Close\n\nThe ledger agrees with the bank.\n');
  });
  const row = objects.find((object) => object.objectType === 'DATASET_ROW');
  const note = objects.find((object) => object.path === 'Close.md');
  const links = [(await (await share(row, 'INDEXED')).json()).share, (await (await share(note, 'DOCUMENT')).json()).share];

  // Act
  const statuses = await Promise.all(links.map(async ({ token: link }) => (await fetch(`${base}/d/${link}/slide`)).status));

  // Assert
  assert.deepEqual(statuses, [404, 404]);
});
