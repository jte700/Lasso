// Reviews in The Ranch: a folder's changes since it was last approved, shown
// file by file the way each kind reads best, with comments and suggested
// changes pinned beside them, suggestions applied as the person's own edit,
// changes asked of an AI recorded as the AI's, files marked as looked at, and
// the approval that closes the review.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSpreadsheetTables } from '../src/dependencies/document-extraction.js';
import { readZip, zipBytes } from '../src/dependencies/zip-archive.js';
import { createApplication } from '../src/server.js';
import { textPdf } from './fixtures/pdf.js';
import { storedZip } from './fixtures/workbook.js';

const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const me = { id: 'human:desktop', displayName: 'Desktop', actorType: 'HUMAN_SELF' };
const dana = { id: 'human:dana', displayName: 'Dana Walker', actorType: 'HUMAN_SELF' };

const CODE = ['export const MAX_ATTEMPTS = 8;', 'const BASE_DELAY_MS = 30_000;', '', 'export function nextDelay(attempt) {',
  '  const ceiling = BASE_DELAY_MS * 2 ** (attempt - 1);', '  return Math.round(Math.random() * ceiling);', '}', ''].join('\n');

/** An income statement: two inputs and a formula total above them. */
const statement = (product, parts = {}) => storedZip({
  'xl/workbook.xml': '<workbook><sheets><sheet name="Accounting" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml': `<worksheet><sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>Line</t></is></c><c r="B1" t="inlineStr"><is><t>Current Period</t></is></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>Revenue</t></is></c><c r="B2"><f>B3+B4</f><v>${product + 6200}</v></c></row>
    <row r="3"><c r="A3" t="inlineStr"><is><t>Product 1</t></is></c><c r="B3" s="2"><v>${product}</v></c></row>
    <row r="4"><c r="A4" t="inlineStr"><is><t>Product 2</t></is></c><c r="B4"><v>6200</v></c></row>
  </sheetData></worksheet>`,
  ...parts,
});

function folder(t, { reply = null } = {}) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-review-')));
  const root = path.join(sandbox, 'Webhooks');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'backoff.ts'), CODE);
  fs.writeFileSync(path.join(root, 'statement.xlsx'), statement(4000));
  fs.writeFileSync(path.join(root, 'crew.csv'), 'Name,Hours\nAda,8\nBo,6\n');
  const launcher = path.join(sandbox, 'codex');
  fs.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CODEX}" "$@"\n`, { mode: 0o755 });
  const replyFile = path.join(sandbox, 'reply.json');
  if (reply) fs.writeFileSync(replyFile, JSON.stringify(reply));
  const before = process.env.FAKE_CODEX_REPLY_FILE;
  process.env.FAKE_CODEX_REPLY_FILE = replyFile;
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false, codexPath: launcher });
  t.after(async () => {
    await app.close();
    if (before === undefined) delete process.env.FAKE_CODEX_REPLY_FILE; else process.env.FAKE_CODEX_REPLY_FILE = before;
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const project = app.timeline.importProject(root, me, { watch: false }).project;
  app.dependencies.ensureIndex(project.id);
  const save = (name, content, who = dana) => {
    fs.writeFileSync(path.join(root, name), content);
    app.timeline.capture(project.id, who);
    app.dependencies.ensureIndex(project.id);
  };
  const read = (name) => fs.readFileSync(path.join(root, name));
  return { app, id: project.id, root, save, read, reviews: app.reviews, replyFile };
}

test('A folder\'s review lists what changed since it was first read, and a text file shows its changed lines with three around them', (t) => {
  // Arrange
  const { reviews, id, save } = folder(t);
  save('backoff.ts', CODE.replace('2 ** (attempt - 1);', 'Math.min(2 ** (attempt - 1), 30);'));

  // Act
  const review = reviews.summary(id, me.id);
  const file = reviews.file(id, 'backoff.ts', me.id);

  // Assert
  assert.equal(review.state, 'open');
  assert.deepEqual(review.files.map((item) => [item.path, item.change, item.kind]), [['backoff.ts', 'edited', 'lines']]);
  assert.deepEqual(review.people.map((person) => person.name), ['Dana Walker']);
  assert.equal(file.code, true, 'code is shown in a code face');
  assert.deepEqual(file.lines.hunks[0].lines.map((line) => [line.kind, line.before, line.after]), [
    ['same', 2, 2], ['same', 3, 3], ['same', 4, 4], ['remove', 5, null], ['add', null, 5], ['same', 6, 6], ['same', 7, 7],
  ]);
});

test('Loading a folder, and files added or removed many at once, put nothing up for review; a file someone edits does', (t) => {
  // Arrange
  const { app, reviews, id, root, save } = folder(t);
  for (let index = 0; index < 30; index += 1) fs.writeFileSync(path.join(root, `part-${index}.txt`), `Part ${index}\n`);
  app.timeline.capture(id, dana);
  const afterBatch = reviews.summary(id, me.id);
  save('notes.txt', 'A new note.\n');
  const afterNewFile = reviews.summary(id, me.id);
  for (let index = 0; index < 30; index += 1) fs.rmSync(path.join(root, `part-${index}.txt`));
  app.timeline.capture(id, dana);

  // Act
  save('crew.csv', 'Name,Hours\nAda,9\nBo,6\n');
  const review = reviews.summary(id, me.id);

  // Assert
  assert.deepEqual([afterBatch.state, afterBatch.files.length], ['empty', 0], 'a folder copied in is not an edit');
  assert.equal(afterNewFile.files.length, 0, 'nor is a new file');
  assert.deepEqual(review.files.map((file) => [file.path, file.change]), [['crew.csv', 'edited']]);
  assert.deepEqual(review.people.map((person) => person.name), ['Dana Walker'], 'only the people who edited are named');
  assert.equal(review.saves, 1);
});

test('A file edited after it arrived is compared with how it read before the edit, not with nothing', (t) => {
  // Arrange
  const { reviews, id, save } = folder(t);
  save('notes.txt', 'First line.\nSecond line.\n');

  // Act
  save('notes.txt', 'First line.\nSecond line, reworded.\n');
  const file = reviews.file(id, 'notes.txt', me.id);

  // Assert
  assert.equal(file.change, 'edited');
  assert.deepEqual(file.lines.hunks[0].lines.map((line) => line.kind), ['same', 'remove', 'add']);
});

test('A change requested on a file no one edited puts it up for review, with its lines to comment on', (t) => {
  // Arrange
  const { reviews, id } = folder(t);
  const line = 'const BASE_DELAY_MS = 30_000;';

  // Act
  const { threadId } = reviews.comment(id, { path: 'backoff.ts', anchor: { kind: 'line', line: 2, text: line },
    body: 'Start at 10 seconds', suggestion: { before: line, after: 'const BASE_DELAY_MS = 10_000;' } }, dana);
  const review = reviews.summary(id, me.id);
  const file = reviews.file(id, 'backoff.ts', me.id);
  reviews.resolve(threadId, true, me);
  const settled = reviews.summary(id, me.id);

  // Assert
  assert.deepEqual([review.state, review.requests], ['open', 1]);
  assert.deepEqual(review.files.map((item) => [item.path, item.change]), [['backoff.ts', 'unchanged']]);
  assert.equal(file.change, 'unchanged');
  assert.deepEqual(file.lines.hunks[0].lines.slice(0, 2).map((item) => [item.kind, item.after]), [['same', 1], ['same', 2]], 'its lines are there to comment on');
  assert.deepEqual(file.threads[0].position, { line: 2 });
  assert.deepEqual([settled.state, settled.files.length], ['empty', 0], 'a settled request leaves the review');
});

test('A comment is pinned to its line, follows it when lines move, and is pending until the folder is approved', (t) => {
  // Arrange
  const { reviews, id, save } = folder(t);
  save('backoff.ts', CODE.replace('const BASE', 'const BASE_RETRY = 3;\nconst BASE'));
  const line = 6;
  const text = '  const ceiling = BASE_DELAY_MS * 2 ** (attempt - 1);';

  // Act
  reviews.comment(id, { path: 'backoff.ts', anchor: { kind: 'line', line, text }, body: 'Ship it' }, me);
  save('backoff.ts', `// Retries\n${CODE.replace('const BASE', 'const BASE_RETRY = 3;\nconst BASE')}`);
  const moved = reviews.file(id, 'backoff.ts', me.id).threads[0];
  const approved = reviews.approve(id, me).review;
  const sent = reviews.file(id, 'backoff.ts', me.id).threads[0];
  const undone = reviews.undo(id, approved.approval.id, me).review;

  // Assert
  assert.deepEqual([moved.state, moved.position, moved.place, moved.pending], ['open', { line: 7 }, 'Line 7', true]);
  assert.deepEqual([approved.state, approved.approval.comments], ['approved', 1], 'the approval says it sent one comment');
  assert.equal(sent.pending, false);
  assert.equal(undone.state, 'open');
  assert.equal(reviews.file(id, 'backoff.ts', me.id).threads[0].pending, true, 'taking the approval back makes it pending again');
});

test('Applying a suggested line writes it into the file as the person\'s own edit, and the thread reads as applied', (t) => {
  // Arrange
  const { app, reviews, id, save, read } = folder(t);
  save('backoff.ts', CODE.replace('MAX_ATTEMPTS = 8', 'MAX_ATTEMPTS = 9'));
  const before = '  const ceiling = BASE_DELAY_MS * 2 ** (attempt - 1);';
  const after = '  const ceiling = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), 15 * 60_000);';
  const { threadId } = reviews.comment(id, { path: 'backoff.ts', anchor: { kind: 'line', line: 5, text: before },
    body: 'Can we hold the ceiling at 15 minutes?', suggestion: { before, after } }, dana);

  // Act
  const { file } = reviews.apply(threadId, me);

  // Assert
  assert.equal(read('backoff.ts').toString('utf8').split('\n')[4], after);
  const thread = file.threads.find((item) => item.id === threadId);
  assert.deepEqual([thread.state, thread.applied.by.id, thread.position], ['applied', me.id, { line: 5 }]);
  const [newest] = app.ranch.overview().history;
  assert.deepEqual([newest.path, newest.source, newest.actor.name], ['backoff.ts', 'DOCUMENT_CHANGE', 'Desktop']);
});

test('A workbook\'s changes are a grid of its rows around each change, with formula cells marked as recalculated', (t) => {
  // Arrange
  const { reviews, id, save } = folder(t);

  // Act
  save('statement.xlsx', statement(5000));
  const file = reviews.file(id, 'statement.xlsx', me.id);

  // Assert
  assert.equal(file.kind, 'sheet');
  assert.equal(file.writable, true);
  const [sheet] = file.sheet.sheets;
  assert.equal(sheet.name, 'Accounting');
  const [hunk] = sheet.hunks;
  assert.deepEqual(hunk.columns.map((column) => column.letter), ['A', 'B']);
  const cells = Object.fromEntries(hunk.rows.map((row) => [row.number, row.cells[1]]));
  assert.deepEqual(cells[3], { value: '5000', before: '4000', changed: true });
  assert.deepEqual(cells[2], { value: '11200', before: '10200', changed: true, recalculated: true });
  assert.deepEqual(file.sheet.counts, { cells: 2, recalculated: 1, rowsAdded: 0, rowsRemoved: 0 });
});

test('A row inserted into a sheet is one added row, not a change to every row below it', (t) => {
  // Arrange
  const { reviews, id, save } = folder(t);

  // Act
  save('crew.csv', 'Name,Hours\nCy,4\nAda,8\nBo,6\n');
  const file = reviews.file(id, 'crew.csv', me.id);

  // Assert
  const rows = file.sheet.sheets[0].hunks[0].rows;
  assert.deepEqual(rows.map((row) => [row.number, row.kind]), [[1, 'same'], [2, 'added'], [3, 'same'], [4, 'same']]);
  assert.deepEqual(file.sheet.counts, { cells: 0, recalculated: 0, rowsAdded: 1, rowsRemoved: 0 });
});

test('A suggested cell is written into an .xlsx and a CSV, keeping the cell\'s style; a formula cell is never overwritten', (t) => {
  // Arrange
  const { reviews, id, save, read } = folder(t);
  save('statement.xlsx', statement(5000));
  save('crew.csv', 'Name,Hours\nAda,9\nBo,6\n');
  const cell = (row, column, value, sheet = 'Accounting') => ({ kind: 'cell', sheet, row, column, value });
  const workbook = reviews.comment(id, { path: 'statement.xlsx', anchor: cell(3, 1, '5000'), body: 'Should be 5,250',
    suggestion: { before: '5000', after: '5250' } }, dana).threadId;
  const csv = reviews.comment(id, { path: 'crew.csv', anchor: cell(3, 1, '6', 'crew.csv'), body: 'Bo did 7',
    suggestion: { before: '6', after: '7' } }, dana).threadId;
  const formula = reviews.comment(id, { path: 'statement.xlsx', anchor: cell(2, 1, '11200'), body: 'Round it',
    suggestion: { before: '11200', after: '11000' } }, dana).threadId;

  // Act
  reviews.apply(workbook, me);
  reviews.apply(csv, me);

  // Assert
  const [sheet] = extractSpreadsheetTables(read('statement.xlsx'));
  assert.equal(sheet.rows[2][1], '5250');
  const sheetXml = zipBytes(readZip(read('statement.xlsx')).get('xl/worksheets/sheet1.xml'), 1e6).toString('utf8');
  assert.match(sheetXml, /<c r="B3" s="2"><v>5250<\/v><\/c>/, 'the cell keeps its style');
  const workbookXml = zipBytes(readZip(read('statement.xlsx')).get('xl/workbook.xml'), 1e6).toString('utf8');
  assert.match(workbookXml, /<calcPr fullCalcOnLoad="1"\/>/, 'Excel works the formulas out again on opening');
  assert.equal(read('crew.csv').toString('utf8'), 'Name,Hours\nAda,9\nBo,7\n');
  assert.throws(() => reviews.apply(formula, me), /B2 holds a formula/);
});

test('A suggestion reads as applied once a save makes the file read as it suggested; one for a file Lasso cannot write is left to its app', (t) => {
  // Arrange
  const { reviews, id, save } = folder(t);
  save('crew.csv', 'Name,Hours\nAda,9\nBo,6\n');
  save('statement.xls', Buffer.from('not really a workbook'));
  const bo = reviews.comment(id, { path: 'crew.csv', anchor: { kind: 'cell', sheet: 'crew.csv', row: 3, column: 1, value: '6' },
    body: 'Bo did 7', suggestion: { before: '6', after: '7' } }, me).threadId;
  const legacy = reviews.comment(id, { path: 'statement.xls', anchor: { kind: 'file' }, body: 'Update the template',
    suggestion: { before: null, after: 'x' } }, dana).threadId;

  // Act
  save('crew.csv', 'Name,Hours\nAda,9\nBo,7\n');
  const thread = reviews.file(id, 'crew.csv', me.id).threads.find((item) => item.id === bo);

  // Assert
  assert.deepEqual([thread.state, thread.applied.saved], ['applied', true]);
  assert.throws(() => reviews.apply(legacy, me), /can\u2019t write this kind of file/);
});

test('A backslash prompt has ChatGPT change the line, recorded as its edit, asked for by the person, with their words', async (t) => {
  // Arrange
  const after = '  const ceiling = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), 15 * 60_000);';
  const { app, reviews, id, save, read } = folder(t, { reply: { summary: 'Capped the ceiling at 15 minutes.', edits: [{ from: 5, to: 5, lines: [after] }] } });
  save('backoff.ts', CODE.replace('MAX_ATTEMPTS = 8', 'MAX_ATTEMPTS = 9'));
  const before = '  const ceiling = BASE_DELAY_MS * 2 ** (attempt - 1);';

  // Act
  const { threadId, file } = await reviews.ask(id, { path: 'backoff.ts', anchor: { kind: 'line', line: 5, text: before },
    prompt: '\\ cap the ceiling at 15 minutes' }, me);

  // Assert
  assert.equal(read('backoff.ts').toString('utf8').split('\n')[4], after);
  const thread = file.threads.find((item) => item.id === threadId);
  const [asked, answered] = thread.comments;
  assert.deepEqual([asked.author.id, asked.prompt, asked.body], [me.id, 'cap the ceiling at 15 minutes', 'cap the ceiling at 15 minutes']);
  assert.deepEqual([answered.author.name, answered.author.type, answered.initiatedBy.id, answered.body],
    ['ChatGPT', 'AI_AGENT', me.id, 'Capped the ceiling at 15 minutes.']);
  assert.deepEqual(answered.suggestion, { before, after });
  assert.deepEqual([thread.state, thread.applied.by.name, thread.position], ['applied', 'ChatGPT', { line: 5 }]);
  const [newest] = app.ranch.overview().history;
  const detail = app.ranch.change({ id: newest.id });
  assert.deepEqual([detail.source, detail.actor.name, detail.initiatedBy.name, detail.request],
    ['AGENT_EDIT', 'ChatGPT', 'Desktop', 'cap the ceiling at 15 minutes']);
});

test('A backslash prompt on a workbook cell has ChatGPT set the cell, and never a formula', async (t) => {
  // Arrange
  const { reviews, id, save, read, replyFile } = folder(t, { reply: { summary: 'Set Product 1 to 5,500.', cells: [{ cell: 'B3', value: '5500' }] } });
  save('statement.xlsx', statement(5000));
  const anchor = { kind: 'cell', sheet: 'Accounting', row: 3, column: 1, value: '5000' };

  // Act
  const { file } = await reviews.ask(id, { path: 'statement.xlsx', anchor, prompt: '\\ make it 5,500' }, me);
  fs.writeFileSync(replyFile, JSON.stringify({ summary: 'Rounded revenue.', cells: [{ cell: 'B2', value: '11000' }] }));
  const refused = reviews.ask(id, { path: 'statement.xlsx', anchor, prompt: '\\ round revenue' }, me);

  // Assert
  assert.equal(extractSpreadsheetTables(read('statement.xlsx'))[0].rows[2][1], '5500');
  const answered = file.threads[0].comments.at(-1);
  assert.deepEqual([answered.author.name, answered.suggestion], ['ChatGPT', { before: '5000', after: '5500' }]);
  await assert.rejects(refused, /B2, which holds a formula/);
});

test('A PDF\'s changes are its passages, and a backslash prompt there leaves ChatGPT\'s wording as a suggestion', async (t) => {
  // Arrange
  const { reviews, id, save, read } = folder(t, { reply: { summary: 'Reworded the finding.', text: 'Soil was damp after two days of rain.' } });
  save('site.pdf', textPdf('Soil was dry at the east trench.'));
  reviews.approve(id, me);
  save('site.pdf', textPdf('Soil was damp at the east trench.'));
  const bytes = read('site.pdf');

  // Act
  const file = reviews.file(id, 'site.pdf', me.id);
  const value = file.values.find((candidate) => candidate.kind === 'modified');
  const { file: asked } = await reviews.ask(id, { path: 'site.pdf', anchor: { kind: 'value', place: value.place, label: value.label, value: value.after },
    prompt: '\\ say it rained for two days' }, me);

  // Assert
  assert.deepEqual([file.kind, file.writable, value.kind, value.place], ['values', false, 'modified', 'Page 1']);
  assert.match(value.before, /dry/);
  assert.match(value.after, /damp/);
  const thread = asked.threads[0];
  assert.deepEqual([thread.state, thread.comments.at(-1).suggestion.after], ['open', 'Soil was damp after two days of rain.'],
    'the suggestion waits to be made in the file\'s own app');
  assert.deepEqual(read('site.pdf'), bytes, 'the PDF is untouched');
});

test('A workbook written again with no cell changed is not in the review, and a file looked at is looked at again after its next save', (t) => {
  // Arrange
  const { reviews, id, save } = folder(t);
  save('statement.xlsx', statement(4000, { 'docProps/app.xml': '<Properties/>' }));
  save('crew.csv', 'Name,Hours\nAda,9\nBo,6\n');

  // Act
  const listed = reviews.summary(id, me.id).files.map((file) => file.path);
  reviews.viewed(id, 'crew.csv', true, me);
  const looked = reviews.summary(id, me.id).files[0].viewed;
  save('crew.csv', 'Name,Hours\nAda,10\nBo,6\n');
  const again = reviews.summary(id, me.id).files[0].viewed;

  // Assert
  assert.deepEqual(listed, ['crew.csv']);
  assert.deepEqual([looked, again], [true, false]);
});

test('The review routes list folders, start a thread and approve over HTTP', async (t) => {
  // Arrange
  const { app, id, save } = folder(t);
  save('crew.csv', 'Name,Hours\nAda,9\nBo,6\n');
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then((response) => response.json());

  // Act
  const { folders } = await fetch(`${base}/api/reviews`).then((response) => response.json());
  const started = await post(`/api/reviews/${id}/threads`, { path: 'crew.csv', anchor: { kind: 'cell', sheet: 'crew.csv', row: 2, column: 1, value: '9' }, body: 'Check this' });
  const { review } = await post(`/api/reviews/${id}/approve`, {});
  await new Promise((resolve) => app.server.close(resolve));

  // Assert
  assert.deepEqual(folders.map((item) => [item.name, item.files, item.state]), [['Webhooks', 1, 'open']]);
  assert.deepEqual([started.file.threads[0].place, started.file.threads[0].comments[0].body], ['B2', 'Check this']);
  assert.deepEqual([review.state, review.approval.comments, review.approval.by.name], ['approved', 1, 'Desktop']);
});
