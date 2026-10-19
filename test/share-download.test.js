import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { buildShareDownload, downloadDisposition, shareDownloadOptions } from '../src/sharing/share-download.js';
import { redactModelPlan } from '../src/sharing/model-redaction.js';
import { documentExtractionInternals } from '../src/dependencies/document-extraction.js';
import { parseDelimited } from '../src/history/diff.js';
import { renderSharePage } from '../src/sharing/share-page.js';
import { createApplication } from '../src/server.js';

const resolved = (accessScope = 'INDEXED', redactions = []) => ({
  source: { filename: 'Capacity.csv', label: 'Invoice', snapshotVersion: 3, valueText: 'A permitted source passage.',
    absolutePath: '/private/PRIVATE_PATH', metadata: { textExcerpt: 'PRIVATE_UNSHARED_TEXT' } },
  share: { accessScope, redactions, createdAt: '2026-10-16T01:00:00Z' },
});
const preview = rows => ({ columns: ['A', 'B'], headers: ['Account', 'Amount'],
  rows: rows.map((row, index) => ({ rowNumber: index + 2, cells: row.map(value => ({ value, cited: true })) })) });

test('CSV excerpts preserve the visible rows, Unicode, commas and newlines while neutralizing formulas', () => {
  const rows = [['Café, office\nNorth', '42'], ['=HYPERLINK("bad")', '-12.5'], ['\t @SUM(1,2)', '+10'], ['-1+2', '  =1+2']];
  const result = buildShareDownload(resolved(), preview(rows), null);
  assert.equal(result.format, 'CSV');
  assert.equal(result.filename, 'Capacity-excerpt-v3.csv');
  const decoded = parseDelimited(result.content.toString('utf8').replace(/^\uFEFF/, ''), ',');
  assert.deepEqual(decoded, [['Account', 'Amount'], ['Café, office\nNorth', '42'], ["'=HYPERLINK(\"bad\")", '-12.5'], ["'\t @SUM(1,2)", '+10'], ["'-1+2", "'  =1+2"]]);
  assert.doesNotMatch(result.content.toString(), /PRIVATE_/);
});

test('redacted text and table exports remove private bytes rather than hiding them', () => {
  const source = resolved('REDACTED', [{ kind: 'CELL', sheet: 0, row: 1, column: 0, effect: 'BLUR' },
    { kind: 'BLOCK', block: 1, effect: 'BLANK' }]);
  source.source.label = 'PRIVATE_ROW_TITLE';
  const table = buildShareDownload(source, null, { kind: 'table', sheets: [{ name: 'Capacity', rows: [['Name', 'Count'], ['PRIVATE_CELL', '40']] }] });
  assert.match(table.content.toString(), /\[Redacted\]/);
  assert.doesNotMatch(table.content.toString(), /PRIVATE_/);
  const text = buildShareDownload(source, null, { kind: 'text', blocks: ['Public first section', 'PRIVATE_PASSAGE', 'Public final section'] });
  assert.equal(text.content.toString(), 'Public first section\n\n[Redacted]\n\nPublic final section\n');
  assert.doesNotMatch(text.content.toString(), /PRIVATE_/);
});

test('multi-sheet redacted copies contain every worksheet in a valid safe ZIP archive', () => {
  const source = resolved('REDACTED', [{ kind: 'CELL', sheet: 1, row: 1, column: 1, effect: 'BLANK' }]);
  const result = buildShareDownload(source, null, { kind: 'table', sheets: [
    { name: '../Capacity', rows: [['Clinic', 'Count'], ['North', '40']] },
    { name: 'Follow-up', rows: [['Issue', 'Notes'], ['Label printer', 'PRIVATE_NOTE']] },
  ] });
  assert.equal(result.format, 'ZIP');
  const first = documentExtractionInternals.zipEntry(result.content, '1-Capacity.csv');
  const second = documentExtractionInternals.zipEntry(result.content, '2-Follow-up.csv');
  assert.match(first.toString(), /North/); assert.match(second.toString(), /Label printer/);
  assert.doesNotMatch(result.content.toString(), /PRIVATE_NOTE|\.\.\//);
  assert.match(second.toString(), /\[Redacted\]/);
  assert.equal(result.content.readUInt32LE(14), crc32(first), 'ZIP checksum agrees with a separate archive reader');
});

test('drawing downloads use the same clipped geometry and visible masks as the public view', () => {
  const mask = { kind: 'DRAWING', effect: 'BLUR', x: .4, y: .4, width: .2, height: .2 };
  const plan = { kind: 'model-plan', format: 'dxf', units: 'm', bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    sourceHash: 'PRIVATE_HASH', fileName: 'PRIVATE_NAME', elements: [], drawing: [
      { type: 'path', id: 'PRIVATE_HANDLE', points: [[0, 50], [100, 50]], closed: false },
      { type: 'text', id: 'PRIVATE_ID', point: [50, 50], height: 1, rotation: 0, text: 'PRIVATE_LABEL' },
      { type: 'text', point: [10, 90], height: 1, rotation: 0, text: 'PUBLIC LABEL' },
    ] };
  const source = resolved('REDACTED', [mask]); source.source.filename = 'Floor-Plan.dxf';
  const sanitized = redactModelPlan(plan, [mask]);
  const result = buildShareDownload(source, null, sanitized);
  const svg = result.content.toString();
  assert.match(svg, /^<\?xml/); assert.match(svg, /xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(svg, /drawing-redaction blur/); assert.match(svg, /PUBLIC LABEL/);
  assert.doesNotMatch(svg, /PRIVATE_|<script|<foreignObject/);
  const page = renderSharePage(source, 'x'.repeat(32), null, sanitized);
  assert.match(page, /Download redacted copy/); assert.match(page, /<small>SVG<\/small>/);
  assert.equal(buildShareDownload(source, null, plan), null, 'unsanitized geometry cannot be exported');
});

test('recipient presentation hides inferred profiles and makes the actual table and download primary', () => {
  const source = resolved();
  source.source.objectType = 'DATASET_COLUMN';
  source.source.valueText = 'invoice; inferred categorical variable; examples PRIVATE_UNSHARED_SAMPLE';
  const page = renderSharePage(source, 'x'.repeat(32), preview([['North', '40']]), null);
  assert.match(page, /class="shared-window"/); assert.match(page, /<span>Lasso<\/span>/);
  assert.match(page, /Download excerpt/); assert.match(page, /<small>CSV<\/small>/);
  assert.match(page, /North/); assert.doesNotMatch(page, /inferred categorical|PRIVATE_|Download original/);
  assert.equal(shareDownloadOptions(source, null, null), null, 'internal column profiles do not become text excerpts');
  const text = buildShareDownload(resolved(), null, null);
  assert.equal(text.content.toString(), 'A permitted source passage.\n');
});

test('download headers safely encode Unicode and reject header/path injection', () => {
  assert.equal(downloadDisposition('Report.csv'), 'attachment; filename="Report.csv"');
  const header = downloadDisposition('../Café "report"\r\nInjected.csv');
  assert.doesNotMatch(header, /\r|\n|\.\.\//);
  assert.match(header, /filename\*=UTF-8''Caf%C3%A9/);
});

test('public excerpt routes respect pinned versions, grants, and original-file restrictions', async t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-excerpt-http-'));
  const root = path.join(sandbox, 'Project'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Capacity.csv'), 'Clinic,Count\nNorth,40\nSouth,30\nWest,20\n');
  const app = createApplication({ dataDir: path.join(sandbox, 'data'), watchProjects: false, port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const actor = { id: 'human:qa', displayName: 'QA', actorType: 'HUMAN_SELF' };
  const { project } = app.timeline.importProject(root, actor, { watch: false }); app.dependencies.ensureIndex(project.id);
  const object = app.db.prepare(`SELECT v.object_id AS objectId,v.id AS versionId FROM scientific_object_versions v
    JOIN scientific_objects o ON o.id=v.object_id WHERE o.project_id=? AND o.object_type='DATASET_ROW' LIMIT 1`).get(project.id);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  for (const accessScope of ['INDEXED', 'REDACTED', 'DOCUMENT']) {
    const share = app.objectShares.createShare({ projectId: project.id, ...object, actor, accessScope,
      redactions: accessScope === 'REDACTED' ? [{ kind: 'CELL', row: 1, column: 1, effect: 'BLANK' }] : [] });
    const url = `${base}/d/${share.token}`;
    const page = await (await fetch(url)).text(); assert.match(page, /\/excerpt/);
    const response = await fetch(`${url}/excerpt`);
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/csv/);
    assert.match(response.headers.get('content-disposition'), /attachment;/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.text();
    assert.match(body, /Clinic/); assert.match(body, /North/);
    if (accessScope === 'REDACTED') { assert.doesNotMatch(body, /"40"/); assert.match(body, /\[Redacted\]/); }
    else assert.match(body, /"40"/);
    fs.writeFileSync(path.join(root, 'Capacity.csv'), 'Changed after sharing');
    assert.equal(await (await fetch(`${url}/excerpt`)).text(), body, 'export stays pinned after source changes');
    assert.equal((await fetch(`${url}/download`)).status, accessScope === 'DOCUMENT' ? 200 : 403);
    app.objectShares.revokeShare(share.token);
    assert.equal((await fetch(`${url}/excerpt`)).status, 410);
  }
  const expired = app.objectShares.createShare({ projectId: project.id, ...object, actor, accessScope: 'INDEXED',
    expiresAt: new Date(Date.now() + 60_000).toISOString() });
  // The link lapses: its stored expiry passes.
  app.db.prepare('UPDATE object_share_grants SET expires_at = ? WHERE token = ?').run('2000-01-01T00:00:00.000Z', expired.token);
  assert.equal((await fetch(`${base}/d/${expired.token}/excerpt`)).status, 410);
  assert.equal((await fetch(`${base}/d/${'z'.repeat(32)}/excerpt`)).status, 404);
});
