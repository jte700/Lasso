import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { activityScore, latestTime, normalizedActivity } from '../src/ranch/activity.js';
import { fileNamesIn, shareLinksIn } from '../src/ranch/text-links.js';
import { nameGroups, nameStem } from '../src/ranch/name-groups.js';
import { sourceKind } from '../src/ranch/kinds.js';
import { edgeCollector, mentionTargets } from '../src/ranch/network.js';
import { linkReviewItems, readingReviewItems } from '../src/ranch/review.js';
import { shownCell, spreadsheetView } from '../src/ranch/sheets.js';
import { workbook } from './fixtures/workbook.js';
import { VISIT_SESSION_MS } from '../src/ranch/service.js';
import { bracketPart } from './fixtures/step-models.js';

const actor = { id: 'human:ranch', displayName: 'Ranch test', actorType: 'HUMAN_SELF' };
const FOREIGN_LINK = 'https://lasso.example.com/d/AbCdEfGhIjKlMnOpQrStUvWxYz012345';

test('activity weighs deliberate actions and scales them against the busiest file', () => {
  assert.equal(activityScore({}), 0);
  assert.equal(activityScore({ tabs: 1, shares: 1, references: 1, opens: 1, visits: 1 }), 11);
  const scaled = normalizedActivity(new Map([['busy', 40], ['some', 4], ['idle', 0]]));
  assert.equal(scaled.get('busy'), 1);
  assert.equal(scaled.get('idle'), 0);
  assert.ok(scaled.get('some') > 0.3 && scaled.get('some') < 1, 'a little use still shows on a log scale');
  assert.deepEqual([...normalizedActivity(new Map([['a', 0]])).values()], [0]);
});

test('latestTime takes ISO strings and milliseconds and ignores missing values', () => {
  assert.equal(latestTime('2026-10-01T00:00:00.000Z', Date.parse('2026-10-02T00:00:00.000Z'), null),
    '2026-10-02T00:00:00.000Z');
  assert.equal(latestTime([], null), null);
});

test('share links are found once each, without trailing punctuation', () => {
  const text = `See ${FOREIGN_LINK}. Again: ${FOREIGN_LINK}, and http://127.0.0.1:4319/d/ZyXwVuTsRqPoNmLkJiHg_-0123456789!`;
  assert.deepEqual(shareLinksIn(text), [
    { url: FOREIGN_LINK, token: 'AbCdEfGhIjKlMnOpQrStUvWxYz012345' },
    { url: 'http://127.0.0.1:4319/d/ZyXwVuTsRqPoNmLkJiHg_-0123456789', token: 'ZyXwVuTsRqPoNmLkJiHg_-0123456789' },
  ]);
  assert.deepEqual(shareLinksIn('no links /d/short here'), []);
  // Google Docs and Drive use /d/ too, with ids of other lengths.
  assert.deepEqual(shareLinksIn('https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit '
    + 'https://drive.google.com/file/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456/view'), []);
});

test('file names are read from prose, paths and Markdown links', () => {
  const names = fileNamesIn('Totals come from Income-Statement.csv; see [plan](Drawings/Site%20Plan.pdf) and a.b.');
  assert.deepEqual(names, ['income-statement.csv', 'site plan.pdf']);
  assert.deepEqual(fileNamesIn('mail me at someone@example.com'), []);
});

test('name stems drop revisions and copies, and only distinctive names group', () => {
  assert.equal(nameStem('Bracket-Rev2.STEP'), 'bracket');
  assert.equal(nameStem('Site Plan (1).pdf'), 'site plan');
  assert.equal(nameStem('Budget_v3.xlsx'), 'budget');
  const groups = nameGroups([
    { key: 'a', name: 'Bracket.step' }, { key: 'b', name: 'Bracket.pdf' },
    { key: 'c', name: 'README.md' }, { key: 'd', name: 'readme.txt' },
    { key: 'e', name: '2026.csv' }, { key: 'f', name: '2026.pdf' },
  ]);
  assert.deepEqual(groups, [['a', 'b']]);
});

test('source kinds choose how The Ranch previews a file', () => {
  assert.equal(sourceKind('Models/Bracket.STEP', 'drawing'), 'model');
  assert.equal(sourceKind('Plan.dxf', 'drawing'), 'drawing');
  assert.equal(sourceKind('Budget.xlsx', 'spreadsheet'), 'spreadsheet');
  assert.equal(sourceKind('Brief.docx', 'document'), 'document');
  assert.equal(sourceKind('script.py', 'code'), 'code');
  assert.equal(sourceKind('archive.zip', 'binary'), 'other');
});

test('edges add up repeats, ignore self links and keep the strongest first', () => {
  const collector = edgeCollector();
  collector.add('b', 'a', 'link');
  collector.add('a', 'b', 'link');
  collector.add('a', 'a', 'link');
  collector.add('a', 'c', 'same-name');
  assert.deepEqual(collector.edges(), [
    { from: 'a', to: 'b', kind: 'link', weight: 2 },
    { from: 'a', to: 'c', kind: 'same-name', weight: 0.5 },
  ]);
});

test('a mention prefers the named file in its own directory and skips common names', () => {
  const byName = new Map([
    ['plan.pdf', [{ id: 'x', directoryId: 'one' }, { id: 'y', directoryId: 'two' }]],
    ['data.csv', ['p', 'q', 'r', 's'].map((id) => ({ id, directoryId: 'three' }))],
  ]);
  assert.deepEqual(mentionTargets(byName, 'plan.pdf', { id: 'n', directoryId: 'two' }).map((file) => file.id), ['y']);
  assert.deepEqual(mentionTargets(byName, 'plan.pdf', { id: 'n', directoryId: 'four' }).map((file) => file.id), ['x', 'y']);
  assert.deepEqual(mentionTargets(byName, 'data.csv', { id: 'n', directoryId: 'four' }), []);
});

test('review groups link problems by source and skips formats Lasso does not read', () => {
  const items = linkReviewItems([
    { projectId: 'doc', documentPath: 'Report.md', status: 'STALE', source: { projectId: 'src', path: 'Budget.csv' } },
    { projectId: 'doc', documentPath: 'Memo.md', status: 'STALE', source: { projectId: 'src', path: 'Budget.csv' } },
    { projectId: 'doc', documentPath: 'Memo.md', status: 'LINKED', source: { projectId: 'src', path: 'Other.csv' } },
  ], () => 'file-1');
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].documents, ['Report.md', 'Memo.md']);
  assert.match(items[0].detail, /2 documents/);
  assert.deepEqual(items[0].links.map((link) => link.documentPath), ['Report.md', 'Memo.md']);

  // Each link says where it is written, what it cites and what Lasso found, as recorded.
  const [changed] = linkReviewItems([{
    id: 'dependency-1', projectId: 'doc', documentPath: 'Memo.docx', status: 'STALE', spanText: '400',
    statusDetails: { linkedSourceValue: '400', currentSourceValue: '450' },
    source: { projectId: 'src', path: 'Budget.xlsx', label: 'Supplies · Current Period', valueText: '400',
      anchor: { kind: 'table-cell', sheet: 'Accounting', rowIndex: 18, columnIndex: 1, rowKey: 'Supplies' } },
  }], (directoryId, filePath) => `${directoryId}:${filePath}`);
  assert.deepEqual(changed.links, [{
    id: 'dependency-1', status: 'STALE', documentDirectoryId: 'doc', documentPath: 'Memo.docx', documentFileId: 'doc:Memo.docx',
    text: '400', label: 'Supplies · Current Period', linkedValue: '400', currentValue: '450',
    anchor: { kind: 'table-cell', sheet: 'Accounting', rowIndex: 18, columnIndex: 1, rowKey: 'Supplies' }, issue: null,
  }]);
  const [unverified] = linkReviewItems([{
    id: 'dependency-2', projectId: 'doc', documentPath: 'Memo.docx', status: 'NEEDS_REVIEW', spanText: 'supplies',
    statusDetails: { anchorIssue: 'Document no longer exists.', sourceIssue: 'Re-point the claim.' },
    source: { projectId: 'src', path: 'Budget.xlsx', label: 'Supplies', valueText: '400', anchor: null },
  }], () => null);
  assert.equal(unverified.links[0].issue, 'Document no longer exists. Re-point the claim.');
  assert.equal(unverified.links[0].currentValue, null, 'no current value is shown that Lasso did not find');
  const reading = readingReviewItems('src', [
    { path: 'Locked.xlsx', code: 'UNREADABLE_CONTENT', reason: 'The workbook is password protected.' },
    { path: 'Part.f3d', code: 'UNSUPPORTED_FORMAT', reason: 'Not read.' },
  ], () => null);
  assert.deepEqual(reading.map((item) => item.path), ['Locked.xlsx']);
});

test('the sheet view shows each cell as the sheet does, with the row numbers beside it', () => {
  const view = spreadsheetView(workbook('Accounting', {
    4: ['Supplies', '400', '', '493.30000000000018'],
    6: ['TOTAL', '47400'],
  }));
  assert.deepEqual(view.sheets.map((sheet) => sheet.name), ['Accounting']);
  const [sheet] = view.sheets;
  assert.equal(sheet.columns, 4);
  assert.deepEqual(sheet.rows[0], ['Supplies', '400', '', '493.3'], 'stored floating-point residue is not shown');
  assert.deepEqual(sheet.rowNumbers, sheet.rows.map((_, index) => [4, 6][index]), 'rows keep the numbers the app shows');
  assert.equal(sheet.truncated, false);
  assert.equal(shownCell('$129,950', '129950'), '$129,950', 'a formatted value is shown as the sheet formats it');
  assert.equal(shownCell(null, '0.5'), '0.5');
  assert.equal(shownCell(null, null), '');
  assert.deepEqual(spreadsheetView(Buffer.from('not a workbook')).sheets, []);
});

async function library(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-ranch-'));
  const finance = path.join(sandbox, 'Finance');
  const models = path.join(sandbox, 'Models');
  fs.mkdirSync(finance);
  fs.mkdirSync(models);
  fs.writeFileSync(path.join(finance, 'Income-Statement.csv'), 'Account,Actual\nRevenue,485000\nNet income,48000\n');
  fs.writeFileSync(path.join(finance, 'Bracket.csv'), 'Item,Cost\nBracket,12\n');
  fs.writeFileSync(path.join(models, 'Bracket.step'), bracketPart());
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false, port: 0 });
  await app.workspace.add([fs.realpathSync(finance), fs.realpathSync(models)], actor);
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const directory = (name) => app.workspace.state().directories.find((entry) => entry.name === name);
  return { app, finance: fs.realpathSync(finance), financeId: directory('Finance').id, modelsId: directory('Models').id };
}

test('the overview lists every directory and file with use, links, history and connections', async (t) => {
  // Arrange
  const { app, finance, financeId, modelsId } = await library(t);
  const target = app.ranch.shareTarget({ directoryId: financeId, path: 'Income-Statement.csv' });
  const share = app.objectShares.createShare({ projectId: financeId, objectId: target.objectId,
    versionId: target.versionId, actor });
  app.dependencies.recordRecommendationUsage(financeId, { path: 'Income-Statement.csv', kind: 'accept', sessionId: 'ranch' });
  fs.writeFileSync(path.join(finance, 'Notes.md'),
    `# Notes\nTotals come from Income-Statement.csv.\nFrom Sam: ${FOREIGN_LINK}\nMine: ${share.url}\n`);
  app.timeline.capture(financeId, actor);

  // Act
  const overview = app.ranch.overview();

  // Assert
  const byName = new Map(overview.sources.map((source) => [source.name, source]));
  assert.deepEqual(overview.directories.map((entry) => [entry.name, entry.kind]), [['Finance', 'folder'], ['Models', 'folder']]);
  assert.ok(overview.directories.every((entry) => entry.lastEditedAt && entry.createdAt));
  assert.equal(overview.directories.find((entry) => entry.id === financeId).lastUsedAt !== null, true);
  const statement = byName.get('Income-Statement.csv');
  assert.equal(statement.counts.tabs, 1);
  assert.equal(statement.counts.shares, 1);
  assert.equal(statement.activity, 1);
  assert.ok(statement.lastUsedAt);
  assert.equal(byName.get('Bracket.step').kind, 'model');
  assert.equal(byName.get('Bracket.step').activity, 0);
  assert.deepEqual(overview.links.outgoing.map((link) => [link.fileId, link.status, link.url]),
    [[statement.id, 'active', share.url]]);
  assert.deepEqual(overview.links.received.map((link) => [link.url, link.fileId]), [[FOREIGN_LINK, byName.get('Notes.md').id]]);
  const edges = overview.network.edges.map((edge) => [edge.kind, [edge.from, edge.to].sort().join('|')]);
  assert.ok(edges.some(([kind, pair]) => kind === 'mention'
    && pair === [byName.get('Notes.md').id, statement.id].sort().join('|')), 'Notes.md names the statement');
  assert.ok(edges.some(([kind, pair]) => kind === 'same-name'
    && pair === [byName.get('Bracket.csv').id, byName.get('Bracket.step').id].sort().join('|')), 'one bracket, two files');
  assert.deepEqual(overview.history.filter((entry) => entry.change === 'directory-added').map((entry) => entry.directoryId).sort(),
    [financeId, modelsId].sort());
  assert.ok(overview.history.some((entry) => entry.change === 'added' && entry.path === 'Notes.md'
    && entry.fileId === byName.get('Notes.md').id));
  assert.equal(app.ranch.overview(), overview, 'an unchanged library is read once');
  assert.equal(statement.activeShares, 1, 'a working link marks the file as shared');

  // Stopping the link keeps it counted as use, but the file is no longer shared.
  app.objectShares.revokeShare(share.token);
  const after = app.ranch.overview().sources.find((source) => source.name === 'Income-Statement.csv');
  assert.equal(after.activeShares, 0);
  assert.equal(after.counts.shares, 1);
});

test('a capture that changed many files is one history row, so two weeks still fit', async (t) => {
  const { app, finance, financeId } = await library(t);
  for (let index = 0; index < 30; index += 1) fs.writeFileSync(path.join(finance, `Export-${index}.csv`), `Row,${index}\n`);
  app.timeline.capture(financeId, actor);
  fs.writeFileSync(path.join(finance, 'Bracket.csv'), 'Item,Cost\nBracket,13\n');
  app.timeline.capture(financeId, actor);

  const history = app.ranch.overview().history.filter((entry) => entry.directoryId === financeId);

  assert.deepEqual(history.map((entry) => [entry.change, entry.path ?? null, entry.fileCount ?? null]), [
    ['edited', 'Bracket.csv', null],
    ['many', null, 30],
    ['directory-added', null, 2],
  ]);
  assert.equal(app.ranch.overview().historyTruncated, false);
});

test('visits count once per half hour and brighten the file', async (t) => {
  const { app, financeId } = await library(t);
  let now = Date.parse('2026-10-20T09:00:00.000Z');
  app.ranch.now = () => now;
  const visit = () => app.ranch.recordVisit({ directoryId: financeId, path: 'Bracket.csv' });
  assert.equal(visit().visits, 1);
  now += 60_000;
  assert.equal(visit().visits, 1, 'a second click a minute later is the same visit');
  now += VISIT_SESSION_MS;
  assert.equal(visit().visits, 2);
  const bracket = app.ranch.overview().sources.find((source) => source.name === 'Bracket.csv');
  assert.equal(bracket.counts.visits, 2);
  assert.equal(bracket.activity, 1);
  assert.throws(() => app.ranch.recordVisit({ directoryId: financeId, path: 'Gone.csv' }), /not in the directory/);
  assert.throws(() => app.ranch.recordVisit({ directoryId: financeId }), /Choose a file/);
});

test('the Ranch routes answer the Mac app and keep file copies out of the page origin', async (t) => {
  const { app, financeId } = await library(t);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const query = `directory=${encodeURIComponent(financeId)}&path=${encodeURIComponent('Bracket.csv')}`;

  const overview = await fetch(`${base}/api/ranch`);
  assert.equal(overview.status, 200);
  assert.equal((await overview.json()).sources.length, 3);
  const tag = overview.headers.get('etag');
  assert.ok(tag, 'the overview carries a tag');
  const unchanged = await fetch(`${base}/api/ranch`, { headers: { 'if-none-match': tag } });
  assert.equal(unchanged.status, 304, 'an unchanged library is not sent again');

  const visit = await fetch(`${base}/api/ranch/visits`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ directoryId: financeId, path: 'Bracket.csv' }) });
  assert.equal((await visit.json()).visit.visits, 1);
  const crossSite = await fetch(`${base}/api/ranch/visits`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ directoryId: financeId, path: 'Bracket.csv' }) });
  assert.equal(crossSite.status, 403);

  const target = await fetch(`${base}/api/ranch/share-target?${query}`);
  assert.equal((await target.json()).target.path, 'Bracket.csv');

  const copy = await fetch(`${base}/api/ranch/file?${query}`);
  assert.equal(copy.status, 200);
  assert.equal(copy.headers.get('content-type'), 'application/octet-stream');
  assert.match(copy.headers.get('content-disposition'), /attachment/);
  assert.equal(await copy.text(), 'Item,Cost\nBracket,12\n');

  const missing = await fetch(`${base}/api/ranch/file?directory=${encodeURIComponent(financeId)}`);
  assert.equal(missing.status, 400);

  const notAWorkbook = await fetch(`${base}/api/ranch/sheet?${query}`);
  assert.deepEqual((await notAWorkbook.json()).sheets, [], 'a file that is not a workbook has no sheets to show');
});
