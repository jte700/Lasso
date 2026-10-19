import fs from 'node:fs';
import path from 'node:path';
import { detectFileType, isTrackedFile } from './file-types.js';

const IGNORED_DIRECTORIES = new Set(['.git', '.svn', '.hg', 'node_modules', '.lasso-data', '.colab-dry-data']);

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
 */
export function scanDirectory(rootPath, blobStore, options = {}) {
  const root = fs.realpathSync(rootPath);
  const rootStat = fs.statSync(root);
  if (!rootStat.isDirectory()) throw new Error('Project root must be a directory.');
  const exclude = typeof options.exclude === 'function' ? options.exclude : () => false;
  const failures = options.failures ?? [];
  const files = [];

  const relative = (absolutePath) => path.relative(root, absolutePath).split(path.sep).join('/');

  function walk(directory) {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      failures.push({ path: relative(directory) || '.', ...describeScanError(error) });
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = relative(absolutePath);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name) || exclude(relativePath, true)) continue;
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile() || !isTrackedFile(absolutePath)) continue;
      if (exclude(relativePath, false)) continue;
      let stat;
      let buffer;
      try {
        stat = fs.statSync(absolutePath);
        buffer = fs.readFileSync(absolutePath);
      } catch (error) {
        failures.push({ path: relativePath, ...describeScanError(error) });
        continue;
      }
      const contentHash = blobStore.put(buffer);
      const fileType = detectFileType(relativePath);
      files.push({
        path: relativePath,
        contentHash,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        fileType,
        device: String(stat.dev),
        inode: String(stat.ino),
        metadata: metadataFor(fileType, buffer),
      });
    }
  }

  walk(root);
  return files;
}
