import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { createApplication } from '../src/server.js';
import { BlobStore } from '../src/history/blob-store.js';
import { scanDirectory } from '../src/history/scanner.js';
import { TextStore } from '../src/dependencies/text-store.js';

const actor = { id: 'human:indexing-architecture', displayName: 'Indexing architecture', actorType: 'HUMAN_SELF' };

function sandbox(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-indexing-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function write(root, files) {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
}

function ledger(rows, offset = 0) {
  return `Account,Value\n${Array.from({ length: rows }, (_, row) => `Item ${offset + row},${offset + row + 100}`).join('\n')}\n`;
}

function pdf(lines) {
  const escape = (text) => text.replace(/[\\()]/g, (character) => `\\${character}`);
  const stream = lines.map((text, line) => `BT /F1 12 Tf 50 ${740 - line * 24} Td (${escape(text)}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let output = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(`${output}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test('scans skip installed packages, caches and environments of any name', (t) => {
  const root = sandbox(t);
  write(root, {
    'notes.md': '# Notes\n', 'src/model.py': 'RATE = 3\n', 'analysis/renv.lock': '{}',
    '.venv/lib/python3.9/site-packages/pkg/core.py': 'x = 1\n',
    'env/pyvenv.cfg': 'home = /usr/bin\n', 'env/lib/python3.12/site-packages/numpy/core.py': 'y = 2\n',
    'tools/miniconda/conda-meta/history': '', 'tools/miniconda/lib/site.py': 'z = 3\n',
    'src/__pycache__/model.cpython-312.pyc': 'compiled', '.pycache/Users/me/app.cpython-39.pyc': 'compiled',
    'analysis/renv/library/R-4.3/dplyr/DESCRIPTION': 'Package: dplyr\n', 'web/node_modules/left-pad/index.js': '',
  });
  const environments = new Set();
  const files = scanDirectory(root, new BlobStore(path.join(root, '..', `blobs-${path.basename(root)}`)), { environments });
  t.after(() => fs.rmSync(path.join(root, '..', `blobs-${path.basename(root)}`), { recursive: true, force: true }));
  assert.deepEqual(files.map((file) => file.path).sort(), ['analysis/renv.lock', 'notes.md', 'src/model.py']);
  assert.deepEqual([...environments].sort(), ['env', 'tools/miniconda']);
});

test('a watcher ignores changes inside an environment its folder\'s scan skipped', async (t) => {
  const root = sandbox(t);
  write(root, { 'project/notes.md': '# Notes\n', 'project/venv/pyvenv.cfg': '', 'project/venv/lib/core.py': 'x = 1\n' });
  let listener;
  t.mock.method(fs, 'watch', (_root, _options, callback) => { listener = callback; return { close() {}, on() {} }; });
  const app = createApplication({ dataDir: path.join(root, 'history'), watchProjects: true, watchDebounceMs: 5 });
  t.after(() => app.close());
  const { project } = app.timeline.importProject(path.join(root, 'project'), actor);
  const captures = [];
  t.mock.method(app.timeline, 'captureFromWatcher', (...args) => captures.push(args));
  listener('change', 'venv/lib/core.py');
  listener('rename', 'venv/lib/python3.12/site-packages/new.py');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(captures.length, 0, 'pip installing into the environment records nothing');
  listener('change', 'notes.md');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(captures.length, 1);
  assert.deepEqual(captures[0][2].dirtyPaths, ['notes.md']);
  assert.ok(project.id);
});

test('a folder that stops indexing a large subfolder records it without reading the files and writes its index in full', async (t) => {
  const root = sandbox(t);
  const folder = path.join(root, 'project');
  write(folder, { 'summary.csv': ledger(3) });
  for (let index = 0; index < 30; index += 1) write(folder, { [`bulk/part-${index}.csv`]: ledger(12, index * 100) });
  const app = createApplication({ dataDir: path.join(root, 'history'), watchProjects: false });
  t.after(() => app.close());
  const { project } = app.timeline.importProject(folder, actor);
  app.dependencies.ensureIndex(project.id);
  const before = app.timeline.objectVersions.count(project.currentSnapshotId);
  const linked = app.dependencies.objectsAt(project.id).find((object) => object.path === 'bulk/part-3.csv'
    && object.objectType === 'DATASET');

  // The subfolder turns out to be a virtual environment.
  fs.writeFileSync(path.join(folder, 'bulk', 'pyvenv.cfg'), 'home = /usr/bin\n');
  const read = [];
  const get = app.timeline.blobs.get.bind(app.timeline.blobs);
  t.mock.method(app.timeline.blobs, 'get', (hash) => { read.push(hash); return get(hash); });
  const capture = app.timeline.capture(project.id, actor, { source: 'OPEN_RECONCILE' });
  assert.equal(capture.event.changes.filter((change) => change.changeType === 'DELETED').length, 30);
  assert.equal(read.length, 0, 'a removed file\'s history entry needs none of its bytes');

  app.dependencies.ensureIndex(project.id, capture.snapshot.id);
  const after = app.timeline.objectVersions.count(capture.snapshot.id);
  assert.ok(after * 4 < before, 'the fixture keeps little of its base');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM object_index_bases WHERE snapshot_id = ?').get(capture.snapshot.id).count, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM scientific_object_removals WHERE snapshot_id = ?').get(capture.snapshot.id).count, 0,
    'a removal for most of the base would be read again on every later resolution');
  assert.ok(app.dependencies.objectsAt(project.id).every((object) => object.path === 'summary.csv'));
  // A full index lists everything present, so its history still says what left.
  const [removal] = app.terminal.graph.activityChanges(project.id, { objectIds: new Set([linked.id]), includeSourceChanges: true });
  assert.equal(removal.removed, true);
  assert.equal(removal.toVersion, 2);
  assert.equal(removal.path, 'bulk/part-3.csv');
});

test('adding a folder reads it in slices and lists its progress from the moment it is chosen', async (t) => {
  const root = sandbox(t);
  const folder = path.join(root, 'Large Folder');
  for (let index = 0; index < 160; index += 1) write(folder, { [`tables/sheet-${index}.csv`]: ledger(60, index * 1000) });
  const app = createApplication({ dataDir: path.join(root, 'history'), watchProjects: false });
  t.after(() => app.close());
  const observed = [];
  const begin = app.workspace.beginIndexing.bind(app.workspace);
  t.mock.method(app.workspace, 'beginIndexing', (projectId, options) => {
    const progress = begin(projectId, options);
    const report = progress.report.bind(progress);
    progress.report = (step) => {
      report(step);
      const listed = app.workspace.state({ pending: true }).directories.find((directory) => directory.id === projectId);
      observed.push({ percent: listed?.indexing?.percent, phase: step.phase, pending: listed?.pending === true });
    };
    return progress;
  });
  let turns = 0;
  let running = true;
  const ticker = (async () => { while (running) { turns += 1; await yieldTurn(); } })();

  const adding = app.workspace.add([folder], actor);
  assert.deepEqual(app.workspace.state().directories, [], 'other clients see the folder once it is recorded');
  const first = app.workspace.state({ pending: true }).directories;
  const listedId = first[0]?.id;
  assert.equal(first.length, 1, 'the chosen folder is listed before it is read');
  assert.equal(first[0].pending, true);
  assert.equal(first[0].indexing.percent, 0);
  assert.deepEqual(first[0].indexing, { kind: 'adding', phase: 'waiting', percent: 0 });
  assert.deepEqual(app.workspace.state().activeProjectIds, [], 'a folder being read does not answer suggestions yet');
  const state = await adding;
  running = false;
  await ticker;

  assert.ok(turns > 3, `other work ran while the folder was read (${turns} turns)`);
  for (const phase of ['listing', 'reading', 'indexing', 'saving']) {
    assert.ok(observed.some((entry) => entry.phase === phase), `${phase} is reported`);
  }
  const percents = observed.map((entry) => entry.percent);
  assert.ok(percents.every((percent) => Number.isInteger(percent) && percent >= 0 && percent <= 99));
  assert.deepEqual(percents, [...percents].sort((left, right) => left - right), 'the bar only moves forward');
  assert.ok(new Set(percents).size > 10, 'the bar moves in small steps rather than jumping to the end');
  assert.ok(observed.some((entry) => entry.pending), 'the row is listed before the folder is recorded');
  const [directory] = state.directories;
  assert.equal(directory.indexing, undefined, 'finished folders carry no progress');
  assert.equal(directory.fileCount, 160);
  assert.deepEqual(state.activeProjectIds, [directory.id]);
  assert.equal(directory.id, listedId, 'the row keeps the id it was listed under');
});

test('typed object lookups are kept by type and agree with the complete snapshot', (t) => {
  const root = sandbox(t);
  const folder = path.join(root, 'project');
  write(folder, { 'a.csv': ledger(4), 'b.csv': ledger(4, 50), 'notes.md': '# Notes\n\nCapacity is reviewed annually.\n' });
  const app = createApplication({ dataDir: path.join(root, 'history'), watchProjects: false });
  t.after(() => app.close());
  const { project } = app.timeline.importProject(folder, actor);
  const types = ['DATASET_VALUE', 'DATASET'];
  const typed = app.dependencies.objectsAt(project.id, null, types);
  const mapped = t.mock.method(app.dependencies, 'mappedObjects');
  assert.deepEqual(app.dependencies.objectsAt(project.id, null, ['DATASET']),
    typed.filter((object) => object.objectType === 'DATASET'));
  assert.deepEqual(app.dependencies.objectsAt(project.id, null, types), typed);
  assert.equal(mapped.mock.callCount(), 0, 'repeated suggestions map nothing again');
  mapped.mock.restore();
  app.dependencies.typedObjectCache.clear();
  const complete = app.dependencies.objectsAt(project.id);
  assert.deepEqual(typed, complete.filter((object) => types.includes(object.objectType)));
});

test('a PDF\'s text is read once and kept across restarts', async (t) => {
  const root = sandbox(t);
  const folder = path.join(root, 'papers');
  write(folder, { 'trial.pdf': pdf(['Neural tube defects declined after folic acid fortification.']) });
  const dataDir = path.join(root, 'history');
  let app = createApplication({ dataDir, watchProjects: false });
  await app.workspace.add([folder], actor);
  const [{ id }] = app.workspace.state().directories;
  const file = app.timeline.snapshotFiles(app.timeline.getProject(id).currentSnapshotId)[0];
  const text = app.dependencies.fileText(file, 'PAPER');
  assert.match(text, /folic acid/);
  await app.close();

  app = createApplication({ dataDir, watchProjects: false });
  t.after(() => app.close());
  const read = [];
  const get = app.timeline.blobs.get.bind(app.timeline.blobs);
  t.mock.method(app.timeline.blobs, 'get', (hash) => { read.push(hash); return get(hash); });
  app.dependencies.warmPredictionCaches(id);
  assert.equal(app.dependencies.fileText(file, 'PAPER'), text);
  assert.ok(!read.includes(file.contentHash), 'the restarted server does not read the PDF again');
});

test('the text store keeps only its own reader version and tolerates damage', (t) => {
  const root = sandbox(t);
  const older = new TextStore(root, 1);
  older.set('hash|pdf|all', 'older reading');
  assert.equal(older.get('hash|pdf|all'), 'older reading');
  const current = new TextStore(root, 2);
  assert.equal(current.get('hash|pdf|all'), undefined, 'a newer reader never serves an older reading');
  assert.deepEqual(fs.readdirSync(root), [], 'older readings are removed');
  current.set('hash|pdf|pages', [{ pageNumber: 1, text: 'Plan' }]);
  fs.writeFileSync(current.pathFor('hash|pdf|pages'), '{"truncated');
  assert.equal(current.get('hash|pdf|pages'), undefined, 'a damaged entry is read again from the file');
});

test('folders indexed by an older reader are read again in the background after a restart', async (t) => {
  const root = sandbox(t);
  const folder = path.join(root, 'project');
  write(folder, { 'data.csv': ledger(3) });
  const dataDir = path.join(root, 'history');
  let app = createApplication({ dataDir, watchProjects: false });
  await app.workspace.add([folder], actor);
  const [{ id }] = app.workspace.state().directories;
  app.db.prepare('UPDATE snapshot_object_indexes SET extractor_version = 0 WHERE snapshot_id = ?')
    .run(app.timeline.getProject(id).currentSnapshotId);
  assert.equal(app.workspace.state().directories[0].issue.kind, 'READER');
  await app.close();

  app = createApplication({ dataDir, watchProjects: true });
  t.after(() => app.close());
  await app.workspace.ready;
  await app.workspace.mutations;
  const [directory] = app.workspace.state().directories;
  assert.equal(directory.issue, null, 'no folder is left asking to be re-read');
  assert.equal(app.dependencies.indexFreshness(id).stale, false);
  assert.deepEqual(app.workspace.state().activeProjectIds, [id]);
});

test('refreshing the work directory list reads no file text', async (t) => {
  const root = sandbox(t);
  const folder = path.join(root, 'papers');
  write(folder, { 'trial.pdf': pdf(['Prevalence fell by a third.']), 'data.csv': ledger(3) });
  const app = createApplication({ dataDir: path.join(root, 'history'), watchProjects: false });
  t.after(() => app.close());
  await app.workspace.add([folder], actor);
  for (const cache of [app.dependencies.objectCache, app.dependencies.typedObjectCache, app.dependencies.extractedTextCache,
    app.dependencies.sourceTextCache, app.terminal.indexing.drawingProblems]) cache.clear();
  const fileText = t.mock.method(app.dependencies, 'fileText');
  const mapped = t.mock.method(app.dependencies, 'mappedObjects');
  for (let poll = 0; poll < 3; poll += 1) app.workspace.state();
  assert.equal(fileText.mock.callCount(), 0);
  assert.equal(mapped.mock.callCount(), 0, 'drawing statuses come from their recorded metadata');
});
