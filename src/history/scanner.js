import fs from 'node:fs';
import path from 'node:path';
import { detectFileType, isTrackedFile } from './file-types.js';
import { runSync, workUnits } from './work.js';

// Directories that hold tools' files rather than the user's work: version
// control, installed packages, language and build caches, and the metadata
// macOS and Windows keep on each volume. A Python environment inside a project
// held thousands of library sources, and indexing them crowded out the work.
const IGNORED_DIRECTORIES = new Set([
  '.git', '.svn', '.hg', '.lasso-data', '.colab-dry-data',
  'node_modules', 'bower_components', 'site-packages', '.venv', '.tox', '.nox', '.eggs',
  '__pycache__', '.pycache', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.ipynb_checkpoints',
  '.gradle', '.parcel-cache', '.next', '.nuxt', '.svelte-kit', '.turbo', '.terraform', '.Rproj.user',
  '.Trash', '.Trashes', '.Spotlight-V100', '.fseventsd', '.TemporaryItems', '.DocumentRevisions-V100',
  '$RECYCLE.BIN', 'System Volume Information',
]);
// R's project libraries keep installed packages under the project itself.
const IGNORED_SUBPATHS = /(?:^|\/)(?:renv\/(?:library|staging|sandbox)|packrat\/lib(?:-[^/]*)?)(?:\/|$)/;
// A virtual or conda environment can have any name; these entries mark one.
const ENVIRONMENT_MARKERS = new Set(['pyvenv.cfg', 'conda-meta']);

export function isIgnoredScanPath(relativePath) {
  return relativePath.split('/').some((part) => IGNORED_DIRECTORIES.has(part)) || IGNORED_SUBPATHS.test(relativePath);
}

/** Whether a directory's entries mark it as a Python virtual or conda environment. */
export function isEnvironmentDirectory(entries) {
  return entries.some((entry) => ENVIRONMENT_MARKERS.has(typeof entry === 'string' ? entry : entry.name));
}

function statFingerprint(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/** Whether two file records carry the same stat values. A record without a change time matches none. */
export function sameRecordedStat(left, right) {
  return left.ctimeMs != null && left.ctimeMs === right.ctimeMs && left.mtimeMs === right.mtimeMs
    && left.size === right.size && String(left.device) === String(right.device) && String(left.inode) === String(right.inode);
}

/** A recorded snapshot file in the shape a scan produces. */
export function scannedFile(file) {
  return { path: file.path, contentHash: file.contentHash, size: file.size, mtimeMs: file.mtimeMs,
    ctimeMs: file.ctimeMs ?? null, fileType: file.fileType, device: file.device, inode: file.inode, metadata: file.metadata };
}

/**
 * Whether a file still matches its cached entry. A live entry holds the exact
 * fingerprint. An entry seeded from the last snapshot after a restart holds
 * the recorded stat values; without a recorded change time it is not trusted.
 * Such an entry may also hold `verified`, the fingerprint an earlier scan
 * read these same bytes under (verified-stats.js).
 */
function matchesCache(cached, fingerprint, stat) {
  if (!cached) return false;
  if (cached.fingerprint) return cached.fingerprint === fingerprint;
  if (cached.verified === fingerprint) return true;
  const recorded = cached.file;
  return recorded.ctimeMs != null && String(stat.dev) === String(recorded.device)
    && String(stat.ino) === String(recorded.inode) && Number(stat.size) === recorded.size
    && Number(stat.mtimeNs) / 1_000_000 === recorded.mtimeMs && Number(stat.ctimeNs) / 1_000_000 === recorded.ctimeMs;
}

function isDirty(relativePath, dirtyPaths) {
  for (let current = relativePath; current !== '.'; current = path.posix.dirname(current)) {
    if (dirtyPaths.has(current)) return true;
  }
  return false;
}

// A PNG states its size in its first bytes; no other metadata is read from a file.
const METADATA_HEAD_BYTES = 24;

/** A file's recorded metadata, from the first bytes of it. */
function metadataFor(type, head) {
  const metadata = {};
  if (type === 'image' && head.length >= METADATA_HEAD_BYTES && head.subarray(1, 4).toString() === 'PNG') {
    metadata.width = head.readUInt32BE(16);
    metadata.height = head.readUInt32BE(20);
  }
  return metadata;
}

/**
 * Why a file the scanner reached could not be indexed. Reported verbatim by
 * `index failures`, so the codes stay stable and the reasons stay literal.
 */
export function describeScanError(error) {
  switch (error?.code) {
    case 'EACCES':
    case 'EPERM': return { code: 'PERMISSION_DENIED', reason: 'permission denied' };
    case 'ENOENT': return { code: 'DISAPPEARED', reason: 'file changed during indexing' };
    case 'EIO':
    case 'ENODEV':
    case 'ENXIO': return { code: 'DEVICE_UNAVAILABLE', reason: 'storage device became unavailable' };
    case 'EISDIR': return { code: 'NOT_A_FILE', reason: 'path is not a regular file' };
    case 'EBUSY': return { code: 'BUSY', reason: 'file is locked by another process' };
    case 'EMFILE':
    case 'ENFILE': return { code: 'TOO_MANY_FILES', reason: 'too many open files' };
    default: return { code: 'UNREADABLE', reason: error?.message ? String(error.message) : 'file could not be read' };
  }
}

/**
 * Walks a project directory.
 *
 * `options.exclude(relativePath, isDirectory)` skips paths the user excluded
 * from the index. `options.failures` collects files that were reached but could
 * not be read, rather than aborting the scan — one unreadable file must not
 * cost the user every other file in the directory.
 * An in-memory fileCache permits unchanged-byte reuse only when explicitly
 * enabled. Dirty paths (including directory ancestors) always force a read;
 * explicit checkpoints omit reuseUnchanged and verify every file's bytes.
 * `options.environments`, when given, collects the environment directories
 * skipped, so a watcher can ignore their events too.
 */
export function scanDirectory(rootPath, blobStore, options = {}) {
  return runSync(scanSteps(rootPath, blobStore, options));
}

/**
 * The same walk as steps: it lists the folder first, yielding
 * `{ phase: 'listing', files }` per directory, then reads what changed,
 * yielding `{ phase: 'reading', done, total }` in work units after each file.
 */
export function* scanSteps(rootPath, blobStore, options = {}) {
  const root = fs.realpathSync(rootPath);
  const rootStat = fs.statSync(root);
  if (!rootStat.isDirectory()) throw new Error('Project root must be a directory.');
  const exclude = typeof options.exclude === 'function' ? options.exclude : () => false;
  const failures = options.failures ?? [];
  const files = [];
  const nextCache = new Map();
  const dirtyPaths = new Set(options.dirtyPaths ?? []);
  // A path that exists but cannot be read right now (locked, busy, or denied
  // by a privacy prompt) keeps its last recorded version. Recording it as
  // deleted would give it a new identity when it returns and break its links.
  const previousFiles = options.previousFiles ?? [];
  let previousByPath = null;
  const carryForward = (error, failedPath, isDirectory) => {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return;
    if (!isDirectory) {
      previousByPath ??= new Map(previousFiles.map((file) => [file.path, file]));
      const previous = previousByPath.get(failedPath);
      if (previous) files.push(scannedFile(previous));
      return;
    }
    for (const file of previousFiles) {
      if (!failedPath || file.path.startsWith(`${failedPath}/`)) files.push(scannedFile(file));
    }
  };

  const relative = (absolutePath) => path.relative(root, absolutePath).split(path.sep).join('/');

  // Listing first tells how much there is to read. Entries keep the walk's
  // order, so a failed directory's carried files land where they always did.
  const entries = [];
  let listed = 0;
  function* list(directory) {
    let children;
    try {
      children = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      entries.push({ kind: 'directory', relativePath: relative(directory), error });
      return;
    }
    if (directory !== root && isEnvironmentDirectory(children)) {
      options.environments?.add(relative(directory));
      return;
    }
    for (const entry of children) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = relative(absolutePath);
      if (isIgnoredScanPath(relativePath)) continue;
      if (entry.isDirectory()) {
        if (exclude(relativePath, true)) continue;
        yield* list(absolutePath);
        continue;
      }
      if (!entry.isFile() || !isTrackedFile(absolutePath)) continue;
      if (exclude(relativePath, false)) continue;
      let stat = null;
      let error = null;
      try { stat = fs.statSync(absolutePath, { bigint: true }); } catch (failure) { error = failure; }
      entries.push({ kind: 'file', absolutePath, relativePath, stat, error });
      listed += 1;
    }
    yield { phase: 'listing', files: listed };
  }
  if (!exclude('', true)) yield* list(root);

  const reuses = (entry) => {
    if (!entry.stat || !options.reuseUnchanged || isDirty(entry.relativePath, dirtyPaths)) return false;
    entry.fingerprint = statFingerprint(entry.stat);
    return matchesCache(options.fileCache?.get(entry.relativePath), entry.fingerprint, entry.stat);
  };
  let total = 0;
  for (const entry of entries) {
    if (entry.kind !== 'file' || entry.error) continue;
    entry.reused = reuses(entry);
    if (!entry.reused) total += workUnits(entry.stat.size);
  }
  let done = 0;
  for (const entry of entries) {
    if (entry.kind === 'directory') {
      failures.push({ path: entry.relativePath || '.', ...describeScanError(entry.error) });
      carryForward(entry.error, entry.relativePath, true);
      continue;
    }
    const { absolutePath, relativePath, stat } = entry;
    if (entry.error) {
      failures.push({ path: relativePath, ...describeScanError(entry.error) });
      carryForward(entry.error, relativePath, false);
      continue;
    }
    const fingerprint = entry.fingerprint ?? statFingerprint(stat);
    if (entry.reused) {
      const cached = options.fileCache.get(relativePath);
      files.push(cached.file);
      nextCache.set(relativePath, { fingerprint, file: cached.file });
      continue;
    }
    const fileType = detectFileType(relativePath);
    // A file whose recorded stat values still hold most likely has its
    // recorded bytes: the store then only hashes it, and writes nothing.
    const recorded = options.fileCache?.get(relativePath);
    let stored;
    try {
      // Read a chunk at a time, so a large file is never held whole.
      stored = blobStore.putFile(absolutePath, {
        headBytes: fileType === 'image' ? METADATA_HEAD_BYTES : 0,
        expectedHash: matchesCache(recorded, fingerprint, stat) ? recorded.file.contentHash : null,
      });
    } catch (error) {
      // The store failing to write is not this file's fault, and stops the scan.
      if (error?.storing) throw error;
      failures.push({ path: relativePath, ...describeScanError(error) });
      carryForward(error, relativePath, false);
      done += workUnits(stat.size);
      yield { phase: 'reading', done, total };
      continue;
    }
    const file = {
      path: relativePath,
      contentHash: stored.contentHash,
      size: Number(stat.size),
      mtimeMs: Number(stat.mtimeNs) / 1_000_000,
      ctimeMs: Number(stat.ctimeNs) / 1_000_000,
      fileType,
      device: String(stat.dev),
      inode: String(stat.ino),
      metadata: metadataFor(fileType, stored.head),
    };
    files.push(file);
    // A writer can change the file while it is being read. Keep its captured
    // bytes, but require another read before trusting a cached fingerprint.
    try {
      if (statFingerprint(fs.statSync(absolutePath, { bigint: true })) === fingerprint) {
        nextCache.set(relativePath, { fingerprint, file });
      }
    } catch { /* A later scan will reconcile a file removed during this read. */ }
    done += workUnits(stat.size);
    yield { phase: 'reading', done, total };
  }

  if (options.fileCache) {
    options.fileCache.clear();
    for (const [filePath, entry] of nextCache) options.fileCache.set(filePath, entry);
  }
  return files;
}
