import crypto from 'node:crypto';
import { BoundedCache } from '../cache.js';
import { compareText, mergeSorted } from './text-order.js';

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
 * Every version keeps the snapshot that first recorded it. Because a version
 * records its file's content hash, the file it points to has the same bytes at
 * every snapshot the version spans.
 */

// An index resolves through at most this many bases; past it, the next index
// is written in full, which bounds the cost of reading any one snapshot.
export const MAX_INDEX_CHAIN = 2_000;
// An index that keeps less than a quarter of its base's objects is written in full.
export const FULL_WRITE_SHARE = 4;
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

const OBJECT_ENTRIES = `SELECT rowid AS version_rowid, snapshot_id FROM scientific_object_versions WHERE object_id = ?
  UNION ALL SELECT NULL, snapshot_id FROM scientific_object_removals WHERE object_id = ?`;

const VERSION_BY_ROWID = `SELECT ${VERSION_COLUMNS} FROM scientific_object_versions v
  JOIN scientific_objects o ON o.id = v.object_id WHERE v.rowid = ?`;

const INSERT_VERSION = `INSERT INTO scientific_object_versions(
  id, object_id, snapshot_id, path, anchor_json, label, value_text, search_text, content_hash, metadata_json, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

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

function sameVersion(row, fields) {
  const [filePath, anchor, label, value, searchText, contentHash, metadata] = fields;
  return row.path === filePath && row.anchor_json === anchor && row.label === label && row.value_text === value
    && row.search_text === searchText && row.content_hash === contentHash && row.metadata_json === metadata;
}

function resolvedSet(snapshotId, version, rows) {
  return { snapshotId, version, rows, byObject: new Map(rows.map((row) => [row.object_id, row])) };
}

export class ObjectVersionStore {
  constructor(db) {
    this.db = db;
    this.chains = new BoundedCache({ maxEntries: 64, maxWeight: 64 * MAX_INDEX_CHAIN, weight: (chain) => chain.size });
    // Rows in a set say nothing about the snapshot they were read at, so
    // consecutive snapshots share the rows they carry forward.
    this.sets = new BoundedCache({ maxEntries: 8, maxWeight: 160_000, weight: (set) => set.rows.length });
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

  /** A row as read at a snapshot, the shape callers of a single version expect. */
  rowAtSnapshot(row, snapshotId, version = this.snapshotVersion(snapshotId)) {
    return { ...row, snapshot_id: snapshotId, snapshot_version: version };
  }

  /** One object's version at a snapshot, or null when it is not there. */
  at(snapshotId, objectId) {
    const cached = this.sets.get(snapshotId);
    if (cached) {
      const row = cached.byObject.get(objectId);
      return row ? this.rowAtSnapshot(row, snapshotId, cached.version) : null;
    }
    const chain = this.chain(snapshotId);
    let nearest = null;
    for (const entry of this.db.prepare(OBJECT_ENTRIES).all(objectId, objectId)) {
      const depth = chain.get(entry.snapshot_id);
      if (depth !== undefined && (!nearest || depth < nearest.depth)) nearest = { ...entry, depth };
    }
    if (nearest?.version_rowid == null) return null;
    return this.rowAt(nearest.version_rowid, snapshotId);
  }

  rowAt(versionRowid, snapshotId) {
    return this.rowAtSnapshot(this.db.prepare(VERSION_BY_ROWID).get(versionRowid), snapshotId);
  }

  /** A version by id, at the snapshot that recorded it. */
  versionById(versionId) {
    const row = this.db.prepare(`SELECT ${VERSION_COLUMNS}, s.version AS snapshot_version
      FROM scientific_object_versions v JOIN scientific_objects o ON o.id = v.object_id
      JOIN snapshots s ON s.id = v.snapshot_id WHERE v.id = ?`).get(versionId);
    return row ? { ...row, snapshot_id: row.recorded_snapshot_id } : null;
  }

  /**
   * The folder's current snapshot if a version is still current there,
   * otherwise the snapshot that recorded it. Used to report which version a
   * pinned version id was taken from.
   */
  currentSnapshotOf(version) {
    const head = this.db.prepare(`SELECT p.current_snapshot_id AS id FROM projects p
      JOIN scientific_objects o ON o.project_id = p.id WHERE o.id = ?`).get(version.object_id)?.id;
    const indexed = head && this.db.prepare('SELECT 1 FROM snapshot_object_indexes WHERE snapshot_id = ?').get(head);
    return indexed && this.at(head, version.object_id)?.version_id === version.version_id
      ? head : version.recorded_snapshot_id;
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

  /** The nearest earlier indexed snapshot a new index can build on, or null to write it in full. */
  baseFor(projectId, snapshotId) {
    const base = this.db.prepare(`SELECT s.id FROM snapshots s JOIN snapshot_object_indexes i ON i.snapshot_id = s.id
      WHERE s.project_id = ? AND s.version < (SELECT version FROM snapshots WHERE id = ?)
      ORDER BY s.version DESC LIMIT 1`).get(projectId, snapshotId)?.id ?? null;
    return base && this.depthOf(base) + 1 < MAX_INDEX_CHAIN ? base : null;
  }

  /**
   * Records a snapshot's index. `entries` are { object, descriptor } in index
   * order, where `object` is the scientific_objects row (id, rowid, key, type).
   * A new index stores only what differs from its base; objects of files in
   * `carriedPaths` are kept from the base without entries. An index that already
   * exists (an upgrade pass) only gains the objects it lacks, as the full-copy
   * INSERT OR IGNORE did; indexes built on it record those objects as absent,
   * so no later snapshot changes. Runs inside the caller's transaction.
   */
  record(projectId, snapshotId, entries, { existing = false, carriedPaths = null } = {}) {
    if (existing) {
      this.addMissing(snapshotId, entries);
      return;
    }
    const insert = this.db.prepare(INSERT_VERSION);
    const createdAt = now();
    let cacheRows = entries.length <= this.sets.maxWeight && this.sets.maxEntries > 0;
    const store = ({ object, descriptor }, fields) => {
      const versionId = crypto.randomUUID();
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
    let base = this.baseFor(projectId, snapshotId);
    const baseCount = base ? this.count(base) : 0;
    // A reading that keeps little of its base, such as the first after a large
    // subfolder stopped being indexed, is written in full. As differences it
    // would record a removal for most of the base, and every later read of
    // this index would resolve through all of them.
    if (base && !carriedPaths?.size && entries.length * FULL_WRITE_SHARE < baseCount) base = null;
    if (!base) {
      const rows = [];
      for (const entry of entries) {
        const row = store(entry, storedFields(entry.descriptor));
        if (row) rows.push(row);
      }
      if (cacheRows) this.sets.set(snapshotId, resolvedSet(snapshotId, version, rows.sort(compareResolved)));
      this.chains.delete(snapshotId);
      this.depths.set(snapshotId, 0);
      return;
    }
    const previous = baseCount <= this.sets.maxWeight ? this.resolved(base) : null;
    cacheRows = cacheRows && previous !== null && baseCount + entries.length <= this.sets.maxWeight;
    this.db.prepare('INSERT INTO object_index_bases(snapshot_id, base_snapshot_id, created_at) VALUES (?, ?, ?)')
      .run(snapshotId, base, createdAt);
    const replaced = new Set();
    const added = [];
    for (const entry of entries) {
      const fields = storedFields(entry.descriptor);
      const before = previous ? previous.byObject.get(entry.object.id) : this.at(base, entry.object.id);
      if (before && sameVersion(before, fields)) continue;
      if (before) replaced.add(entry.object.id);
      const row = store(entry, fields);
      if (row) added.push(row);
    }
    // Base objects of files the caller carries forward stay without an entry.
    const present = new Set(entries.map((entry) => entry.object.id));
    const remove = this.db.prepare('INSERT INTO scientific_object_removals(snapshot_id, object_id) VALUES (?, ?)');
    const previousRows = previous?.rows ?? this.db.prepare(`${RESOLVE_ENTRIES}
      SELECT v.object_id, v.path FROM nearest
      JOIN scientific_object_versions v ON v.rowid = nearest.version_rowid`).iterate(base);
    for (const row of previousRows) {
      if (present.has(row.object_id) || carriedPaths?.has(row.path)) continue;
      remove.run(snapshotId, row.object_id);
      replaced.add(row.object_id);
    }
    // The new index read without the database: its base's rows with this
    // index's changes applied, in the order RESOLVE_OBJECTS returns.
    if (cacheRows) {
      const kept = replaced.size ? previous.rows.filter((row) => !replaced.has(row.object_id)) : previous.rows;
      this.sets.set(snapshotId, resolvedSet(snapshotId, version, mergeSorted(kept, added.sort(compareResolved), compareResolved)));
    }
    this.chains.delete(snapshotId);
    this.depths.set(snapshotId, this.depthOf(base) + 1);
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
