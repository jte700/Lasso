import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { createApplication } from '../src/server.js';
import { createConfig } from '../src/config.js';
import { BlobStore, RECENT_TOUCH_WINDOW_MS } from '../src/history/blob-store.js';
import { COMPACTION_BATCH_BYTES, COMPACTION_BATCH_MS } from '../src/history/blob-compaction.js';

const actor = { id: 'human:compaction', displayName: 'Compaction', actorType: 'HUMAN_SELF' };
const agent = { id: 'agent:compaction', displayName: 'Compaction agent', actorType: 'AI_AGENT' };
const DAY = 86_400_000;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** A ledger of repeating lines, long enough to be worth compressing. Revision n changes row n. */
function ledger(revision) {
  const lines = ['Site,Metric,Amount'];
  for (let row = 0; row < 400; row += 1) lines.push(`Site ${row},Metric ${row % 7},${row === revision ? 999_000 + row : 1000 + row}`);
  return `${lines.join('\n')}\n`;
}

function notes(revision) {
  return `# Site notes\n\n${'Each site reports its metrics once a month to the regional office.\n'.repeat(12)}\nRevision ${revision}.\n`;
}

/** Where every build, old or new, finds a blob's raw bytes. */
const rawLocation = (app, hash) => path.join(app.config.blobDir, hash.slice(0, 2), hash.slice(2));

/** A recorded folder with a ledger and notes. `save(n)` records revision n of both. */
function library(t, overrides = {}) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-blob-compaction-')));
  const folder = path.join(sandbox, 'Sites');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'ledger.csv'), ledger(0));
  fs.writeFileSync(path.join(folder, 'notes.md'), notes(0));
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false, blobTouchWindowMs: 0, ...overrides });
  t.after(async () => {
    await app.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const project = app.timeline.importProject(folder, actor, { watch: false }).project;
  const save = (revision, files = ['ledger.csv', 'notes.md']) => {
    if (files.includes('ledger.csv')) fs.writeFileSync(path.join(folder, 'ledger.csv'), ledger(revision));
    if (files.includes('notes.md')) fs.writeFileSync(path.join(folder, 'notes.md'), notes(revision));
    const capture = app.timeline.capture(project.id, actor, { source: 'WATCHER', dirtyPaths: files });
    assert.equal(capture.changed, true, `revision ${revision} should be recorded`);
    return capture;
  };
  return { app, sandbox, folder, project, save };
}

/** Runs compaction batch after batch until a whole pass is done, and returns the hashes it compressed. */
function drain(app, now = Date.now()) {
  const compacted = [];
  for (let batches = 0; batches < 1_000; batches += 1) {
    const batch = app.compaction.compactBatch({ now });
    compacted.push(...batch.compacted.map((entry) => entry.contentHash));
    if (batch.done) return compacted.sort();
  }
  throw new Error('Compaction did not finish.');
}

/** Makes every stored blob look as if nothing had touched it for `ageMs`. */
function ageBlobs(app, ageMs) {
  const then = new Date(Date.now() - ageMs);
  for (const entry of fs.readdirSync(app.config.blobDir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) fs.utimesSync(path.join(entry.parentPath, entry.name), then, then);
  }
}

test('Every current version stays raw where an earlier build reads it, through several edits', (t) => {
  // Arrange
  const { app, project, save } = library(t);
  const blobs = app.timeline.blobs;

  for (let revision = 1; revision <= 4; revision += 1) {
    // Act: an earlier build, about to diff the next edit, reads the current version from its raw path.
    drain(app);
    const current = app.timeline.snapshotFiles(app.timeline.getProject(project.id).currentSnapshotId);
    for (const file of current) {
      // Assert
      assert.deepEqual(fs.readFileSync(blobs.pathFor(file.contentHash)), fs.readFileSync(rawLocation(app, file.contentHash)));
      assert.equal(blobs.pathFor(file.contentHash), rawLocation(app, file.contentHash), `${file.path} is handed out where it lies`);
      const expected = file.path === 'ledger.csv' ? ledger(revision - 1) : notes(revision - 1);
      assert.equal(fs.readFileSync(rawLocation(app, file.contentHash), 'utf8'), expected, `${file.path} at revision ${revision - 1}`);
    }
    save(revision);
  }
  const compacted = drain(app);

  // Assert: the versions no folder holds now are compressed, and read back whole.
  for (let revision = 0; revision <= 3; revision += 1) {
    for (const text of [ledger(revision), notes(revision)]) {
      const hash = sha256(text);
      assert.ok(compacted.includes(hash) || blobs.encodingOf(hash) === 'zstd', `revision ${revision} is compressed`);
      assert.equal(fs.existsSync(rawLocation(app, hash)), false);
      assert.equal(blobs.get(hash).toString(), text);
      assert.deepEqual(zlib.zstdDecompressSync(fs.readFileSync(`${rawLocation(app, hash)}.zst`)).toString(), text);
    }
  }
  for (const text of [ledger(4), notes(4)]) assert.equal(blobs.encodingOf(sha256(text)), 'raw');
  const timeline = app.timeline.listEvents(project.id);
  assert.ok(timeline.length >= 5, 'every edit is recorded');
});

test('A compressed version that becomes current again is stored raw again', (t) => {
  // Arrange
  const { app, sandbox, folder, project, save } = library(t);
  save(1);
  save(2);
  drain(app);
  const first = sha256(ledger(0));
  const second = sha256(notes(1));
  assert.equal(app.timeline.blobs.encodingOf(first), 'zstd');
  assert.equal(app.timeline.blobs.encodingOf(second), 'zstd');

  // Act: the ledger goes back to its first content, and another folder holds the second notes.
  fs.writeFileSync(path.join(folder, 'ledger.csv'), ledger(0));
  app.timeline.capture(project.id, actor, { source: 'WATCHER', dirtyPaths: ['ledger.csv'] });
  const other = path.join(sandbox, 'Copy');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'notes.md'), notes(1));
  app.timeline.importProject(other, actor, { watch: false });
  drain(app);

  // Assert
  assert.equal(fs.readFileSync(rawLocation(app, first), 'utf8'), ledger(0));
  assert.equal(fs.readFileSync(rawLocation(app, second), 'utf8'), notes(1));
  assert.equal(app.timeline.blobs.get(first).toString(), ledger(0));
});

test('The versions a pending agent edit names stay raw', (t) => {
  // Arrange: an agent proposes new notes, and the notes change before anyone applies it.
  const { app, project, save } = library(t);
  const proposal = app.timeline.proposeAgentEdit(project.id, { agent, initiatedBy: actor, path: 'notes.md', content: notes(9), request: 'Revise.' });
  save(1);

  // Act
  const compacted = drain(app);

  // Assert
  assert.equal(compacted.includes(proposal.proposal.contentHashBefore), false);
  assert.equal(fs.readFileSync(rawLocation(app, proposal.proposal.contentHashBefore), 'utf8'), notes(0));
  assert.equal(fs.readFileSync(rawLocation(app, proposal.proposal.contentHashAfter), 'utf8'), notes(9));
  assert.ok(compacted.includes(sha256(ledger(0))), 'the old ledger, which nothing pending names, is compressed');
});

test('Compression of old versions is on by default and has its own switch', (t) => {
  // Arrange
  const previous = process.env.LASSO_BLOB_COMPRESSION;
  t.after(() => {
    if (previous === undefined) delete process.env.LASSO_BLOB_COMPRESSION;
    else process.env.LASSO_BLOB_COMPRESSION = previous;
  });
  const { app, save } = library(t, { blobCompressionEnabled: false });
  save(1);

  // Act
  const compacted = drain(app);
  delete process.env.LASSO_BLOB_COMPRESSION;
  const byDefault = createConfig({ dataDir: app.config.dataDir });
  process.env.LASSO_BLOB_COMPRESSION = 'off';
  const switchedOff = createConfig({ dataDir: app.config.dataDir });

  // Assert
  assert.deepEqual(compacted, []);
  assert.equal(app.timeline.blobs.encodingOf(sha256(ledger(0))), 'raw');
  assert.equal(byDefault.blobCompressionEnabled, true);
  assert.equal(byDefault.blobRetentionEnabled, false, 'releasing bytes stays off on its own switch');
  assert.equal(switchedOff.blobCompressionEnabled, false);
  assert.equal(app.compaction.timer, null, 'no timer runs for a switch that is off');
});

test('Compaction waits while a capture is being read', (t) => {
  // Arrange
  const { app, folder, project, save } = library(t);
  save(1);
  fs.writeFileSync(path.join(folder, 'ledger.csv'), ledger(0));
  const steps = app.timeline.captureSteps(project.id, actor, { source: 'WATCHER', dirtyPaths: ['ledger.csv'] });
  steps.next();

  // Act
  const during = app.compaction.compactBatch();
  let step = steps.next();
  while (!step.done) step = steps.next();
  const after = drain(app);

  // Assert
  assert.equal(during.waiting, 'capture');
  assert.deepEqual(during.compacted, []);
  assert.equal(step.value.changed, true);
  assert.equal(after.includes(sha256(ledger(0))), false, 'the content the ledger went back to is current again');
  assert.equal(fs.readFileSync(rawLocation(app, sha256(ledger(0))), 'utf8'), ledger(0));
  assert.ok(after.includes(sha256(ledger(1))));
});

test('Compaction starts by itself once captures stop, and leaves no timer running', async (t) => {
  // Arrange
  const { app, save } = library(t, { blobCompressionIdleMs: 5 });

  // Act
  save(1);
  for (let waited = 0; waited < 200 && (app.timeline.blobs.encodingOf(sha256(ledger(0))) !== 'zstd' || app.compaction.timer); waited += 1) {
    await wait(10);
  }

  // Assert
  assert.equal(app.timeline.blobs.encodingOf(sha256(ledger(0))), 'zstd');
  assert.equal(app.timeline.blobs.encodingOf(sha256(ledger(1))), 'raw');
  assert.equal(app.compaction.timer, null, 'nothing is scheduled once a pass is done');
});

test('A blob found again recently is neither compressed nor released', (t) => {
  // Arrange: every version looks a day old, then another capture finds the first ledger again.
  const { app, sandbox, project, save } = library(t, { blobTouchWindowMs: RECENT_TOUCH_WINDOW_MS, blobRetentionEnabled: true,
    blobRetentionVersions: 1, blobRetentionDays: 0, blobRetentionGraceMs: 0 });
  // Every version is indexed, so its values are recorded and its bytes may go.
  app.dependencies.ensureIndex(project.id);
  save(1);
  save(2);
  ageBlobs(app, DAY);
  const before = fs.statSync(rawLocation(app, sha256(ledger(0)))).mtimeMs;
  const store = new BlobStore(app.config.blobDir);
  store.put(Buffer.from(ledger(0)));
  fs.mkdirSync(path.join(sandbox, 'Elsewhere'));
  fs.writeFileSync(path.join(sandbox, 'Elsewhere', 'notes.md'), notes(1));
  store.putFile(path.join(sandbox, 'Elsewhere', 'notes.md'));

  // Act
  const compacted = drain(app);
  const released = [];
  for (let batches = 0; batches < 100; batches += 1) {
    const batch = app.retention.releaseBatch({ now: Date.now() });
    released.push(...batch.released.map((entry) => entry.contentHash));
    if (batch.done) break;
  }

  // Assert
  assert.ok(fs.statSync(rawLocation(app, sha256(ledger(0)))).mtimeMs > before, 'storing bytes already there marks them');
  assert.ok(RECENT_TOUCH_WINDOW_MS >= 10 * 60 * 1000 && RECENT_TOUCH_WINDOW_MS >= app.config.blobRetentionIdleMs);
  for (const text of [ledger(0), notes(1)]) {
    assert.equal(compacted.includes(sha256(text)), false);
    assert.equal(released.includes(sha256(text)), false);
    assert.equal(app.timeline.blobs.encodingOf(sha256(text)), 'raw');
  }
  assert.ok(released.includes(sha256(notes(0))), 'versions nobody has found again still go');
});

test('Compressed bytes replace the raw ones only once they read back whole', (t) => {
  // Arrange: a damaged compressed copy already lies beside an old version.
  const { app, save } = library(t);
  save(1);
  const hash = sha256(ledger(0));
  fs.writeFileSync(`${rawLocation(app, hash)}.zst`, zlib.zstdCompressSync(Buffer.from(ledger(5))));

  // Act
  drain(app);

  // Assert
  assert.equal(app.timeline.blobs.get(hash).toString(), ledger(0));
  assert.equal(zlib.zstdDecompressSync(fs.readFileSync(`${rawLocation(app, hash)}.zst`)).toString(), ledger(0));
  const leftovers = fs.readdirSync(path.dirname(rawLocation(app, hash))).filter((name) => name.includes('.tmp') || name.includes('.withdrawn'));
  assert.deepEqual(leftovers, []);
});

test('The decompress command turns every compressed version back into a raw one, and can be stopped and run again', (t) => {
  // Arrange: a library with compressed old versions, part way through an earlier decompress.
  const { app, save } = library(t);
  save(1);
  save(2);
  const compacted = drain(app);
  assert.ok(compacted.length >= 4);
  const interrupted = compacted[0];
  fs.writeFileSync(rawLocation(app, interrupted), app.timeline.blobs.get(interrupted));
  const script = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts['blobs:decompress'];
  const run = () => execFileSync(process.execPath, ['scripts/decompress-blobs.mjs', '--data-dir', app.config.dataDir], { encoding: 'utf8' });

  // Act
  const output = run();
  const again = run();

  // Assert
  assert.match(script, /scripts\/decompress-blobs\.mjs/);
  for (const hash of compacted) {
    assert.equal(fs.existsSync(`${rawLocation(app, hash)}.zst`), false);
    assert.equal(sha256(fs.readFileSync(rawLocation(app, hash))), hash);
  }
  assert.match(output, new RegExp(`${compacted.length} compressed blobs`));
  assert.match(again, /0 compressed blobs/, 'running it again changes nothing');
  assert.throws(() => execFileSync(process.execPath, ['scripts/decompress-blobs.mjs'], { stdio: 'pipe' }), 'it names no library by itself');
});

test('Temporary files a stopped store left behind are cleared from its folders', (t) => {
  // Arrange: an hour-old temporary file of each kind, and a fresh one, where the next blob goes.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-blob-temporaries-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from(ledger(3));
  const hash = sha256(bytes);
  const folder = path.join(root, hash.slice(0, 2));
  fs.mkdirSync(folder, { recursive: true });
  const stale = [`${'a'.repeat(62)}.123.${crypto.randomUUID()}.tmp`, `${'b'.repeat(62)}.zst.123.${crypto.randomUUID()}.tmp`];
  const fresh = `${'c'.repeat(62)}.123.${crypto.randomUUID()}.tmp`;
  const then = new Date(Date.now() - 2 * 60 * 60 * 1000);
  for (const name of stale) {
    fs.writeFileSync(path.join(folder, name), 'partial');
    fs.utimesSync(path.join(folder, name), then, then);
  }
  fs.writeFileSync(path.join(folder, fresh), 'partial');
  const kept = path.join(folder, 'd'.repeat(62));
  fs.writeFileSync(kept, 'a blob');
  fs.utimesSync(kept, then, then);

  // Act
  const store = new BlobStore(root);
  store.put(bytes);

  // Assert
  assert.deepEqual(fs.readdirSync(folder).sort(), [fresh, 'd'.repeat(62), hash.slice(2)].sort());
});

/** The old text versions three saves leave behind: revisions 0 to 2 of the ledger and the notes. */
const oldVersions = () => [0, 1, 2].flatMap((revision) => [sha256(ledger(revision)), sha256(notes(revision))]).sort();

/** Runs batches with the given budget until a pass is done, and returns each batch. */
function batchesWithin(app, budget) {
  const batches = [];
  for (let count = 0; count < 100; count += 1) {
    const batch = app.compaction.compactBatch(budget);
    batches.push(batch);
    if (batch.done) return batches;
  }
  throw new Error('Compaction did not finish.');
}

test('A compaction batch stops once it has read its share of bytes, and the next batch carries on', (t) => {
  // Arrange: every old ledger alone is close to the cap, so no batch can take two of them.
  const { app, save } = library(t);
  for (let revision = 1; revision <= 3; revision += 1) save(revision);
  const maxBytes = Buffer.byteLength(ledger(0)) + 10;

  // Act
  const batches = batchesWithin(app, { maxBytes });

  // Assert
  const compacted = batches.flatMap((batch) => batch.compacted.map((entry) => entry.contentHash)).sort();
  assert.deepEqual(compacted, oldVersions(), 'every old version is compressed once over the pass');
  assert.ok(batches.length >= 3, 'the three old ledgers take a batch each');
  assert.ok(batches.slice(0, -1).every((batch) => batch.done === false), 'a batch that stops early does not end the pass');
  for (const batch of batches) {
    const read = batch.compacted.reduce((total, entry) => total + entry.storedBytes + entry.savedBytes, 0);
    assert.equal(batch.readBytes, read);
    assert.ok(batch.compacted.length <= 1 || read <= maxBytes, `a batch read ${read} bytes, past the cap`);
  }
});

test('A compaction batch stops once its time is up, after compressing at least one version', (t) => {
  // Arrange
  const { app, save } = library(t);
  for (let revision = 1; revision <= 3; revision += 1) save(revision);

  // Act
  const batches = batchesWithin(app, { maxMs: 0 });

  // Assert
  const compacted = batches.flatMap((batch) => batch.compacted.map((entry) => entry.contentHash)).sort();
  assert.deepEqual(compacted, oldVersions());
  assert.ok(batches.every((batch) => batch.compacted.length <= 1), 'each batch compresses one version and stops');
  assert.equal(batches.filter((batch) => batch.compacted.length === 1).length, oldVersions().length);
});

test('The default budget of a compaction batch keeps one batch short', () => {
  // Assert: about 32 MB of text, or about 100 ms, whichever comes first.
  assert.equal(COMPACTION_BATCH_BYTES, 32 * 1024 * 1024);
  assert.equal(COMPACTION_BATCH_MS, 100);
});
