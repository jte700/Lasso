import { BoundedCache } from '../cache.js';
import { json, transaction } from '../db.js';
import { compareText, mergeSorted } from './text-order.js';

/**
 * A snapshot built on a base stores rows only for the files that are new or
 * whose recorded values changed since that base, and lists the files it
 * removed. Its manifest is its base's manifest with those rows applied, so
 * saving one file no longer copies every other file. Snapshots without a base
 * (imports, and every snapshot written before carry-forward) hold all files.
 */

// A manifest resolves through at most this many bases. Past it, the next
// snapshot is stored in full, so reading one stays bounded however long the
// history grows. Amortized, that costs a fraction of a row per capture.
export const MAX_FILE_CHAIN = 2_000;

const FILE_CHAIN = `WITH RECURSIVE chain(snapshot_id, depth) AS (
  SELECT ?, 0
  UNION ALL
  SELECT s.files_base_snapshot_id, chain.depth + 1 FROM chain
  JOIN snapshots s ON s.id = chain.snapshot_id
  WHERE s.files_base_snapshot_id IS NOT NULL
)`;

// For each file, the entry nearest the snapshot wins: its row, or a removal.
// SQLite takes bare columns from the row that holds the MIN().
const NEAREST_FILES = `${FILE_CHAIN},
entries AS (
  SELECT f.project_file_id, f.rowid AS file_rowid, chain.depth FROM snapshot_files f
  JOIN chain ON f.snapshot_id = chain.snapshot_id
  UNION ALL
  SELECT r.project_file_id, NULL, chain.depth FROM snapshot_file_removals r
  JOIN chain ON r.snapshot_id = chain.snapshot_id
),
nearest AS (SELECT project_file_id, file_rowid, MIN(depth) AS depth FROM entries GROUP BY project_file_id)`;

const RESOLVE_FILES = `${NEAREST_FILES}
SELECT f.* FROM nearest JOIN snapshot_files f ON f.rowid = nearest.file_rowid ORDER BY f.path`;

const COUNT_FILES = `${NEAREST_FILES} SELECT COUNT(*) AS count FROM nearest WHERE file_rowid IS NOT NULL`;

// The nearest entry for one file: its row id, or NULL for a removal.
const NEAREST_FILE_ENTRY = `${FILE_CHAIN}
SELECT f.rowid AS file_rowid, chain.depth FROM snapshot_files f JOIN chain ON f.snapshot_id = chain.snapshot_id
WHERE f.project_file_id = ?
UNION ALL
SELECT NULL, chain.depth FROM snapshot_file_removals r JOIN chain ON r.snapshot_id = chain.snapshot_id
WHERE r.project_file_id = ?
ORDER BY depth LIMIT 1`;

const FILE_IDS_AT_PATH = `${FILE_CHAIN}
SELECT DISTINCT f.project_file_id FROM snapshot_files f JOIN chain ON f.snapshot_id = chain.snapshot_id WHERE f.path = ?`;

const CHAIN_DEPTH = `${FILE_CHAIN} SELECT MAX(depth) AS depth FROM chain`;

const INSERT_FILE = `INSERT INTO snapshot_files(snapshot_id, project_file_id, path, content_hash, size, mtime_ms,
  file_type, device, inode, metadata_json, ctime_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** The row as the snapshot it was resolved at would have stored it. */
function asRowAt(row, snapshotId) {
  return row.snapshot_id === snapshotId ? row : { ...row, snapshot_id: snapshotId };
}

const byPath = (left, right) => compareText(left.path, right.path);

function manifestOf(rows) {
  return {
    rows,
    byPath: new Map(rows.map((row) => [row.path, row])),
    byId: new Map(rows.map((row) => [row.project_file_id, row])),
  };
}

/** `snapshotId` is the snapshot the row is read at, when that is not the one that stored it. */
export function rowToSnapshotFile(row, snapshotId = row.snapshot_id) {
  return {
    snapshotId,
    projectFileId: row.project_file_id,
    path: row.path,
    contentHash: row.content_hash,
    size: row.size,
    mtimeMs: row.mtime_ms,
    ctimeMs: row.ctime_ms ?? null,
    fileType: row.file_type,
    device: row.device,
    inode: row.inode,
    metadata: json(row.metadata_json, {}),
  };
}

function fileValues(file) {
  return [file.path, file.contentHash, file.size, file.mtimeMs, file.fileType, file.device ?? null,
    file.inode ?? null, JSON.stringify(file.metadata ?? {}), file.ctimeMs ?? null];
}

function sameRecord(left, right) {
  const a = fileValues(left);
  const b = fileValues(right);
  return a.every((value, index) => value === b[index]);
}

export class SnapshotFileStore {
  constructor(db) {
    this.db = db;
    // Snapshots never change, so a resolved manifest stays valid forever.
    this.manifests = new BoundedCache({ maxEntries: 8, maxWeight: 200_000, weight: (manifest) => manifest.rows.length });
    // How many bases each recent snapshot resolves through, so a capture does
    // not walk its parent's chain to find out.
    this.depths = new BoundedCache({ maxEntries: 256 });
    this.counts = new BoundedCache({ maxEntries: 256 });
  }

  clear() {
    this.manifests.clear();
    this.depths.clear();
    this.counts.clear();
  }

  depthOf(snapshotId) {
    let depth = this.depths.get(snapshotId);
    if (depth === undefined) {
      depth = this.db.prepare(CHAIN_DEPTH).get(snapshotId)?.depth ?? 0;
      this.depths.set(snapshotId, depth);
    }
    return depth;
  }

  /** A snapshot's resolved file rows. Each row keeps the snapshot that stored it. */
  manifest(snapshotId) {
    let manifest = this.manifests.get(snapshotId);
    if (!manifest) {
      manifest = manifestOf(this.db.prepare(RESOLVE_FILES).all(snapshotId));
      this.manifests.set(snapshotId, manifest);
    }
    return manifest;
  }

  /** Every file at a snapshot, ordered by path. */
  files(snapshotId) {
    return this.manifest(snapshotId).rows.map((row) => rowToSnapshotFile(row, snapshotId));
  }

  /** How many files a snapshot has, without resolving them when they are not in memory. */
  count(snapshotId) {
    const cached = this.manifests.get(snapshotId);
    if (cached) return cached.rows.length;
    let count = this.counts.get(snapshotId);
    if (count === undefined) {
      count = this.db.prepare(COUNT_FILES).get(snapshotId).count;
      this.counts.set(snapshotId, count);
    }
    return count;
  }

  /** One file's stored row as of a snapshot, without resolving the whole manifest. */
  rowById(snapshotId, projectFileId) {
    const cached = this.manifests.get(snapshotId)?.byId.get(projectFileId);
    if (cached) return asRowAt(cached, snapshotId);
    if (this.manifests.has(snapshotId)) return null;
    const entry = this.db.prepare(NEAREST_FILE_ENTRY).get(snapshotId, projectFileId, projectFileId);
    if (entry?.file_rowid == null) return null;
    return asRowAt(this.db.prepare('SELECT * FROM snapshot_files WHERE rowid = ?').get(entry.file_rowid), snapshotId);
  }

  rowAtPath(snapshotId, filePath) {
    const cached = this.manifests.get(snapshotId)?.byPath.get(filePath);
    if (cached) return asRowAt(cached, snapshotId);
    if (this.manifests.has(snapshotId)) return null;
    // Only files that held this path somewhere in the chain can hold it now.
    for (const { project_file_id: projectFileId } of this.db.prepare(FILE_IDS_AT_PATH).all(snapshotId, filePath)) {
      const row = this.rowById(snapshotId, projectFileId);
      if (row?.path === filePath) return row;
    }
    return null;
  }

  fileById(snapshotId, projectFileId) {
    const row = this.rowById(snapshotId, projectFileId);
    return row ? rowToSnapshotFile(row) : null;
  }

  fileAtPath(snapshotId, filePath) {
    const row = this.rowAtPath(snapshotId, filePath);
    return row ? rowToSnapshotFile(row) : null;
  }

  /**
   * Records a new snapshot's files. With a base, only files that differ from
   * the base's are written, plus a removal for each base file that is gone.
   * Runs inside the caller's transaction, after the snapshot row exists.
   */
  write(snapshotId, files, baseSnapshotId = null) {
    const insert = this.db.prepare(INSERT_FILE);
    const record = (file) => {
      const values = fileValues(file);
      insert.run(snapshotId, file.projectFileId, ...values);
      const [filePath, contentHash, size, mtimeMs, fileType, device, inode, metadataJson, ctimeMs] = values;
      return { snapshot_id: snapshotId, project_file_id: file.projectFileId, path: filePath, content_hash: contentHash,
        size, mtime_ms: mtimeMs, file_type: fileType, device, inode, metadata_json: metadataJson, ctime_ms: ctimeMs };
    };
    this.depths.set(snapshotId, baseSnapshotId ? this.depthOf(baseSnapshotId) + 1 : 0);
    if (!baseSnapshotId) {
      this.manifests.set(snapshotId, manifestOf(files.map(record).sort(byPath)));
      return;
    }
    const base = this.manifest(baseSnapshotId);
    const present = new Set();
    const written = [];
    for (const file of files) {
      present.add(file.projectFileId);
      const previous = base.byId.get(file.projectFileId);
      if (!previous || !sameRecord(rowToSnapshotFile(previous), file)) written.push(record(file));
    }
    const remove = this.db.prepare('INSERT INTO snapshot_file_removals(snapshot_id, project_file_id) VALUES (?, ?)');
    for (const projectFileId of base.byId.keys()) if (!present.has(projectFileId)) remove.run(snapshotId, projectFileId);
    // The new manifest without reading it back: the base's rows with this
    // snapshot's changes applied, in path order as RESOLVE_FILES returns it.
    const replaced = new Set(written.map((row) => row.project_file_id));
    const kept = base.rows.filter((row) => present.has(row.project_file_id) && !replaced.has(row.project_file_id));
    this.manifests.set(snapshotId, manifestOf(mergeSorted(kept, written.sort(byPath), byPath)));
  }

  /** Runs a transaction that writes a snapshot, forgetting its manifest if it rolls back. */
  transaction(snapshotId, work) {
    try {
      return transaction(this.db, work);
    } catch (error) {
      this.manifests.delete(snapshotId);
      this.depths.delete(snapshotId);
      throw error;
    }
  }

  /** The base a new snapshot after `parentSnapshotId` should build on, or null to store it in full. */
  baseFor(parentSnapshotId) {
    if (!parentSnapshotId) return null;
    return this.depthOf(parentSnapshotId) + 1 >= MAX_FILE_CHAIN ? null : parentSnapshotId;
  }
}
