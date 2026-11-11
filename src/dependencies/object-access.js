// Reading a snapshot's source objects back, with their lineage.

import { json } from '../db.js';
import { HttpError } from '../history/errors.js';
import { compareText } from '../history/text-order.js';
import { id, now } from './basics.js';
import { OBJECT_TYPES } from './constants.js';
import { isComponentIdentifier } from './file-objects.js';
import { freezeIndexedValue, mapObjectRow } from './object-descriptors.js';
import { isPassageExcerpt } from './workspace-completion.js';

// Up to this many new objects are looked up one by one; larger batches look
// up only the keys being indexed, not every historical object in the folder.
const INDIVIDUAL_OBJECT_LOOKUPS = 200;

export const objectAccessMethods = {
  /** Each descriptor with its object row, creating objects first seen here. */
  indexEntries(projectId, descriptors) {
    const getObject = this.db.prepare(`SELECT rowid, id, object_key, object_type FROM scientific_objects
      WHERE project_id = ? AND object_key = ?`);
    const insertObject = this.db.prepare(`
      INSERT INTO scientific_objects(id, project_id, object_key, object_type, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, object_key) DO NOTHING
    `);
    const objects = new Map();
    if (descriptors.length > INDIVIDUAL_OBJECT_LOOKUPS) {
      const keys = [...new Set(descriptors.map(descriptor => descriptor.key))];
      for (let offset = 0; offset < keys.length; offset += 128) {
        const batch = keys.slice(offset, offset + 128);
        const rows = this.db.prepare(`SELECT rowid, id, object_key, object_type FROM scientific_objects
          WHERE project_id = ? AND object_key IN (${batch.map(() => '?').join(',')})`).all(projectId, ...batch);
        for (const row of rows) objects.set(row.object_key, row);
      }
    }
    const entries = [];
    const seen = new Set();
    for (const descriptor of descriptors) {
      let object = objects.get(descriptor.key) ?? getObject.get(projectId, descriptor.key);
      if (!object) {
        insertObject.run(id(), projectId, descriptor.key, descriptor.type, now());
        object = getObject.get(projectId, descriptor.key);
      }
      objects.set(descriptor.key, object);
      // The first descriptor for an object wins, as INSERT OR IGNORE did.
      if (seen.has(object.id)) continue;
      seen.add(object.id);
      entries.push({ object, descriptor });
    }
    return entries;
  },

  objectsAt(projectId, snapshotId = null, objectTypes = null) {
    const project = this.timeline.getProject(projectId);
    const target = snapshotId ?? project.currentSnapshotId;
    this.ensureIndex(projectId, target);
    const types = new Set([...(objectTypes ?? [])].filter((type) => OBJECT_TYPES.has(type)));
    const complete = this.objectCache.get(target);
    // Each consumer gets its own array. Indexed object values are immutable.
    if (complete) return types.size ? complete.filter((object) => types.has(object.objectType)) : [...complete];
    if (!types.size) {
      const objects = this.mappedObjects(projectId, this.timeline.objectVersions.resolved(target));
      this.objectCache.set(target, objects);
      return [...objects];
    }
    // Nearly every suggestion asks for a few types. They are kept by type, so
    // a later request for an overlapping set maps nothing again; mapping a
    // PDF's objects reads its text, which ran the PDF reader on each keystroke.
    // Full resolution orders rows by type first, so joining the types in that
    // order is the same list the complete snapshot would filter down to.
    const ordered = [...types].sort(compareText);
    const byType = new Map(ordered.map((type) => [type, this.typedObjectCache.get(`${target}|${type}`)]));
    const missing = ordered.filter((type) => !byType.get(type));
    if (missing.length) {
      const mapped = this.mappedObjects(projectId, this.timeline.objectVersions.resolvedTypes(target, missing));
      for (const type of missing) {
        const objects = mapped.filter((object) => object.objectType === type);
        byType.set(type, objects);
        // Partial results never stand in for the complete snapshot.
        this.typedObjectCache.set(`${target}|${type}`, objects);
      }
    }
    return ordered.flatMap((type) => byType.get(type));
  },

  /** Version rows as the objects suggestions and search are offered. */
  mappedObjects(projectId, resolved) {
    // A version spans snapshots whose files differ; its bytes are this snapshot's.
    const at = { snapshotId: resolved.snapshotId, version: resolved.version,
      hashOf: this.timeline.objectVersions.fileHashes(resolved.snapshotId) };
    return resolved.rows.filter((row) => row.project_id === projectId).map((row) => {
        const object = mapObjectRow(row, at);
        // Search existing PDF versions through their preserved bytes as well as
        // the short metadata excerpt. Derived search text stays in memory so
        // immutable object versions and existing links retain their identity.
        if (/\.pdf$/i.test(object.path) && ['PAPER', 'DRAWING', 'DOCUMENT'].includes(object.objectType)
          && !isPassageExcerpt(object)) {
          object.searchText += ` ${this.sourceText(object).toLowerCase()}`;
        }
        return freezeIndexedValue(object);
      // Earlier indexes recorded prose such as "figure found" as a component.
      // Those versions stay resolvable for existing links but are not offered.
      }).filter((object) => !object.metadata.componentType || !['FIGURE', 'TABLE'].includes(object.metadata.componentType)
        || isComponentIdentifier(object.metadata.identifier))
        // Workbook objects from before worksheet coordinates were superseded
        // by xlsx-v2 keys; they stay resolvable for links but are not offered.
        .filter((object) => !/\.xlsx?$/i.test(object.path) || object.metadata.binary || object.metadata.spreadsheetExtractionVersion === 2);
  },

  /** Drops a snapshot's mapped objects, complete and by type, after its index changes. */
  forgetObjects(snapshotId) {
    this.objectCache.delete(snapshotId);
    for (const type of OBJECT_TYPES) this.typedObjectCache.delete(`${snapshotId}|${type}`);
  },

  objectAt(projectId, snapshotId, objectId) {
    this.ensureIndex(projectId, snapshotId);
    const row = this.timeline.objectVersions.at(snapshotId, objectId);
    return row?.project_id === projectId ? mapObjectRow(row) : null;
  },

  /** Resolve a source in its own directory without weakening objectsAt's
   * explicit project/snapshot isolation. Document transitions remain owned by
   * the destination directory even when their sources live elsewhere. */
  sourceVersion(objectId, snapshotId = null, { destinationProjectId = null, newLink = false } = {}) {
    const owner = this.db.prepare('SELECT project_id FROM scientific_objects WHERE id = ?').get(objectId);
    if (!owner) return null;
    const project = this.timeline.getProject(owner.project_id);
    if (newLink && destinationProjectId && destinationProjectId !== project.id && this.workspace
      && (!this.workspace.isActive(destinationProjectId) || !this.workspace.isActive(project.id))) {
      throw new HttpError(409, 'Enable both work directories before linking sources between them.');
    }
    const target = snapshotId ?? project.currentSnapshotId;
    const snapshot = this.db.prepare('SELECT project_id FROM snapshots WHERE id = ?').get(target);
    if (!snapshot || snapshot.project_id !== project.id) return null;
    this.ensureIndex(project.id, target);
    return this.timeline.objectVersions.at(target, objectId);
  },

  sourceProjectId(object) {
    return object.projectId ?? this.db.prepare('SELECT project_id FROM scientific_objects WHERE id = ?')
      .get(object.id)?.project_id ?? null;
  },

  /// Latest indexed version by globally unique object id. Used only by the
  /// local native overlay to migrate pre-source-identity references.
  objectById(objectId) {
    const row = this.timeline.objectVersions.latest(objectId);
    return row ? { ...mapObjectRow(row), projectId: row.project_id } : null;
  },

  lineageForObject(projectId, object, limit = 8) {
    // This runs for every suggestion while typing. Most snapshots have no
    // outgoing links: find the ones that do for the object's paths in one
    // query, then keep those where the object was indexed at that path.
    const paths = [...new Set([object.path, ...this.db.prepare(
      'SELECT DISTINCT path FROM scientific_object_versions WHERE object_id = ?').all(object.id).map((row) => row.path)])];
    const versions = this.timeline.objectVersions;
    const queue = this.db.prepare(`SELECT DISTINCT p.from_snapshot_id, p.from_path, s.version FROM provenance_links p
      JOIN snapshots s ON s.id = p.from_snapshot_id
      WHERE p.project_id = ? AND p.relation <> 'DEPENDS_ON' AND p.from_path IN (${paths.map(() => '?').join(', ')})
      ORDER BY s.version DESC`).all(projectId, ...paths)
      .filter((row) => versions.nearestVersion(row.from_snapshot_id, object.id)?.path === row.from_path)
      .map((row) => ({ snapshotId: row.from_snapshot_id, path: row.from_path, version: row.version, depth: 0 }));
    this.lineageLinks ??= this.db.prepare(`
      SELECT p.*, s.version AS to_version
      FROM provenance_links p LEFT JOIN snapshots s ON s.id = p.to_snapshot_id
      WHERE p.project_id = ? AND p.from_snapshot_id = ? AND p.from_path = ?
      ORDER BY p.created_at DESC
    `);
    const visited = new Set();
    const seenLinks = new Set();
    const lineage = [];
    while (queue.length && lineage.length < limit) {
      const node = queue.shift();
      const key = `${node.snapshotId}|${node.path}`;
      if (visited.has(key) || node.depth > 4) continue;
      visited.add(key);
      const links = this.lineageLinks.all(projectId, node.snapshotId, node.path);
      for (const link of links) {
        if (seenLinks.has(link.id) || link.relation === 'DEPENDS_ON') continue;
        seenLinks.add(link.id);
        const entry = {
          relation: link.relation,
          snapshotId: link.to_snapshot_id,
          version: link.to_version,
          path: link.to_path,
          anchor: json(link.to_anchor_json, null),
          metadata: json(link.metadata_json, {}),
        };
        lineage.push(entry);
        if (entry.snapshotId && entry.path) queue.push({ ...entry, depth: node.depth + 1 });
        if (lineage.length >= limit) break;
      }
    }
    return lineage;
  },

  enrichObject(projectId, object) {
    const ownerId = this.sourceProjectId(object) ?? projectId;
    const lineage = this.lineageForObject(ownerId, object);
    const origin = lineage.find((item) => /\.(?:py|r|ipynb|js|ts|sql)$/i.test(item.path ?? '')
      || ['line', 'code-block', 'notebook-cell'].includes(item.anchor?.kind)) ?? lineage[0] ?? null;
    return { ...object, projectId: ownerId, lineage, origin };
  },
};
