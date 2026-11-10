// Measures what indexing and saved edits cost in disk and memory, on generated
// tables, and writes the run to docs/benchmarks/storage.json under a label so
// a later run sits next to the baseline. Run with:
//
//   npm run bench:storage -- --label baseline [--date 2026-11-10T00:00:00Z]
//
// Nothing is written to the user's own Lasso library: every run uses a
// temporary data directory and removes it. The scenarios run in a child
// process so their peak memory is theirs alone; the idle server and the
// first edit of a process just started each run in another.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { storedZip } from '../test/fixtures/workbook.js';
import {
  addFolder, captureSavedFile, csvText, fileBytes, generatedRows, ledgerCsv, median, memoryBytes, peakRssBytes,
  rowCount, settle, storageBytes, temporaryDirectory,
} from './storage-measures.mjs';
import { printRun, round } from './bench-storage-report.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');
const outputPath = path.join(repoRoot, 'docs', 'benchmarks', 'storage.json');

const CSV_ROWS = 20_000;
const XLSX_ROWS = 5_000;
const SMALL_CSV_ROWS = 200;
const CSV_NAME = 'ledger.csv';
const XLSX_NAME = 'parts.xlsx';
const SMALL_CSV_NAME = 'lines.csv';
// The cell no edit touches, so its versions show what an unrelated save records.
const REFERENCE_ROW = 374;
const REFERENCE_LABEL = `Item ${REFERENCE_ROW} · Q4`;
// [data row, value column] of each one-cell save. Rows are among those the
// indexer reads as objects, and no cell is saved twice.
const CSV_EDITS = [[11, 0], [53, 1], [97, 2], [211, 3], [307, 0]];
const XLSX_EDITS = [[17, 0], [61, 1], [103, 2], [229, 3], [311, 0]];
// One save after the application is reopened in the same process, and one in a process just started.
const RESTART_EDITS = [[331, 1], [347, 2]];
const EDITED_VALUE = 700_000;
const IDLE_SETTLE_MS = 1500;
const IDLE_SAMPLES = 5;
const IDLE_SAMPLE_GAP_MS = 200;
const LARGEST_TABLES = 8;
// An edit that writes this share of a file's objects again has rewritten its index.
const REWRITE_SHARE = 0.9;
const VERSION_TEXT_COLUMNS = ['id', 'object_id', 'snapshot_id', 'path', 'anchor_json', 'label', 'value_text',
  'search_text', 'content_hash', 'metadata_json', 'created_at'];

function workbookBytes(edits = new Map()) {
  const cell = (value, reference) => (typeof value === 'number' ? `<c r="${reference}"><v>${value}</v></c>`
    : `<c r="${reference}" t="inlineStr"><is><t>${value}</t></is></c>`);
  const rows = [['Part', 'Jan', 'Feb', 'Mar', 'Apr'], ...generatedRows(XLSX_ROWS, { label: 'Part', edits })];
  const rowXml = rows.map((cells, index) => `<row r="${index + 1}">${cells.map((value, column) =>
    cell(value, `${String.fromCharCode(65 + column)}${index + 1}`)).join('')}</row>`).join('');
  return storedZip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Parts" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rowXml}</sheetData></worksheet>`,
  }, { deflate: true });
}

function smallCsv({ topRow = false } = {}) {
  const rows = Array.from({ length: SMALL_CSV_ROWS }, (_, index) => [`Line ${index + 1}`, 101 + index]);
  return csvText(['Account', 'Value'], topRow ? [['Line 0', 100], ...rows] : rows);
}

function editsThrough(edits, count) {
  return new Map(edits.slice(0, count).map(([row, column], index) => [`${row}:${column}`, EDITED_VALUE + index]));
}

/** Everything measured after a step, with its change from the step before. */
function measureStep(app, previous, { name, scenario, wallMs }) {
  const totals = { ...storageBytes(app), versionRows: rowCount(app, 'scientific_object_versions'),
    removalRows: rowCount(app, 'scientific_object_removals'), ...memoryBytes(), peakRssBytes: peakRssBytes() };
  const delta = Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value - (previous?.totals[key] ?? 0)]));
  return { name, scenario, wallMs: round(wallMs, 1), totals, delta };
}

function tableRowCounts(app) {
  const names = app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  return new Map(names.map(({ name }) => [name, rowCount(app, name)]));
}

/** Bytes of pages per table and index, or null where this SQLite build has no dbstat. */
function tablePageBytes(app) {
  try {
    return new Map(app.db.prepare('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name').all()
      .map(({ name, bytes }) => [name, bytes]));
  } catch (error) {
    if (/no such table/i.test(error.message)) return null;
    throw error;
  }
}

function largestGrowth(before, after) {
  if (!before || !after) return null;
  return [...after].map(([name, value]) => ({ name, delta: value - (before.get(name) ?? 0) }))
    .filter((entry) => entry.delta !== 0).sort((left, right) => right.delta - left.delta).slice(0, LARGEST_TABLES);
}

/** Where timeline.sqlite grew over one save: rows and pages per table, and the size of what was written. */
function editBreakdown(app, capture, before) {
  const byteLength = (column) => `COALESCE(LENGTH(CAST(${column} AS BLOB)), 0)`;
  const versions = app.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(${VERSION_TEXT_COLUMNS.map(byteLength).join(' + ')}), 0) AS bytes
    FROM scientific_object_versions WHERE snapshot_id = ?`).get(capture.snapshot.id);
  const diff = app.db.prepare(`SELECT COALESCE(SUM(${byteLength('structured_diff_json')}), 0) AS bytes FROM file_changes WHERE event_id = ?`)
    .get(capture.event.id);
  return {
    rowDeltas: largestGrowth(before.rows, tableRowCounts(app)).map(({ name, delta }) => ({ table: name, rows: delta })),
    pageByteDeltas: largestGrowth(before.pages, tablePageBytes(app))?.map(({ name, delta }) => ({ name, bytes: delta })) ?? null,
    structuredDiffJsonBytes: diff.bytes,
    newVersionRows: versions.count,
    newVersionRowsContentBytes: versions.bytes,
  };
}

/** How many versions the untouched cell has, and whether they differ in anything but the file's hash. */
function referenceCell(app, projectId) {
  const versions = app.db.prepare(`SELECT v.object_id, v.path, v.anchor_json, v.label, v.value_text, v.search_text, v.metadata_json, v.content_hash
    FROM scientific_object_versions v JOIN scientific_objects o ON o.id = v.object_id
    WHERE o.project_id = ? AND v.path = ? AND v.label = ?`).all(projectId, CSV_NAME, REFERENCE_LABEL);
  const apartFromHash = ({ content_hash: _hash, ...rest }) => JSON.stringify(rest);
  return {
    label: REFERENCE_LABEL,
    objects: new Set(versions.map((version) => version.object_id)).size,
    versions: versions.length,
    distinctContentHashes: new Set(versions.map((version) => version.content_hash)).size,
    identicalApartFromContentHash: new Set(versions.map(apartFromHash)).size === 1,
  };
}

function objectIds(app, projectId, filePath) {
  return app.dependencies.objectsAt(projectId).filter((object) => object.path === filePath).map((object) => object.id);
}

/** Where the parent keeps the bytes of a file's `index`th save (0 is the file as first indexed). */
function savedPath(sandbox, name, index) {
  return path.join(sandbox, 'saves', `${index}-${name}`);
}

/**
 * Writes every state each file is saved in. The parent does this before the
 * scenarios start, so the measured process generates no data of its own and
 * its memory is the server's.
 */
function writeSaves(sandbox) {
  const csvEdits = [...CSV_EDITS, ...RESTART_EDITS];
  if (csvEdits.some(([row]) => row === REFERENCE_ROW)) throw new Error(`Row ${REFERENCE_ROW} is the untouched reference and cannot be edited.`);
  const states = {
    [CSV_NAME]: [ledgerCsv(CSV_ROWS), ...csvEdits.map((_, index) => ledgerCsv(CSV_ROWS, editsThrough(csvEdits, index + 1)))],
    [XLSX_NAME]: [workbookBytes(), ...XLSX_EDITS.map((_, index) => workbookBytes(editsThrough(XLSX_EDITS, index + 1)))],
    [SMALL_CSV_NAME]: [smallCsv(), smallCsv({ topRow: true })],
  };
  fs.mkdirSync(path.join(sandbox, 'saves'));
  for (const [name, saves] of Object.entries(states)) {
    saves.forEach((bytes, index) => fs.writeFileSync(savedPath(sandbox, name, index), bytes));
  }
}

/**
 * Saves a file in each of the states numbered `saves`, measuring after each.
 * Returns the steps so far and, when `explainFirst` is set, where the first
 * save's bytes went.
 */
async function saveSteps(app, steps, { sandbox, projectId, file, name, scenario, saves, explainFirst = false }) {
  let recorded = steps;
  let firstBreakdown = null;
  for (const [position, save] of saves.entries()) {
    const before = position === 0 && explainFirst ? { rows: tableRowCounts(app), pages: tablePageBytes(app) } : null;
    fs.writeFileSync(file, fs.readFileSync(savedPath(sandbox, path.basename(file), save)));
    const { capture, milliseconds } = captureSavedFile(app, projectId, path.basename(file));
    await settle();
    const stepName = saves.length > 1 ? `${name} ${position + 1}` : name;
    recorded = [...recorded, measureStep(app, recorded.at(-1), { name: stepName, scenario, wallMs: milliseconds })];
    if (before) firstBreakdown = editBreakdown(app, capture, before);
  }
  return { steps: recorded, firstBreakdown };
}

async function timed(work) {
  const started = performance.now();
  const value = await work();
  return { value, milliseconds: performance.now() - started };
}

/** Adds a folder holding the given files as first indexed, and measures the import. */
async function importStep(app, steps, { sandbox, root, names, name, scenario }) {
  fs.mkdirSync(root);
  for (const fileName of names) fs.copyFileSync(savedPath(sandbox, fileName, 0), path.join(root, fileName));
  const added = await timed(() => addFolder(app, root));
  await settle();
  return { projectId: added.value, steps: [...steps, measureStep(app, steps.at(-1), { name, scenario, wallMs: added.milliseconds })] };
}

/** What the first save after a restart wrote, against what the file and its folder hold. */
function restartOutcome(app, projectId, step) {
  const snapshotId = app.timeline.getProject(projectId).currentSnapshotId;
  const fileObjects = objectIds(app, projectId, CSV_NAME).length;
  const versionRows = step.delta.versionRows;
  return { versionRows, fileObjects, folderObjects: app.dependencies.objectsAt(projectId).length,
    builtOnPreviousIndex: Boolean(app.db.prepare('SELECT 1 FROM object_index_bases WHERE snapshot_id = ?').get(snapshotId)),
    rewroteFileIndex: versionRows >= fileObjects * REWRITE_SHARE };
}

/** Scenarios 1 to 5, in order, in one process. */
async function runScenarios(sandbox) {
  const { createApplication } = await import('../src/server.js');
  const ledgerRoot = path.join(sandbox, 'Ledger');
  const budgetRoot = path.join(sandbox, 'Budget');
  const csvFile = path.join(ledgerRoot, CSV_NAME);
  const smallFile = path.join(budgetRoot, SMALL_CSV_NAME);
  const numbered = (edits) => edits.map((_, index) => index + 1);
  const open = () => createApplication({ dataDir: path.join(sandbox, 'data'), watchProjects: false });
  const opened = await timed(open);
  let app = opened.value;
  try {
    let steps = [measureStep(app, null, { name: 'empty library', scenario: 0, wallMs: opened.milliseconds })];
    const ledger = await importStep(app, steps, { sandbox, root: ledgerRoot, names: [CSV_NAME, XLSX_NAME],
      name: 'import csv + xlsx', scenario: 1 });
    const csvSaves = await saveSteps(app, ledger.steps, { sandbox, projectId: ledger.projectId, file: csvFile,
      name: 'csv edit', scenario: 2, saves: numbered(CSV_EDITS), explainFirst: true });
    const untouched = referenceCell(app, ledger.projectId);
    ({ steps } = await saveSteps(app, csvSaves.steps, { sandbox, projectId: ledger.projectId,
      file: path.join(ledgerRoot, XLSX_NAME), name: 'xlsx edit', scenario: 3, saves: numbered(XLSX_EDITS) }));

    const budget = await importStep(app, steps, { sandbox, root: budgetRoot, names: [SMALL_CSV_NAME],
      name: 'import 200-row csv', scenario: 4 });
    const identitiesBefore = objectIds(app, budget.projectId, SMALL_CSV_NAME);
    ({ steps } = await saveSteps(app, budget.steps, { sandbox, projectId: budget.projectId, file: smallFile,
      name: 'top-row insert', scenario: 4, saves: [1] }));
    const identitiesAfter = new Set(objectIds(app, budget.projectId, SMALL_CSV_NAME));
    const topRowInsert = { kept: identitiesBefore.filter((id) => identitiesAfter.has(id)).length,
      total: identitiesBefore.length, objectsAfter: identitiesAfter.size, removals: steps.at(-1).delta.removalRows };

    const restarted = await timed(async () => { await app.close(); app = open(); });
    steps = [...steps, measureStep(app, steps.at(-1), { name: 'restart', scenario: 5, wallMs: restarted.milliseconds })];
    ({ steps } = await saveSteps(app, steps, { sandbox, projectId: ledger.projectId, file: csvFile,
      name: 'csv edit after restart', scenario: 5, saves: [CSV_EDITS.length + 1] }));
    const firstIndexed = (name) => fileBytes(savedPath(sandbox, name, 0));
    const files = { csvFileBytes: firstIndexed(CSV_NAME), xlsxFileBytes: firstIndexed(XLSX_NAME),
      smallCsvFileBytes: firstIndexed(SMALL_CSV_NAME) };
    return { steps, files, firstCsvEdit: csvSaves.firstBreakdown, referenceCell: untouched, topRowInsert,
      restart: restartOutcome(app, ledger.projectId, steps.at(-1)), peakRssBytes: peakRssBytes() };
  } finally {
    await app.close();
  }
}

/**
 * One more save, in a process that has only just started, on the library the
 * scenarios left. Reopening in the same process keeps compiled code and
 * module state; this is the restart a relaunched app goes through.
 */
async function runFreshRestart(sandbox) {
  const loaded = await timed(() => import('../src/server.js'));
  const opened = await timed(() => loaded.value.createApplication({ dataDir: path.join(sandbox, 'data'), watchProjects: false }));
  const app = opened.value;
  try {
    const root = path.join(sandbox, 'Ledger');
    const project = app.timeline.listProjects().find((candidate) => candidate.rootPath === root);
    if (!project) throw new Error(`The library holds no folder at ${root}.`);
    const versionsBefore = rowCount(app, 'scientific_object_versions');
    fs.writeFileSync(path.join(root, CSV_NAME), fs.readFileSync(savedPath(sandbox, CSV_NAME, CSV_EDITS.length + RESTART_EDITS.length)));
    const { milliseconds } = captureSavedFile(app, project.id, CSV_NAME);
    return { moduleLoadMs: round(loaded.milliseconds, 1), openMs: round(opened.milliseconds, 1), firstEditMs: round(milliseconds, 1),
      versionRows: rowCount(app, 'scientific_object_versions') - versionsBefore };
  } finally {
    await app.close();
  }
}

/** A server with nothing indexed, left alone until its memory stops moving. */
async function runIdle(sandbox) {
  const { createApplication } = await import('../src/server.js');
  const app = createApplication({ dataDir: path.join(sandbox, 'idle-data'), watchProjects: false });
  try {
    await delay(IDLE_SETTLE_MS);
    const samples = [];
    for (let sample = 0; sample < IDLE_SAMPLES; sample += 1) {
      samples.push(process.memoryUsage().rss);
      await delay(IDLE_SAMPLE_GAP_MS);
    }
    return { idleRssBytes: median(samples), heapUsedBytes: process.memoryUsage().heapUsed };
  } finally {
    await app.close();
  }
}

function runChild(mode, sandbox) {
  const resultPath = path.join(sandbox, `${mode}.json`);
  const child = spawnSync(process.execPath, [...process.execArgv, scriptPath, '--child', mode, '--sandbox', sandbox, '--out', resultPath],
    { stdio: 'inherit' });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`The ${mode} measurement exited with ${child.status ?? child.signal}.`);
  return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
}

function targetsOf(scenarios, idle) {
  const csvEdits = scenarios.steps.filter((step) => step.scenario === 2);
  const medianOf = (read) => median(csvEdits.map(read));
  const derivedGrowth = medianOf((step) => step.delta.derivedStoredBytes);
  const warmEditMs = medianOf((step) => step.wallMs);
  const firstEditAfterRestartMs = scenarios.steps.find((step) => step.name === 'csv edit after restart').wallMs;
  return {
    versionRowsPerOneCellEdit: medianOf((step) => step.delta.versionRows),
    dbGrowthPerEditBytes: medianOf((step) => step.delta.timelineStoredBytes),
    derivedGrowthPerCsvEditBytes: derivedGrowth,
    csvFileBytes: scenarios.files.csvFileBytes,
    derivedGrowthToCsvRatio: round(derivedGrowth / scenarios.files.csvFileBytes, 2),
    identitiesKeptOnTopRowInsert: { kept: scenarios.topRowInsert.kept, total: scenarios.topRowInsert.total },
    firstEditAfterRestartMs,
    warmEditMs,
    restartToWarmRatio: round(firstEditAfterRestartMs / warmEditMs, 2),
    idleRssBytes: idle.idleRssBytes,
    peakRssBytes: scenarios.peakRssBytes,
  };
}

function readRuns() {
  if (!fs.existsSync(outputPath)) return {};
  try { return JSON.parse(fs.readFileSync(outputPath, 'utf8')); } catch (error) {
    throw new Error(`${outputPath} is not valid JSON (${error.message}). Fix or remove it before recording a run.`);
  }
}

function options() {
  const { values } = parseArgs({ options: { label: { type: 'string', default: 'latest' }, date: { type: 'string' },
    child: { type: 'string' }, sandbox: { type: 'string' }, out: { type: 'string' } } });
  if (!/^[\w.-]+$/.test(values.label)) throw new Error('--label takes letters, digits, dots, dashes and underscores.');
  if (values.date !== undefined && Number.isNaN(Date.parse(values.date))) throw new Error(`--date is not a date: ${values.date}`);
  return values;
}

async function main() {
  const { label, date, child, sandbox, out } = options();
  if (child) {
    const modes = { scenarios: runScenarios, fresh: runFreshRestart, idle: runIdle };
    if (!modes[child] || !sandbox || !out) throw new Error('A child run needs --child scenarios|fresh|idle, --sandbox and --out.');
    fs.writeFileSync(out, JSON.stringify(await modes[child](sandbox)));
    return;
  }
  const scratch = temporaryDirectory('lasso-bench-storage-');
  try {
    writeSaves(scratch);
    const scenarios = runChild('scenarios', scratch);
    const freshProcess = runChild('fresh', scratch);
    const idle = runChild('idle', scratch);
    const { steps, peakRssBytes: _peak, restart, ...details } = scenarios;
    const run = {
      date: date ?? new Date().toISOString(),
      node: process.version,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).toString().trim(),
      steps,
      targets: targetsOf(scenarios, idle),
      ...details,
      restart: { ...restart, freshProcess },
      idle,
    };
    printRun(label, run);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify({ ...readRuns(), [label]: run }, null, 2)}\n`);
    console.log(`\nWritten to ${path.relative(repoRoot, outputPath)} as "${label}".`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
