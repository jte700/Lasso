import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { createApplication } from '../src/server.js';
import { largeWorkbook, workbook } from './fixtures/workbook.js';
import { extractSpreadsheetTables, isLargeSpreadsheet, streamSpreadsheetRows } from '../src/dependencies/document-extraction.js';
import { delimitedRows, parseDelimited } from '../src/history/diff.js';
import { rowTerms } from '../src/dependencies/table-index.js';

const actor = { id: 'human:table-index', displayName: 'Table index', actorType: 'HUMAN_SELF' };
const provinces = ['Ontario', 'Quebec', 'Alberta', 'Manitoba', 'Nova Scotia', 'British Columbia'];
// Its worksheet is past the 5 MB the in-memory reader holds at once.
const ROWS = 50_000;
const deathsOf = (row) => (row * 7) % 5000 + 1;
const deaths = (rows = ROWS, changed = () => null) => largeWorkbook('Deaths', ['Region', 'Deaths', 'Rate'], rows,
  (row) => [`${provinces[row % 6]} district ${row}`, changed(row) ?? deathsOf(row), (row % 97) / 10]);

function sandbox(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-table-index-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function mortality(t, files = { 'deaths.xlsx': deaths() }) {
  const root = sandbox(t);
  const folder = path.join(root, 'Mortality');
  fs.mkdirSync(folder);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(folder, name), content);
  const dataDir = path.join(root, 'history');
  const app = createApplication({ dataDir, watchProjects: false });
  t.after(() => app.close());
  return { app, folder, dataDir };
}

const typed = (app, text, pendingDependencies = []) => app.workspace.predict({
  text, cursor: text.length, blockIndex: 0, ...(pendingDependencies.length ? { pendingDependencies } : {}),
});
const named = (prediction) => prediction.claims.flatMap((claim) => claim.candidates);

test('a worksheet streamed a batch of rows at a time reads as the in-memory reader reads it', async () => {
  for (const buffer of [
    workbook('Budget', { 1: ['Account', 'Amount'], 2: ['Rent', '1200'], 4: ['Supplies', '80'] }),
    largeWorkbook('Deaths', ['Region', 'Deaths'], 900, (row) => [`${provinces[row % 6]} & co ${row}`, row]),
  ]) {
    const [sheet] = extractSpreadsheetTables(buffer);
    const rows = [];
    const rowNumbers = [];
    const read = await streamSpreadsheetRows(buffer, {
      onSheet: () => {}, onSheetEnd: () => {},
      onRows: (batch, numbers) => { rows.push(...batch); rowNumbers.push(...numbers); },
    });
    assert.deepEqual(read, { sheets: [sheet.name], skipped: [] });
    assert.deepEqual(rows, sheet.rows);
    assert.deepEqual(rowNumbers, sheet.rowNumbers);
  }
  assert.equal(isLargeSpreadsheet(deaths()), true);
  assert.deepEqual(extractSpreadsheetTables(deaths()), [], 'the in-memory reader cannot hold this sheet');
});

test('a delimited file read in pieces gives the rows of the whole text, wherever the pieces are cut', () => {
  for (const text of ['a,b\n1,2\n', 'a,"b""c",d\n"x\ny",2', '"q"""\n,\n', 'x,"', '"a""","b"\r\n1,2\r\n', '""""', '']) {
    const whole = parseDelimited(text, ',', { detect: false });
    for (let size = 1; size <= Math.max(1, text.length); size += 1) {
      const reader = delimitedRows(',');
      const rows = [];
      for (let index = 0; index < text.length; index += size) reader.write(text.slice(index, index + size), rows);
      assert.deepEqual(reader.end(rows), whole, `${JSON.stringify(text)} in pieces of ${size}`);
    }
  }
});

test('a row is found by its name, from any word of it, and by its numbered reference', () => {
  const terms = rowTerms('Ontario, Males 2019');
  for (const term of ['ontariomales2019', 'males2019', '2019']) assert.ok(terms.includes(term), term);
  assert.ok(rowTerms('Control 3').includes('con3'));
  assert.deepEqual(rowTerms(''), []);
});

test('a workbook too large to read in memory is indexed whole, off the server thread, with its progress', async (t) => {
  const { app, folder } = await mortality(t);
  const percents = [];
  let polls = 0;
  let reading = true;
  const poller = (async () => {
    while (reading) {
      const [directory] = app.workspace.state({ pending: true }).directories;
      if (directory?.indexing) percents.push(directory.indexing.percent);
      polls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  const state = await app.workspace.add([folder], actor);
  reading = false;
  await poller;

  assert.ok(polls > 20, `the server answered while the workbook was read (${polls} polls)`);
  assert.ok(new Set(percents).size > 10, 'the bar moves a percent at a time through the read');
  assert.deepEqual(percents, [...percents].sort((left, right) => left - right));
  const [directory] = state.directories;
  assert.equal(directory.issue, null);
  assert.equal(directory.note, null, 'nothing about the workbook was left unread');
  const objects = app.dependencies.objectsAt(directory.id);
  assert.equal(objects.find((object) => object.metadata.metric === 'row-count').valueText, `n = ${ROWS}`,
    'the row count is the whole table');
  assert.ok(objects.length < 3_000, `history keeps only the first rows as objects (${objects.length})`);
  const [table] = app.dependencies.tables.sheets(app.timeline.snapshotFiles(directory.currentSnapshotId)[0].contentHash);
  assert.equal(table.rowCount, ROWS + 1, 'every row, with its header, is in the table index');
});

test('naming a row deep in a large table is a bounded lookup in the table index', async (t) => {
  const { app, folder } = await mortality(t);
  const [{ id }] = (await app.workspace.add([folder], actor)).directories;
  const searches = t.mock.method(app.dependencies.tables, 'search');
  const prediction = await typed(app, 'The deaths in Quebec district 30001');
  const [row] = named(prediction);
  assert.equal(row.label, 'Quebec district 30001');
  assert.equal(row.objectType, 'DATASET_ROW');
  const file = app.timeline.snapshotFiles(app.timeline.getProject(id).currentSnapshotId)[0];
  assert.equal(app.db.prepare('SELECT object_key FROM scientific_objects WHERE id = ?').get(row.id).object_key,
    `${file.projectFileId}:xlsx-v2:sheet:Deaths:row:quebecdistrict30001`,
    'the row has the key the indexer would have given it');
  assert.ok(searches.mock.calls.every((call) => call.arguments[2] <= 12), 'each lookup is bounded');
  assert.ok(app.dependencies.studyVariables(id).length < 3_000, 'suggestions never score every row');
  assert.equal(named(await typed(app, 'The deaths in quebec district 30002')).length, 0,
    'a row the table does not have is not invented');
});

test('an accepted column offers the value of the deep row a writer names after it', async (t) => {
  const { app, folder } = await mortality(t);
  await app.workspace.add([folder], actor);
  const opening = await typed(app, 'The Deat');
  const claim = opening.claims.find((candidate) => candidate.candidates.some((source) => source.label === 'Deaths'));
  const column = claim.candidates.find((source) => source.label === 'Deaths');
  const accepted = `The ${column.completionText ?? column.label}`;
  const link = { projectId: column.projectId, blockIndex: 0, start: claim.start, end: accepted.length,
    sourceObjectId: column.id, sourceSnapshotId: column.snapshotId };
  const values = await typed(app, `${accepted} in Manitoba district 45003 were`, [link]);
  assert.equal(values.workspaceHeading, 'Values for Deaths');
  assert.equal(values.workspaceCompletions[0].replacementText ?? values.workspaceCompletions[0].text, String(deathsOf(45003)));
});

test('a link to a deep cell survives restarts and re-reading, and goes stale when its value changes', async (t) => {
  const { app: first, folder, dataDir } = await mortality(t, { 'deaths.xlsx': deaths(), 'draft.md': 'Deaths were 8.\n' });
  const [{ id }] = (await first.workspace.add([folder], actor)).directories;
  const [row] = first.dependencies.candidatesForStudyVariable(id, { text: 'Quebec district 30001' });
  const [table] = first.dependencies.snapshotTables(id, row.snapshotId);
  const stored = first.dependencies.tables.rowNumbered(table.meta.id, row.anchor.rowIndex);
  const descriptor = first.dependencies.indexedRowObjects(table, stored).find((object) => object.metadata.column === 'Deaths');
  const [cell] = first.dependencies.indexedObjects(id, row.snapshotId, table, [descriptor]);
  assert.equal(cell.valueText, String(deathsOf(30001)));
  first.dependencies.link(id, { documentPath: 'draft.md', sourceObjectId: cell.id, sourceSnapshotId: cell.snapshotId,
    spanText: '8', anchor: { kind: 'manuscript-span', blockIndex: 0, start: 12, end: 13 } }, actor);
  await first.close();
  const statuses = (app) => app.dependencies.currentDependencies(id).map((dependency) => dependency.status);

  // A new process reads the folder with nothing carried over.
  let app = createApplication({ dataDir, watchProjects: true });
  await app.workspace.ready;
  await app.workspace.mutations;
  assert.deepEqual(statuses(app), ['LINKED']);
  assert.equal(app.dependencies.reindex(id, actor).reason, 'IDENTICAL_READING',
    'a cell read from the table index is part of the file\'s reading');
  await app.close();

  fs.writeFileSync(path.join(folder, 'deaths.xlsx'), deaths(ROWS, (row) => (row === 30001 ? 9 : null)));
  app = createApplication({ dataDir, watchProjects: true });
  t.after(() => app.close());
  await app.workspace.ready;
  await app.workspace.mutations;
  assert.deepEqual(statuses(app), ['STALE']);
});

test('a deep row previews from the table index, among the rows around it', async (t) => {
  const { app, folder } = await mortality(t);
  const [{ id }] = (await app.workspace.add([folder], actor)).directories;
  const [row] = app.dependencies.candidatesForStudyVariable(id, { text: 'Manitoba district 45003' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { preview } = await fetch(`http://127.0.0.1:${app.server.address().port}/api/dependency-objects/${row.id}/preview`)
    .then((response) => response.json());
  assert.deepEqual(preview.headers, ['Region', 'Deaths', 'Rate']);
  const cited = preview.rows.find((entry) => entry.cells.some((cell) => cell.cited));
  assert.equal(cited.rowNumber, 45005);
  assert.equal(cited.cells[0].value, 'Manitoba district 45003');
  assert.ok(preview.rows.length >= 3 && preview.rows.length <= 12, 'only the rows around it were read');
});

test('a table small enough to read in memory indexes its later rows there, without a worker', async (t) => {
  const csv = `Ward,Glucose,Lactate\n${Array.from({ length: 4_000 }, (_, row) => `Hospital ward ${row},${row % 90},${row % 7}`).join('\n')}\n`;
  const { app, folder } = await mortality(t, { 'metabolites.csv': csv });
  const workers = t.mock.method(app.dependencies.tables, 'build');
  await app.workspace.add([folder], actor);
  assert.equal(workers.mock.callCount(), 0);
  const [row] = named(await typed(app, 'Glucose on Hospital ward 3999'));
  assert.equal(row?.label, 'Hospital ward 3999');
});

test('a watcher reads a changed folder in slices and indexes its new version before anything asks', async (t) => {
  const root = sandbox(t);
  const folder = path.join(root, 'project');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'data.csv'), 'Metric,Value\nRevenue,10\n');
  let listener;
  t.mock.method(fs, 'watch', (_root, _options, callback) => { listener = callback; return { close() {}, on() {} }; });
  const app = createApplication({ dataDir: path.join(root, 'history'), watchProjects: true, watchDebounceMs: 5 });
  t.after(() => app.close());
  const [{ id }] = (await app.workspace.add([folder], actor)).directories;
  const indexedWhenHeard = [];
  app.timeline.onCapture((capture) => {
    if (capture.changed) indexedWhenHeard.push(app.dependencies.isIndexed(capture.snapshot.id));
  });
  fs.writeFileSync(path.join(folder, 'data.csv'), 'Metric,Value\nRevenue,20\n');
  listener('change', 'data.csv');
  for (let turn = 0; turn < 200 && !indexedWhenHeard.length; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await yieldTurn();
  }
  assert.deepEqual(indexedWhenHeard, [true]);
  assert.ok(app.dependencies.objectsAt(id).some((object) => object.valueText === '20'));
});

test('a reader upgrade re-reads only the kinds of file it reads differently', async (t) => {
  const csv = `Ward,Glucose\n${Array.from({ length: 50 }, (_, row) => `Ward ${row},${row}`).join('\n')}\n`;
  const { app, folder } = await mortality(t, { 'glucose.csv': csv, 'notes.md': '# Notes\n\nGlucose was measured daily.\n' });
  const [{ id }] = (await app.workspace.add([folder], actor)).directories;
  const snapshotId = app.timeline.getProject(id).currentSnapshotId;
  const before = app.dependencies.objectsAt(id).length;
  app.db.prepare('UPDATE snapshot_object_indexes SET extractor_version = 5 WHERE snapshot_id = ?').run(snapshotId);
  app.dependencies.extractionCache.clear();
  const read = t.mock.method(app.dependencies, 'extractedObjectSteps');
  const result = app.dependencies.reindex(id, actor);
  assert.deepEqual(read.mock.calls.map((call) => call.arguments[0].path), ['glucose.csv'], 'the notes are not read again');
  assert.equal(result.reason, 'IDENTICAL_READING');
  assert.equal(app.dependencies.indexFreshness(id).stale, false);
  assert.equal(app.dependencies.objectsAt(id).length, before);
});

test('a table whose rows have no names keeps its first and last rows, and counts every one', async (t) => {
  const rows = 80_000;
  // Tidy data: every column repeats its values, so none names the rows.
  const buffer = largeWorkbook('Readings', ['Year', 'Age', 'Deaths'], rows, (row) => [1990 + (row % 30), row % 90, (row * 7) % 50]);
  assert.equal(isLargeSpreadsheet(buffer), true, 'the fixture needs the streamed reader');
  const { app, folder } = await mortality(t, { 'readings.xlsx': buffer });
  const [{ id }] = (await app.workspace.add([folder], actor)).directories;
  const file = app.timeline.snapshotFiles(app.timeline.getProject(id).currentSnapshotId)[0];
  const [table] = app.dependencies.tables.sheets(file.contentHash);
  assert.equal(table.shape.searchable, false);
  assert.equal(table.rowCount, rows + 1);
  const stored = app.dependencies.tables.db.prepare('SELECT COUNT(*) AS count FROM table_rows WHERE table_id = ?').get(table.id).count;
  assert.ok(stored < 1_200, `only the first rows and the last are kept (${stored})`);
  assert.equal(app.dependencies.objectsAt(id).find((object) => object.metadata.metric === 'row-count').valueText, `n = ${rows}`);
});

test('an index records how many objects it holds as it is written', async (t) => {
  const { app, folder } = await mortality(t, { 'a.csv': 'Account,Value\nRent,10\nPower,20\n', 'b.csv': 'Account,Value\nFood,5\n' });
  const [{ id }] = (await app.workspace.add([folder], actor)).directories;
  const recorded = () => {
    const snapshotId = app.timeline.getProject(id).currentSnapshotId;
    app.dependencies.ensureIndex(id, snapshotId);
    return [app.db.prepare('SELECT object_count FROM snapshot_object_indexes WHERE snapshot_id = ?').get(snapshotId).object_count,
      app.timeline.objectVersions.count(snapshotId)];
  };
  const [first, counted] = recorded();
  assert.equal(first, counted);
  fs.writeFileSync(path.join(folder, 'a.csv'), 'Account,Value\nRent,11\nPower,20\nWater,7\n');
  fs.rmSync(path.join(folder, 'b.csv'));
  app.timeline.capture(id, actor);
  const [after, recount] = recorded();
  assert.equal(after, recount, 'a delta index adds what it adds and takes away what it removes');
  assert.notEqual(after, first);
});

test('A deep row recorded under its row number by an earlier reader is read again under its label', async (t) => {
  // Arrange: reader 8 recorded a cell of row 3,001 by that row's number.
  const csv = `Ward,Glucose,Lactate\n${Array.from({ length: 4_000 }, (_, row) => `Hospital ward ${row},${row % 90},${row % 7}`).join('\n')}\n`;
  const { app, folder } = await mortality(t, { 'metabolites.csv': csv });
  const [{ id }] = (await app.workspace.add([folder], actor)).directories;
  const snapshotId = app.timeline.getProject(id).currentSnapshotId;
  const [table] = app.dependencies.snapshotTables(id, snapshotId);
  const recorded = app.db.prepare('INSERT INTO table_objects(key_prefix, object_key) VALUES (?, ?)');
  recorded.run(table.keyPrefix, `${table.keyPrefix}:cell:3001:hospitalward3000:Glucose`);

  // Act
  const descriptors = app.dependencies.recordedTableDescriptors(table.file, []);

  // Assert
  assert.deepEqual(descriptors.map((descriptor) => [descriptor.key, descriptor.value]),
    [[`${table.keyPrefix}:cell:hospitalward3000:Glucose`, String(3000 % 90)]]);
  const keys = app.db.prepare('SELECT object_key FROM table_objects WHERE key_prefix = ?').all(table.keyPrefix)
    .map((row) => row.object_key);
  assert.ok(keys.includes(`${table.keyPrefix}:cell:hospitalward3000:Glucose`), 'later readings follow the row by its label');
});
