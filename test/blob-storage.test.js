import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createApplication } from '../src/server.js';
import { BLOB_CHUNK_BYTES, BlobStore, COMPRESS_MAX_BYTES, COMPRESS_MIN_BYTES, RAW_CACHE_MAX_ENTRIES } from '../src/history/blob-store.js';
import { scanDirectory } from '../src/history/scanner.js';
import { isCompressibleType } from '../src/history/file-types.js';
import { MAX_IN_MEMORY_PART_BYTES } from '../src/dependencies/document-extraction.js';

const actor = { id: 'human:blob-storage', displayName: 'Blob storage', actorType: 'HUMAN_SELF' };
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function sandbox(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-blob-storage-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** A ledger of repeating lines, long enough to be worth compressing. */
function ledger(rows, changedRow = null) {
  const lines = ['Site,Metric,Amount'];
  for (let row = 0; row < rows; row += 1) lines.push(`Site ${row},Metric ${row % 7},${row === changedRow ? 999_999 : 1000 + row}`);
  return `${lines.join('\n')}\n`;
}

/** The smallest PNG header that states a size. */
function pngHeader(width, height) {
  const header = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

/** Records whole-file reads and the size of each chunk read from files under `directory`. */
function watchReads(t, directory) {
  const seen = { whole: [], chunks: [], descriptors: new Set() };
  const readFile = fs.readFileSync;
  const open = fs.openSync;
  const read = fs.readSync;
  const inside = (file) => typeof file === 'string' && file.startsWith(`${directory}${path.sep}`);
  t.mock.method(fs, 'readFileSync', function (file, ...rest) {
    if (inside(file)) seen.whole.push(file);
    return readFile.call(this, file, ...rest);
  });
  t.mock.method(fs, 'openSync', function (file, ...rest) {
    const descriptor = open.call(this, file, ...rest);
    if (inside(file)) seen.descriptors.add(descriptor);
    return descriptor;
  });
  t.mock.method(fs, 'readSync', function (descriptor, ...rest) {
    const count = read.call(this, descriptor, ...rest);
    if (seen.descriptors.has(descriptor)) seen.chunks.push(count);
    return count;
  });
  return seen;
}

test('A large file is stored without being read whole', (t) => {
  // Arrange
  const directory = sandbox(t);
  const folder = path.join(directory, 'project');
  fs.mkdirSync(folder);
  const bytes = crypto.randomBytes(BLOB_CHUNK_BYTES * 3 + 4321);
  const source = path.join(folder, 'survey.pdf');
  fs.writeFileSync(source, bytes);
  const store = new BlobStore(path.join(directory, 'blobs'));
  const reads = watchReads(t, folder);

  // Act
  const [file] = scanDirectory(folder, store);

  // Assert
  assert.equal(file.contentHash, sha256(bytes));
  assert.deepEqual(reads.whole, [], 'the file is never read in one piece');
  assert.ok(reads.chunks.length >= 4, `it is read a chunk at a time (${reads.chunks.length} reads)`);
  assert.ok(Math.max(...reads.chunks) <= BLOB_CHUNK_BYTES, 'no read is larger than a chunk');
  assert.equal(store.encodingOf(file.contentHash), 'raw');
  assert.equal(sha256(store.get(file.contentHash)), file.contentHash);
  assert.equal(sha256(fs.readFileSync(store.rawPath(file.contentHash))), file.contentHash);
  assert.deepEqual(fs.readdirSync(store.root).filter((name) => name.endsWith('.tmp')), [], 'no temporary file is left behind');
});

test('A file stored from its path matches the same bytes stored from memory', (t) => {
  const directory = sandbox(t);
  const store = new BlobStore(path.join(directory, 'blobs'));
  const bytes = crypto.randomBytes(BLOB_CHUNK_BYTES + 99);
  const source = path.join(directory, 'model.step');
  fs.writeFileSync(source, bytes);

  const fromMemory = store.put(bytes);
  const fromPath = store.putFile(source);

  assert.equal(fromPath.contentHash, fromMemory);
  assert.equal(fromPath.size, bytes.length);
  assert.deepEqual(store.get(fromMemory), bytes);
});

test('A file that is already stored is hashed again without being written again', (t) => {
  const directory = sandbox(t);
  const store = new BlobStore(path.join(directory, 'blobs'));
  const bytes = crypto.randomBytes(BLOB_CHUNK_BYTES * 2 + 5);
  const source = path.join(directory, 'film.mov');
  fs.writeFileSync(source, bytes);
  const { contentHash } = store.putFile(source);
  const writes = t.mock.method(fs, 'writeSync');

  const again = store.putFile(source, { expectedHash: contentHash });

  assert.equal(again.contentHash, contentHash);
  assert.equal(writes.mock.callCount(), 0, 'nothing is written for bytes the store already holds');
});

test('A file that changes while it is read is stored as the bytes that were hashed', (t) => {
  // Arrange
  const directory = sandbox(t);
  const store = new BlobStore(path.join(directory, 'blobs'));
  const source = path.join(directory, 'recording.mov');
  fs.writeFileSync(source, crypto.randomBytes(BLOB_CHUNK_BYTES * 2 + 17));
  const read = fs.readSync;
  let rewritten = false;
  t.mock.method(fs, 'readSync', function (...rest) {
    const count = read.apply(this, rest);
    // Another program overwrites the rest of the file after the first chunk is read.
    if (!rewritten) {
      rewritten = true;
      const writer = fs.openSync(source, 'r+');
      fs.writeSync(writer, crypto.randomBytes(BLOB_CHUNK_BYTES), 0, BLOB_CHUNK_BYTES, BLOB_CHUNK_BYTES);
      fs.closeSync(writer);
    }
    return count;
  });

  // Act
  const { contentHash } = store.putFile(source);

  // Assert
  assert.equal(sha256(store.get(contentHash)), contentHash);
});

test("A picture's size is read from the first bytes of its file", (t) => {
  const directory = sandbox(t);
  const folder = path.join(directory, 'project');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'plan.png'), Buffer.concat([pngHeader(640, 480), crypto.randomBytes(BLOB_CHUNK_BYTES * 2)]));

  const [file] = scanDirectory(folder, new BlobStore(path.join(directory, 'blobs')));

  assert.deepEqual(file.metadata, { width: 640, height: 480 });
});

/** Stores bytes and compresses them at once, as compaction later does to an old text version. */
function storeCompressed(store, buffer) {
  const hash = store.put(buffer);
  assert.ok(store.compact(hash, Infinity), 'the bytes compress');
  return hash;
}

test('Old uncompressed blobs still read', (t) => {
  // Arrange: a text blob written whole at its raw path, as earlier builds stored every file.
  const directory = sandbox(t);
  const root = path.join(directory, 'blobs');
  const text = Buffer.from(ledger(400));
  const hash = sha256(text);
  fs.mkdirSync(path.join(root, hash.slice(0, 2)), { recursive: true });
  fs.writeFileSync(path.join(root, hash.slice(0, 2), hash.slice(2)), text);
  const store = new BlobStore(root);

  // Act
  const stored = store.put(text);

  // Assert
  assert.equal(stored, hash);
  assert.equal(store.has(hash), true);
  assert.deepEqual(store.get(hash), text);
  assert.equal(store.encodingOf(hash), 'raw', 'bytes already stored are not stored a second time');
  assert.equal(store.rawPath(hash), path.join(root, hash.slice(0, 2), hash.slice(2)));
  assert.equal(store.pathFor(hash), store.rawPath(hash));
});

test('Every file is stored raw when recorded, and an old text version compresses and reads back identical', (t) => {
  // Arrange
  const directory = sandbox(t);
  const folder = path.join(directory, 'Clinic');
  fs.mkdirSync(folder);
  const table = Buffer.from(ledger(2_000));
  const picture = Buffer.concat([pngHeader(8, 8), crypto.randomBytes(4_000)]);
  const tiny = Buffer.from('ok\n');
  fs.writeFileSync(path.join(folder, 'ledger.csv'), table);
  fs.writeFileSync(path.join(folder, 'scan.png'), picture);
  fs.writeFileSync(path.join(folder, 'tiny.txt'), tiny);
  const app = createApplication({ dataDir: path.join(directory, 'history'), watchProjects: false });
  t.after(() => app.close());

  // Act
  app.timeline.importProject(folder, actor);
  const blobs = app.timeline.blobs;
  const encodings = [table, picture, tiny].map((bytes) => blobs.encodingOf(sha256(bytes)));
  const results = [table, picture, tiny].map((bytes) => blobs.compact(sha256(bytes), Infinity));

  // Assert
  assert.deepEqual(encodings, ['raw', 'raw', 'raw'], 'a file is stored where every earlier build reads it');
  assert.equal(blobs.encodingOf(sha256(table)), 'zstd');
  assert.deepEqual(blobs.get(sha256(table)), table);
  assert.ok(results[0].savedBytes > table.length / 2, 'the table takes less room than its text');
  assert.ok(blobs.storedBytes(sha256(table)) < table.length / 2);
  assert.equal(fs.existsSync(path.join(blobs.root, sha256(table).slice(0, 2), sha256(table).slice(2))), false);
  assert.deepEqual(zlib.zstdDecompressSync(fs.readFileSync(path.join(blobs.root, sha256(table).slice(0, 2), `${sha256(table).slice(2)}.zst`))), table);
  assert.equal(results[1], null, 'random bytes do not shrink');
  assert.equal(blobs.encodingOf(sha256(picture)), 'raw');
  assert.equal(results[2], null, 'a few bytes are not worth compressing');
  assert.equal(blobs.encodingOf(sha256(tiny)), 'raw');
  assert.ok(tiny.length < COMPRESS_MIN_BYTES && COMPRESS_MIN_BYTES < COMPRESS_MAX_BYTES);
});

test('Bytes held only compressed are written raw again when they are stored again', (t) => {
  // Arrange
  const directory = sandbox(t);
  const store = new BlobStore(path.join(directory, 'blobs'));
  const texts = [Buffer.from(ledger(500)), Buffer.from(ledger(500, 3))];
  const hashes = texts.map((text) => storeCompressed(store, text));
  const source = path.join(directory, 'ledger.csv');
  fs.writeFileSync(source, texts[1]);

  // Act
  store.put(texts[0]);
  store.putFile(source, { expectedHash: hashes[1] });

  // Assert
  for (const [index, hash] of hashes.entries()) {
    assert.deepEqual(fs.readFileSync(store.rawLocation(hash)), texts[index], `text ${index} lies raw where earlier builds read it`);
    assert.equal(store.encodingOf(hash), 'raw');
  }
});

test('Compressed blobs are turned back into raw ones for an earlier build', (t) => {
  // Arrange: a data folder whose old text was compressed, one blob in both forms.
  const directory = sandbox(t);
  const root = path.join(directory, 'blobs');
  const store = new BlobStore(root);
  const texts = [Buffer.from(ledger(500)), Buffer.from(ledger(500, 3))];
  const hashes = texts.map((text) => storeCompressed(store, text));
  fs.writeFileSync(store.rawLocation(hashes[1]), texts[1]);
  const picture = Buffer.concat([pngHeader(8, 8), crypto.randomBytes(4_000)]);
  const pictureHash = store.put(picture);
  assert.deepEqual(hashes.map((hash) => fs.existsSync(store.compressedLocation(hash))), [true, true]);

  // Act
  const output = execFileSync(process.execPath, ['scripts/decompress-blobs.mjs', directory], { encoding: 'utf8' });
  const again = execFileSync(process.execPath, ['scripts/decompress-blobs.mjs', directory], { encoding: 'utf8' });

  // Assert
  const reopened = new BlobStore(root);
  for (const [index, hash] of hashes.entries()) {
    assert.equal(fs.existsSync(reopened.compressedLocation(hash)), false, `text ${index} has no compressed form left`);
    assert.deepEqual(fs.readFileSync(reopened.rawLocation(hash)), texts[index]);
  }
  assert.deepEqual(reopened.get(pictureHash), picture);
  assert.match(output, /2 compressed blobs/);
  assert.match(again, /0 compressed blobs/, 'running it again changes nothing');
});

test('Only textual kinds of file are compressed', () => {
  for (const type of ['text', 'table', 'code', 'json', 'markdown', 'xml', 'yaml', 'notebook']) assert.equal(isCompressibleType(type), true, type);
  for (const type of ['spreadsheet', 'document', 'presentation', 'pdf', 'image', 'video', 'drawing', 'binary']) {
    assert.equal(isCompressibleType(type), false, type);
  }
});

test('Text that does not shrink, or is past the size ceiling, is kept as it is', (t) => {
  const directory = sandbox(t);
  const store = new BlobStore(path.join(directory, 'blobs'));
  // Random bytes named as text: compressing them would only add to them.
  const noise = crypto.randomBytes(COMPRESS_MIN_BYTES * 8);
  const source = path.join(directory, 'huge.csv');
  const descriptor = fs.openSync(source, 'w');
  const line = Buffer.from(`${'Site 1,Metric 2,1000\n'.repeat(4096)}`);
  for (let written = 0; written <= COMPRESS_MAX_BYTES; written += line.length) fs.writeSync(descriptor, line);
  fs.closeSync(descriptor);

  const noiseHash = store.put(noise);
  const huge = store.putFile(source);

  assert.equal(store.compact(noiseHash, Infinity), null);
  assert.equal(store.compact(huge.contentHash, Infinity), null);
  assert.equal(store.encodingOf(noiseHash), 'raw');
  assert.equal(store.encodingOf(huge.contentHash), 'raw');
  assert.equal(fs.statSync(store.rawPath(huge.contentHash)).size, huge.size);
});

test('A compressed blob is handed out as a raw copy, and removing it removes every form', (t) => {
  // Arrange
  const directory = sandbox(t);
  const store = new BlobStore(path.join(directory, 'blobs'), { rawCacheDir: path.join(directory, 'raw') });
  const texts = Array.from({ length: RAW_CACHE_MAX_ENTRIES + 3 }, (_, index) => Buffer.from(ledger(300, index)));
  const hashes = texts.map((text) => storeCompressed(store, text));

  // Act
  const copies = hashes.map((hash) => store.rawPath(hash));

  // Assert
  assert.deepEqual(fs.readFileSync(copies.at(-1)), texts.at(-1));
  assert.ok(copies.every((copy) => copy.startsWith(path.join(directory, 'raw'))), 'copies are kept apart from the blobs');
  assert.ok(fs.readdirSync(path.join(directory, 'raw')).length <= RAW_CACHE_MAX_ENTRIES, 'only a few copies are kept');
  assert.equal(fs.existsSync(copies[0]), false, 'the copy made first is dropped first');
  assert.deepEqual(fs.readFileSync(store.rawPath(hashes[0])), texts[0], 'and made again when asked for');

  store.remove(hashes[0]);
  assert.equal(store.has(hashes[0]), false);
  assert.equal(fs.existsSync(copies[0]), false);
  assert.throws(() => store.rawPath(hashes[0]), { code: 'BLOB_MISSING' });
  assert.throws(() => store.pathFor(hashes[0]), { code: 'BLOB_MISSING' }, 'a path is never given for bytes that are not there');
  assert.throws(() => store.get(hashes[0]), { code: 'BLOB_MISSING' });
});

test('A compressed table is still read by its worker', (t) => {
  // Arrange: past the size the in-memory reader holds, so a worker streams it from a path.
  const directory = sandbox(t);
  const folder = path.join(directory, 'Mortality');
  fs.mkdirSync(folder);
  const rows = 140_000;
  const lines = ['Region,Deaths,Rate'];
  for (let row = 0; row < rows; row += 1) lines.push(`Ontario health district ${row},${(row * 7) % 5000 + 1},${(row % 97) / 10}`);
  const csv = Buffer.from(`${lines.join('\n')}\n`);
  assert.ok(csv.length > MAX_IN_MEMORY_PART_BYTES && csv.length < COMPRESS_MAX_BYTES, 'the fixture needs the worker');
  fs.writeFileSync(path.join(folder, 'deaths.csv'), csv);
  const app = createApplication({ dataDir: path.join(directory, 'history'), watchProjects: false });
  t.after(() => app.close());
  // Recorded but not yet read, then compressed as an old version would be.
  app.timeline.captureListeners.clear();
  const { project } = app.timeline.importProject(folder, actor, { watch: false });
  const [file] = app.timeline.snapshotFiles(project.currentSnapshotId);
  assert.ok(app.timeline.blobs.compact(file.contentHash, Infinity));

  // Act
  app.dependencies.ensureIndex(project.id);

  // Assert
  assert.equal(app.timeline.blobs.encodingOf(file.contentHash), 'zstd');
  const [table] = app.dependencies.tables.sheets(file.contentHash);
  assert.equal(table.rowCount, rows + 1, 'the worker read every row');
  const last = app.dependencies.tables.rows(table.id, table.rowCount - 1, table.rowCount)[0];
  assert.equal(last.cells[0], `Ontario health district ${rows - 1}`);
});
