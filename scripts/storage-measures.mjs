// What the storage benchmarks share: generated tables, sizes of a data
// directory on disk, memory readings, and the capture a watcher makes after
// one cell of a file is saved. Used by bench-storage.mjs and benchmark.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BENCH_ACTOR = { id: 'human:storage-benchmark', displayName: 'Storage benchmark', actorType: 'HUMAN_SELF' };

const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'];
// Fixed multipliers stand in for a random seed, so every run writes the same bytes.
const ROW_STEP = 7919;
const COLUMN_STEP = 104_729;
// node reports ru_maxrss in kilobytes on every platform (libuv converts the
// bytes macOS returns), so the peak is this many bytes per unit.
const MAX_RSS_UNIT_BYTES = 1024;

/** The value a generated table holds at a data row (from 1) and value column (from 0). */
export function generatedValue(row, column, columns = QUARTERS.length) {
  const mixed = row * ROW_STEP + (column + 1) * COLUMN_STEP;
  // The last column is one digit wider, which brings 20,000 rows to about 0.63 MB.
  return column === columns - 1 ? 10_000 + (mixed % 90_000) : 1000 + (mixed % 9000);
}

/**
 * A table of `rows` data rows: a unique label, then one value per column.
 * `edits` maps "row:column" to the value saved over the generated one.
 */
export function generatedRows(rows, { label = 'Item', columns = QUARTERS, edits = new Map() } = {}) {
  return Array.from({ length: rows }, (_, index) => {
    const row = index + 1;
    return [`${label} ${row}`, ...columns.map((_, column) => edits.get(`${row}:${column}`) ?? generatedValue(row, column, columns.length))];
  });
}

export function csvText(header, rows) {
  return `${[header, ...rows].map((cells) => cells.join(',')).join('\n')}\n`;
}

export function ledgerCsv(rows, edits = new Map()) {
  return csvText(['Item', ...QUARTERS], generatedRows(rows, { edits }));
}

export function fileBytes(file) {
  try { return fs.statSync(file).size; } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

export function directoryBytes(directory) {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  return entries.reduce((sum, entry) => {
    const full = path.join(directory, entry.name);
    return sum + (entry.isDirectory() ? directoryBytes(full) : fileBytes(full));
  }, 0);
}

/** What a database holds, counting pages still in its write-ahead log once each. */
export function storedBytes(db) {
  const pages = db.prepare('PRAGMA page_count').get().page_count;
  const pageSize = db.prepare('PRAGMA page_size').get().page_size;
  return pages * pageSize;
}

/**
 * The bytes a data directory holds. Files are measured as found, which is
 * what the disk gives up: a write-ahead log keeps its largest size and holds
 * pages the database file also has, so file sizes move in jumps at each
 * checkpoint. The `Stored` figures count each page once and grow only by what
 * was written, so growth per edit is taken from those. Nothing is
 * checkpointed here; the server is measured as it runs.
 */
export function storageBytes(app) {
  const { dataDir, databasePath, blobDir } = app.config;
  const derived = path.join(dataDir, 'derived');
  const tablesPath = path.join(derived, 'tables.sqlite');
  const timelineSqliteBytes = fileBytes(databasePath);
  const timelineWalBytes = fileBytes(`${databasePath}-wal`);
  const derivedBytes = directoryBytes(derived);
  const tablesFilesBytes = ['', '-wal', '-shm'].reduce((sum, suffix) => sum + fileBytes(`${tablesPath}${suffix}`), 0);
  const derivedTablesStoredBytes = storedBytes(app.dependencies.tables.db);
  return {
    blobsBytes: directoryBytes(blobDir),
    timelineSqliteBytes,
    timelineWalBytes,
    timelineBytes: timelineSqliteBytes + timelineWalBytes,
    timelineStoredBytes: storedBytes(app.db),
    derivedBytes,
    derivedTablesBytes: fileBytes(tablesPath),
    derivedTablesStoredBytes,
    derivedStoredBytes: derivedBytes - tablesFilesBytes + derivedTablesStoredBytes,
  };
}

export function rowCount(app, table) {
  return app.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

export function memoryBytes() {
  const { rss, heapUsed } = process.memoryUsage();
  return { rssBytes: rss, heapUsedBytes: heapUsed };
}

/** The most memory this process has held, which a timer cannot sample while indexing blocks it. */
export function peakRssBytes() {
  return Math.max(process.resourceUsage().maxRSS * MAX_RSS_UNIT_BYTES, process.memoryUsage().rss);
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** A new empty directory under the system's temporary folder, never the user's library. */
export function temporaryDirectory(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Lets work queued for after a capture (the suggestion caches) finish before anything is measured. */
export async function settle() {
  for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Records a saved file as the folder watcher does, and returns the capture with how long it took. */
export function captureSavedFile(app, projectId, relativePath) {
  const started = performance.now();
  const capture = app.timeline.capture(projectId, BENCH_ACTOR, { source: 'WATCHER', dirtyPaths: [relativePath] });
  app.dependencies.ensureIndex(projectId);
  const milliseconds = performance.now() - started;
  if (!capture.changed) throw new Error(`Saving ${relativePath} recorded no change.`);
  return { capture, milliseconds };
}

/** The folder's id after it is added to the work directories. */
export async function addFolder(app, root) {
  const before = new Set(app.workspace.state().directories.map((directory) => directory.id));
  const added = await app.workspace.add([root], BENCH_ACTOR);
  const directory = added.directories.find((candidate) => !before.has(candidate.id));
  if (!directory) throw new Error(`Adding ${root} listed no new directory.`);
  return directory.id;
}

/**
 * The disk one saved cell costs: a generated table is indexed in a temporary
 * data directory, one cell is saved `edits` times, and the median growth of
 * each store is returned.
 */
export async function diskPerOneCellEdit(createApplication, { rows = 20_000, edits = 3 } = {}) {
  const sandbox = temporaryDirectory('lasso-disk-per-edit-');
  const root = path.join(sandbox, 'Ledger');
  const file = path.join(root, 'ledger.csv');
  fs.mkdirSync(root);
  fs.writeFileSync(file, ledgerCsv(rows));
  const app = createApplication({ dataDir: path.join(sandbox, 'data'), watchProjects: false });
  try {
    const projectId = await addFolder(app, root);
    await settle();
    const growth = [];
    let saved = new Map();
    let before = storageBytes(app);
    for (let edit = 0; edit < edits; edit += 1) {
      saved = new Map([...saved, [`${11 + edit * 40}:${edit % QUARTERS.length}`, 700_000 + edit]]);
      fs.writeFileSync(file, ledgerCsv(rows, saved));
      captureSavedFile(app, projectId, 'ledger.csv');
      await settle();
      const after = storageBytes(app);
      growth.push({ blobsBytes: after.blobsBytes - before.blobsBytes,
        timelineBytes: after.timelineStoredBytes - before.timelineStoredBytes,
        derivedBytes: after.derivedStoredBytes - before.derivedStoredBytes });
      before = after;
    }
    const perStore = (key) => median(growth.map((step) => step[key]));
    const result = { fileBytes: fileBytes(file), rows, edits, blobsBytes: perStore('blobsBytes'),
      timelineBytes: perStore('timelineBytes'), derivedBytes: perStore('derivedBytes') };
    return { ...result, totalBytes: result.blobsBytes + result.timelineBytes + result.derivedBytes };
  } finally {
    await app.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}
