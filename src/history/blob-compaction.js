import { json } from '../db.js';
import { currentFileType, isCompressibleType } from './file-types.js';
import { IdleBatches } from './idle-batches.js';

// Compressing the stored bytes of text versions that no folder holds any
// longer. Every build reads a file's current version from its raw path, and
// builds from before compression read nothing else, so a version is
// compressed only once it stops being the current version of every folder
// that has it. It runs by default, in small batches while the library is
// quiet, and config.blobCompressionEnabled switches it off; it is separate
// from releasing old bytes (retention.js), which stays off unless switched on.
//
// A version stays raw while any of these holds:
// - it is the current version of a file in any folder;
// - a pending agent edit names it, before or after;
// - a scan has read it and the capture has not recorded it yet;
// - it was stored, or found again by a capture, within config.blobTouchWindowMs;
// - any file recorded with it is of a kind that is not plain text;
// - it is too small or too large to compress, or compressing saves too little.
// Bytes that no snapshot records (an agent edit that was never applied) are never examined.

// How many stored hashes one batch looks at.
export const COMPACTION_BATCH_SIZE = 25;
// Compressing runs on the server's own thread, so a batch also stops once it
// has read about this many raw bytes, or after about this long, and the next
// batch starts at the hash it stopped before. Each batch compresses at least one version.
export const COMPACTION_BATCH_BYTES = 32 * 1024 * 1024;
export const COMPACTION_BATCH_MS = 100;

const NEXT_STORED_HASHES = `SELECT DISTINCT content_hash FROM snapshot_files
  WHERE content_hash > ? ORDER BY content_hash LIMIT ?`;

// Every file recorded with these bytes, and what kind of file each was.
const FILE_USES = `SELECT DISTINCT f.project_file_id AS fileId, s.project_id AS projectId, f.path, f.file_type AS fileType
  FROM snapshot_files f JOIN snapshots s ON s.id = f.snapshot_id WHERE f.content_hash = ?`;

/** The hashes a batch must leave raw whatever their history: pending agent edits and scans not yet recorded. */
function heldRaw(db, timeline) {
  const hashes = new Set();
  for (const row of db.prepare("SELECT proposal_json FROM agent_executions WHERE status = 'PROPOSED'").all()) {
    const proposal = json(row.proposal_json, {});
    for (const hash of [proposal.contentHashBefore, proposal.contentHashAfter]) if (hash) hashes.add(hash);
  }
  for (const cache of timeline.scanCaches.values()) {
    for (const entry of cache.values()) if (entry.file?.contentHash) hashes.add(entry.file.contentHash);
  }
  return hashes;
}

export class BlobCompaction {
  constructor({ db, timeline, config }) {
    this.db = db;
    this.timeline = timeline;
    this.config = config;
    // Where the current pass has got to, by hash; '' starts a new pass.
    this.cursor = '';
    this.batches = new IdleBatches({
      timeline, idleMs: config.blobCompressionIdleMs, isEnabled: () => this.enabled,
      runBatch: () => this.compactBatch(), label: 'compress the bytes of old versions',
    });
  }

  get enabled() {
    return this.config.blobCompressionEnabled !== false;
  }

  /** The next batch, when one is waiting. */
  get timer() {
    return this.batches.timer;
  }

  start() {
    this.batches.start();
  }

  close() {
    this.batches.close();
  }

  /**
   * Looks at up to `limit` stored hashes, past where the last batch stopped,
   * and compresses the old text versions among them, stopping early once it
   * has read `maxBytes` raw bytes or spent `maxMs`. Returns what it
   * compressed and `readBytes`, the raw bytes it read to do so; `done` once a
   * pass has looked at every hash, and `waiting` when a capture is running
   * and nothing was done.
   */
  compactBatch({ now = Date.now(), limit = COMPACTION_BATCH_SIZE, maxBytes = COMPACTION_BATCH_BYTES,
    maxMs = COMPACTION_BATCH_MS } = {}) {
    const startedAt = performance.now();
    const nothing = { enabled: this.enabled, compacted: [], savedBytes: 0, readBytes: 0, examined: 0 };
    if (!this.enabled) return { ...nothing, done: true };
    // A capture stores bytes before it records them, so none are judged meanwhile.
    if (this.timeline.activeCaptures > 0) return { ...nothing, waiting: 'capture', done: false };
    const hashes = this.db.prepare(NEXT_STORED_HASHES).all(this.cursor, limit).map((row) => row.content_hash);
    const currentSnapshots = new Map(this.db.prepare('SELECT id, current_snapshot_id AS snapshotId FROM projects').all()
      .map((row) => [row.id, row.snapshotId]));
    const held = heldRaw(this.db, this.timeline);
    const untouchedBefore = now - this.config.blobTouchWindowMs;
    const compacted = [];
    let readBytes = 0;
    let examined = 0;
    for (const hash of hashes) {
      if (!held.has(hash) && this.isOldText(hash, currentSnapshots)) {
        const candidate = this.timeline.blobs.compactionCandidate(hash, untouchedBefore);
        if (candidate) {
          const spent = readBytes > 0 && (readBytes + candidate.size > maxBytes || performance.now() - startedAt >= maxMs);
          if (spent) break;
          readBytes += candidate.size;
          const result = this.compactOne(hash, untouchedBefore);
          if (result) compacted.push(result);
        }
      }
      examined += 1;
    }
    // A batch that stopped early, or found a full batch, leaves the rest of the pass to the next one.
    const done = examined === hashes.length && hashes.length < limit;
    this.cursor = done ? '' : hashes[examined - 1];
    return { ...nothing, compacted, savedBytes: compacted.reduce((total, entry) => total + entry.savedBytes, 0),
      readBytes, examined, done };
  }

  /** Compresses one old version, or leaves it as it was when that fails. */
  compactOne(hash, untouchedBefore) {
    try {
      return this.timeline.blobs.compact(hash, untouchedBefore);
    } catch (error) {
      // One blob that cannot be compressed leaves it as it was; the others go on.
      console.warn(`Lasso could not compress the bytes of ${hash}:`, error.message);
      return null;
    }
  }

  /** Whether every file recorded with these bytes is text, and none holds them now. */
  isOldText(hash, currentSnapshots) {
    const uses = this.db.prepare(FILE_USES).all(hash);
    if (!uses.length || !uses.every((use) => isCompressibleType(currentFileType(use.path, use.fileType)))) return false;
    return !uses.some((use) => {
      const current = currentSnapshots.get(use.projectId);
      // A file of a folder that is gone, or has no version, is left alone.
      if (!current) return true;
      return this.timeline.files.rowById(current, use.fileId)?.content_hash === hash;
    });
  }
}
