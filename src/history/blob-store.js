import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { BlobMissingError, BlobReleasedError } from './errors.js';

// Every version of every file is kept here by the SHA-256 of its raw bytes,
// at blobs/<first two characters>/<the rest>, where every earlier build
// stores and reads it. A text version that no folder holds any longer may
// later be compressed beside that path under a suffix (see
// blob-compaction.js), and its raw form removed. A file's current version is
// always kept raw: storing bytes that lie only compressed writes the raw form
// again. The hash never depends on how the bytes are stored, and
// decompressAll turns every compressed blob back into a raw one.

// A file is read, hashed and written this much at a time, so storing one
// holds no more than this of it.
export const BLOB_CHUNK_BYTES = 1024 * 1024;
// Text shorter than this is kept as it is: compressing it saves nothing.
export const COMPRESS_MIN_BYTES = 256;
// Text longer than this is kept as it is, so compressing never holds a huge file whole.
export const COMPRESS_MAX_BYTES = 16 * 1024 * 1024;
// Compressed bytes replace the raw ones only when they are at least this much smaller.
const COMPRESS_MIN_SAVING = 0.1;
const COMPRESSED_SUFFIX = '.zst';
// A blob being released or compressed is moved aside under this suffix while
// the store checks that no capture has just found it again.
const WITHDRAWN_SUFFIX = '.withdrawn';
// Bytes stored, or found again by a capture, this recently are neither
// compressed nor released: another Lasso sharing the data folder may be
// recording them, and its captures cannot be seen from here. It is longer
// than the idle wait before either cleanup starts.
export const RECENT_TOUCH_WINDOW_MS = 10 * 60 * 1000;
// Raw copies of compressed blobs, kept for readers that are handed a path
// (a worker reading a large table once per content). The copy just made is
// kept even past these limits.
export const RAW_CACHE_MAX_ENTRIES = 8;
export const RAW_CACHE_MAX_BYTES = 128 * 1024 * 1024;
// A file being stored is written here until its hash is known.
const INCOMING_PREFIX = '.incoming-';
// A temporary or withdrawn file this old was left by a store that stopped part way.
const STALE_TEMPORARY_MS = 60 * 60 * 1000;
// What a store writes beside a blob before moving it into place:
// <name>.<pid>.<uuid>.tmp, or <name>.zst.<pid>.<uuid>.tmp.
const TEMPORARY_NAME = /^[0-9a-f]+(?:\.zst)?\.\d+\.[0-9a-f-]{36}\.tmp$/;
// A blob form moved aside: <name>[.zst].withdrawn.<pid>.<uuid>.
const WITHDRAWN_NAME = /^([0-9a-f]+)(\.zst)?\.withdrawn\.\d+\.[0-9a-f-]{36}$/;

export function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function moveIntoPlace(temporary, destination) {
  try {
    fs.renameSync(temporary, destination);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    fs.rmSync(temporary, { force: true });
  }
}

function writeAll(descriptor, buffer) {
  for (let written = 0; written < buffer.length;) written += fs.writeSync(descriptor, buffer, written, buffer.length - written);
}

/** Marks a failure as the store's own, so a caller can tell it from a file that could not be read. */
function storing(work) {
  try {
    return work();
  } catch (error) {
    throw Object.assign(error, { storing: true });
  }
}

/** Whether a compressed file holds exactly the bytes named `hash`. */
function readsBackAs(packedPath, hash) {
  try {
    return hashBuffer(zlib.zstdDecompressSync(fs.readFileSync(packedPath))) === hash;
  } catch {
    return false;
  }
}

/** Whether a raw file holds exactly the bytes named `hash`. */
function holdsBytes(rawPath, hash) {
  try {
    return hashBuffer(fs.readFileSync(rawPath)) === hash;
  } catch {
    return false;
  }
}

/**
 * Reads a file a chunk at a time, hashing it and handing each chunk to
 * `onChunk`. The chunk is reused: a receiver that keeps it must copy it.
 */
function readChunks(filePath, headBytes, onChunk) {
  const hash = crypto.createHash('sha256');
  const chunk = Buffer.allocUnsafe(BLOB_CHUNK_BYTES);
  const head = [];
  let size = 0;
  const descriptor = fs.openSync(filePath, 'r');
  try {
    for (;;) {
      const count = fs.readSync(descriptor, chunk, 0, BLOB_CHUNK_BYTES, null);
      if (!count) break;
      const piece = chunk.subarray(0, count);
      hash.update(piece);
      if (size < headBytes) head.push(Buffer.from(piece.subarray(0, headBytes - size)));
      size += count;
      onChunk(piece);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return { contentHash: hash.digest('hex'), size, head: Buffer.concat(head) };
}

export class BlobStore {
  /**
   * `options.rawCacheDir` holds raw copies of compressed blobs.
   * `options.releasedAt(hash)` says when a blob's bytes were released on
   * purpose, so reading one says so instead of reporting damage.
   */
  constructor(root, { rawCacheDir = `${root}-raw`, releasedAt = null } = {}) {
    this.root = root;
    this.rawCacheDir = rawCacheDir;
    this.releasedAt = releasedAt;
    // Folders whose leftovers this store has cleared. Each is cleared the
    // first time the store writes there, so startup reads no folder but the root.
    this.clearedFolders = new Set();
    fs.mkdirSync(root, { recursive: true });
    this.clearStaleTemporaries(root, (name) => name.startsWith(INCOMING_PREFIX));
  }

  rawLocation(hash) {
    return path.join(this.root, hash.slice(0, 2), hash.slice(2));
  }

  compressedLocation(hash) {
    return `${this.rawLocation(hash)}${COMPRESSED_SUFFIX}`;
  }

  /** How a blob is stored: 'raw' (whether or not a compressed form lies beside it), 'zstd', or null when the store does not hold it. */
  encodingOf(hash) {
    if (fs.existsSync(this.rawLocation(hash))) return 'raw';
    return fs.existsSync(this.compressedLocation(hash)) ? 'zstd' : null;
  }

  has(hash) {
    return this.encodingOf(hash) !== null;
  }

  /** The room a blob takes on disk, in whichever forms it is stored. */
  storedBytes(hash) {
    let bytes = 0;
    for (const stored of [this.rawLocation(hash), this.compressedLocation(hash)]) {
      try { bytes += fs.statSync(stored).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return bytes;
  }

  /**
   * Marks every stored form of a blob as just found again, so cleanup in any
   * Lasso sharing this folder leaves it alone (see withdraw and compact).
   * True when its raw form is there; a blob held only compressed answers
   * false, so its raw form is written again.
   */
  touch(hash) {
    const now = new Date();
    let raw = false;
    for (const stored of [this.rawLocation(hash), this.compressedLocation(hash)]) {
      try {
        fs.utimesSync(stored, now, now);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        // A blob that cannot be marked is still there to be read.
        if (!fs.existsSync(stored)) throw error;
      }
      if (stored === this.rawLocation(hash)) raw = true;
    }
    return raw;
  }

  /** Stores bytes already in memory, raw. */
  put(buffer) {
    const hash = hashBuffer(buffer);
    if (!this.touch(hash)) this.writeAtomically(this.rawLocation(hash), buffer);
    return hash;
  }

  /**
   * Stores a file from its path without holding it whole: each chunk feeds
   * the hash and a temporary file together, and the temporary file becomes
   * the blob once the hash is known. The bytes stored are the bytes hashed,
   * whatever another program writes to the file meanwhile.
   *
   * `options.headBytes` asks for that many of its first bytes back.
   * `options.expectedHash` is the hash the file had when last recorded: when
   * it still has it and its raw form is stored, the file is only hashed and
   * nothing is written.
   */
  putFile(filePath, { headBytes = 0, expectedHash = null } = {}) {
    if (expectedHash && fs.existsSync(this.rawLocation(expectedHash))) {
      const unchanged = readChunks(filePath, headBytes, () => {});
      if (unchanged.contentHash === expectedHash && storing(() => this.touch(expectedHash))) return unchanged;
    }
    let kept = [];
    let keptBytes = 0;
    let temporary = null;
    let descriptor = null;
    const take = (piece) => storing(() => {
      if (kept && keptBytes + piece.length <= BLOB_CHUNK_BYTES) {
        kept.push(Buffer.from(piece));
        keptBytes += piece.length;
        return;
      }
      if (descriptor === null) {
        temporary = path.join(this.root, `${INCOMING_PREFIX}${process.pid}.${crypto.randomUUID()}.tmp`);
        descriptor = fs.openSync(temporary, 'wx');
        for (const earlier of kept) writeAll(descriptor, earlier);
        kept = null;
      }
      writeAll(descriptor, piece);
    });
    try {
      const read = readChunks(filePath, headBytes, take);
      storing(() => {
        if (descriptor !== null) {
          fs.closeSync(descriptor);
          descriptor = null;
        }
        if (this.touch(read.contentHash)) return;
        const destination = this.rawLocation(read.contentHash);
        if (!temporary) {
          this.writeAtomically(destination, Buffer.concat(kept));
          return;
        }
        this.prepareFolder(path.dirname(destination));
        moveIntoPlace(temporary, destination);
        temporary = null;
      });
      return read;
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
      if (temporary) fs.rmSync(temporary, { force: true });
    }
  }

  get(hash) {
    try {
      return fs.readFileSync(this.rawLocation(hash));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    let packed;
    try {
      packed = fs.readFileSync(this.compressedLocation(hash));
    } catch (error) {
      throw error.code === 'ENOENT' ? this.absent(hash) : error;
    }
    return zlib.zstdDecompressSync(packed);
  }

  /**
   * A path to a blob's raw bytes, for a reader that opens the file itself:
   * the blob where it lies, or a raw copy of a compressed one. Never a path
   * to nothing: absent bytes raise the error `get` would.
   */
  rawPath(hash) {
    const raw = this.rawLocation(hash);
    if (fs.existsSync(raw)) return raw;
    if (!fs.existsSync(this.compressedLocation(hash))) throw this.absent(hash);
    return this.rawCopy(hash);
  }

  /** The same; the name earlier callers used when every blob was raw. */
  pathFor(hash) {
    return this.rawPath(hash);
  }

  /** Removes every stored form of a blob, and returns the bytes that freed. */
  remove(hash) {
    let freed = 0;
    for (const stored of [this.rawLocation(hash), this.compressedLocation(hash)]) {
      try {
        const { size } = fs.statSync(stored);
        fs.rmSync(stored);
        freed += size;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    fs.rmSync(path.join(this.rawCacheDir, hash), { force: true });
    return freed;
  }

  /**
   * The raw form's file details when compact would read it: stored raw,
   * untouched since `untouchedBefore` and of a size worth compressing.
   * Null otherwise, so a caller can weigh the work before doing it.
   */
  compactionCandidate(hash, untouchedBefore) {
    let stat;
    try {
      stat = fs.statSync(this.rawLocation(hash));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (stat.mtimeMs >= untouchedBefore || stat.size < COMPRESS_MIN_BYTES || stat.size > COMPRESS_MAX_BYTES) return null;
    return stat;
  }

  /**
   * Compresses a blob's raw bytes beside them and then removes the raw form,
   * unless something stored or found the blob at or after `untouchedBefore`
   * (a time in ms), its bytes do not match its name, or compressing saves
   * too little. The compressed form is written through a temporary file, and
   * the raw form goes only once the compressed one reads back to the same
   * hash. Returns the room saved, or null when the blob is left as it was.
   */
  compact(hash, untouchedBefore) {
    const raw = this.rawLocation(hash);
    const stat = this.compactionCandidate(hash, untouchedBefore);
    if (!stat) return null;
    const packedPath = this.compressedLocation(hash);
    if (!readsBackAs(packedPath, hash)) {
      // A compressed form that does not read back is damage; the raw form is the blob.
      fs.rmSync(packedPath, { force: true });
      const bytes = fs.readFileSync(raw);
      if (hashBuffer(bytes) !== hash) return null;
      const packed = zlib.zstdCompressSync(bytes);
      if (packed.length > bytes.length * (1 - COMPRESS_MIN_SAVING)) return null;
      this.writeAtomically(packedPath, packed);
      if (!readsBackAs(packedPath, hash)) {
        fs.rmSync(packedPath, { force: true });
        return null;
      }
    }
    // Moved aside first, as withdraw does: a capture that finds the raw form
    // before the move shows in its time, and one after finds none and writes it again.
    const aside = `${raw}${WITHDRAWN_SUFFIX}.${process.pid}.${crypto.randomUUID()}`;
    try {
      fs.renameSync(raw, aside);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (fs.statSync(aside).mtimeMs >= untouchedBefore) {
      fs.renameSync(aside, raw);
      return null;
    }
    // The compressed form keeps the time the bytes were last stored or found,
    // so compressing them never restarts the window that keeps them.
    fs.utimesSync(packedPath, stat.atime, stat.mtime);
    fs.rmSync(aside, { force: true });
    const storedBytes = fs.statSync(packedPath).size;
    return { contentHash: hash, storedBytes, savedBytes: stat.size - storedBytes };
  }

  /**
   * Moves a blob's stored forms aside, unless something stored or found it
   * again at or after `untouchedBefore` (a time in ms). Returns a handle for
   * discard or restore, or null when the blob is kept or not stored.
   *
   * A capture in another Lasso touches a blob it finds already stored
   * before it records it. Moving the files first makes that safe: a touch
   * that lands before the move shows in the moved file's time, and one after
   * it finds nothing, so that capture stores the bytes again.
   */
  withdraw(hash, untouchedBefore) {
    const moved = [];
    for (const stored of [this.rawLocation(hash), this.compressedLocation(hash)]) {
      const aside = `${stored}${WITHDRAWN_SUFFIX}.${process.pid}.${crypto.randomUUID()}`;
      try {
        if (fs.statSync(stored).mtimeMs >= untouchedBefore) break;
        fs.renameSync(stored, aside);
        let stat;
        try {
          stat = fs.statSync(aside);
        } catch (error) {
          fs.renameSync(aside, stored);
          throw error;
        }
        moved.push({ stored, aside, bytes: stat.size, touchedAt: stat.mtimeMs });
      } catch (error) {
        if (error.code !== 'ENOENT') {
          this.restore({ moved });
          throw error;
        }
      }
    }
    const kept = moved.length === 0 || moved.some((form) => form.touchedAt >= untouchedBefore)
      || fs.existsSync(this.rawLocation(hash)) || fs.existsSync(this.compressedLocation(hash));
    if (kept) {
      this.restore({ moved });
      return null;
    }
    return { hash, moved, storedBytes: moved.reduce((total, form) => total + form.bytes, 0) };
  }

  /** Puts withdrawn forms back where they were. */
  restore({ moved }) {
    for (const form of moved) fs.renameSync(form.aside, form.stored);
  }

  /** Deletes withdrawn forms for good, with any raw copy of them. */
  discard({ hash, moved }) {
    for (const form of moved) fs.rmSync(form.aside, { force: true });
    fs.rmSync(path.join(this.rawCacheDir, hash), { force: true });
  }

  /**
   * Turns every compressed blob back into a raw one, so a build from before
   * compression can read the folder. Each raw form is written whole before
   * its compressed form goes, so stopping part way loses nothing and running
   * it again finishes the job. A compressed blob whose bytes do not match its
   * name is left as it is. Returns how many it turned back and which it left.
   */
  decompressAll() {
    const result = { decompressed: 0, damaged: [] };
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const folder = path.join(this.root, entry.name);
      this.clearFolderLeftovers(folder);
      for (const name of fs.readdirSync(folder)) {
        if (!name.endsWith(COMPRESSED_SUFFIX)) continue;
        const hash = `${entry.name}${name.slice(0, -COMPRESSED_SUFFIX.length)}`;
        const packed = path.join(folder, name);
        const raw = this.rawLocation(hash);
        if (!holdsBytes(raw, hash)) {
          let bytes = null;
          try { bytes = zlib.zstdDecompressSync(fs.readFileSync(packed)); } catch { /* reported below as damaged */ }
          if (!bytes || hashBuffer(bytes) !== hash) {
            result.damaged.push(hash);
            continue;
          }
          this.writeAtomically(raw, bytes);
        }
        fs.rmSync(packed, { force: true });
        result.decompressed += 1;
      }
    }
    return result;
  }

  /** Why a blob cannot be read: released on purpose, or missing. */
  absent(hash) {
    const releasedAt = this.releasedAt?.(hash) ?? null;
    return releasedAt ? new BlobReleasedError(hash, releasedAt) : new BlobMissingError(hash);
  }

  /** A compressed blob's raw copy, made on first use and then reused. */
  rawCopy(hash) {
    const copy = path.join(this.rawCacheDir, hash);
    const now = new Date();
    try {
      // Using a copy makes it the newest, so the copies dropped are the idle ones.
      fs.utimesSync(copy, now, now);
      return copy;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    this.writeAtomically(copy, this.get(hash));
    this.trimRawCopies(hash);
    return copy;
  }

  /** Keeps the raw copies within their limits, dropping the ones used longest ago. */
  trimRawCopies(justMade) {
    const copies = [];
    for (const name of fs.readdirSync(this.rawCacheDir)) {
      if (name.endsWith('.tmp')) continue;
      try {
        const stat = fs.statSync(path.join(this.rawCacheDir, name), { bigint: true });
        copies.push({ name, size: Number(stat.size), usedAt: stat.mtimeNs });
      } catch { /* dropped by another reader meanwhile */ }
    }
    copies.sort((left, right) => (left.usedAt < right.usedAt ? 1 : left.usedAt > right.usedAt ? -1 : 0));
    let entries = 0;
    let bytes = 0;
    for (const copy of copies) {
      const within = entries < RAW_CACHE_MAX_ENTRIES && bytes + copy.size <= RAW_CACHE_MAX_BYTES;
      if (within || copy.name === justMade) {
        entries += 1;
        bytes += copy.size;
      } else {
        fs.rmSync(path.join(this.rawCacheDir, copy.name), { force: true });
      }
    }
  }

  /** Writes bytes to a path through a temporary file beside it, so no reader ever sees part of them. */
  writeAtomically(destination, buffer) {
    this.prepareFolder(path.dirname(destination));
    const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, buffer, { flag: 'wx' });
    moveIntoPlace(temporary, destination);
  }

  /** Makes a folder to write into, clearing what a stopped store left there the first time. */
  prepareFolder(folder) {
    fs.mkdirSync(folder, { recursive: true });
    if (this.clearedFolders.has(folder)) return;
    this.clearedFolders.add(folder);
    this.clearFolderLeftovers(folder);
  }

  /**
   * Clears a folder of the temporary files a stopped store left, and puts
   * back a form it moved aside and never released (or drops it, when its
   * bytes were released or are stored again).
   */
  clearFolderLeftovers(folder) {
    this.clearStaleTemporaries(folder, (name) => TEMPORARY_NAME.test(name));
    if (folder === this.rawCacheDir) return;
    try {
      const cutoff = Date.now() - STALE_TEMPORARY_MS;
      for (const name of fs.readdirSync(folder)) {
        const withdrawn = WITHDRAWN_NAME.exec(name);
        const aside = path.join(folder, name);
        if (!withdrawn || fs.statSync(aside).mtimeMs >= cutoff) continue;
        const hash = `${path.basename(folder)}${withdrawn[1]}`;
        const stored = path.join(folder, `${withdrawn[1]}${withdrawn[2] ?? ''}`);
        if (this.has(hash) || this.releasedAt?.(hash)) fs.rmSync(aside, { force: true });
        else fs.renameSync(aside, stored);
      }
    } catch { /* a leftover costs room, never correctness */ }
  }

  clearStaleTemporaries(directory, isTemporary) {
    try {
      const cutoff = Date.now() - STALE_TEMPORARY_MS;
      for (const name of fs.readdirSync(directory)) {
        if (!isTemporary(name)) continue;
        const stale = path.join(directory, name);
        if (fs.statSync(stale).mtimeMs < cutoff) fs.rmSync(stale, { force: true });
      }
    } catch { /* a leftover temporary file costs room, never correctness */ }
  }
}
