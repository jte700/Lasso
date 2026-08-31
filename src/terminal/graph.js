// The read layer every terminal command shares.
//
// It owns no data. Every answer here is assembled from the same tables the
// editor, the source inspector and the share service read: scientific objects
// and their versions, claim dependencies and their versions, snapshots, and
// share grants. Nothing is recomputed and nothing is cached beyond the
// per-snapshot object list, which the indexer already treats as immutable.

import path from 'node:path';
import { json } from '../db.js';
import { parseDelimited } from '../history/diff.js';
import { extractSpreadsheetTables } from '../dependencies/document-extraction.js';
import {
  canonicalAddress, dependencyName, describeObject, slug, sourceDirectory, sourceFileName, sourceLocator,
} from './names.js';

/** Objects that are containers rather than addressable values. */
const CONTAINER_TYPES = new Set(['DATASET', 'DOCUMENT', 'TABLE', 'CODE_BLOCK']);

function tokens(value) {
  return String(value ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function normalizeQueryName(value) {
  return slug(value);
}

export class DependencyGraph {
  constructor({ timeline, dependencies, objectShares = null, aliases = null }) {
    this.timeline = timeline;
    this.dependencies = dependencies;
    this.objectShares = objectShares;
    this.aliases = aliases;
    this.db = timeline.db;
    this.namedObjectCache = new Map();
    this.unsubscribe = timeline.onCapture(() => this.namedObjectCache.clear());
  }

  close() { this.unsubscribe?.(); }

  project(projectId) { return this.timeline.getProject(projectId); }

  currentSnapshotId(projectId) { return this.project(projectId).currentSnapshotId; }

  // ── the addressable index ────────────────────────────────────────────────

  /**
   * Every indexed object at a snapshot, with the typeable name and the exact
   * source locator attached. This is the terminal's view of the source
   * registry; the editor sees the same rows through the same service.
   */
  namedObjects(projectId, snapshotId = null) {
    const target = snapshotId ?? this.currentSnapshotId(projectId);
    if (this.namedObjectCache.has(target)) return this.namedObjectCache.get(target);
    const objects = this.dependencies.objectsAt(projectId, target).map((object) => ({
      ...object,
      name: dependencyName(object),
      locator: sourceLocator(object),
      directory: sourceDirectory(object.path),
      fileName: sourceFileName(object.path),
    }));
    this.namedObjectCache.set(target, objects);
    return objects;
  }

  /** Addressable objects only — containers are reachable through `impact`. */
  addressableObjects(projectId, snapshotId = null) {
    return this.namedObjects(projectId, snapshotId)
      .filter((object) => object.name && !CONTAINER_TYPES.has(object.objectType));
  }

  objectByKey(projectId, objectKey, snapshotId = null) {
    return this.namedObjects(projectId, snapshotId).find((object) => object.objectKey === objectKey) ?? null;
  }

  objectById(projectId, objectId, snapshotId = null) {
    return this.namedObjects(projectId, snapshotId).find((object) => object.id === objectId) ?? null;
  }

  // ── search ───────────────────────────────────────────────────────────────

  /**
   * Exact-name matching first, then relevance over the indexed search text.
   * Exact matches always outrank fuzzy ones, so a name that exists is never
   * buried under something merely similar.
   */
  search(projectId, query, options = {}) {
    const raw = String(query ?? '').trim();
    const wanted = normalizeQueryName(raw);
    const terms = tokens(raw);
    const pool = options.includeContainers
      ? this.namedObjects(projectId, options.snapshotId)
      : this.addressableObjects(projectId, options.snapshotId);

    // Naming an indexed file means that file. Scoring its path word by word
    // would drag in every sibling that shares a directory.
    const named = raw.toLowerCase();
    const inFile = (object) => object.path.toLowerCase() === named || object.fileName.toLowerCase() === named;
    const exactSource = named && (pool.filter(inFile).length
      ? pool.filter(inFile)
      : this.namedObjects(projectId, options.snapshotId).filter(inFile));
    if (exactSource && exactSource.length) {
      return exactSource
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, options.limit ?? 25)
        .map((object) => ({ object, score: 1, matchKind: 'source' }));
    }

    const scored = [];
    for (const object of pool) {
      if (options.directory && !`${object.path}/`.toLowerCase().startsWith(`${String(options.directory).replace(/\/+$/, '').toLowerCase()}/`)) continue;
      if (options.sourceType && path.posix.extname(object.path).slice(1).toLowerCase() !== String(options.sourceType).toLowerCase().replace(/^\./, '')) continue;
      if (options.pathFragment && !object.path.toLowerCase().includes(String(options.pathFragment).toLowerCase())) continue;

      let score = 0;
      let matchKind = null;
      if (wanted && object.name === wanted) { score = 1; matchKind = 'exact'; }
      else if (wanted && object.name.startsWith(wanted)) { score = 0.82; matchKind = 'prefix'; }
      else if (wanted && object.name.includes(wanted)) { score = 0.66; matchKind = 'contains'; }
      if (terms.length) {
        const haystack = object.searchText;
        const hits = terms.filter((term) => haystack.includes(term)).length;
        const semantic = (hits / terms.length) * 0.6;
        if (semantic > score) { score = semantic; matchKind = matchKind ?? 'relevance'; }
        else if (hits === terms.length && matchKind === null) { score = semantic; matchKind = 'relevance'; }
      }
      if (!raw) { score = 0.2; matchKind = 'all'; }
      if (score <= 0) continue;
      scored.push({ object, score, matchKind });
    }

    let results = scored;
    if (options.updatedWithinMs) {
      const cutoff = Date.now() - options.updatedWithinMs;
      results = results.filter(({ object }) => {
        const updated = this.sourceUpdatedAt(projectId, object);
        return updated != null && Date.parse(updated) >= cutoff;
      });
    }

    return results
      .sort((left, right) => right.score - left.score
        || left.object.name.localeCompare(right.object.name)
        || left.object.path.localeCompare(right.object.path))
      .slice(0, options.limit ?? 25);
  }

  // ── name resolution ──────────────────────────────────────────────────────

  /**
   * Resolves a typed name to exactly one indexed object, or reports the
   * candidates. It never picks between equally-ranked candidates: an ambiguous
   * name is an answer the user has to give, through an alias or a filter.
   */
  resolve(projectId, name, options = {}) {
    const raw = String(name ?? '').trim();
    if (!raw) return { status: 'NOT_FOUND', query: raw, candidates: [] };

    const alias = this.aliases?.find(projectId, raw) ?? null;
    if (alias) {
      const object = this.objectByKey(projectId, alias.objectKey, options.snapshotId);
      if (object) return { status: 'RESOLVED', query: raw, object, alias, candidates: [object] };
      return { status: 'ALIAS_BROKEN', query: raw, alias, candidates: [] };
    }

    const wanted = normalizeQueryName(raw);
    const pool = this.addressableObjects(projectId, options.snapshotId)
      .filter((object) => !options.directory
        || `${object.path}/`.toLowerCase().startsWith(`${String(options.directory).replace(/\/+$/, '').toLowerCase()}/`));

    const exact = pool.filter((object) => object.name === wanted);
    if (exact.length === 1) return { status: 'RESOLVED', query: raw, object: exact[0], candidates: exact };
    if (exact.length > 1) {
      // Only a single candidate that anything actually references breaks the tie.
      const referenced = exact.filter((object) => this.referenceCount(projectId, object.id) > 0);
      if (referenced.length === 1) {
        return { status: 'RESOLVED', query: raw, object: referenced[0], candidates: exact, disambiguatedBy: 'references' };
      }
      return { status: 'AMBIGUOUS', query: raw, candidates: exact };
    }

    const prefix = pool.filter((object) => object.name.startsWith(wanted));
    if (prefix.length === 1) return { status: 'RESOLVED', query: raw, object: prefix[0], candidates: prefix };
    if (prefix.length > 1) return { status: 'AMBIGUOUS', query: raw, candidates: prefix.slice(0, 25) };

    const near = this.search(projectId, raw, { limit: 8, snapshotId: options.snapshotId })
      .map(({ object }) => object);
    return { status: 'NOT_FOUND', query: raw, candidates: near };
  }

  /**
   * Suggestions for a half-typed dependency name.
   *
   * Prefix matches come first because that is what completing a name means.
   * When nothing starts with the fragment, related sources are offered rather
   * than an empty box — a person who types `find account` is looking for
   * something, and the index usually knows what.
   */
  nameSuggestions(projectId, fragment, limit = 12) {
    const wanted = normalizeQueryName(fragment);
    const seen = new Map();
    const add = (entry) => {
      if (!seen.has(entry.name)) seen.set(entry.name, entry);
    };
    const describe = (object) => ({
      name: object.name,
      kind: 'dependency',
      value: object.valueText ?? null,
      detail: [object.fileName, object.locator].filter(Boolean).join(' · '),
      objectKey: object.objectKey,
    });

    for (const alias of this.aliases?.list(projectId) ?? []) {
      if (!wanted || alias.name.startsWith(wanted)) {
        add({ name: alias.name, kind: 'alias', value: null, detail: alias.address, objectKey: alias.objectKey });
      }
    }
    for (const object of this.addressableObjects(projectId)) {
      if (wanted && !object.name.startsWith(wanted)) continue;
      add(describe(object));
      if (seen.size >= limit * 3) break;
    }

    const prefixed = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit);
    // Prefix matches are what completing a name means, so when there are any,
    // padding the list out with loosely related sources would only be noise.
    if (prefixed.length || !wanted) return prefixed;

    // Nothing starts with the fragment. Rather than an empty box, offer what
    // the index considers related, marked so the terminal can say as much.
    for (const { object } of this.search(projectId, fragment, { limit })) {
      add({ ...describe(object), kind: 'related' });
      if (seen.size >= limit) break;
    }
    return [...seen.values()].slice(0, limit);
  }

  /**
   * Indexed source files matching a fragment. A file is usually named after
   * what it is, so this is often the most direct thing to complete: the name
   * matches first, then the path, then anything containing the fragment.
   */
  sourceSuggestions(projectId, fragment, limit = 8) {
    const wanted = String(fragment ?? '').toLowerCase();
    const files = new Map();
    for (const object of this.namedObjects(projectId)) {
      if (files.has(object.path)) continue;
      const name = object.fileName.toLowerCase();
      const full = object.path.toLowerCase();
      const rank = !wanted ? 3
        : name.startsWith(wanted) ? 0
        : full.startsWith(wanted) ? 1
        : name.includes(wanted) || full.includes(wanted) ? 2
        : -1;
      if (rank < 0) continue;
      files.set(object.path, {
        name: object.path,
        kind: 'source',
        value: null,
        detail: `${this.objectsInFile(projectId, object.path)} indexed`,
        rank,
      });
    }
    return [...files.values()]
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  /** How many indexed objects one file contributes. */
  objectsInFile(projectId, filePath) {
    return this.namedObjects(projectId).filter((object) => object.path === filePath).length;
  }

  /** Directories that hold indexed files, for `--directory` and `index remove`. */
  directorySuggestions(projectId, fragment, limit = 10) {
    const wanted = String(fragment ?? '').toLowerCase().replace(/\/+$/, '');
    const directories = new Map();
    for (const object of this.namedObjects(projectId)) {
      const parts = sourceDirectory(object.path).split('/').filter(Boolean);
      for (let depth = 1; depth <= parts.length; depth += 1) {
        const directory = parts.slice(0, depth).join('/');
        const entry = directories.get(directory) ?? { files: new Set() };
        entry.files.add(object.path);
        directories.set(directory, entry);
      }
    }
    return [...directories.entries()]
      .filter(([directory]) => !wanted || directory.toLowerCase().startsWith(wanted))
      .map(([directory, entry]) => ({
        name: directory,
        kind: 'directory',
        value: null,
        detail: `${entry.files.size} file${entry.files.size === 1 ? '' : 's'}`,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  /** `path:locator` addresses, which is what `alias` pins. */
  addressSuggestions(projectId, fragment, limit = 12) {
    const wanted = String(fragment ?? '').toLowerCase();
    return this.addressableObjects(projectId)
      .map((object) => ({
        name: canonicalAddress(object),
        kind: 'address',
        value: object.valueText ?? null,
        detail: object.name,
      }))
      .filter((entry) => !wanted || entry.name.toLowerCase().includes(wanted)
        || entry.detail.toLowerCase().startsWith(wanted))
      // An address is pinned in order to name a value, so those lead.
      .sort((a, b) => Number(b.value != null) - Number(a.value != null)
        || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  /** File extensions present in the index, for `--source`. */
  sourceTypeSuggestions(projectId, fragment) {
    const wanted = String(fragment ?? '').toLowerCase().replace(/^\./, '');
    const types = new Map();
    for (const object of this.namedObjects(projectId)) {
      const extension = path.posix.extname(object.path).slice(1).toLowerCase();
      if (!extension) continue;
      types.set(extension, (types.get(extension) ?? 0) + 1);
    }
    return [...types.entries()]
      .filter(([extension]) => !wanted || extension.startsWith(wanted))
      .map(([extension, count]) => ({
        name: extension,
        kind: 'type',
        value: null,
        detail: `${count} indexed`,
      }))
      .sort((a, b) => b.detail.localeCompare(a.detail) || a.name.localeCompare(b.name));
  }

  // ── provenance ───────────────────────────────────────────────────────────

  /** When the file behind an object was last written, from the snapshot record. */
  sourceUpdatedAt(projectId, object) {
    const row = this.db.prepare('SELECT mtime_ms FROM snapshot_files WHERE snapshot_id = ? AND path = ?')
      .get(object.snapshotId, object.path);
    return row ? new Date(row.mtime_ms).toISOString() : null;
  }

  indexedAt(snapshotId) {
    return this.db.prepare('SELECT indexed_at FROM snapshot_object_indexes WHERE snapshot_id = ?')
      .get(snapshotId)?.indexed_at ?? null;
  }

  /** Everything `trace` reports about one object. */
  trace(projectId, object) {
    const snapshot = this.timeline.getSnapshot(object.snapshotId);
    const references = this.referencesTo(projectId, object.id);
    const shares = this.sharesForObject(projectId, object.id);
    const enriched = this.dependencies.enrichObject(projectId, object);
    return {
      ...describeObject(object),
      address: canonicalAddress(object),
      alias: this.aliases?.findByObjectKey(projectId, object.objectKey)?.name ?? null,
      updatedAt: this.sourceUpdatedAt(projectId, object),
      indexedAt: this.indexedAt(object.snapshotId),
      projectVersion: snapshot.version,
      origin: enriched.origin ?? null,
      references,
      shares,
      valid: references.every((reference) => reference.status === 'LINKED'),
    };
  }

  // ── downstream references ────────────────────────────────────────────────

  /** Live claim-dependency versions pointing at an object, newest state only. */
  dependenciesForObject(projectId, objectId) {
    const maximum = this.timeline.getSnapshot(this.currentSnapshotId(projectId)).version;
    const ids = this.db.prepare(`
      SELECT DISTINCT v.dependency_id AS id
      FROM claim_dependency_versions v
      JOIN claim_dependencies d ON d.id = v.dependency_id
      WHERE d.project_id = ? AND v.source_object_id = ?
      ORDER BY v.dependency_id
    `).all(projectId, objectId);
    return ids
      .map(({ id }) => this.dependencies.mapDependency(this.dependencies.latestVersionRow(id, maximum)))
      .filter((dependency) => dependency && !dependency.removed && dependency.source.id === objectId);
  }

  referenceCount(projectId, objectId) {
    return this.dependenciesForObject(projectId, objectId).length;
  }

  /** One row per reference: where it is, what it says, and whether it still agrees. */
  referencesTo(projectId, objectId) {
    const object = this.objectById(projectId, objectId);
    const currentValue = object?.valueText ?? null;
    return this.dependenciesForObject(projectId, objectId).map((dependency) => ({
      dependencyId: dependency.id,
      documentPath: dependency.documentPath,
      documentName: sourceFileName(dependency.documentPath),
      blockIndex: dependency.anchor?.blockIndex ?? null,
      blockType: dependency.anchor?.blockType ?? null,
      spanText: dependency.spanText,
      linkedValue: dependency.source.valueText ?? null,
      sourceValue: dependency.statusDetails?.currentSourceValue ?? currentValue,
      status: dependency.status,
      statusDetails: dependency.statusDetails ?? {},
      linkedBy: dependency.linkedBy?.displayName ?? null,
      updatedAt: dependency.createdAt,
    }));
  }

  /** References grouped by the document that holds them. */
  referencesByDocument(projectId, objectId) {
    const grouped = new Map();
    for (const reference of this.referencesTo(projectId, objectId)) {
      const existing = grouped.get(reference.documentPath) ?? {
        documentPath: reference.documentPath,
        documentName: reference.documentName,
        references: [],
      };
      existing.references.push(reference);
      grouped.set(reference.documentPath, existing);
    }
    return [...grouped.values()].sort((a, b) => a.documentPath.localeCompare(b.documentPath));
  }

  // ── impact ───────────────────────────────────────────────────────────────

  /** Objects indexed from one source file, whichever way the user named it. */
  objectsFromSource(projectId, sourceQuery, snapshotId = null) {
    const query = String(sourceQuery ?? '').trim().toLowerCase();
    if (!query) return [];
    const objects = this.namedObjects(projectId, snapshotId);
    const exactPath = objects.filter((object) => object.path.toLowerCase() === query);
    if (exactPath.length) return exactPath;
    const byFileName = objects.filter((object) => object.fileName.toLowerCase() === query);
    if (byFileName.length) return byFileName;
    const byPrefix = objects.filter((object) => `${object.path.toLowerCase()}/`.startsWith(`${query.replace(/\/+$/, '')}/`));
    if (byPrefix.length) return byPrefix;
    return objects.filter((object) => object.path.toLowerCase().includes(query));
  }

  /** The full downstream picture for a set of objects. */
  impactOf(projectId, objects) {
    const affected = [];
    const documents = new Map();
    const shares = [];
    for (const object of objects) {
      const references = this.referencesTo(projectId, object.id);
      const objectShares = this.sharesForObject(projectId, object.id);
      shares.push(...objectShares);
      if (!references.length && !objectShares.length) continue;
      affected.push({
        ...describeObject(object),
        referenceCount: references.length,
        shareCount: objectShares.length,
        stale: references.filter((reference) => reference.status !== 'LINKED').length,
        references,
      });
      for (const reference of references) {
        const entry = documents.get(reference.documentPath) ?? {
          documentPath: reference.documentPath,
          documentName: reference.documentName,
          references: 0,
          stale: 0,
        };
        entry.references += 1;
        if (reference.status !== 'LINKED') entry.stale += 1;
        documents.set(reference.documentPath, entry);
      }
    }
    return {
      affected: affected.sort((a, b) => b.referenceCount - a.referenceCount || a.name.localeCompare(b.name)),
      documents: [...documents.values()].sort((a, b) => b.references - a.references || a.documentPath.localeCompare(b.documentPath)),
      shares,
      sources: [...new Set(objects.map((object) => object.path))].sort(),
    };
  }

  // ── change detection ─────────────────────────────────────────────────────

  /**
   * Value changes recorded between consecutive indexed snapshots. This reads
   * the immutable object-version history rather than re-reading files, so a
   * change is always attributable to a snapshot the timeline recorded.
   */
  valueChanges(projectId, options = {}) {
    this.dependencies.ensureIndex(projectId);
    const rows = this.db.prepare(`
      WITH ordered AS (
        SELECT
          v.object_id, v.snapshot_id, v.value_text, v.content_hash, v.path, v.anchor_json,
          v.metadata_json, v.label, s.version, s.created_at,
          LAG(v.value_text) OVER window_by_object AS previous_value,
          LAG(v.path) OVER window_by_object AS previous_path,
          LAG(s.version) OVER window_by_object AS previous_version,
          LAG(s.created_at) OVER window_by_object AS previous_at
        FROM scientific_object_versions v
        JOIN scientific_objects o ON o.id = v.object_id
        JOIN snapshots s ON s.id = v.snapshot_id
        WHERE o.project_id = ?
        WINDOW window_by_object AS (PARTITION BY v.object_id ORDER BY s.version)
      )
      SELECT * FROM ordered
      WHERE previous_version IS NOT NULL
        AND (value_text IS NOT previous_value OR path IS NOT previous_path)
      ORDER BY version DESC, object_id
    `).all(projectId);

    const seen = new Set();
    const changes = [];
    for (const row of rows) {
      const rowAnchor = json(row.anchor_json, null);
      const rowMetadata = json(row.metadata_json, {});
      // A column profile's "value" is the indexer's own description of the
      // column, not a value from the source. Reporting it as a change would
      // announce that a range widened, which is not what the user recorded.
      if (rowAnchor?.kind === 'table-column' && !rowMetadata.dictionary) continue;
      if (rowAnchor?.kind === 'table-row' || rowAnchor?.kind === 'table-summary') continue;
      if (row.value_text == null && row.previous_value == null) continue;
      if (options.latestPerObject !== false) {
        if (seen.has(row.object_id)) continue;
        seen.add(row.object_id);
      }
      if (options.since && Date.parse(row.created_at) < options.since) continue;
      const object = this.objectById(projectId, row.object_id);
      const anchor = json(row.anchor_json, null);
      const metadata = json(row.metadata_json, {});
      const shape = object ?? {
        id: row.object_id, objectKey: null, objectType: null, label: row.label,
        path: row.path, anchor, metadata, valueText: row.value_text,
      };
      const name = object?.name ?? dependencyName(shape);
      if (options.sourcePrefix) {
        const prefix = String(options.sourcePrefix).replace(/\/+$/, '').toLowerCase();
        if (!row.path.toLowerCase().startsWith(prefix) && !sourceFileName(row.path).toLowerCase().includes(prefix)) continue;
      }
      const references = object ? this.referencesTo(projectId, object.id) : [];
      const unresolved = references.filter((reference) => reference.status !== 'LINKED').length;
      if (options.unresolvedOnly && !unresolved) continue;
      changes.push({
        name,
        objectId: row.object_id,
        objectKey: object?.objectKey ?? null,
        previousValue: row.previous_value,
        currentValue: row.value_text,
        previousPath: row.previous_path,
        path: row.path,
        moved: row.previous_path !== row.path,
        fileName: sourceFileName(row.path),
        locator: object?.locator ?? sourceLocator(shape),
        fromVersion: row.previous_version,
        toVersion: row.version,
        changedAt: row.created_at,
        previousAt: row.previous_at,
        referenceCount: references.length,
        unresolvedReferences: unresolved,
      });
      if (changes.length >= (options.limit ?? 200)) break;
    }
    return changes;
  }

  // ── staleness ────────────────────────────────────────────────────────────

  /**
   * Dependencies whose document no longer agrees with the source, plus sources
   * that moved or disappeared. Reconciliation runs first so the answer reflects
   * the current snapshot rather than the last time someone looked.
   */
  staleDependencies(projectId, options = {}) {
    if (options.reconcile !== false) this.dependencies.reconcileProject(projectId);
    const dependencies = this.dependencies.currentDependencies(projectId);
    const grouped = new Map();
    for (const dependency of dependencies) {
      if (dependency.status === 'LINKED' || dependency.status === 'PREDICTED') continue;
      const object = this.objectById(projectId, dependency.source.id);
      const name = object?.name ?? dependencyName(dependency.source);
      const entry = grouped.get(name) ?? {
        name,
        objectId: dependency.source.id,
        objectKey: dependency.source.objectKey,
        path: object?.path ?? dependency.source.path,
        previousPath: dependency.source.path,
        locator: object?.locator ?? sourceLocator(dependency.source),
        documentValue: dependency.source.valueText ?? null,
        sourceValue: null,
        reason: null,
        references: [],
      };
      const details = dependency.statusDetails ?? {};
      entry.documentValue = details.linkedSourceValue ?? entry.documentValue;
      entry.sourceValue = details.currentSourceValue ?? object?.valueText ?? null;
      if (dependency.status === 'BROKEN') {
        entry.reason = object ? 'source file moved' : 'source no longer resolves';
        if (object && object.path !== dependency.source.path) entry.previousPath = dependency.source.path;
      } else if (dependency.status === 'STALE') {
        entry.reason = entry.reason ?? 'referenced value changed';
      } else if (dependency.status === 'NEEDS_REVIEW') {
        entry.reason = entry.reason ?? (details.anchorIssue ?? 'source cannot be verified');
      }
      if (object && object.path !== dependency.source.path) {
        entry.reason = 'source file moved';
        entry.previousPath = dependency.source.path;
      }
      entry.references.push({
        dependencyId: dependency.id,
        documentPath: dependency.documentPath,
        documentName: sourceFileName(dependency.documentPath),
        spanText: dependency.spanText,
        status: dependency.status,
        blockIndex: dependency.anchor?.blockIndex ?? null,
      });
      grouped.set(name, entry);
    }
    return [...grouped.values()]
      .map((entry) => ({ ...entry, referenceCount: entry.references.length }))
      .sort((a, b) => b.referenceCount - a.referenceCount || a.name.localeCompare(b.name));
  }

  // ── history ──────────────────────────────────────────────────────────────

  /** Every recorded value of one object, newest first. */
  history(projectId, objectId, options = {}) {
    const rows = this.db.prepare(`
      SELECT v.id AS version_id, v.snapshot_id, v.path, v.anchor_json, v.metadata_json, v.label,
        v.value_text, v.content_hash, s.version, s.created_at,
        (SELECT mtime_ms FROM snapshot_files f WHERE f.snapshot_id = v.snapshot_id AND f.path = v.path) AS mtime_ms
      FROM scientific_object_versions v
      JOIN snapshots s ON s.id = v.snapshot_id
      WHERE v.object_id = ?
      ORDER BY s.version DESC
    `).all(objectId);

    const shareVersions = new Set(
      this.db.prepare('SELECT object_version_id FROM object_share_grants WHERE object_id = ?')
        .all(objectId).map((row) => row.object_version_id),
    );

    const distinct = options.allVersions ? rows : rows.filter((row, position) => {
      const next = rows[position + 1];
      return !next || next.value_text !== row.value_text || next.path !== row.path;
    });

    return distinct.map((row) => {
      const shape = {
        path: row.path, anchor: json(row.anchor_json, null), metadata: json(row.metadata_json, {}), label: row.label,
      };
      return {
        versionId: row.version_id,
        snapshotId: row.snapshot_id,
        projectVersion: row.version,
        value: row.value_text,
        path: row.path,
        fileName: sourceFileName(row.path),
        locator: sourceLocator(shape),
        recordedAt: row.created_at,
        sourceUpdatedAt: row.mtime_ms == null ? null : new Date(row.mtime_ms).toISOString(),
        referenceCount: this.referencesAtVersion(projectId, objectId, row.version),
        shared: shareVersions.has(row.version_id),
      };
    });
  }

  /** How many documents referenced an object as of a given project version. */
  referencesAtVersion(projectId, objectId, projectVersion) {
    return this.db.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT v.dependency_id, v.source_object_id, v.is_removed,
          ROW_NUMBER() OVER (PARTITION BY v.dependency_id ORDER BY s.version DESC) AS rank
        FROM claim_dependency_versions v
        JOIN claim_dependencies d ON d.id = v.dependency_id
        JOIN snapshots s ON s.id = v.snapshot_id
        WHERE d.project_id = ? AND s.version <= ?
      ) WHERE rank = 1 AND is_removed = 0 AND source_object_id = ?
    `).get(projectId, projectVersion, objectId).count;
  }

  /** The recorded state closest to, but not after, a point in time. */
  historyAt(projectId, objectId, instant) {
    const versions = this.history(projectId, objectId);
    return versions.find((version) => Date.parse(version.recordedAt) <= instant) ?? null;
  }

  // ── conflicts ────────────────────────────────────────────────────────────

  /** Names carried by more than one indexed source. */
  conflicts(projectId, options = {}) {
    const byName = new Map();
    for (const object of this.addressableObjects(projectId)) {
      const list = byName.get(object.name) ?? [];
      list.push(object);
      byName.set(object.name, list);
    }
    const aliasedKeys = new Set((this.aliases?.list(projectId) ?? []).map((alias) => alias.objectKey));
    return [...byName.entries()]
      .filter(([, candidates]) => candidates.length > 1)
      .filter(([name]) => !options.name || name === normalizeQueryName(options.name))
      .map(([name, candidates]) => ({
        name,
        candidates: candidates.map((object) => ({
          ...describeObject(object),
          address: canonicalAddress(object),
          references: this.referenceCount(projectId, object.id),
          aliased: aliasedKeys.has(object.objectKey),
        })),
        resolved: candidates.some((object) => aliasedKeys.has(object.objectKey)),
      }))
      .sort((a, b) => b.candidates.length - a.candidates.length || a.name.localeCompare(b.name));
  }

  // ── sharing ──────────────────────────────────────────────────────────────

  /**
   * Shares of one object, from both share paths: an object shared directly by
   * the typing overlay, and a manuscript claim shared with its source.
   */
  sharesForObject(projectId, objectId) {
    return this.shares(projectId, { includeRevoked: true, includeExpired: true })
      .filter((share) => share.objectId === objectId);
  }

  shares(projectId, options = {}) {
    const timestamp = new Date().toISOString();
    const objectRows = this.db.prepare(`
      SELECT g.*, a.display_name AS created_by_name, v.object_id AS resolved_object_id,
        v.path AS source_path, v.label AS source_label, v.value_text AS source_value,
        v.anchor_json, v.metadata_json, s.version AS shared_version
      FROM object_share_grants g
      JOIN actors a ON a.id = g.created_by_actor_id
      JOIN scientific_object_versions v ON v.id = g.object_version_id
      JOIN snapshots s ON s.id = v.snapshot_id
      WHERE g.project_id = ?
      ORDER BY g.created_at DESC
    `).all(projectId);

    const dependencyRows = this.db.prepare(`
      SELECT g.*, a.display_name AS created_by_name, d.id AS dependency_id
      FROM dependency_share_grants g
      JOIN actors a ON a.id = g.created_by_actor_id
      JOIN claim_dependencies d ON d.id = g.dependency_id
      WHERE d.project_id = ?
      ORDER BY g.created_at DESC
    `).all(projectId);

    const statusOf = (row) => {
      if (row.revoked_at) return 'revoked';
      if (row.expires_at && row.expires_at <= timestamp) return 'expired';
      return 'active';
    };

    const shares = [];
    for (const row of objectRows) {
      const shape = { path: row.source_path, anchor: json(row.anchor_json, null), metadata: json(row.metadata_json, {}), label: row.source_label };
      const object = this.objectById(projectId, row.resolved_object_id);
      shares.push({
        kind: 'OBJECT',
        id: row.id,
        token: row.token,
        url: this.objectShares?.shareUrl(row.token) ?? `/d/${row.token}`,
        objectId: row.resolved_object_id,
        name: object?.name ?? dependencyName(shape),
        path: row.source_path,
        fileName: sourceFileName(row.source_path),
        locator: sourceLocator(shape),
        sharedValue: row.source_value,
        currentValue: object?.valueText ?? null,
        sharedVersion: row.shared_version,
        target: sourceFileName(row.source_path),
        createdAt: row.created_at,
        createdBy: row.created_by_name,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        status: statusOf(row),
      });
    }
    for (const row of dependencyRows) {
      let dependency = null;
      try { dependency = this.dependencies.getDependency(row.dependency_id); } catch { dependency = null; }
      if (!dependency) continue;
      const object = this.objectById(projectId, dependency.source.id);
      shares.push({
        kind: 'DEPENDENCY',
        id: row.id,
        token: row.token,
        url: `/?share=${encodeURIComponent(row.token)}`,
        objectId: dependency.source.id,
        dependencyId: row.dependency_id,
        name: object?.name ?? dependencyName(dependency.source),
        path: dependency.source.path,
        fileName: sourceFileName(dependency.source.path),
        locator: object?.locator ?? sourceLocator(dependency.source),
        sharedValue: dependency.source.valueText ?? null,
        currentValue: object?.valueText ?? null,
        target: sourceFileName(dependency.documentPath),
        documentPath: dependency.documentPath,
        createdAt: row.created_at,
        createdBy: row.created_by_name,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        scope: row.access_scope,
        recipientLabel: row.recipient_label,
        status: statusOf(row),
      });
    }

    return shares
      .filter((share) => (share.status !== 'revoked' || options.includeRevoked)
        && (share.status !== 'expired' || options.includeExpired))
      .filter((share) => !options.status || share.status === options.status)
      .filter((share) => !options.name || share.name === normalizeQueryName(options.name))
      .map((share) => ({
        ...share,
        // A share pins the version it was created from; the source may since
        // have moved on. That is reported, never silently corrected.
        drifted: share.status === 'active' && share.currentValue != null
          && share.sharedValue != null && share.currentValue !== share.sharedValue,
      }))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  // ── previews ─────────────────────────────────────────────────────────────

  /**
   * A few rows of the source around an object, so a result can be judged
   * without opening the original application.
   */
  preview(projectId, object, options = {}) {
    const radius = Number.isFinite(options.radius) ? options.radius : 3;
    const file = this.timeline.snapshotFile(object.snapshotId, object.path);
    if (!file) return { kind: 'unavailable', reason: 'The source file is not in this snapshot.' };
    const header = {
      fileName: object.fileName ?? sourceFileName(object.path),
      path: object.path,
      locator: object.locator ?? sourceLocator(object),
    };
    const anchor = object.anchor ?? {};

    if (['table', 'spreadsheet'].includes(file.fileType) && ['table-cell', 'table-row', 'table-column', 'table-summary'].includes(anchor.kind)) {
      const table = this.tablePreview(file, object, radius);
      if (table) return { kind: 'table', ...header, ...table };
    }
    const text = this.textPreview(file, object, radius);
    if (text) return { kind: 'text', ...header, ...text };
    return { kind: 'meta', ...header, value: object.valueText ?? null, objectType: object.objectType };
  }

  tablePreview(file, object, radius) {
    const buffer = this.timeline.blobs.get(file.contentHash);
    if (!buffer) return null;
    let rows = null;
    const anchor = object.anchor ?? {};
    try {
      if (file.fileType === 'spreadsheet') {
        const sheetName = object.metadata?.sheet ?? anchor.sheet ?? null;
        const sheets = extractSpreadsheetTables(buffer);
        const sheet = sheets.find((candidate) => candidate.name === sheetName) ?? sheets[0];
        rows = sheet?.rows ?? null;
      } else {
        const delimiter = path.posix.extname(file.path).toLowerCase() === '.tsv' ? '\t' : ',';
        rows = parseDelimited(buffer.subarray(0, 2_000_000).toString('utf8'), delimiter);
      }
    } catch { return null; }
    if (!rows?.length) return null;
    const target = Number.isInteger(anchor.rowIndex) ? anchor.rowIndex : 0;
    const start = Math.max(0, target - radius);
    const end = Math.min(rows.length, target + radius + 1);
    return {
      headerRow: rows[0]?.map((cell) => String(cell ?? '')) ?? [],
      rows: rows.slice(start, end).map((row, offset) => ({
        rowNumber: start + offset + 1,
        highlighted: start + offset === target,
        cells: row.map((cell) => String(cell ?? '')),
      })),
      highlightColumn: Number.isInteger(anchor.columnIndex) ? anchor.columnIndex : null,
    };
  }

  textPreview(file, object, radius) {
    const buffer = this.timeline.blobs.get(file.contentHash);
    if (!buffer || !['markdown', 'text', 'code', 'json', 'notebook', 'yaml'].includes(file.fileType)) return null;
    const lines = buffer.subarray(0, 2_000_000).toString('utf8').replace(/\r\n/g, '\n').split('\n');
    const anchor = object.anchor ?? {};
    const target = Number.isInteger(anchor.line) ? anchor.line - 1
      : lines.findIndex((line) => object.valueText && line.includes(object.valueText));
    const centre = target >= 0 ? target : 0;
    const start = Math.max(0, centre - radius);
    const end = Math.min(lines.length, centre + radius + 1);
    return {
      lines: lines.slice(start, end).map((text, offset) => ({
        lineNumber: start + offset + 1,
        highlighted: start + offset === centre,
        text,
      })),
    };
  }
}

