import fs from 'node:fs';
import path from 'node:path';
import { detectFileType, isTrackedFile } from './file-types.js';

const IGNORED_DIRECTORIES = new Set(['.git', '.svn', '.hg', 'node_modules', '.lasso-data', '.colab-dry-data']);

export function isIgnoredScanPath(relativePath) {
  return relativePath.split('/').some((part) => IGNORED_DIRECTORIES.has(part));
}

function statFingerprint(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
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
 */
function matchesCache(cached, fingerprint, stat) {
  if (!cached) return false;
  if (cached.fingerprint) return cached.fingerprint === fingerprint;
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

function metadataFor(type, buffer) {
  const metadata = {};
  if (type === 'image' && buffer.length >= 24 && buffer.subarray(1, 4).toString() === 'PNG') {
    metadata.width = buffer.readUInt32BE(16);
    metadata.height = buffer.readUInt32BE(20);
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
 */
export function scanDirectory(rootPath, blobStore, options = {}) {
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

  function walk(directory) {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      const prefix = relative(directory);
      failures.push({ path: prefix || '.', ...describeScanError(error) });
      carryForward(error, prefix, true);
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = relative(absolutePath);
      if (isIgnoredScanPath(relativePath)) continue;
      if (entry.isDirectory()) {
        if (exclude(relativePath, true)) continue;
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile() || !isTrackedFile(absolutePath)) continue;
      if (exclude(relativePath, false)) continue;
      let stat;
      let buffer;
      let fingerprint;
      try {
        stat = fs.statSync(absolutePath, { bigint: true });
        fingerprint = statFingerprint(stat);
        const cached = options.fileCache?.get(relativePath);
        if (options.reuseUnchanged && !isDirty(relativePath, dirtyPaths) && matchesCache(cached, fingerprint, stat)) {
          files.push(cached.file);
          nextCache.set(relativePath, { fingerprint, file: cached.file });
          continue;
        }
        buffer = fs.readFileSync(absolutePath);
      } catch (error) {
        failures.push({ path: relativePath, ...describeScanError(error) });
        carryForward(error, relativePath, false);
        continue;
      }
      const contentHash = blobStore.put(buffer);
      const fileType = detectFileType(relativePath);
      const file = {
        path: relativePath,
        contentHash,
        size: Number(stat.size),
        mtimeMs: Number(stat.mtimeNs) / 1_000_000,
        ctimeMs: Number(stat.ctimeNs) / 1_000_000,
        fileType,
        device: String(stat.dev),
        inode: String(stat.ino),
        metadata: metadataFor(fileType, buffer),
      };
      files.push(file);
      // A writer can change the file while it is being read. Keep its captured
      // bytes, but require another read before trusting a cached fingerprint.
      try {
        if (statFingerprint(fs.statSync(absolutePath, { bigint: true })) === fingerprint) {
          nextCache.set(relativePath, { fingerprint, file });
        }
      } catch { /* A later scan will reconcile a file removed during this read. */ }
    }
  }

  if (!exclude('', true)) walk(root);
  if (options.fileCache) {
    options.fileCache.clear();
    for (const [filePath, entry] of nextCache) options.fileCache.set(filePath, entry);
  }
  return files;
}
