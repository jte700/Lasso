import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// The whole store is cleared past this size; everything in it can be read again.
const MAX_STORE_BYTES = 256 * 1024 * 1024;

/**
 * Text read out of PDFs, kept on disk by the file's content hash. Reading a
 * PDF's text takes the native reader a moment per file, and search needs it
 * for every PDF each time Lasso starts. Like the in-memory caches this is
 * derived data: a missing or unreadable entry is read from the file again.
 * Entries live under the reader version that produced them, so a better
 * reader never serves an older reading.
 */
export class TextStore {
  constructor(root, readerVersion, { tidy = true } = {}) {
    this.root = root;
    this.directory = path.join(root, `v${readerVersion}`);
    if (!tidy) return;
    try {
      for (const entry of fs.readdirSync(root)) {
        if (entry !== path.basename(this.directory)) fs.rmSync(path.join(root, entry), { recursive: true, force: true });
      }
      if (directorySize(this.directory) > MAX_STORE_BYTES) fs.rmSync(this.directory, { recursive: true, force: true });
    } catch { /* A store that cannot be tidied is still usable, or simply unused. */ }
  }

  pathFor(key) {
    const name = crypto.createHash('sha256').update(key).digest('hex');
    return path.join(this.directory, name.slice(0, 2), name.slice(2));
  }

  get(key) {
    try { return JSON.parse(fs.readFileSync(this.pathFor(key), 'utf8')); } catch { return undefined; }
  }

  set(key, value) {
    const destination = this.pathFor(key);
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(value));
      fs.renameSync(temporary, destination);
    } catch { /* Not kept: it is read from the file again next time. */ }
  }
}

function directorySize(directory) {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += fs.statSync(path.join(entry.parentPath, entry.name)).size;
  }
  return total;
}
