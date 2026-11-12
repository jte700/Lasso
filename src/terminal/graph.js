import { buildSharePreview } from '../sharing/share-preview.js';
// The read layer every terminal command shares.
//
// It owns no data. Every answer here is assembled from the same tables the
// editor, the source inspector and the share service read: scientific objects
// and their versions, claim dependencies and their versions, snapshots, and
// share grants. Nothing is recomputed and nothing is cached beyond the
// per-snapshot object list, which the indexer already treats as immutable,
// and which objects' values have changed, which only grows.

import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { json } from '../db.js';
import { BoundedCache } from '../cache.js';
import { parseDelimited } from '../history/diff.js';
import { BlobReleasedError } from '../history/errors.js';
import { runSliced, runSync } from '../history/work.js';
import { NEWEST_VERSION, readChangedObjects } from './changed-objects.js';
import { extractSpreadsheetTables } from '../dependencies/document-extraction.js';
import { directRecommendationMatch } from '../dependencies/ranking.js';
import { drawingContext } from '../dependencies/drawing-objects.js';
import {
  canonicalAddress, dependencyName, describeObject, slug, sourceDirectory, sourceFileName, sourceLocator,
} from './names.js';

/** Objects that are containers rather than addressable values. */
const CONTAINER_TYPES = new Set(['DATASET', 'DOCUMENT', 'TABLE', 'CODE_BLOCK', 'DRAWING']);

/** Every version one folder recorded, as value history reads it. */
const FOLDER_HISTORY = 'o.project_id = ?';

/**
 * Two readings of changed objects as one, when together they cover every
 * version up to the later of them; otherwise the first alone.
 */
function combinedReading(known, read) {
  if (!read || (read.since ?? 0) > (known?.newest ?? 0)) return known;
  if (!known) return read;
  return { newest: Math.max(known.newest, read.newest), ids: new Set([...known.ids, ...read.ids]) };
}

function tokens(value) {
  return String(value ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

// Sentence and paragraph passages are stored as DOCUMENT objects, but they
// are the text a person searches for, unlike whole-document containers.
export function isPassage(object) {
  return ['PDF_EXCERPT', 'TEXT_EXCERPT'].includes(object?.metadata?.componentType);
}

// A query term counts when it is a whole word (or its plural) in the source.
// A longer term may also start a word; a fragment inside a word never counts,
// so "cap" does not match "capital".
function termMatcher(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const whole = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:s|es)?(?![a-z0-9])`);
  const prefix = term.length >= 4 ? new RegExp(`(?:^|[^a-z0-9])${escaped}`) : null;
  return (haystack) => whole.test(haystack) ? 1 : prefix?.test(haystack) ? 0.5 : 0;
}

function normalizeQueryName(value) {
  return slug(value);
}

function namedObject(object) {
  return { ...object, name: dependencyName(object), locator: sourceLocator(object),
    directory: sourceDirectory(object.path), fileName: sourceFileName(object.path) };
}

function compareIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The later of two snapshots, each { version, at }; either may be missing. */
function laterSnapshot(first, second) {
  if (first?.version == null) return second;
  if (second?.version == null) return first;
  return second.version > first.version ? second : first;
}

function changeRow(row, at, previous, previousAt) {
  return {
    object_id: row.object_id, source_project_id: row.source_project_id ?? row.project_id,
    snapshot_id: row.snapshot_id, value_text: row.value_text, content_hash: row.content_hash, path: row.path,
    anchor_json: row.anchor_json, metadata_json: row.metadata_json, label: row.label,
    version: at.version, created_at: at.at,
    previous_value: previous.value_text, previous_path: previous.path,
    removed: Boolean(row.removed), restored: Boolean(row.restored),
    content_changed: row.content_hash !== previous.content_hash,
    previous_version: previousAt?.version ?? null, previous_at: previousAt?.at ?? null,
  };
}

export class DependencyGraph {
  constructor({ timeline, dependencies, objectShares = null, aliases = null }) {
    this.timeline = timeline;
    this.dependencies = dependencies;
    this.objectShares = objectShares;
    this.aliases = aliases;
    this.db = timeline.db;
    this.namedObjectCache = new BoundedCache({ maxEntries: 16, maxWeight: 100_000, weight: (objects) => objects.length });
    this.foreignDependencyCache = new BoundedCache({ maxEntries: 16, maxWeight: 10_000,
      weight: (dependencies) => dependencies.length });
    // Objects whose value or location has changed, by query, as of the newest
    // version recorded when they were found, and the readings under way
    // (see changedObjectSteps).
    this.changedObjectSets = new BoundedCache({ maxEntries: 16 });
    this.changedObjectReads = new Map();
    this.unsubscribe = timeline.onCapture((capture) => {
      // Removing directories (a drive's saved data) drops their snapshots.
      if (capture?.removedProjectIds?.length) {
        this.namedObjectCache.clear();
        this.foreignDependencyCache.clear();
        this.changedObjectSets.clear();
        return;
      }
      const previous = capture?.event?.previousSnapshotId;
      if (previous) {
        this.namedObjectCache.delete(previous);
        this.foreignDependencyCache.delete(previous);
      }
    });
  }

  close() {
    this.unsubscribe?.();
    this.namedObjectCache.clear();
    this.foreignDependencyCache.clear();
    this.changedObjectSets.clear();
  }

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
    let ownObjects = this.namedObjectCache.get(target);
    if (!ownObjects) {
      ownObjects = this.dependencies.objectsAt(projectId, target).map(namedObject);
      this.namedObjectCache.set(target, ownObjects);
    }
    // Sources remain in their owning version chain. A destination needs the
    // sources it references for trace/update/unlink without importing their
    // complete corpus or confusing equal paths from different roots.
    const foreign = new Map();
    let foreignDependencies = this.foreignDependencyCache.get(target);
    if (!foreignDependencies) {
      foreignDependencies = this.dependencies.currentDependencies(projectId, { snapshotId: target })
        .filter((dependency) => dependency.source.projectId !== projectId);
      this.foreignDependencyCache.set(target, foreignDependencies);
    }
    if (!foreignDependencies.length) return ownObjects;
    const sourceHeads = new Map();
    for (const dependency of foreignDependencies) {
      const ownerId = this.dependencies.sourceProjectId(dependency.source);
      if (!sourceHeads.has(ownerId)) sourceHeads.set(ownerId, this.currentSnapshotId(ownerId));
    }
    const foreignKey = `${target}|${snapshotId ? 'historical' : [...sourceHeads.values()].join('|')}`;
    const combined = this.namedObjectCache.get(foreignKey);
    if (combined) return combined;
    for (const dependency of foreignDependencies) {
      const ownerId = this.dependencies.sourceProjectId(dependency.source);
      if (!ownerId || ownerId === projectId || foreign.has(dependency.source.id)) continue;
      const sourceSnapshotId = snapshotId ? dependency.source.snapshotId : sourceHeads.get(ownerId);
      const current = this.dependencies.objectAt(ownerId, sourceSnapshotId, dependency.source.id);
      foreign.set(dependency.source.id, current ?? { ...dependency.source, currentSourceAvailable: false });
    }
    const objects = foreign.size ? [...ownObjects, ...[...foreign.values()].map(namedObject)] : ownObjects;
    this.namedObjectCache.set(foreignKey, objects);
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

  suggestionFilter(projectId, options = {}) {
    const filters = new Map();
    return (object) => {
      const ownerId = object.projectId ?? projectId;
      if (ownerId !== projectId && this.dependencies.workspace && !this.dependencies.workspace.isActive(ownerId)) return false;
      if (options.surface === 'search' || options.sourcePath) return true;
      if (!filters.has(ownerId)) filters.set(ownerId, this.dependencies.autocompleteFilter(ownerId));
      return filters.get(ownerId)(object);
    };
  }

  // ── search ───────────────────────────────────────────────────────────────

  /** Use the same relevance, relationship and usage priorities as the editor. */
  rankRecommendations(projectId, candidates, options = {}) {
    const ordered = [...candidates].sort((left, right) => String(left.name ?? left.label ?? '').localeCompare(String(right.name ?? right.label ?? ''))
      || String(left.path ?? '').localeCompare(String(right.path ?? '')));
    const owners = new Map();
    for (const candidate of ordered) {
      const source = candidate.object ?? candidate;
      const ownerId = source.projectId ?? projectId;
      const group = owners.get(ownerId) ?? [];
      group.push(candidate);
      owners.set(ownerId, group);
    }
    if (!owners.size || (owners.size === 1 && owners.has(projectId))) {
      return this.dependencies.ranking.rank(projectId, ordered, options);
    }
    const ranked = [];
    for (const [ownerId, group] of owners) {
      ranked.push(...this.dependencies.ranking.rank(ownerId, group, { ...options,
        documentPath: ownerId === projectId ? options.documentPath : null,
        relatedPaths: ownerId === projectId ? options.relatedPaths : group.map((candidate) => candidate.path),
        limit: group.length, diversify: false,
      }));
    }
    const hasQuery = Boolean(options.query);
    ranked.sort((a, b) => a.ranking.tier - b.ranking.tier
      || b.ranking.directSpecificity - a.ranking.directSpecificity
      || (hasQuery ? b.ranking.relevanceBand - a.ranking.relevanceBand : 0)
      || (hasQuery ? Number(b.ranking.relationship) - Number(a.ranking.relationship)
        : b.ranking.recentScore - a.ranking.recentScore || b.ranking.frequencyScore - a.ranking.frequencyScore)
      || (hasQuery ? (b.ranking.relevanceScore + b.ranking.usageBoost) - (a.ranking.relevanceScore + a.ranking.usageBoost)
        : Number(b.ranking.relationship) - Number(a.ranking.relationship))
      || b.ranking.relevanceScore - a.ranking.relevanceScore
      || String(a.id ?? a.objectId ?? '').localeCompare(String(b.id ?? b.objectId ?? '')));
    const limit = options.limit ?? 8;
    if (options.diversify === false) return ranked.slice(0, limit);
    const counts = new Map();
    return ranked.filter((candidate) => {
      const source = candidate.object ?? candidate;
      const key = `${source.projectId ?? projectId}|${candidate.diversityKey ?? candidate.path ?? source.path}`;
      const count = counts.get(key) ?? 0;
      if (count >= (options.maxPerFile ?? 2)) return false;
      counts.set(key, count + 1);
      return true;
    }).slice(0, limit);
  }

  /**
   * Exact-name matching first, then relevance over the indexed search text.
   * Exact matches always outrank fuzzy ones, so a name that exists is never
   * buried under something merely similar.
   */
  search(projectId, query, options = {}) {
    const raw = String(query ?? '').trim();
    const wanted = normalizeQueryName(raw);
    const terms = tokens(raw);
    const matchers = terms.map(termMatcher);
    const contextTerms = tokens(options.context);
    const alias = raw ? this.aliases?.find(projectId, raw) : null;
    const aliasObject = alias ? this.objectByKey(projectId, alias.objectKey, options.snapshotId) : null;
    const pool = options.includeContainers
      ? this.namedObjects(projectId, options.snapshotId)
      : this.namedObjects(projectId, options.snapshotId)
        .filter((object) => object.name && (!CONTAINER_TYPES.has(object.objectType) || isPassage(object)));
    if (aliasObject && !pool.some((object) => object.id === aliasObject.id)) pool.push(aliasObject);

    // Naming an indexed file means that file. Scoring its path word by word
    // would drag in every sibling that shares a directory.
    const named = raw.toLowerCase();
    const permitted = (object) => {
      if (object.projectId !== projectId && this.dependencies.workspace
        && !this.dependencies.workspace.isActive(object.projectId)) return false;
      if (options.sourcePath && object.path !== options.sourcePath) return false;
      if (options.directory && !`${object.path}/`.toLowerCase().startsWith(`${String(options.directory).replace(/\/+$/, '').toLowerCase()}/`)) return false;
      if (options.sourceType && path.posix.extname(object.path).slice(1).toLowerCase() !== String(options.sourceType).toLowerCase().replace(/^\./, '')) return false;
      if (options.pathFragment && !object.path.toLowerCase().includes(String(options.pathFragment).toLowerCase())) return false;
      if (options.updatedWithinMs) {
        const updated = this.sourceUpdatedAt(projectId, object);
        if (updated == null || Date.parse(updated) < Date.now() - options.updatedWithinMs) return false;
      }
      return true;
    };
    const inFile = (object) => (object.path.toLowerCase() === named || object.fileName.toLowerCase() === named);
    const exactSource = named && (pool.filter(inFile).length
      ? pool.filter(inFile)
      : this.namedObjects(projectId, options.snapshotId).filter(inFile));
    if (exactSource && exactSource.length) {
      return this.rankRecommendations(projectId, exactSource.filter(permitted).map((object) => ({
        object, path: object.path, id: object.id, label: object.name,
        diversityKey: object.objectType === 'REFERENCE' ? object.id : object.path,
        score: 1, matchTier: 0, matchKind: 'source', reasons: ['Exact file match'],
      })), { ...options, query: raw, diversify: false, limit: options.limit ?? 25 });
    }

    const scored = [];
    for (const object of pool) {
      if (!permitted(object)) continue;

      let score = 0;
      let matchKind = null;
      // File completion has its own surface. A directory/filename prefix must
      // not turn every cell in that file into a strong dependency-name match.
      const direct = directRecommendationMatch({ ...object, path: '' }, raw);
      const aliasMatch = aliasObject && object.id === aliasObject.id;
      if (aliasMatch) { score = 1; matchKind = 'identifier'; }
      else if (direct.direct && direct.exact) {
        score = 1;
        matchKind = direct.reason === 'Exact value match' ? 'value'
          : direct.reason === 'Exact identifier match' ? 'identifier'
            : object.name === wanted ? 'exact' : 'sourceName';
      }
      else if (wanted && object.name === wanted) { score = 1; matchKind = 'exact'; }
      else if (direct.direct) { score = direct.score; matchKind = 'prefix'; }
      else if (wanted && object.name.startsWith(wanted)) { score = 0.82; matchKind = 'prefix'; }
      else if (wanted && object.name.includes(wanted)) { score = 0.66; matchKind = 'contains'; }
      if (terms.length) {
        const haystack = String(object.searchText ?? '').toLowerCase();
        const hits = matchers.reduce((sum, matches) => sum + matches(haystack), 0);
        const semantic = (hits / terms.length) * 0.6;
        if (semantic > score) { score = semantic; matchKind = matchKind ?? 'relevance'; }
        else if (hits === terms.length && matchKind === null) { score = semantic; matchKind = 'relevance'; }
      }
      if (!raw) { score = 0.2; matchKind = 'all'; }
      if (contextTerms.length && (!raw || score > 0)) {
        const haystack = String(object.searchText ?? '').toLowerCase();
        const hits = contextTerms.filter((term) => haystack.includes(term)).length;
        if (!raw && hits) { score = 0.25 + (hits / contextTerms.length) * 0.35; matchKind = 'context'; }
        else if (score < 1) score = Math.min(0.95, score + (hits / contextTerms.length) * 0.03);
      }
      if (score <= 0) continue;
      const matchTier = ['exact', 'prefix', 'value', 'identifier', 'sourceName'].includes(matchKind) ? 0 : matchKind === 'all' ? 3 : 1;
      const reason = aliasMatch ? 'Exact alias match' : direct.direct && direct.exact ? direct.reason
        : { exact: 'Exact name match', prefix: 'Name starts with your query', contains: 'Name matches your query', context: 'Matches current context', relevance: 'Relevant content', all: 'Indexed source' }[matchKind];
      scored.push({ object, path: object.path, id: object.id, label: object.name,
        diversityKey: object.objectType === 'REFERENCE' ? object.id : object.path,
        score, matchTier, matchKind, reasons: [reason] });
    }

    // A one-sentence paragraph is indexed as both a sentence and a paragraph.
    // Offer that passage once, at its better score.
    const passages = new Map();
    const unique = scored.filter((entry) => {
      if (!isPassage(entry.object)) return true;
      const key = `${entry.path}|${String(entry.object.valueText ?? '').replace(/\s+/g, ' ').trim().toLowerCase()}`;
      const kept = passages.get(key);
      if (kept && kept.score >= entry.score) return false;
      if (kept) kept.duplicate = true;
      passages.set(key, entry);
      return true;
    }).filter((entry) => !entry.duplicate);
    return this.rankRecommendations(projectId, unique, {
      ...options, query: raw || options.context, limit: options.limit ?? 25,
      diversify: options.diversify !== false, maxPerFile: options.maxPerFile ?? 2,
    });
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
  nameSuggestions(projectId, fragment, limit = 12, options = {}) {
    const wanted = normalizeQueryName(fragment);
    const candidates = [];
    const permitted = this.suggestionFilter(projectId, options);
    const describe = (object) => ({
      name: object.name,
      label: object.name,
      kind: 'dependency',
      value: object.valueText ?? null,
      detail: [object.fileName, object.locator].filter(Boolean).join(' · '),
      path: object.path,
      projectId: object.projectId,
      id: object.id,
      objectId: object.id,
      objectKey: object.objectKey,
      diversityKey: object.objectType === 'REFERENCE' ? object.id : object.path,
    });

    for (const alias of this.aliases?.list(projectId) ?? []) {
      if (!wanted || alias.name.startsWith(wanted)) {
        const object = this.objectByKey(projectId, alias.objectKey);
        if (!object || !permitted(object) || (options.sourcePath && object.path !== options.sourcePath)) continue;
        const source = describe(object);
        candidates.push({ ...source, name: alias.name, label: alias.name, kind: 'alias', detail: alias.address,
          score: !wanted ? 0.2 : alias.name === wanted ? 1 : 0.82, matchTier: wanted ? 0 : 3,
          reasons: [wanted ? alias.name === wanted ? 'Exact name match' : 'Name starts with your query' : 'Indexed source'],
        });
      }
    }
    const matches = this.search(projectId, fragment, {
      ...options, limit: this.namedObjects(projectId).length, diversify: false,
    });
    for (const match of matches) {
      if (!permitted(match.object)) continue;
      if (wanted && !match.object.name.startsWith(wanted)) continue;
      candidates.push({ ...describe(match.object), score: match.score, matchTier: match.matchTier, reasons: match.reasons });
    }

    // Keep the established prefix-only completion behavior. A broad search is
    // still useful when the fragment does not begin an indexed name.
    if (!candidates.length && wanted) {
      for (const match of matches) {
        if (!permitted(match.object)) continue;
        candidates.push({ ...describe(match.object), kind: 'related', score: match.score, matchTier: match.matchTier, reasons: match.reasons });
      }
    }
    // Rank before collapsing duplicate names so the provenance shown for an
    // ambiguous name comes from the best matching source, not index order.
    const ordered = this.rankRecommendations(projectId, candidates, {
      ...options, query: fragment || options.context, diversify: false, limit: candidates.length,
    });
    const seen = new Map();
    for (const entry of ordered) {
      const key = entry.diversityKey && entry.diversityKey !== entry.path
        ? `work:${entry.diversityKey}` : entry.name;
      if (!seen.has(key)) seen.set(key, entry);
    }
    return this.rankRecommendations(projectId, [...seen.values()], {
      ...options, query: fragment || options.context, limit, diversify: options.diversify !== false, maxPerFile: options.maxPerFile ?? 2,
    });
  }

  /**
   * Indexed source files matching a fragment. A file is usually named after
   * what it is, so this is often the most direct thing to complete: the name
   * matches first, then the path, then anything containing the fragment.
   */
  sourceSuggestions(projectId, fragment, limit = 8, options = {}) {
    const wanted = String(fragment ?? '').trim().toLowerCase();
    const contextTerms = tokens(options.context);
    const files = new Map();
    const permitted = this.suggestionFilter(projectId, options);
    for (const object of this.namedObjects(projectId)) {
      if (!permitted(object) || (options.sourcePath && object.path !== options.sourcePath)) continue;
      const name = object.fileName.toLowerCase();
      const full = object.path.toLowerCase();
      const exact = wanted && (name === wanted || full === wanted);
      let score = !wanted ? 0.2 : exact ? 1 : name.startsWith(wanted) ? 0.94
        : full.startsWith(wanted) ? 0.9 : name.includes(wanted) || full.includes(wanted) ? 0.68 : 0;
      if (!score) continue;
      let matchTier = !wanted ? 3 : exact || name.startsWith(wanted) || full.startsWith(wanted) ? 0 : 1;
      let reason = !wanted ? 'Indexed source' : exact ? 'Exact file match' : matchTier === 0 ? 'File starts with your query' : 'File matches your query';
      if (!wanted && contextTerms.length) {
        const haystack = `${full} ${object.searchText ?? ''}`.toLowerCase();
        const hits = contextTerms.filter((term) => haystack.includes(term)).length;
        if (hits) { score = 0.25 + (hits / contextTerms.length) * 0.35; matchTier = 1; reason = 'Matches current context'; }
      }
      const fileKey = `${object.projectId ?? projectId}|${object.path}`;
      const existing = files.get(fileKey);
      if (existing && existing.score >= score) continue;
      files.set(fileKey, {
        name: object.path,
        label: object.fileName,
        path: object.path,
        projectId: object.projectId,
        kind: 'source',
        value: null,
        detail: `${this.objectsInFile(projectId, object.path, object.projectId)} indexed`,
        score, matchTier, reasons: [reason],
      });
    }
    return this.rankRecommendations(projectId, [...files.values()], {
      ...options, query: fragment || options.context, limit, diversify: false,
    });
  }

  /** How many indexed objects one file contributes. */
  objectsInFile(projectId, filePath, ownerId = null) {
    return this.namedObjects(projectId).filter((object) => object.path === filePath
      && (!ownerId || object.projectId === ownerId)).length;
  }

  /** Directories that hold indexed files, for `--directory` and `index remove`. */
  directorySuggestions(projectId, fragment, limit = 10) {
    const wanted = String(fragment ?? '').toLowerCase().replace(/\/+$/, '');
    const directories = new Map();
    for (const object of this.namedObjects(projectId).filter((object) => object.projectId === projectId)) {
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
  addressSuggestions(projectId, fragment, limit = 12, options = {}) {
    const wanted = String(fragment ?? '').toLowerCase();
    const permitted = this.suggestionFilter(projectId, options);
    const candidates = this.addressableObjects(projectId)
      .filter((object) => permitted(object) && (!options.sourcePath || object.path === options.sourcePath))
      .map((object) => ({
        name: canonicalAddress(object),
        label: canonicalAddress(object),
        id: object.id,
        objectId: object.id,
        objectKey: object.objectKey,
        diversityKey: object.objectType === 'REFERENCE' ? object.id : object.path,
        path: object.path,
        projectId: object.projectId,
        kind: 'address',
        value: object.valueText ?? null,
        detail: object.name,
      }))
      .filter((entry) => !wanted || entry.name.toLowerCase().includes(wanted)
        || entry.detail.toLowerCase().startsWith(wanted))
      .map((entry) => {
        const exact = wanted && entry.name.toLowerCase() === wanted;
        const prefix = wanted && (entry.name.toLowerCase().startsWith(wanted) || entry.detail.toLowerCase().startsWith(wanted));
        return { ...entry, score: !wanted ? 0.2 : exact ? 1 : prefix ? 0.82 : 0.66,
          matchTier: !wanted ? 3 : exact || prefix ? 0 : 1,
          reasons: [!wanted ? 'Indexed source' : exact ? 'Exact address match' : 'Address matches your query'],
        };
      });
    const scopedFile = wanted && candidates.some((entry) => entry.path.toLowerCase() === wanted
      || sourceFileName(entry.path).toLowerCase() === wanted);
    return this.rankRecommendations(projectId, candidates, {
      ...options, query: fragment, limit, diversify: !scopedFile && options.diversify !== false, maxPerFile: options.maxPerFile ?? 2,
    });
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
    const file = this.timeline.snapshotFile(object.snapshotId, object.path);
    return file ? new Date(file.mtimeMs).toISOString() : null;
  }

  indexedAt(snapshotId) {
    return this.db.prepare('SELECT indexed_at FROM snapshot_object_indexes WHERE snapshot_id = ?')
      .get(snapshotId)?.indexed_at ?? null;
  }

  /** Everything `trace` reports about one object. */
  trace(projectId, object) {
    const snapshot = this.timeline.snapshotRecord(object.snapshotId);
    const references = this.referencesTo(projectId, object.id);
    const shares = this.sharesForObject(projectId, object.id);
    const enriched = this.dependencies.enrichObject(projectId, object);
    return {
      ...describeObject(object),
      sourceProjectId: object.projectId ?? projectId,
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
    const maximum = this.timeline.snapshotRecord(this.currentSnapshotId(projectId)).version;
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
      projectId,
      sourceProjectId: dependency.source.projectId,
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
    this.dependencies.ensureIndex(projectId, options.snapshotId);
    if (options.previousSnapshotId) this.dependencies.ensureIndex(projectId, options.previousSnapshotId);
    // Automatic rules compare only the capture they are handling. Interactive
    // history queries retain their complete historical view below.
    const rows = options.snapshotId && options.previousSnapshotId
      ? this.changesBetween(projectId, options.previousSnapshotId, options.snapshotId)
      : this.recordedChanges(FOLDER_HISTORY, [projectId], options)
        .sort((left, right) => right.version - left.version || compareIds(left.object_id, right.object_id));

    if (!options.previousSnapshotId && !options.ownSourcesOnly) {
      const foreignIds = this.namedObjects(projectId)
        .filter((object) => object.projectId !== projectId).map((object) => object.id);
      if (foreignIds.length) rows.push(...this.recordedChanges(`o.id IN (${foreignIds.map(() => '?').join(',')})`, foreignIds));
      rows.sort((left, right) => String(right.created_at).localeCompare(String(left.created_at))
        || right.version - left.version || compareIds(left.object_id, right.object_id));
    }
    const seen = new Set();
    const changes = [];
    for (const row of rows) {
      if (options.objectIds && !options.objectIds.has(row.object_id)) continue;
      const rowAnchor = json(row.anchor_json, null);
      const rowMetadata = json(row.metadata_json, {});
      // A column profile's "value" is the indexer's own description of the
      // column, not a value from the source. Reporting it as a change would
      // announce that a range widened, which is not what the user recorded.
      if (!options.includeSourceChanges) {
        if (rowAnchor?.kind === 'table-column' && !rowMetadata.dictionary) continue;
        if (rowAnchor?.kind === 'table-row' || rowAnchor?.kind === 'table-summary') continue;
        if (row.value_text == null && row.previous_value == null) continue;
      }
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
        projectId: row.source_project_id,
        name,
        objectId: row.object_id,
        objectKey: object?.objectKey ?? null,
        previousValue: row.previous_value,
        currentValue: row.value_text,
        previousPath: row.previous_path,
        path: row.path,
        moved: row.previous_path !== row.path,
        ...(options.includeSourceChanges ? { removed: row.removed, restored: row.restored,
          contentChanged: row.content_changed && row.previous_value === row.value_text } : {}),
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

  /** Lightweight notch history. Never resolves the full object index or dependency graph. */
  activityChanges(projectId, { objectIds = null, limit = 8, includeSourceChanges = false } = {}) {
    let ids = objectIds ? [...objectIds] : [];
    if (!objectIds) {
      // Manual history is a recent sample. Visit indexed snapshots newest first
      // through the snapshot_id index, with a hard candidate budget; opening a
      // notch must not read years of unrelated object metadata into memory.
      const snapshots = this.db.prepare(`SELECT s.id FROM snapshots s
        JOIN snapshot_object_indexes i ON i.snapshot_id = s.id
        WHERE s.project_id = ? ORDER BY s.version DESC LIMIT 8`).all(projectId);
      const candidates = new Set();
      for (const snapshot of snapshots) {
        const remaining = 64 - candidates.size;
        if (remaining <= 0) break;
        for (const row of this.db.prepare(`SELECT object_id FROM scientific_object_versions
          WHERE snapshot_id = ? LIMIT ?`).all(snapshot.id, remaining)) candidates.add(row.object_id);
      }
      ids = [...candidates];
    }
    if (!ids.length) return [];
    const rows = [];
    // SQLite's object_id index restricts the read before metadata is loaded.
    // Keep parameter counts bounded even for a large set of browser links.
    for (let offset = 0; offset < ids.length; offset += 128) {
      const batch = ids.slice(offset, offset + 128);
      rows.push(...this.recordedChanges(`o.project_id = ? AND x.object_id IN (${batch.map(() => '?').join(',')})`,
        [projectId, ...batch], { includeSourceChanges, indexedObjectLookup: true }));
    }
    rows.sort((a, b) => b.version - a.version || compareIds(a.object_id, b.object_id));
    const seen = new Set(), changes = [];
    for (const row of rows) {
      const anchor = json(row.anchor_json, null), metadata = json(row.metadata_json, {});
      if (!includeSourceChanges && ((anchor?.kind === 'table-column' && !metadata.dictionary)
        || ['table-row', 'table-summary'].includes(anchor?.kind)
        || (row.value_text == null && row.previous_value == null))) continue;
      if (seen.has(row.object_id)) continue;
      seen.add(row.object_id);
      const shape = { id: row.object_id, objectKey: null, objectType: null, label: row.label,
        path: row.path, anchor, metadata, valueText: row.value_text };
      changes.push({ projectId, name: dependencyName(shape), objectId: row.object_id, objectKey: null,
        previousValue: row.previous_value, currentValue: row.value_text,
        previousPath: row.previous_path, path: row.path, moved: row.previous_path !== row.path,
        ...(includeSourceChanges ? { removed: row.removed, restored: row.restored,
          contentChanged: row.content_changed && row.previous_value === row.value_text } : {}),
        fileName: sourceFileName(row.path), locator: sourceLocator(shape),
        fromVersion: row.previous_version, toVersion: row.version,
        changedAt: row.created_at, previousAt: row.previous_at });
      if (changes.length >= limit) break;
    }
    return changes;
  }

  /** Objects present at both snapshots whose value or location differs. */
  changesBetween(projectId, previousSnapshotId, snapshotId) {
    const versions = this.timeline.objectVersions;
    const previous = versions.resolved(previousSnapshotId).byObject;
    const before = this.timeline.snapshotRecord(previousSnapshotId);
    const after = this.timeline.snapshotRecord(snapshotId);
    return versions.resolved(snapshotId).rows
      .filter((row) => row.project_id === projectId && previous.has(row.object_id))
      .filter((row) => row.value_text !== previous.get(row.object_id).value_text
        || row.path !== previous.get(row.object_id).path)
      .map((row) => changeRow({ ...row, snapshot_id: snapshotId }, { version: after.version, at: after.createdAt },
        previous.get(row.object_id), { version: before.version, at: before.createdAt }))
      .sort((left, right) => compareIds(left.object_id, right.object_id));
  }

  /**
   * Every recorded change of value or location for the matching objects. An
   * object stores a version only when it changes, so the version it changed
   * from was last seen at the snapshot the changing index was built on (or
   * just before a removal), as a full copy per indexed snapshot would show.
   */
  recordedChanges(filter, parameters, options = {}) {
    const columns = `o.project_id AS source_project_id, s.version, s.created_at,
      base.version AS base_version, base.created_at AS base_at`;
    // For activity's small IN-list, SQLite otherwise prefers the project's
    // object index and visits every object before filtering IDs. CROSS JOIN
    // pins x first so both versions and removals use their object_id index.
    let objectJoin = options.indexedObjectLookup ? 'CROSS JOIN' : 'JOIN';
    // Without source changes, an object changes only between two of its own
    // versions with a different value or location. A folder's history can
    // hold hundreds of thousands of objects that never changed, and reading
    // every version of them ran the server out of memory, so SQLite picks out
    // the objects that did change and only their history is read.
    if (!options.includeSourceChanges) {
      const changed = this.changedObjectIds(filter, parameters);
      if (!changed.length) return [];
      filter = 'x.object_id IN (SELECT value FROM json_each(?))';
      parameters = [JSON.stringify(changed)];
      objectJoin = 'CROSS JOIN';
    }
    const joins = `${objectJoin} scientific_objects o ON o.id = x.object_id
      JOIN snapshots s ON s.id = x.snapshot_id
      LEFT JOIN object_index_bases b ON b.snapshot_id = x.snapshot_id
      LEFT JOIN snapshots base ON base.id = b.base_snapshot_id`;
    const events = [
      ...this.db.prepare(`SELECT x.object_id, x.snapshot_id, x.value_text, x.content_hash, x.path, x.anchor_json,
        x.metadata_json, x.label, 0 AS removed, ${columns}
        FROM scientific_object_versions x ${joins} WHERE ${filter}`).all(...parameters),
      ...this.db.prepare(`SELECT x.object_id, x.snapshot_id, 1 AS removed, ${columns}
        FROM scientific_object_removals x ${joins} WHERE ${filter}`).all(...parameters),
    ];
    const byObject = new Map();
    for (const event of events) {
      if (!byObject.has(event.object_id)) byObject.set(event.object_id, []);
      byObject.get(event.object_id).push(event);
    }
    this.addFullIndexRemovals(byObject);
    const changes = [];
    for (const objectEvents of byObject.values()) {
      objectEvents.sort((left, right) => left.version - right.version);
      let last = null;
      let lastSeen = null;
      for (const event of objectEvents) {
        const seenUntil = laterSnapshot({ version: last?.version, at: last?.created_at },
          event.base_version == null ? null : { version: event.base_version, at: event.base_at });
        if (event.removed) {
          if (last && !lastSeen) {
            lastSeen = seenUntil;
            if (options.includeSourceChanges) changes.push(changeRow({ ...last, ...event, value_text: null },
              { version: event.version, at: event.created_at }, last, seenUntil));
          }
          continue;
        }
        if (last && (event.value_text !== last.value_text || event.path !== last.path
          || (options.includeSourceChanges && (event.content_hash !== last.content_hash || lastSeen)))) {
          changes.push(changeRow({ ...event, restored: Boolean(lastSeen) },
            { version: event.version, at: event.created_at }, last, lastSeen ?? seenUntil));
        }
        last = event;
        lastSeen = null;
      }
    }
    return changes;
  }

  /**
   * The matching objects with a version whose value or location differs from
   * the version before it, compared inside SQLite so no version is read here.
   */
  changedObjectIds(filter, parameters) {
    return runSync(this.changedObjectSteps(filter, parameters));
  }

  /**
   * Reads which objects changed across each folder's history off the server's
   * thread, for the folders not read yet. Requests that show value history
   * wait for this, so a long history cannot stop the server answering.
   */
  readFolderHistories(projectIds) {
    return Promise.all(projectIds.map((projectId) => runSliced(this.changedObjectSteps(FOLDER_HISTORY, [projectId]))));
  }

  /**
   * Comparing a folder's whole history reads all of it, so the answer is kept
   * as of the newest version it read. Versions are only ever added (removing
   * a directory clears this), so an object found to have changed always has;
   * a later call compares again only the objects recorded since. A reading
   * that is not up to date is offered to a worker, since a first one or a
   * folder read again can take a minute; a synchronous caller gets no reply
   * and reads here.
   */
  *changedObjectSteps(filter, parameters) {
    const key = JSON.stringify([filter, parameters]);
    let known = this.changedObjectSets.get(key);
    if (known?.newest !== this.newestVersion()) {
      const since = known?.newest ?? null;
      const read = yield { offThread: () => this.readChangedObjectsOffThread(filter, parameters, since) };
      known = combinedReading(this.changedObjectSets.get(key) ?? known, read);
    }
    // Whatever was recorded after the worker's reading is read here.
    const newest = this.newestVersion();
    if (known?.newest !== newest) {
      const since = known && known.newest < newest ? known.newest : null;
      const read = readChangedObjects(this.db, filter, parameters, since);
      known = { newest: read.newest, ids: new Set([...(since === null ? [] : known.ids), ...read.ids]) };
    }
    // Versions written inside an open transaction may yet be rolled back.
    if (!this.db.isTransaction) this.changedObjectSets.set(key, known);
    return [...known.ids];
  }

  newestVersion() { return this.db.prepare(NEWEST_VERSION).get().rowid ?? 0; }

  /** Resolves to a worker's { since, newest, ids } reading, or null when it cannot read one. */
  readChangedObjectsOffThread(filter, parameters, since) {
    const key = JSON.stringify([filter, parameters, since]);
    if (this.changedObjectReads.has(key)) return this.changedObjectReads.get(key);
    const read = new Promise((resolve) => {
      const worker = new Worker(new URL('./changed-objects-worker.js', import.meta.url), {
        workerData: { databasePath: this.timeline.config.databasePath, filter, parameters, since },
      });
      // A reading under way does not keep a closing server open.
      worker.unref();
      worker.once('message', ({ newest, ids }) => resolve({ since, newest, ids: new Set(ids) }));
      worker.once('error', () => resolve(null));
      worker.once('exit', () => resolve(null));
    }).finally(() => this.changedObjectReads.delete(key));
    this.changedObjectReads.set(key, read);
    return read;
  }

  /**
   * An index written without a base holds every object present at its
   * snapshot, so an object with no version there had gone by then. Such an
   * index records no removal rows: one written in full after most of a
   * folder stopped being indexed would otherwise need one for nearly every
   * object it no longer has. The removal is read from the absence instead,
   * as the object was last seen at the indexed snapshot before it.
   */
  addFullIndexRemovals(byObject) {
    const projects = [...new Set([...byObject.values()].map((objectEvents) => objectEvents[0].source_project_id))];
    if (!projects.length) return;
    const indexed = this.db.prepare(`SELECT s.id, s.project_id, s.version, s.created_at, b.snapshot_id IS NULL AS full
      FROM snapshots s JOIN snapshot_object_indexes i ON i.snapshot_id = s.id
      LEFT JOIN object_index_bases b ON b.snapshot_id = s.id
      WHERE s.project_id IN (${projects.map(() => '?').join(',')}) ORDER BY s.version`).all(...projects);
    const byProject = new Map();
    for (const snapshot of indexed) {
      if (!byProject.has(snapshot.project_id)) byProject.set(snapshot.project_id, []);
      byProject.get(snapshot.project_id).push(snapshot);
    }
    for (const objectEvents of byObject.values()) {
      const snapshots = byProject.get(objectEvents[0].source_project_id) ?? [];
      const recorded = new Set(objectEvents.map((event) => event.snapshot_id));
      const first = Math.min(...objectEvents.map((event) => event.version));
      for (let index = 1; index < snapshots.length; index += 1) {
        const snapshot = snapshots[index];
        if (!snapshot.full || snapshot.version <= first || recorded.has(snapshot.id)) continue;
        const before = snapshots[index - 1];
        objectEvents.push({ object_id: objectEvents[0].object_id, snapshot_id: snapshot.id, removed: 1,
          source_project_id: snapshot.project_id, version: snapshot.version, created_at: snapshot.created_at,
          base_version: before.version, base_at: before.created_at });
      }
    }
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
      const key = dependency.source.projectId === projectId ? name : `${dependency.source.projectId}|${dependency.source.id}`;
      const entry = grouped.get(key) ?? {
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
        entry.reason = object && object.currentSourceAvailable !== false ? 'source file moved' : 'source no longer resolves';
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
      grouped.set(key, entry);
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
        v.value_text, v.content_hash, s.version, s.created_at
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
      const mtimeMs = this.timeline.snapshotFile(row.snapshot_id, row.path)?.mtimeMs ?? null;
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
        sourceUpdatedAt: mtimeMs == null ? null : new Date(mtimeMs).toISOString(),
        referenceCount: this.dependencies.sourceProjectId({ id: objectId }) === projectId
          ? this.referencesAtVersion(projectId, objectId, row.version)
          : this.referencesAtTime(projectId, objectId, row.created_at),
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

  referencesAtTime(projectId, objectId, instant) {
    return this.db.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT v.dependency_id, v.source_object_id, v.is_removed,
          ROW_NUMBER() OVER (PARTITION BY v.dependency_id ORDER BY s.version DESC) AS rank
        FROM claim_dependency_versions v JOIN claim_dependencies d ON d.id = v.dependency_id
        JOIN snapshots s ON s.id = v.snapshot_id
        WHERE d.project_id = ? AND s.created_at <= ?
      ) WHERE rank = 1 AND is_removed = 0 AND source_object_id = ?
    `).get(projectId, instant, objectId).count;
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
    const ownerId = this.db.prepare('SELECT project_id FROM scientific_objects WHERE id = ?').get(objectId)?.project_id;
    const rows = this.shares(projectId, { includeRevoked: true, includeExpired: true });
    if (ownerId && ownerId !== projectId) {
      rows.push(...this.shares(ownerId, { includeRevoked: true, includeExpired: true }));
    }
    const seen = new Set();
    return rows.filter((share) => share.objectId === objectId && !seen.has(share.id) && seen.add(share.id));
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
      JOIN snapshots s ON s.id = COALESCE(g.snapshot_id, v.snapshot_id)
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
        anchor: shape.anchor,
        sharedValue: row.source_value,
        currentValue: object?.valueText ?? null,
        sharedVersion: row.shared_version,
        target: sourceFileName(row.source_path),
        createdAt: row.created_at,
        createdBy: row.created_by_name,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        scope: row.access_scope,
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
        anchor: dependency.source.anchor ?? null,
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
      projectId: object.projectId ?? this.dependencies.sourceProjectId(object) ?? projectId,
      fileName: object.fileName ?? sourceFileName(object.path),
      path: object.path,
      locator: object.locator ?? sourceLocator(object),
    };
    const anchor = object.anchor ?? {};
    // An old version whose bytes retention released previews as its recorded value.
    const absent = this.timeline.blobs.has(file.contentHash) ? null : this.timeline.blobs.absent(file.contentHash);
    if (absent instanceof BlobReleasedError && !object.metadata?.drawing) {
      return { kind: 'meta', ...header, value: object.valueText ?? null, objectType: object.objectType, bytesReleased: absent.describe() };
    }

    if (['table', 'spreadsheet'].includes(file.fileType) && ['table-cell', 'table-row', 'table-column', 'table-summary'].includes(anchor.kind)) {
      const table = this.tablePreview(file, object, radius);
      if (table) return { kind: 'table', ...header, ...table };
    }
    if (object.metadata?.drawing) {
      const context = drawingContext(object);
      return { kind: 'text', ...header, measurementBasis: object.metadata.measurementBasis,
        bbox: anchor.bbox ?? null, pageNumber: anchor.pageNumber ?? null,
        lines: context.text.split('\n').map((text, index) => ({ lineNumber: index + 1,
          highlighted: Boolean(object.metadata.rawText?.includes(text)), text })) };
    }
    const text = this.textPreview(file, object, radius);
    if (text) return { kind: 'text', ...header, ...text };
    return { kind: 'meta', ...header, value: object.valueText ?? null, objectType: object.objectType };
  }

  tablePreview(file, object, radius) {
    const buffer = this.timeline.blobs.get(file.contentHash);
    const context = buildSharePreview({path:file.path,content:buffer}, object.anchor ?? {}, object.metadata ?? {}, radius, '', { display:true });
    if (!context) return null;
    return {
      headerRow:context.headers,
      columns:context.columns,
      rows:context.rows.map(row=>({rowNumber:row.rowNumber,highlighted:row.cells.some(cell=>cell.cited),cells:row.cells.map(cell=>cell.value)})),
      highlightColumn:context.rows.find(row=>row.cells.some(cell=>cell.cited))?.cells.findIndex(cell=>cell.cited) ?? null,
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
