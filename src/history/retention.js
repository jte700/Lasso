import { json, transaction } from '../db.js';
import { IdleBatches } from './idle-batches.js';

// Releasing the bytes of old versions, to keep the blob store from growing
// with every save. It is off unless config.blobRetentionEnabled is set: bytes
// once released cannot be brought back. A version's values (its object
// versions) and its events stay; only the stored copy of the file goes, and
// released_blobs records when, so reading it says so instead of reporting
// damage.
//
// A stored version keeps its bytes when any of these holds:
// - it is among its file's newest versions (config.blobRetentionVersions);
// - it stopped being its file's content within config.blobRetentionDays,
//   or is its content still;
// - a snapshot that something points at holds it: the current snapshot of
//   any project, a share, a linked claim's source or document, a provenance
//   link, a pending agent edit;
// - something names its hash: a pending agent edit, evidence shown to an
//   agent or bound to its task, a document edit layer, the snapshot a share
//   was made from;
// - its folder lives on a removable drive, whose history the drive service keeps whole;
// - its values may not all be recorded: a snapshot holding it has no index,
//   so its bytes are all there is of it there;
// - it was stored, or found again by a capture, within
//   config.blobRetentionGraceMs (never less than config.blobTouchWindowMs):
//   another Lasso sharing the data folder may be about to record it, and
//   its captures cannot be seen from here;
// - the history does not account for it, so it is left alone.
// Blobs that no snapshot records (an agent edit that was never applied, for
// one) are never examined here.

// How many stored hashes one batch looks at.
export const RETENTION_BATCH_SIZE = 25;
const DAY_MS = 86_400_000;
// A rule decided the version keeps its bytes.
const KEEP = Symbol('keep');

const NEXT_STORED_HASHES = `SELECT DISTINCT content_hash FROM snapshot_files
  WHERE content_hash > ? ORDER BY content_hash LIMIT ?`;

// Every file that was recorded with these bytes, and the snapshots that wrote them.
const FILE_USES = `SELECT DISTINCT f.project_file_id AS fileId, s.project_id AS projectId, s.version
  FROM snapshot_files f JOIN snapshots s ON s.id = f.snapshot_id WHERE f.content_hash = ?`;

// One file's recorded changes, oldest first.
const FILE_HISTORY = `SELECT c.content_hash_before AS before, c.content_hash_after AS after,
  s.version, e.occurred_at AS occurredAt
  FROM file_changes c JOIN timeline_events e ON e.id = c.event_id
  JOIN snapshots s ON s.id = e.resulting_snapshot_id
  WHERE c.project_file_id = ? ORDER BY s.version`;

// A snapshot in a span that was never indexed. Indexing it later reads its
// files, so it needs their bytes. An index from an older reader is enough:
// its upgrade pass keeps what it recorded of a file whose bytes are gone.
const UNINDEXED_SNAPSHOT = `SELECT 1 FROM snapshots s LEFT JOIN snapshot_object_indexes i ON i.snapshot_id = s.id
  WHERE s.project_id = ? AND s.version >= ? AND s.version < ? AND i.snapshot_id IS NULL LIMIT 1`;

// Snapshots whose every file stays readable. A dependency share reads its
// claim's versions, which are all listed here.
const PINNED_SNAPSHOTS = `SELECT s.id, s.project_id AS projectId, s.version FROM snapshots s WHERE s.id IN (
  SELECT current_snapshot_id FROM projects
  UNION SELECT COALESCE(g.snapshot_id, v.snapshot_id) FROM object_share_grants g
    LEFT JOIN scientific_object_versions v ON v.id = g.object_version_id
  UNION SELECT snapshot_id FROM claim_dependency_versions
  UNION SELECT source_snapshot_id FROM claim_dependency_versions
  UNION SELECT document_snapshot_id FROM claim_dependency_versions
  UNION SELECT from_snapshot_id FROM provenance_links
  UNION SELECT to_snapshot_id FROM provenance_links
  UNION SELECT base_snapshot_id FROM agent_executions WHERE status = 'PROPOSED')`;

// Bytes named directly by their hash.
const PINNED_HASHES = `SELECT content_hash AS hash FROM agent_evidence
  UNION SELECT content_hash FROM agent_bindings
  UNION SELECT source_content_hash FROM document_edit_layer_versions
  UNION SELECT v.content_hash FROM object_share_grants g JOIN scientific_object_versions v ON v.id = g.object_version_id`;

const RECORD_RELEASE = `INSERT INTO released_blobs(content_hash, released_at, stored_bytes) VALUES (?, ?, ?)
  ON CONFLICT(content_hash) DO UPDATE SET released_at = excluded.released_at, stored_bytes = excluded.stored_bytes`;

/**
 * The spans of snapshot versions in which a file held some bytes, each with
 * when it ended; KEEP when the file holds them still or the bytes are among
 * its newest versions.
 */
function heldSpans(history, hash, newestKept) {
  const contentVersions = history.filter((change) => change.after && change.after !== change.before);
  if (contentVersions.slice(-newestKept).some((change) => change.after === hash)) return KEEP;
  const spans = [];
  let open = null;
  for (const change of history) {
    if (change.after === hash) {
      open ??= { from: change.version };
    } else if (open) {
      spans.push({ ...open, to: change.version, endedAt: Date.parse(change.occurredAt) });
      open = null;
    }
  }
  return open ? KEEP : spans;
}

const within = (spans, version) => spans.some((span) => version >= span.from && version < span.to);

/** One batch's view of what keeps its bytes. What pins a snapshot or a hash is read once, when first needed. */
class RetentionRules {
  constructor(retention, now) {
    this.db = retention.db;
    this.timeline = retention.timeline;
    this.newestKept = retention.config.blobRetentionVersions;
    this.cutoff = now - retention.config.blobRetentionDays * DAY_MS;
    this.pins = null;
  }

  keeps(hash) {
    const uses = this.usesOf(hash);
    // Bytes no snapshot records are not a version of any file.
    if (!uses.length) return true;
    for (const use of uses) {
      use.spans = this.spansOf(hash, use);
      if (use.spans === KEEP) return true;
    }
    const pins = this.pinned();
    if (pins.hashes.has(hash) || uses.some((use) => pins.driveProjects.has(use.projectId))) return true;
    return uses.some((use) => (pins.snapshots.get(use.projectId) ?? []).some((snapshot) => within(use.spans, snapshot.version)
      && this.timeline.files.rowById(snapshot.id, use.fileId)?.content_hash === hash));
  }

  /** The files recorded with these bytes, each with the snapshot versions that wrote them. */
  usesOf(hash) {
    const uses = new Map();
    for (const row of this.db.prepare(FILE_USES).all(hash)) {
      const key = `${row.projectId}\u0000${row.fileId}`;
      if (!uses.has(key)) uses.set(key, { projectId: row.projectId, fileId: row.fileId, versions: [] });
      uses.get(key).versions.push(row.version);
    }
    return [...uses.values()];
  }

  /** Where a file held these bytes, or KEEP when a rule about the file itself keeps them. */
  spansOf(hash, use) {
    const spans = heldSpans(this.db.prepare(FILE_HISTORY).all(use.fileId), hash, this.newestKept);
    if (spans === KEEP) return KEEP;
    if (spans.some((span) => span.endedAt > this.cutoff || Number.isNaN(span.endedAt))) return KEEP;
    // A snapshot that recorded these bytes outside every span means the
    // history and the snapshots disagree; such bytes are left alone.
    if (!use.versions.every((version) => within(spans, version))) return KEEP;
    const unindexed = this.db.prepare(UNINDEXED_SNAPSHOT);
    if (spans.some((span) => unindexed.get(use.projectId, span.from, span.to))) return KEEP;
    return spans;
  }

  pinned() {
    if (this.pins) return this.pins;
    const snapshots = new Map();
    for (const snapshot of this.db.prepare(PINNED_SNAPSHOTS).all()) {
      if (!snapshots.has(snapshot.projectId)) snapshots.set(snapshot.projectId, []);
      snapshots.get(snapshot.projectId).push(snapshot);
    }
    const hashes = new Set(this.db.prepare(PINNED_HASHES).all().map((row) => row.hash));
    for (const row of this.db.prepare("SELECT proposal_json FROM agent_executions WHERE status = 'PROPOSED'").all()) {
      const proposal = json(row.proposal_json, {});
      for (const hash of [proposal.contentHashBefore, proposal.contentHashAfter]) if (hash) hashes.add(hash);
    }
    // A scan's results are reused by the next capture without reading the
    // file again, so bytes a scan saw stay until it is recorded or replaced.
    for (const cache of this.timeline.scanCaches.values()) {
      for (const entry of cache.values()) if (entry.file?.contentHash) hashes.add(entry.file.contentHash);
    }
    const driveProjects = new Set(this.db.prepare('SELECT project_id FROM drive_projects').all().map((row) => row.project_id));
    this.pins = { snapshots, hashes, driveProjects };
    return this.pins;
  }
}

export class BlobRetention {
  constructor({ db, timeline, config }) {
    this.db = db;
    this.timeline = timeline;
    this.config = config;
    // Where the current pass has got to, by hash; '' starts a new pass.
    this.cursor = '';
    this.batches = new IdleBatches({
      timeline, idleMs: config.blobRetentionIdleMs, isEnabled: () => this.enabled,
      runBatch: () => this.releaseBatch(), label: 'release the bytes of old versions',
    });
  }

  get enabled() {
    return this.config.blobRetentionEnabled === true;
  }

  /** The next batch, when one is waiting. */
  get timer() {
    return this.batches.timer;
  }

  /** Schedules a first pass after startup, for a library that is not changing. */
  start() {
    this.batches.start();
  }

  close() {
    this.batches.close();
  }

  /**
   * Looks at up to `limit` stored hashes, past where the last batch stopped,
   * and releases the bytes no rule keeps. `now` is the time the rules are
   * judged at. Returns what it released; `done` once a pass has looked at
   * every hash, and `waiting` when a capture is running and nothing was done.
   */
  releaseBatch({ now = Date.now(), limit = RETENTION_BATCH_SIZE } = {}) {
    const nothing = { enabled: this.enabled, released: [], releasedBytes: 0, examined: 0 };
    if (!this.enabled) return { ...nothing, done: true };
    // A capture stores bytes before it records them, so none are judged meanwhile.
    if (this.timeline.activeCaptures > 0) return { ...nothing, waiting: 'capture', done: false };
    const hashes = this.db.prepare(NEXT_STORED_HASHES).all(this.cursor, limit).map((row) => row.content_hash);
    const done = hashes.length < limit;
    this.cursor = done ? '' : hashes.at(-1);
    const rules = new RetentionRules(this, now);
    // Never shorter than the window in which a blob found again is left alone.
    const untouchedBefore = now - Math.max(this.config.blobRetentionGraceMs, this.config.blobTouchWindowMs ?? 0);
    const released = hashes.filter((hash) => this.timeline.blobs.has(hash) && !rules.keeps(hash))
      .map((hash) => this.release(hash, untouchedBefore))
      .filter(Boolean);
    return { ...nothing, released, releasedBytes: released.reduce((total, entry) => total + entry.storedBytes, 0),
      examined: hashes.length, done };
  }

  /**
   * Releases a blob nothing has stored or found again since `untouchedBefore`:
   * moves its bytes aside, records the release, then deletes them. A failed
   * record puts the bytes back, so a missing blob is never unexplained.
   */
  release(hash, untouchedBefore) {
    const blobs = this.timeline.blobs;
    let withdrawn;
    try {
      withdrawn = blobs.withdraw(hash, untouchedBefore);
    } catch (error) {
      console.warn(`Lasso could not release the bytes of ${hash}:`, error.message);
      return null;
    }
    if (!withdrawn) return null;
    const releasedAt = new Date().toISOString();
    try {
      transaction(this.db, () => this.db.prepare(RECORD_RELEASE).run(hash, releasedAt, withdrawn.storedBytes));
    } catch (error) {
      blobs.restore(withdrawn);
      throw error;
    }
    blobs.discard(withdrawn);
    return { contentHash: hash, storedBytes: withdrawn.storedBytes, releasedAt };
  }
}
