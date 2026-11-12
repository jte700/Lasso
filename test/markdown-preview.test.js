import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { markdownBlocks, markdownInlineHtml } from '../src/sharing/markdown.js';
import { isComponentIdentifier } from '../src/dependencies/service.js';

const README = `# Accountant test directory

All figures here are **fictional**. See [the guide](https://example.com/guide) and ![chart](secret/chart.png).

## Try Lasso

1. Enable Suggest While Typing.
2. Toggle the other folder off and repeat a query for a figure found only there.
3. PRIVATE_LIST_ENTRY stays out of redacted copies.

> A quoted note.

\`\`\`js
const value = 1;
\`\`\`

| Account | Amount |
| --- | --- |
| Cash | 10 |

Figure 2: Cash by month.
`;

test('markdown blocks keep structure, line ranges and original source', () => {
  const blocks = markdownBlocks(README);
  assert.deepEqual(blocks.map(block => block.type),
    ['heading', 'paragraph', 'heading', 'item', 'item', 'item', 'quote', 'code', 'table', 'paragraph']);
  assert.equal(blocks[0].level, 1);
  assert.equal(blocks[4].marker, '2.');
  assert.equal(blocks[4].lineStart, 8);
  assert.equal(blocks[7].text, 'const value = 1;');
  assert.equal(blocks[7].source, '```js\nconst value = 1;\n```');
  assert.deepEqual(blocks[8].rows, [['Account', 'Amount'], ['Cash', '10']]);
  assert.equal(markdownBlocks('Title\n===\n\nNext\n---').map(block => `${block.type}${block.level}`).join(), 'heading1,heading2');
});

test('inline markdown is escaped and never loads or follows unsafe resources', () => {
  const html = markdownInlineHtml('**Bold** `<b>` [x](javascript:alert(1)) ![a](file:///etc/passwd) <script>');
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.match(html, /<code>&lt;b&gt;<\/code>/);
  assert.doesNotMatch(html, /href=|<script>|<img|passwd/);
  assert.match(markdownInlineHtml('[x](https://a.test/b_c_d)'), /href="https:\/\/a\.test\/b_c_d"/);
  assert.doesNotMatch(markdownInlineHtml('[x](https://a.test)', { links: false }), /href=/);
});

test('figure and table components require a real identifier', () => {
  for (const identifier of ['1', '2a', 'S1', '3.2', 'A', 'IV']) assert.ok(isComponentIdentifier(identifier), identifier);
  for (const identifier of ['found', 'of', 'shows', 'a']) assert.ok(!isComponentIdentifier(identifier), identifier);
});

test('markdown sources preview, inspect, share and redact like other documents', async t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-markdown-'));
  const root = path.join(sandbox, 'Sources');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'README.md'), README);
  const app = createApplication({ shareBaseUrl: 'http://localhost:4317', dataDir: path.join(sandbox, 'data'), watchProjects: false, port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const actor = { id: 'human:qa', displayName: 'QA', actorType: 'HUMAN_SELF' };
  const { project } = app.timeline.importProject(root, actor, { watch: false });
  app.dependencies.ensureIndex(project.id);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const objects = app.db.prepare(`SELECT v.id AS versionId, v.object_id AS objectId, o.object_type AS type, v.label
    FROM scientific_object_versions v JOIN scientific_objects o ON o.id=v.object_id
    WHERE o.project_id=? AND v.path='README.md' AND o.object_key NOT LIKE '%:text-excerpt:%'`).all(project.id);

  // Prose that mentions "a figure found" is not a figure; "Figure 2" is.
  assert.deepEqual(objects.filter(object => object.type === 'FIGURE').map(object => object.label), ['Figure 2']);
  const documentObject = objects.find(object => object.type === 'DOCUMENT');
  const figure = objects.find(object => object.type === 'FIGURE');
  const previewUrl = (object, extra = '') =>
    `${base}/api/dependency-objects/${object.objectId}/preview?version=${object.versionId}${extra}`;

  const whole = (await (await fetch(previewUrl(documentObject))).json()).preview;
  assert.equal(whole.kind, 'text');
  assert.equal(whole.format, 'markdown');
  assert.equal(whole.location, 'Entire document');
  assert.equal(whole.blocks[0].type, 'heading');
  assert.ok(whole.blocks[0].cited);

  const component = (await (await fetch(previewUrl(figure))).json()).preview;
  assert.equal(component.blocks.filter(block => block.cited).map(block => block.text).join(), 'Figure 2: Cash by month.');
  assert.match(component.location, /^Try Lasso · Line 21$/);

  const matched = (await (await fetch(previewUrl(documentObject,
    `&text=${encodeURIComponent('repeat a query for a figure found only there')}`))).json()).preview;
  assert.deepEqual(matched.blocks.filter(block => block.cited).map(block => block.marker), ['2.']);
  assert.equal(matched.location, 'Try Lasso · Line 8');
  assert.equal(matched.text, 'Toggle the other folder off and repeat a query for a figure found only there.');

  const inspector = await (await fetch(`${base}/inspect?object=${figure.objectId}&version=${figure.versionId}`)).text();
  assert.match(inspector, /class="md-heading md-h2">Try Lasso<\/h4>/);
  assert.match(inspector, /class="md-paragraph cited">Figure 2: Cash by month\.<\/p>/);
  assert.match(inspector, /<strong>fictional<\/strong>/);
  assert.doesNotMatch(inspector, /href="https:\/\/example\.com|secret\/chart\.png|^## /m);

  const local = (await (await fetch(`${base}/api/dependency-objects/${documentObject.objectId}/document?version=${documentObject.versionId}`)).json()).document;
  assert.equal(local.format, 'markdown');
  assert.equal(local.blocks.length, local.styles.length);
  const privateIndex = local.blocks.findIndex(block => block.includes('PRIVATE_LIST_ENTRY'));
  assert.equal(local.styles[privateIndex].type, 'item');

  const share = async (accessScope, redactions = []) => {
    const response = await fetch(`${base}/api/projects/${project.id}/object-shares`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objectId: documentObject.objectId, versionId: documentObject.versionId, actor, accessScope, redactions }),
    });
    assert.equal(response.status, 201);
    return (await response.json()).share;
  };

  const redacted = await share('REDACTED', [{ kind: 'BLOCK', block: privateIndex, effect: 'BLANK' }]);
  assert.equal(redacted.redactions[0].layout, 'markdown');
  const page = await (await fetch(`${base}/d/${redacted.token}`)).text();
  assert.doesNotMatch(page, /PRIVATE_LIST_ENTRY|secret\/chart|javascript:/);
  assert.match(page, /class="md-heading md-h1">Accountant test directory/);
  assert.match(page, /md-redacted"><span class="redaction blank"/);
  assert.match(page, /Enable Suggest While Typing\./);
  const download = await fetch(`${base}/d/${redacted.token}/excerpt`);
  assert.match(download.headers.get('content-disposition'), /README-redacted-v1\.md/);
  const downloaded = await download.text();
  assert.doesNotMatch(downloaded, /PRIVATE_LIST_ENTRY/);
  assert.match(downloaded, /1\. Enable Suggest While Typing\.\n2\. Toggle/);
  assert.match(downloaded, /\n\n\[Redacted\]\n\n/);

  // A text redaction stored before the Markdown layout keeps its original
  // paragraph segmentation, so it can never uncover a different section.
  const legacy = await share('REDACTED', [{ kind: 'BLOCK', block: 3, effect: 'BLANK' }]);
  app.db.prepare('UPDATE object_share_grants SET redactions_json=? WHERE token=?')
    .run(JSON.stringify([{ kind: 'BLOCK', block: 3, effect: 'BLANK' }]), legacy.token);
  const legacyPage = await (await fetch(`${base}/d/${legacy.token}`)).text();
  assert.doesNotMatch(legacyPage, /PRIVATE_LIST_ENTRY|Enable Suggest While Typing/);
  assert.match(legacyPage, /class="full-document document-text"/);

  const complete = await (await fetch(`${base}/d/${(await share('DOCUMENT')).token}`)).text();
  assert.match(complete, /class="full-document markdown-document"/);
  assert.match(complete, /PRIVATE_LIST_ENTRY/);
  assert.match(complete, /href="https:\/\/example\.com\/guide"/);
});
