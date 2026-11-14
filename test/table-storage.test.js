import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApplication } from '../src/server.js';
import { SHAPE_ROWS, TAIL_ROWS, TableWriter, rowTerms, shapeOf, writeTable } from '../src/dependencies/table-index.js';
import { normalizedRowSearch } from '../src/dependencies/row-names.js';

const actor = { id: 'human:table-storage', displayName: 'Table storage', actorType: 'HUMAN_SELF' };
const WARDS = 4_000;

function sandbox(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-table-storage-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** A ward table too long for the indexer to read every row of, so the table index keeps it. */
function wardCsv({ rows = WARDS, changed = () => null, top = [] } = {}) {
  const lines = Array.from({ length: rows }, (_, row) => changed(row) ?? `Hospital ward ${row},${row % 90},${row % 7}`);
  return `Ward,Glucose,Lactate\n${[...top, ...lines].join('\n')}\n`;
}

async function wards(t, csv = wardCsv(), { prepare = () => {}, files = {} } = {}) {
  const root = sandbox(t);
  const folder = path.join(root, 'Wards');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'wards.csv'), csv);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(folder, name), text);
  const app = createApplication({ dataDir: path.join(root, 'history'), watchProjects: false });
  t.after(() => app.close());
  prepare(app);
  const [{ id }] = (await app.workspace.add([folder], actor)).directories;
  return { app, folder, id, root };
}

/** Saves the ward table and records and indexes the new version, as a watcher would. */
function save(app, id, folder, csv) {
  fs.writeFileSync(path.join(folder, 'wards.csv'), csv);
  app.timeline.capture(id, actor);
  app.dependencies.ensureIndex(id);
  return currentHash(app, id);
}

const currentHash = (app, id) => app.timeline.snapshotFiles(app.timeline.getProject(id).currentSnapshotId)
  .find((file) => file.path === 'wards.csv').contentHash;
const count = (app, table) => app.dependencies.tables.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;

/** Runs bounded cleanup batches until one removes nothing. */
function cleanUp(app) {
  const removed = { tables: 0, chunks: 0, rows: 0 };
  for (let batch = 0; batch < 1_000; batch += 1) {
    const step = app.dependencies.tables.cleanup();
    for (const key of Object.keys(removed)) removed[key] += step[key];
    if (!step.tables && !step.parts && !step.chunks && !step.rows) return removed;
  }
  throw new Error('Cleanup did not finish.');
}

test('A one-cell edit stores one new row in the table index', async (t) => {
  // Arrange
  const { app, folder, id } = await wards(t);
  const rowsBefore = count(app, 'table_row_bodies');
  const chunksBefore = count(app, 'table_chunks');

  // Act
  const hash = save(app, id, folder, wardCsv({ changed: (row) => (row === 2_500 ? 'Hospital ward 2500,77,3' : null) }));

  // Assert
  assert.equal(count(app, 'table_row_bodies') - rowsBefore, 1, 'only the edited row is new');
  assert.ok(count(app, 'table_chunks') - chunksBefore <= 2, 'only the run of rows around it is new');
  const [table] = app.dependencies.tables.sheets(hash);
  assert.deepEqual(app.dependencies.tables.rowNumbered(table.id, 2_501).cells, ['Hospital ward 2500', '77', '3']);
  assert.deepEqual(app.dependencies.tables.rowNumbered(table.id, 2_502).cells, ['Hospital ward 2501', String(2501 % 90), String(2501 % 7)]);
});

test('A row inserted at the top stores few new rows', async (t) => {
  // Arrange
  const { app, folder, id } = await wards(t);
  const rowsBefore = count(app, 'table_row_bodies');
  const chunksBefore = count(app, 'table_chunks');

  // Act
  const hash = save(app, id, folder, wardCsv({ top: ['Intake ward,1,1'] }));

  // Assert
  assert.equal(count(app, 'table_row_bodies') - rowsBefore, 1, 'only the inserted row is new');
  assert.ok(count(app, 'table_chunks') - chunksBefore <= 3, `the rows below keep their runs (${count(app, 'table_chunks') - chunksBefore} new)`);
  const [table] = app.dependencies.tables.sheets(hash);
  assert.equal(table.rowCount, WARDS + 2);
  assert.deepEqual(app.dependencies.tables.rowNumbered(table.id, 1).cells, ['Intake ward', '1', '1']);
  assert.deepEqual(app.dependencies.tables.rowNumbered(table.id, 3_001).cells[0], 'Hospital ward 2999', 'every later row moved down one');
  assert.deepEqual(app.dependencies.tables.search(table.id, 'Hospital ward 3999').map((row) => row.rowNumber), [4_001]);
});

// The table index as it was stored before rows were shared: every row and term
// once per table. Its queries are the ones the index answered then.
function previousLayout(directory, tables) {
  const db = new DatabaseSync(path.join(directory, 'previous.sqlite'));
  db.exec(`CREATE TABLE table_rows (table_id INTEGER NOT NULL, ordinal INTEGER NOT NULL, row_number INTEGER NOT NULL,
      cells_json TEXT NOT NULL, display_json TEXT, PRIMARY KEY (table_id, ordinal)) WITHOUT ROWID;
    CREATE INDEX table_rows_number_idx ON table_rows(table_id, row_number);
    CREATE TABLE table_terms (table_id INTEGER NOT NULL, term TEXT NOT NULL, ordinal INTEGER NOT NULL,
      PRIMARY KEY (table_id, term, ordinal)) WITHOUT ROWID;`);
  const insertRow = db.prepare('INSERT INTO table_rows VALUES (?, ?, ?, ?, ?)');
  const insertTerm = db.prepare('INSERT OR IGNORE INTO table_terms VALUES (?, ?, ?)');
  db.exec('BEGIN');
  for (const [tableId, { sheet = null, rows, rowNumbers, displayRows = [] }] of tables.entries()) {
    const kept = rows.map((cells, index) => ({ cells, rowNumber: rowNumbers[index], display: displayRows[index] ?? null,
      blank: sheet == null && !cells.some((cell) => String(cell ?? '').trim()) })).filter((row) => !row.blank);
    // writeTable hands every row to the writer at once, so the shape is read from all of them.
    const shape = shapeOf({ rows: kept.map((row) => row.cells), rowNumbers: kept.map((row) => row.rowNumber), sheet,
      physicalRows: sheet == null ? rows.map((cells) => (cells.some((cell) => String(cell ?? '').trim()) ? cells : [])) : null });
    const headRows = shape.searchable ? Infinity : shape.dataStart + SHAPE_ROWS + 80;
    for (const [ordinal, row] of kept.entries()) {
      if (ordinal >= headRows && ordinal < kept.length - TAIL_ROWS) continue;
      const shown = row.display && Object.keys(row.display).length ? JSON.stringify(row.display) : null;
      insertRow.run(tableId, ordinal, row.rowNumber, JSON.stringify(row.cells), shown);
      if (!shape.searchable || ordinal < shape.dataStart) continue;
      for (const term of rowTerms(row.cells[shape.labelColumn])) insertTerm.run(tableId, term, ordinal);
    }
  }
  db.exec('COMMIT');
  const parse = (row) => ({ ordinal: row.ordinal, rowNumber: row.row_number, cells: JSON.parse(row.cells_json),
    display: row.display_json ? JSON.parse(row.display_json) : null });
  const statements = {
    range: db.prepare('SELECT * FROM table_rows WHERE table_id = ? AND ordinal >= ? AND ordinal < ? ORDER BY ordinal'),
    row: db.prepare('SELECT * FROM table_rows WHERE table_id = ? AND ordinal = ?'),
    numbered: db.prepare('SELECT * FROM table_rows WHERE table_id = ? AND row_number = ? ORDER BY ordinal LIMIT 1'),
    before: db.prepare('SELECT * FROM table_rows WHERE table_id = ? AND row_number <= ? ORDER BY row_number DESC LIMIT ?'),
    search: db.prepare('SELECT DISTINCT ordinal FROM table_terms WHERE table_id = ? AND term >= ? AND term < ? LIMIT ?'),
    named: db.prepare(`SELECT r.* FROM table_terms t JOIN table_rows r ON r.table_id = t.table_id AND r.ordinal = t.ordinal
      WHERE t.table_id = ? AND t.term = ? AND t.ordinal >= ? AND t.ordinal < ? ORDER BY t.ordinal LIMIT ?`),
  };
  const one = (row) => (row ? parse(row) : null);
  return {
    close: () => db.close(),
    rows: (id, from, to) => statements.range.all(id, from, to).map(parse),
    row: (id, ordinal) => one(statements.row.get(id, ordinal)),
    rowNumbered: (id, number) => one(statements.numbered.get(id, number)),
    rowsBefore: (id, number, limit) => statements.before.all(id, number, limit).map(parse),
    rowsNamed: (id, term, from, to = Number.MAX_SAFE_INTEGER, limit = 64) => (term
      ? statements.named.all(id, term, from, to, limit).map(parse) : []),
    search(id, typed, limit = 32) {
      const query = normalizedRowSearch(typed);
      if (query.length < 2) return [];
      return statements.search.all(id, query, `${query}￿`, limit).map((row) => one(statements.row.get(id, row.ordinal)));
    },
  };
}

/** A generated table with repeated names, names sharing words, blank lines, and changes from `edit`. */
function generatedTable(version, { sheet = null } = {}) {
  const regions = ['North ward', 'South ward', 'Ward', 'East wing', 'Ward 1'];
  const rows = [['Region', 'Count', 'Rate']];
  for (let row = 0; row < 3_000; row += 1) {
    if (sheet == null && row % 401 === 7) rows.push(['', '', '']);
    const name = row % 97 === 3 ? 'Ward 12' : `${regions[row % regions.length]} ${row % 1_200}`;
    const count = version > 0 && row % 613 === version ? `${row * 3 + version}` : `${row * 3}`;
    rows.push([name, count, `${(row % 41) / 10}`]);
  }
  if (version > 1) rows.splice(40, 0, ['Inserted ward 1', '1', '1']);
  const rowNumbers = rows.map((_, index) => (sheet == null ? index : index + 1 + Math.floor(index / 500)));
  const displayRows = sheet == null ? [] : rows.map((_, index) => (index % 250 === 9 ? { 1: `$${index}` } : null));
  return { sheet, rows, rowNumbers, displayRows };
}

/** A tidy table: no column names its rows, so only its first and last rows are kept. */
function tidyTable(version) {
  const rows = [['Year', 'Age', 'Deaths'], ...Array.from({ length: SHAPE_ROWS + 400 }, (_, row) =>
    [`${1990 + (row % 30)}`, `${row % 90}`, `${(row * 7 + (row === 1_350 ? version : 0)) % 50}`])];
  return { sheet: null, rows, rowNumbers: rows.map((_, index) => index) };
}

function sameAnswers(index, reference, newId, oldId, table) {
  const total = table.rows.length + 1;
  assert.deepEqual(index.rows(newId, 0, total), reference.rows(oldId, 0, total), 'every row');
  assert.deepEqual(index.rows(newId, 37, 512), reference.rows(oldId, 37, 512), 'a range of rows');
  for (const ordinal of [0, 1, 2, 999, 1_455, 2_999, 3_000, 3_010, 5_000]) {
    assert.deepEqual(index.row(newId, ordinal), reference.row(oldId, ordinal), `row ${ordinal}`);
  }
  for (const number of [0, 1, 8, 9, 409, 1_234, 2_501, 3_006, 9_999]) {
    assert.deepEqual(index.rowNumbered(newId, number), reference.rowNumbered(oldId, number), `row number ${number}`);
    assert.deepEqual(index.rowsBefore(newId, number, 5), reference.rowsBefore(oldId, number, 5), `rows before ${number}`);
  }
  for (const typed of ['wa', 'ward', 'Ward 1', 'ward 12', 'ward12', 'North ward 11', 'south', '11', 'Inserted', 'east wing 4', 'zz', 'w']) {
    for (const limit of [3, 32]) {
      assert.deepEqual(index.search(newId, typed, limit), reference.search(oldId, typed, limit), `search "${typed}" (${limit})`);
    }
  }
  for (const [term, from, to, limit] of [['ward12', 1, undefined, 64], ['ward12', 300, 2_000, 5], ['northward11', 0, undefined, 64],
    ['ward1', 0, 1_000, 4_097], ['12', 0, undefined, 64], ['', 0, undefined, 64]]) {
    assert.deepEqual(index.rowsNamed(newId, term, from, to, limit), reference.rowsNamed(oldId, term, from, to, limit),
      `rows named ${term} from ${from}`);
  }
}

test('A search returns the same rows as before the rows were shared', async (t) => {
  // Arrange
  const { app, root } = await wards(t, 'Ward,Glucose\nRenal,1\n');
  const index = app.dependencies.tables;
  const tables = [generatedTable(0), generatedTable(1), generatedTable(2), generatedTable(0, { sheet: 'Counts' }),
    generatedTable(2, { sheet: 'Counts' }), tidyTable(0), tidyTable(1)];
  const reference = previousLayout(root, tables);
  t.after(() => reference.close());

  // Act: each table is written as a version of one file, so later ones share the earlier ones' rows.
  const ids = tables.map((table, position) => writeTable(index.db, `generated-${position}`, table));

  // Assert
  for (const [position, table] of tables.entries()) sameAnswers(index, reference, ids[position], position, table);
  assert.ok(count(app, 'table_row_bodies') < tables.reduce((sum, table) => sum + table.rows.length, 0) / 2,
    'rows the versions have in common are stored once');
});

test('A long table is written in a few transactions, with a page cache it gives back afterwards', async (t) => {
  // Arrange
  const { app } = await wards(t, 'Ward,Glucose\nRenal,1\n');
  const db = app.dependencies.tables.db;
  const cacheKilobytes = () => -db.prepare('PRAGMA cache_size').get().cache_size;
  const atRest = cacheKilobytes();
  const whileWriting = [];
  const exec = db.exec.bind(db);
  t.mock.method(db, 'exec', (sql) => {
    if (/^BEGIN/.test(sql)) whileWriting.push(cacheKilobytes());
    return exec(sql);
  });
  const rows = [['Ward', 'Glucose'], ...Array.from({ length: 12_000 }, (_, row) => [`Hospital ward ${row}`, row % 90])];

  // Act
  writeTable(db, 'long-table', { rows, rowNumbers: rows.map((_, index) => index + 1) });

  // Assert
  assert.ok(whileWriting.length >= 1 && whileWriting.length <= 3,
    `every row's pages are written once per transaction, so few transactions write few pages (took ${whileWriting.length})`);
  assert.ok(whileWriting.every((kilobytes) => kilobytes >= 16 * 1024), 'the rows being written stay in memory until committed');
  assert.equal(cacheKilobytes(), atRest, 'the connection is left as small as it was');
});

test('An old table is deleted once no snapshot needs it', async (t) => {
  // Arrange
  const { app, folder, id } = await wards(t);
  const hashes = [currentHash(app, id)];
  for (let edit = 1; edit <= 5; edit += 1) {
    hashes.push(save(app, id, folder, wardCsv({ changed: (row) => (row === edit * 500 ? `Hospital ward ${row},${edit},0` : null) })));
  }
  const rowsBefore = count(app, 'table_row_bodies');

  // Act
  const removed = cleanUp(app);

  // Assert
  const tables = app.dependencies.tables;
  assert.deepEqual(hashes.map((hash) => tables.has(hash)), [false, false, false, true, true, true],
    'the current version and the two before it are kept');
  assert.equal(removed.tables, 3);
  assert.equal(count(app, 'table_row_bodies'), rowsBefore - 2, 'the edited rows only the deleted versions had are gone');
  assert.equal(app.dependencies.tables.db.prepare('SELECT COUNT(*) AS count FROM table_row_terms t WHERE NOT EXISTS (SELECT 1 FROM table_row_bodies b WHERE b.id = t.row_id)').get().count, 0,
    'so are their names');
  const [current] = tables.sheets(hashes[5]);
  assert.deepEqual(tables.search(current.id, 'Hospital ward 2500').map((row) => row.cells), [['Hospital ward 2500', '5', '0']]);
  assert.deepEqual(tables.search(current.id, 'Hospital ward 500').map((row) => row.cells), [['Hospital ward 500', String(500 % 90), String(500 % 7)]]);
});

test('A table a share still needs is kept', async (t) => {
  // Arrange
  const { app, folder, id } = await wards(t);
  const shared = app.dependencies.objectsAt(id).find((object) => object.label === 'Hospital ward 10');
  app.objectShares.createShare({ projectId: id, objectId: shared.id, actor });
  const hashes = [currentHash(app, id)];
  for (let edit = 1; edit <= 5; edit += 1) {
    hashes.push(save(app, id, folder, wardCsv({ changed: (row) => (row === edit * 500 ? `Hospital ward ${row},${edit},0` : null) })));
  }

  // Act
  cleanUp(app);

  // Assert
  assert.deepEqual(hashes.map((hash) => app.dependencies.tables.has(hash)), [true, false, false, true, true, true]);
  const [table] = app.dependencies.tables.sheets(hashes[0]);
  assert.deepEqual(app.dependencies.tables.rowNumbered(table.id, 2_501).cells, ['Hospital ward 2500', String(2500 % 90), String(2500 % 7)]);
});

test('A table a share made before shares named their snapshot still needs is kept', async (t) => {
  // Arrange: such a share is pinned only to the version of the object it shared.
  const { app, folder, id } = await wards(t);
  const shared = app.dependencies.objectsAt(id).find((object) => object.label === 'Hospital ward 10');
  app.objectShares.createShare({ projectId: id, objectId: shared.id, actor });
  app.dependencies.db.prepare('UPDATE object_share_grants SET snapshot_id = NULL').run();
  const hashes = [currentHash(app, id)];
  for (let edit = 1; edit <= 5; edit += 1) {
    hashes.push(save(app, id, folder, wardCsv({ changed: (row) => (row === edit * 500 ? `Hospital ward ${row},${edit},0` : null) })));
  }

  // Act
  cleanUp(app);

  // Assert
  assert.deepEqual(hashes.map((hash) => app.dependencies.tables.has(hash)), [true, false, false, true, true, true]);
});

test('A table an earlier version of a linked claim was read from is kept', async (t) => {
  // Arrange: a claim links a row, and after two edits is pointed at the row as it is then.
  const { app, folder, id } = await wards(t, wardCsv(), { files: { 'draft.md': 'Ward ten reads 10.\n' } });
  const ward = () => app.dependencies.objectsAt(id).find((object) => object.label === 'Hospital ward 10');
  const first = ward();
  app.dependencies.link(id, { documentPath: 'draft.md', sourceObjectId: first.id, sourceSnapshotId: first.snapshotId,
    spanText: '10', anchor: { kind: 'manuscript-span', blockIndex: 0, start: 15, end: 17 } }, actor);
  const edit = (number) => save(app, id, folder, wardCsv({ changed: (row) => (row === number * 500 ? `Hospital ward ${row},${number},0` : null) }));
  const hashes = [currentHash(app, id), edit(1), edit(2)];
  const [dependency] = app.dependencies.currentDependencies(id);
  const repointed = ward();
  app.dependencies.revise(dependency.id, actor, { sourceObjectId: repointed.id, sourceSnapshotId: repointed.snapshotId });
  hashes.push(edit(3), edit(4), edit(5));

  // Act
  cleanUp(app);

  // Assert
  assert.deepEqual(hashes.map((hash) => app.dependencies.tables.has(hash)), [true, false, true, true, true, true],
    'the first version a claim read, the version it reads now, and the last three are kept');
});

test('A table replaced while it is still being written leaves none of its rows behind', async (t) => {
  // Arrange: a second build of the same content starts while the first is part way through.
  const { app } = await wards(t, 'Ward,Glucose\nRenal,1\n');
  const db = app.dependencies.tables.db;
  const rows = (label) => Array.from({ length: 3_000 }, (_, row) => ({ rowNumber: row,
    cells: row ? [`${label} ${row}`, `${row}`] : ['Ward', 'Glucose'] }));
  const replaced = new TableWriter(db, 'replaced-content', null, 0);
  replaced.add(rows('Old ward').slice(0, 1_500));
  const replacement = new TableWriter(db, 'replaced-content', null, 0);
  cleanUp(app);

  // Act
  replaced.add(rows('Old ward').slice(1_500));
  replaced.finish();
  replacement.add(rows('New ward'));
  replacement.finish();
  cleanUp(app);

  // Assert
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM table_parts WHERE table_id = ?').get(replaced.id).count, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM table_row_bodies WHERE cells_json LIKE '%Old ward%'`).get().count, 0);
});

test('Old tables are removed after a capture without being asked', async (t) => {
  // Arrange
  const { app, folder, id } = await wards(t, wardCsv(), { prepare: (created) => { created.dependencies.tableCleanupDelayMs = 0; } });
  const first = currentHash(app, id);

  // Act
  for (let edit = 1; edit <= 4; edit += 1) {
    save(app, id, folder, wardCsv({ changed: (row) => (row === edit * 500 ? `Hospital ward ${row},${edit},0` : null) }));
  }
  // Cleanup runs one more batch after its last removal to find nothing left,
  // so wait for that too rather than only for the table to go.
  const cleaning = () => app.dependencies.tables.has(first) || app.dependencies.tableCleanupTimer !== null;
  for (let turn = 0; turn < 200 && cleaning(); turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  // Assert
  assert.equal(app.dependencies.tables.has(first), false);
  assert.equal(app.dependencies.tableCleanupTimer, null, 'no timer is left waiting once nothing is left to remove');
});

test('A table index from the previous layout is rebuilt rather than misread', async (t) => {
  // Arrange: an index written before rows were shared holds a different table for the same bytes.
  const root = sandbox(t);
  const folder = path.join(root, 'Wards');
  fs.mkdirSync(folder);
  const csv = wardCsv();
  fs.writeFileSync(path.join(folder, 'wards.csv'), csv);
  const hash = crypto.createHash('sha256').update(csv).digest('hex');
  const dataDir = path.join(root, 'history');
  fs.mkdirSync(path.join(dataDir, 'derived'), { recursive: true });
  const old = new DatabaseSync(path.join(dataDir, 'derived', 'tables.sqlite'));
  old.exec(`CREATE TABLE tables (id INTEGER PRIMARY KEY, content_hash TEXT NOT NULL, sheet TEXT NOT NULL, position INTEGER NOT NULL,
      version INTEGER NOT NULL, row_count INTEGER NOT NULL DEFAULT 0, shape_json TEXT, extras_json TEXT NOT NULL DEFAULT '{}',
      complete INTEGER NOT NULL DEFAULT 0, UNIQUE(content_hash, sheet, version));
    CREATE TABLE table_rows (table_id INTEGER NOT NULL, ordinal INTEGER NOT NULL, row_number INTEGER NOT NULL,
      cells_json TEXT NOT NULL, display_json TEXT, PRIMARY KEY (table_id, ordinal)) WITHOUT ROWID;
    CREATE INDEX table_rows_number_idx ON table_rows(table_id, row_number);
    CREATE TABLE table_terms (table_id INTEGER NOT NULL, term TEXT NOT NULL, ordinal INTEGER NOT NULL,
      PRIMARY KEY (table_id, term, ordinal)) WITHOUT ROWID;`);
  const shape = { headers: ['Ward', 'Glucose', 'Lactate'], dataStart: 1, labelColumn: 0, firstColumnActsAsRowLabels: true,
    rowDescribesVariable: false, searchable: true };
  old.prepare(`INSERT INTO tables VALUES (1, ?, '', 0, 1, 2, ?, '{}', 1)`).run(hash, JSON.stringify(shape));
  old.prepare('INSERT INTO table_rows VALUES (1, 0, 0, ?, NULL), (1, 1, 1, ?, NULL)')
    .run(JSON.stringify(['Ward', 'Glucose', 'Lactate']), JSON.stringify(['Bogus ward', '1', '1']));
  old.prepare(`INSERT INTO table_terms VALUES (1, 'bogusward', 1), (1, 'ward', 1)`).run();
  old.close();

  // Act
  const app = createApplication({ dataDir, watchProjects: false });
  t.after(() => app.close());
  await app.workspace.add([folder], actor);

  // Assert
  const tables = app.dependencies.tables;
  const [table] = tables.sheets(hash);
  assert.equal(table.rowCount, WARDS + 1, 'the table was read again from the file');
  assert.deepEqual(tables.search(table.id, 'Bogus ward'), []);
  assert.deepEqual(tables.search(table.id, 'Hospital ward 3999').map((row) => row.cells[0]), ['Hospital ward 3999']);
  const leftover = tables.db.prepare(`SELECT name FROM sqlite_master WHERE name IN ('table_rows', 'table_terms')`).all();
  assert.deepEqual(leftover, [], 'the previous layout\'s rows are gone');
});
