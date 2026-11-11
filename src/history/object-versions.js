import crypto from 'node:crypto';
import { BoundedCache } from '../cache.js';
import { compareText, mergeSorted } from './text-order.js';
import { changeKind, sameVersion } from './object-identity.js';
import { recordPassageSuccessions } from './passage-succession.js';

/**
 * Indexed object versions, carried forward between snapshots.
 *
 * An index built on a base (object_index_bases) stores a version only for an
 * object whose recorded content, value, label or location differs from the
 * base's, and a removal for each base object it no longer has. An object at a
 * snapshot is the entry nearest to it along that chain of bases. Indexes
 * without a base (the first index of a folder, and every index written before
 * carry-forward) hold all of their objects.
 *
 * Every version keeps the snapshot that first recorded it. A part of a file
 * (a cell, passage, line, note) keeps its version while what was recorded
 * about it stands, however the rest of its file changes; a whole-file object
 * gets a new version whenever the file's bytes change (see object-identity.js).
 * So a version can span snapshots whose file bytes differ, and its stored
 * content_hash is only the file's hash when the version was first recorded.
 * The bytes of an object read at a snapshot are that snapshot's file: rows
 * read here at a snapshot carry the file's hash there (rowAtSnapshot,
 * fileHashes), never the stored one, unless the file is absent there.
 *
 * Every index after a folder's first also records what changed since the
 * index before it (object_changes): each object added, modified, moved or
 * removed, by version id.
 */

// An index resolves through at most this many bases; past it, the next index
// is written in full, which bounds the cost of reading any one snapshot.
export const MAX_INDEX_CHAIN = 2_000;
// An index that keeps less than a quarter of its base's objects is written in full.
export const FULL_WRITE_SHARE = 4;
// About what one resolved version row takes in memory, for the cache budget.
const VERSION_ROW_BYTES = 900;
// Typed resolution starts at the candidate objects only when they number less
// than this share of the index's rows (see resolvedTypes).
const CANDIDATE_SHARE = 4;

const VERSION_COLUMNS = `o.id AS object_id, o.project_id, o.object_key, o.object_type, o.rowid AS object_rowid,
  v.id, v.id AS version_id, v.snapshot_id AS recorded_snapshot_id, v.path, v.anchor_json, v.label, v.value_text,
  v.search_text, v.content_hash, v.metadata_json, v.created_at`;

const INDEX_CHAIN = `WITH RECURSIVE chain(snapshot_id, depth) AS (
  SELECT ?, 0
  UNION ALL
  SELECT b.base_snapshot_id, chain.depth + 1 FROM chain
  JOIN object_index_bases b ON b.snapshot_id = chain.snapshot_id
)`;

// For each object, the entry nearest the snapshot wins: a version, or a
// removal. SQLite takes bare columns from the row that holds the MIN(). The
// order is the one full indexes were read in: by type and label, then by when
// each object was first indexed. compareResolved below sorts the same way.
const RESOLVE_ENTRIES = `${INDEX_CHAIN},
entries AS (
  SELECT v.object_id, v.rowid AS version_rowid, chain.depth FROM scientific_object_versions v
  JOIN chain ON v.snapshot_id = chain.snapshot_id
  UNION ALL
  SELECT r.object_id, NULL, chain.depth FROM scientific_object_removals r
  JOIN chain ON r.snapshot_id = chain.snapshot_id
),
nearest AS (SELECT object_id, version_rowid, MIN(depth) AS depth FROM entries GROUP BY object_id)`;

const RESOLVE_OBJECTS = `${RESOLVE_ENTRIES}
SELECT ${VERSION_COLUMNS}
FROM nearest JOIN scientific_object_versions v ON v.rowid = nearest.version_rowid
JOIN scientific_objects o ON o.id = v.object_id
ORDER BY o.object_type, v.label, o.rowid`;

const RESOLVE_LOCATIONS = `${RESOLVE_ENTRIES}
SELECT v.object_id, o.project_id, v.path
FROM nearest JOIN scientific_object_versions v ON v.rowid = nearest.version_rowid
JOIN scientific_objects o ON o.id = v.object_id`;

const OBJECT_ENTRIES = `SELECT rowid AS version_rowid, snapshot_id FROM scientific_object_versions WHERE object_id = ?
  UNION ALL SELECT NULL, snapshot_id FROM scientific_object_removals WHERE object_id = ?`;

const VERSION_BY_ROWID = `SELECT ${VERSION_COLUMNS} FROM scientific_object_versions v
  JOIN scientific_objects o ON o.id = v.object_id WHERE v.rowid = ?`;

const INSERT_VERSION = `INSERT INTO scientific_object_versions(
  id, object_id, snapshot_id, path, anchor_json, label, value_text, search_text, content_hash, metadata_json, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_CHANGE = `INSERT INTO object_changes(snapshot_id, object_id, kind, before_version_id, after_version_id)
  VALUES (?, ?, ?, ?, ?)`;

function now() {
  return new Date().toISOString();
}

function compareResolved(left, right) {
  return compareText(left.object_type, right.object_type) || compareText(left.label, right.label)
    || left.object_rowid - right.object_rowid;
}

/** A descriptor as its version row stores it. */
export function storedFields(descriptor) {
  return [descriptor.path, descriptor.anchor ? JSON.stringify(descriptor.anchor) : null, descriptor.label,
    descriptor.value ?? null, descriptor.searchText, descriptor.contentHash, JSON.stringify(descriptor.metadata ?? {})];
}

function resolvedSet(snapshotId, version, rows) {
  return { snapshotId, version, rows, byObject: new Map(rows.map((row) => [row.object_id, row])) };
}

export class ObjectVersionStore {
  /** `files` is the timeline's SnapshotFileStore, which says what each file's bytes are at a snapshot. */
  constructor(db, files = null, budget = null) {
    this.db = db;
    this.files = files;
    this.chains = new BoundedCache({ maxEntries: 64, maxWeight: 64 * MAX_INDEX_CHAIN, weight: (chain) => chain.size });
    // Rows in a set say nothing about the snapshot they were read at, so
    // consecutive snapshots share the rows they carry forward.
    this.sets = new BoundedCache({ maxEntries: 8, maxWeight: 160_000, weight: (set) => set.rows.length,
      budget, bytes: (set) => set.rows.length * VERSION_ROW_BYTES });
    // How many bases each recent index resolves through.
    this.depths = new BoundedCache({ maxEntries: 256 });
  }

  clear() {
    this.chains.clear();
    this.sets.clear();
    this.depths.clear();
  }

  depthOf(snapshotId) {
    let depth = this.depths.get(snapshotId);
    if (depth === undefined) {
      depth = this.db.prepare(`${INDEX_CHAIN} SELECT MAX(depth) AS depth FROM chain`).get(snapshotId)?.depth ?? 0;
      this.depths.set(snapshotId, depth);
    }
    return depth;
  }

  forget(snapshotId) {
    this.chains.delete(snapshotId);
    this.sets.delete(snapshotId);
    this.depths.delete(snapshotId);
  }

  snapshotVersion(snapshotId) {
    return this.db.prepare('SELECT version FROM snapshots WHERE id = ?').get(snapshotId)?.version ?? null;
  }

  /** The snapshots an index resolves through, mapped to their distance from it. */
  chain(snapshotId) {
    let chain = this.chains.get(snapshotId);
    if (!chain) {
      chain = new Map(this.db.prepare(`${INDEX_CHAIN} SELECT snapshot_id, depth FROM chain ORDER BY depth`).all(snapshotId)
        .map((row) => [row.snapshot_id, row.depth]));
      this.chains.set(snapshotId, chain);
    }
    return chain;
  }

  /**
   * Every object version at a snapshot: { snapshotId, version, rows, byObject }.
   * Rows keep the snapshot that recorded them as recorded_snapshot_id.
   */
  resolved(snapshotId, { fresh = false } = {}) {
    let set = fresh ? undefined : this.sets.get(snapshotId);
    if (!set) {
      set = resolvedSet(snapshotId, this.snapshotVersion(snapshotId), this.db.prepare(RESOLVE_OBJECTS).all(snapshotId));
      this.sets.set(snapshotId, set);
    }
    return set;
  }

  /** Where each object at a snapshot is, { object_id, project_id, path }, without reading its content. */
  locations(snapshotId) {
    const cached = this.sets.get(snapshotId);
    if (cached) return cached.rows.map(({ object_id, project_id, path }) => ({ object_id, project_id, path }));
    return this.db.prepare(RESOLVE_LOCATIONS).all(snapshotId);
  }

  /**
   * Resolve only selected object types, without loading the rest of a large
   * snapshot. The same nearest-version/removal rule applies along its bases.
   * Start at the project/type index: a drawing-status poll should not visit
   * every spreadsheet cell before discovering that none of them are drawings.
   */
  resolvedTypes(snapshotId, objectTypes) {
    const types = [...new Set(objectTypes)].filter(type => typeof type === 'string');
    const snapshot = this.db.prepare('SELECT project_id, version FROM snapshots WHERE id = ?').get(snapshotId);
    if (!snapshot || !types.length) return resolvedSet(snapshotId, snapshot?.version ?? null, []);
    const placeholders = types.map(() => '?').join(',');
    // Starting at the folder's objects of these types visits every version
    // each of them ever had; starting at the index visits each of its rows.
    // The first wins for a few types of a large index (drawing statuses);
    // the second when the types are most of the index, or when the folder's
    // history dwarfs it, as after a large subfolder stopped being indexed.
    const candidates = this.db.prepare(`SELECT COUNT(*) AS count FROM scientific_objects
      WHERE project_id = ? AND object_type IN (${placeholders})`).get(snapshot.project_id, ...types).count;
    const fromIndex = candidates * CANDIDATE_SHARE >= this.chainEntries(snapshotId);
    const query = `${INDEX_CHAIN},
      entries AS (${fromIndex ? `
        SELECT v.object_id, v.rowid AS version_rowid, chain.depth FROM chain
        CROSS JOIN scientific_object_versions v ON v.snapshot_id = chain.snapshot_id
        CROSS JOIN scientific_objects candidate ON candidate.id = v.object_id
        WHERE candidate.project_id = ? AND candidate.object_type IN (${placeholders})
        UNION ALL
        SELECT r.object_id, NULL, chain.depth FROM chain
        CROSS JOIN scientific_object_removals r ON r.snapshot_id = chain.snapshot_id
        CROSS JOIN scientific_objects candidate ON candidate.id = r.object_id
        WHERE candidate.project_id = ? AND candidate.object_type IN (${placeholders})` : `
        SELECT v.object_id, v.rowid AS version_rowid, chain.depth FROM scientific_objects candidate
        CROSS JOIN scientific_object_versions v ON v.object_id = candidate.id
        JOIN chain ON v.snapshot_id = chain.snapshot_id
        WHERE candidate.project_id = ? AND candidate.object_type IN (${placeholders})
        UNION ALL
        SELECT r.object_id, NULL, chain.depth FROM scientific_objects candidate
        CROSS JOIN scientific_object_removals r ON r.object_id = candidate.id
        JOIN chain ON r.snapshot_id = chain.snapshot_id
        WHERE candidate.project_id = ? AND candidate.object_type IN (${placeholders})`}
      ),
      nearest AS (SELECT object_id, version_rowid, MIN(depth) AS depth FROM entries GROUP BY object_id)
      SELECT ${VERSION_COLUMNS}
      FROM nearest JOIN scientific_object_versions v ON v.rowid = nearest.version_rowid
      JOIN scientific_objects o ON o.id = v.object_id
      ORDER BY o.object_type, v.label, o.rowid`;
    const rows = this.db.prepare(query).all(snapshotId, snapshot.project_id, ...types, snapshot.project_id, ...types);
    return resolvedSet(snapshotId, snapshot.version, rows);
  }

  /** How many version and removal rows an index resolves through, counted from their snapshot index. */
  chainEntries(snapshotId) {
    return this.db.prepare(`${INDEX_CHAIN}
      SELECT (SELECT COUNT(*) FROM chain JOIN scientific_object_versions v ON v.snapshot_id = chain.snapshot_id)
        + (SELECT COUNT(*) FROM chain JOIN scientific_object_removals r ON r.snapshot_id = chain.snapshot_id) AS count`)
      .get(snapshotId).count;
  }

  /** Read a full index incrementally, without retaining another graph of rows. */
  iterateResolved(snapshotId) {
    return this.db.prepare(RESOLVE_OBJECTS).iterate(snapshotId);
  }

  count(snapshotId) {
    const cached = this.sets.get(snapshotId);
    if (cached) return cached.rows.length;
    // Counting must not load every metadata/search string into JavaScript.
    // Large indexes intentionally exceed the derived row-cache budget.
    return this.db.prepare(`${RESOLVE_ENTRIES}
      SELECT COUNT(*) AS count FROM nearest WHERE version_rowid IS NOT NULL`).get(snapshotId).count;
  }

  /**
   * How many objects an index holds, as recorded when it was written.
   * Counting them again resolves the whole chain, which for a large old index
   * reads hundreds of thousands of rows from across the database.
   */
  indexedCount(snapshotId) {
    const cached = this.sets.get(snapshotId);
    if (cached) return cached.rows.length;
    return this.db.prepare('SELECT object_count FROM snapshot_object_indexes WHERE snapshot_id = ?').get(snapshotId)?.object_count
      ?? this.count(snapshotId);
  }

  /** The content hash of the file at `filePath` as of a snapshot, or null when it is absent there. */
  fileHashAt(snapshotId, filePath) {
    return this.files?.rowAtPath(snapshotId, filePath)?.content_hash ?? null;
  }

  /**
   * A lookup of file hashes at one snapshot, `(path) => hash or null`, for
   * mapping many of its rows. It reads the snapshot's manifest once, on first
   * use, and holds it no longer than the lookup is kept.
   */
  fileHashes(snapshotId) {
    let byPath = null;
    return (filePath) => {
      byPath ??= this.files?.manifest(snapshotId).byPath ?? new Map();
      return byPath.get(filePath)?.content_hash ?? null;
    };
  }

  /**
   * A row as read at a snapshot, the shape callers of a single version expect.
   * Its content_hash is its file's at that snapshot, or the recorded one when
   * the file is absent there; recorded_content_hash keeps the one stored with
   * the version, which stays the same at every snapshot it spans. The row
   * itself, which cached sets share between snapshots, is not changed.
   */
  rowAtSnapshot(row, snapshotId, version = this.snapshotVersion(snapshotId)) {
    const recorded = row.recorded_content_hash ?? row.content_hash;
    return { ...row, snapshot_id: snapshotId, snapshot_version: version,
      content_hash: this.fileHashAt(snapshotId, row.path) ?? recorded, recorded_content_hash: recorded };
  }

  /** One object's version at a snapshot, or null when it is not there. */
  at(snapshotId, objectId) {
    const cached = this.sets.get(snapshotId);
    const row = this.nearestVersion(snapshotId, objectId);
    return row ? this.rowAtSnapshot(row, snapshotId, cached?.version) : null;
  }

  /** The stored version row nearest a snapshot for one object, as recorded, or null when it is not there. */
  nearestVersion(snapshotId, objectId) {
    const cached = this.sets.get(snapshotId);
    if (cached) return cached.byObject.get(objectId) ?? null;
    const chain = this.chain(snapshotId);
    let nearest = null;
    for (const entry of this.db.prepare(OBJECT_ENTRIES).all(objectId, objectId)) {
      const depth = chain.get(entry.snapshot_id);
      if (depth !== undefined && (!nearest || depth < nearest.depth)) nearest = { ...entry, depth };
    }
    if (nearest?.version_rowid == null) return null;
    return this.db.prepare(VERSION_BY_ROWID).get(nearest.version_rowid);
  }

  rowAt(versionRowid, snapshotId) {
    return this.rowAtSnapshot(this.db.prepare(VERSION_BY_ROWID).get(versionRowid), snapshotId);
  }

  /** A version by id, at the snapshot that recorded it. */
  versionById(versionId) {
    const row = this.db.prepare(`SELECT ${VERSION_COLUMNS}, s.version AS snapshot_version
      FROM scientific_object_versions v JOIN scientific_objects o ON o.id = v.object_id
      JOIN snapshots s ON s.id = v.snapshot_id WHERE v.id = ?`).get(versionId);
    return row ? this.rowAtSnapshot(row, row.recorded_snapshot_id, row.snapshot_version) : null;
  }

  /**
   * The latest snapshot a version is current at: the folder's current
   * snapshot while it still is, otherwise the last indexed snapshot before
   * the object next changed, or the snapshot that recorded it. A version
   * spans snapshots whose files differ, so a pinned version id with no
   * snapshot is shown in the newest file that still reads it, never in one
   * older than any it could have been taken from.
   */
  lastSnapshotOf(version) {
    const head = this.db.prepare(`SELECT p.current_snapshot_id AS id FROM projects p
      JOIN scientific_objects o ON o.project_id = p.id WHERE o.id = ?`).get(version.object_id)?.id;
    const indexed = head && this.db.prepare('SELECT 1 FROM snapshot_object_indexes WHERE snapshot_id = ?').get(head);
    if (indexed && this.nearestVersion(head, version.object_id)?.version_id === version.version_id) return head;
    const last = this.db.prepare(`WITH recorded AS (SELECT project_id, version FROM snapshots WHERE id = ?),
      later AS (
        SELECT MIN(s.version) AS version FROM (
          SELECT snapshot_id FROM scientific_object_versions WHERE object_id = ?
          UNION ALL SELECT snapshot_id FROM scientific_object_removals WHERE object_id = ?
          UNION ALL SELECT snapshot_id FROM object_changes WHERE object_id = ? AND kind = 'removed'
        ) entry JOIN snapshots s ON s.id = entry.snapshot_id, recorded WHERE s.version > recorded.version)
      SELECT s.id FROM snapshots s JOIN snapshot_object_indexes i ON i.snapshot_id = s.id, recorded, later
      WHERE s.project_id = recorded.project_id AND s.version >= recorded.version
        AND (later.version IS NULL OR s.version < later.version)
      ORDER BY s.version DESC LIMIT 1`)
      .get(version.recorded_snapshot_id, version.object_id, version.object_id, version.object_id)?.id;
    return last && this.nearestVersion(last, version.object_id)?.version_id === version.version_id
      ? last : version.recorded_snapshot_id;
  }

  /**
   * An object's latest version, resolved at the newest indexed snapshot that
   * still has it, the way a full-copy index's newest row would have read.
   */
  latest(objectId) {
    const owner = this.db.prepare('SELECT project_id FROM scientific_objects WHERE id = ?').get(objectId);
    if (!owner) return null;
    const entries = this.db.prepare(OBJECT_ENTRIES).all(objectId, objectId);
    const newest = this.db.prepare(`SELECT s.id FROM snapshots s JOIN snapshot_object_indexes i ON i.snapshot_id = s.id
      WHERE s.project_id = ? ORDER BY s.version DESC LIMIT 1`).get(owner.project_id)?.id;
    if (newest) {
      const chain = this.chain(newest);
      const order = [...chain.keys()];
      const along = entries.filter((entry) => chain.has(entry.snapshot_id))
        .map((entry) => ({ ...entry, depth: chain.get(entry.snapshot_id) }))
        .sort((left, right) => left.depth - right.depth);
      // Before the nearest removal the object is absent; it is present again
      // from the snapshot just past it, up to the next older version.
      let present = 0;
      for (const entry of along) {
        if (entry.version_rowid != null) return this.rowAt(entry.version_rowid, order[present]);
        present = entry.depth + 1;
      }
    }
    // Versions outside that chain, such as an index written after later ones.
    const recorded = entries.filter((entry) => entry.version_rowid != null)
      .map((entry) => ({ ...entry, version: this.snapshotVersion(entry.snapshot_id) }))
      .sort((left, right) => right.version - left.version)[0];
    return recorded ? this.rowAt(recorded.version_rowid, recorded.snapshot_id) : null;
  }

  /** Whether a snapshot already holds index records, even if its index row was cleared to force a re-index. */
  hasRecords(snapshotId) {
    return Boolean(this.db.prepare(`SELECT 1 FROM object_index_bases WHERE snapshot_id = ?
      UNION ALL SELECT 1 FROM scientific_object_versions WHERE snapshot_id = ?
      UNION ALL SELECT 1 FROM scientific_object_removals WHERE snapshot_id = ? LIMIT 1`).get(snapshotId, snapshotId, snapshotId));
  }

  /** Whether an index can still be built on this one, rather than written in full. */
  canBuildOn(snapshotId) {
    return this.depthOf(snapshotId) + 1 < MAX_INDEX_CHAIN;
  }

  /** The nearest earlier indexed snapshot, or null. */
  previousIndexed(projectId, snapshotId) {
    return this.db.prepare(`SELECT s.id FROM snapshots s JOIN snapshot_object_indexes i ON i.snapshot_id = s.id
      WHERE s.project_id = ? AND s.version < (SELECT version FROM snapshots WHERE id = ?)
      ORDER BY s.version DESC LIMIT 1`).get(projectId, snapshotId)?.id ?? null;
  }

  /** The nearest earlier indexed snapshot a new index can build on, or null to write it in full. */
  baseFor(projectId, snapshotId) {
    const base = this.previousIndexed(projectId, snapshotId);
    return base && this.depthOf(base) + 1 < MAX_INDEX_CHAIN ? base : null;
  }

  /**
   * The cells of a table's rows without names (keys with ":cell:~") that an
   * index holds for one file, as { object_key, value_text, anchor_json }.
   * Only the file's own objects, keys starting with `prefix`, are resolved,
   * not the whole index.
   */
  tokenCellsAt(snapshotId, projectId, prefix) {
    const upper = `${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`;
    const cached = this.sets.get(snapshotId);
    if (cached) {
      return cached.rows.filter((row) => row.object_key >= prefix && row.object_key < upper && row.object_key.includes(':cell:~'))
        .map(({ object_key, value_text, anchor_json }) => ({ object_key, value_text, anchor_json }));
    }
    return this.db.prepare(`${INDEX_CHAIN},
      candidates AS (SELECT id FROM scientific_objects
        WHERE project_id = ? AND object_key >= ? AND object_key < ? AND instr(object_key, ':cell:~') > 0),
      entries AS (
        SELECT v.object_id, v.rowid AS version_rowid, chain.depth FROM candidates c
        CROSS JOIN scientific_object_versions v ON v.object_id = c.id
        JOIN chain ON v.snapshot_id = chain.snapshot_id
        UNION ALL
        SELECT r.object_id, NULL, chain.depth FROM candidates c
        CROSS JOIN scientific_object_removals r ON r.object_id = c.id
        JOIN chain ON r.snapshot_id = chain.snapshot_id
      ),
      nearest AS (SELECT object_id, version_rowid, MIN(depth) AS depth FROM entries GROUP BY object_id)
      SELECT o.object_key, v.value_text, v.anchor_json
      FROM nearest JOIN scientific_object_versions v ON v.rowid = nearest.version_rowid
      JOIN scientific_objects o ON o.id = v.object_id`).all(snapshotId, projectId, prefix, upper);
  }

  /**
   * Records a snapshot's index. `entries` are { object, descriptor } in index
   * order, where `object` is the scientific_objects row (id, rowid, key, type).
   * A new index stores only what differs from its base; objects of files in
   * `carriedPaths` are kept from the base without entries. An index that already
   * exists (an upgrade pass) only gains the objects it lacks, as the full-copy
   * INSERT OR IGNORE did; indexes built on it record those objects as absent,
   * so no later snapshot changes. An index records each change from the index
   * before it in object_changes, whether built on it or written in full; the
   * first index of a folder and an upgrade pass record none.
   * Runs inside the caller's transaction.
   * Returns how many objects the index holds, or null after an upgrade pass,
   * whose count is not known without resolving it.
   */
  record(projectId, snapshotId, entries, { existing = false, carriedPaths = null } = {}) {
    if (existing) {
      this.addMissing(snapshotId, entries);
      return null;
    }
    const insert = this.db.prepare(INSERT_VERSION);
    const createdAt = now();
    let cacheRows = entries.length <= this.sets.maxWeight && this.sets.maxEntries > 0;
    const store = ({ object }, fields, versionId = crypto.randomUUID()) => {
      insert.run(versionId, object.id, snapshotId, ...fields, createdAt);
      if (!cacheRows) return null;
      const [filePath, anchor, label, value, searchText, contentHash, metadata] = fields;
      return {
        object_id: object.id, project_id: projectId, object_key: object.object_key, object_type: object.object_type,
        object_rowid: object.rowid, id: versionId, version_id: versionId, recorded_snapshot_id: snapshotId,
        path: filePath, anchor_json: anchor, label, value_text: value, search_text: searchText,
        content_hash: contentHash, metadata_json: metadata, created_at: createdAt,
      };
    };
    const version = this.snapshotVersion(snapshotId);
    // The index this one follows, whether it is built on it or written in full.
    const prior = this.previousIndexed(projectId, snapshotId);
    let base = prior && this.canBuildOn(prior) ? prior : null;
    const baseCount = base ? this.indexedCount(base) : 0;
    // A reading that keeps little of its base, such as the first after a large
    // subfolder stopped being indexed, is written in full. As differences it
    // would record a removal for most of the base, and every later read of
    // this index would resolve through all of them.
    if (base && !carriedPaths?.size && entries.length * FULL_WRITE_SHARE < baseCount) base = null;
    if (!base) {
      const rows = [];
      const written = [];
      for (const entry of entries) {
        const fields = storedFields(entry.descriptor);
        const versionId = crypto.randomUUID();
        const row = store(entry, fields, versionId);
        written.push({ entry, fields, versionId });
        if (row) rows.push(row);
      }
      // A full write that follows an index still records what changed since
      // it; only the first index of a folder has nothing to compare with.
      if (prior) {
        this.recordChanges(snapshotId, prior, written, carriedPaths);
        recordPassageSuccessions(this.db, snapshotId);
      }
      if (cacheRows) this.sets.set(snapshotId, resolvedSet(snapshotId, version, rows.sort(compareResolved)));
      this.chains.delete(snapshotId);
      this.depths.set(snapshotId, 0);
      return entries.length;
    }
    const previous = baseCount <= this.sets.maxWeight ? this.resolved(base) : null;
    cacheRows = cacheRows && previous !== null && baseCount + entries.length <= this.sets.maxWeight;
    this.db.prepare('INSERT INTO object_index_bases(snapshot_id, base_snapshot_id, created_at) VALUES (?, ?, ?)')
      .run(snapshotId, base, createdAt);
    const replaced = new Set();
    const added = [];
    const change = this.db.prepare(INSERT_CHANGE);
    // The new count is the base's, with the objects this index adds and removes.
    let count = baseCount;
    for (const entry of entries) {
      const fields = storedFields(entry.descriptor);
      const before = previous ? previous.byObject.get(entry.object.id) : this.nearestVersion(base, entry.object.id);
      if (!before) count += 1;
      if (before && sameVersion(before, fields, entry.object.object_type)) continue;
      if (before) replaced.add(entry.object.id);
      const versionId = crypto.randomUUID();
      const row = store(entry, fields, versionId);
      change.run(snapshotId, entry.object.id, changeKind(before, fields, entry.object.object_type),
        before?.version_id ?? null, versionId);
      if (row) added.push(row);
    }
    // Base objects of files the caller carries forward stay without an entry.
    const present = new Set(entries.map((entry) => entry.object.id));
    const remove = this.db.prepare('INSERT INTO scientific_object_removals(snapshot_id, object_id) VALUES (?, ?)');
    for (const row of this.baseRows(base, previous)) {
      if (present.has(row.object_id) || carriedPaths?.has(row.path)) continue;
      remove.run(snapshotId, row.object_id);
      change.run(snapshotId, row.object_id, 'removed', row.version_id, null);
      replaced.add(row.object_id);
      count -= 1;
    }
    recordPassageSuccessions(this.db, snapshotId);
    // The new index read without the database: its base's rows with this
    // index's changes applied, in the order RESOLVE_OBJECTS returns.
    if (cacheRows) {
      const kept = replaced.size ? previous.rows.filter((row) => !replaced.has(row.object_id)) : previous.rows;
      this.sets.set(snapshotId, resolvedSet(snapshotId, version, mergeSorted(kept, added.sort(compareResolved), compareResolved)));
    }
    this.chains.delete(snapshotId);
    this.depths.set(snapshotId, this.depthOf(base) + 1);
    return count;
  }

  /** Every object of an index as { object_id, version_id, path }, from its resolved set when there is one. */
  baseRows(snapshotId, resolved = null) {
    return resolved?.rows ?? this.db.prepare(`${RESOLVE_ENTRIES}
      SELECT v.object_id, v.id AS version_id, v.path FROM nearest
      JOIN scientific_object_versions v ON v.rowid = nearest.version_rowid`).iterate(snapshotId);
  }

  /**
   * The change records of an index written in full after `prior`: each
   * written object { entry, fields, versionId } that differs from its version
   * there, and each object of `prior` it no longer has. An object written
   * again as it read is not a change.
   */
  recordChanges(snapshotId, prior, written, carriedPaths = null) {
    const change = this.db.prepare(INSERT_CHANGE);
    const resolved = this.indexedCount(prior) <= this.sets.maxWeight ? this.resolved(prior) : null;
    for (const { entry, fields, versionId } of written) {
      const before = resolved ? resolved.byObject.get(entry.object.id) : this.nearestVersion(prior, entry.object.id);
      if (before && sameVersion(before, fields, entry.object.object_type)) continue;
      change.run(snapshotId, entry.object.id, changeKind(before, fields, entry.object.object_type),
        before?.version_id ?? null, versionId);
    }
    const present = new Set(written.map(({ entry }) => entry.object.id));
    for (const row of this.baseRows(prior, resolved)) {
      if (present.has(row.object_id) || carriedPaths?.has(row.path)) continue;
      change.run(snapshotId, row.object_id, 'removed', row.version_id, null);
    }
  }

  /**
   * Records objects a snapshot's index did not read when it was built, such
   * as rows of a large table first offered later. Each is the version a
   * reading of the whole file would have recorded. Indexes already built on
   * this one are told they lack them, as for an upgrade pass. An object this
   * index records as removed stays removed. Returns the entries recorded.
   */
  addAt(snapshotId, entries) {
    const insert = this.db.prepare(INSERT_VERSION);
    const removed = this.db.prepare('SELECT 1 FROM scientific_object_removals WHERE snapshot_id = ? AND object_id = ?');
    const added = [];
    for (const entry of entries) {
      if (this.nearestVersion(snapshotId, entry.object.id) || removed.get(snapshotId, entry.object.id)) continue;
      insert.run(crypto.randomUUID(), entry.object.id, snapshotId, ...storedFields(entry.descriptor), now());
      added.push(entry);
    }
    if (!added.length) return added;
    const hide = this.db.prepare(`INSERT OR IGNORE INTO scientific_object_removals(snapshot_id, object_id)
      SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM scientific_object_versions WHERE snapshot_id = ? AND object_id = ?)`);
    for (const { snapshot_id: dependent } of this.db.prepare('SELECT snapshot_id FROM object_index_bases WHERE base_snapshot_id = ?').all(snapshotId)) {
      for (const { object } of added) hide.run(dependent, object.id, dependent, object.id);
    }
    this.sets.delete(snapshotId);
    return added;
  }

  addMissing(snapshotId, entries) {
    const insert = this.db.prepare(INSERT_VERSION);
    // Read from the database: this pass exists to repair what it holds.
    const present = this.resolved(snapshotId, { fresh: true }).byObject;
    const added = entries.filter(({ object }) => !present.has(object.id));
    for (const { object, descriptor } of added) {
      insert.run(crypto.randomUUID(), object.id, snapshotId, ...storedFields(descriptor), now());
    }
    const hide = this.db.prepare(`INSERT OR IGNORE INTO scientific_object_removals(snapshot_id, object_id)
      SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM scientific_object_versions WHERE snapshot_id = ? AND object_id = ?)`);
    const dependents = this.db.prepare('SELECT snapshot_id FROM object_index_bases WHERE base_snapshot_id = ?').all(snapshotId);
    for (const { snapshot_id: dependent } of dependents) {
      for (const { object } of added) hide.run(dependent, object.id, dependent, object.id);
    }
    this.sets.delete(snapshotId);
  }
}
