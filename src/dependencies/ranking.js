import path from 'node:path';
import { HttpError } from '../history/errors.js';
import { BoundedCache } from '../cache.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_MS = 30 * 60 * 1000;
const RELEVANCE_BAND = 0.08;
const MAX_USAGE_BOOST = 0.06;
const clamp = (value, minimum = 0, maximum = 1) => Math.max(minimum, Math.min(maximum, value));
const normalized = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const tokens = (value) => [...new Set(normalized(value).match(/[\p{L}\p{N}_-]+/gu) ?? [])];
const decay = (age, halfLifeDays) => 2 ** (-Math.max(0, age) / (halfLifeDays * DAY_MS));

export function directRecommendationMatch(candidate, input) {
  const query = normalized(input);
  if (!query) return { score: 0, direct: false, reason: null };
  const source = candidate.object ?? candidate;
  const candidatePath = normalized(candidate.path ?? source.path);
  const filename = path.posix.basename(candidatePath);
  const stem = filename.slice(0, filename.length - path.posix.extname(filename).length);
  // A sentence or paragraph is named by its own words. Its file's name would
  // make every passage in the file a direct match for that file.
  const passage = ['PDF_EXCERPT', 'TEXT_EXCERPT'].includes(source.metadata?.componentType);
  const names = [...(passage ? [] : [candidatePath, filename, stem]), candidate.label, candidate.name, source.label]
    .map(normalized).filter(Boolean);
  if (names.includes(query)) return { score: 1, direct: true, exact: true, reason: 'Exact name match' };
  const metadata = source.metadata ?? {};
  const anchor = source.anchor ?? {};
  const identifiers = [source.id, source.objectKey, metadata.variable, metadata.column, metadata.symbol,
    metadata.identifier, metadata.citationKey, metadata.doi, metadata.pmid,
    anchor.identifier, anchor.key, anchor.path].map(normalized).filter(Boolean);
  if (identifiers.includes(query)) return { score: 1, direct: true, exact: true, reason: 'Exact identifier match' };
  if (source.valueText != null && normalized(source.valueText) === query) {
    return { score: 1, direct: true, exact: true, reason: 'Exact value match' };
  }
  if (query.length >= 2 && names.some((name) => name.startsWith(query))) {
    return { score: 0.9, direct: true, reason: 'Name starts with your query' };
  }
  return { score: 0, direct: false, reason: null };
}

function textMatch(candidate, query) {
  const direct = directRecommendationMatch(candidate, query);
  if (direct.direct || !query) return direct;
  const queryTokens = tokens(query);
  const source = candidate.object ?? candidate;
  const candidateTokens = new Set(tokens(`${candidate.path ?? source.path} ${candidate.label ?? source.label} ${source.searchText ?? ''}`));
  const overlap = queryTokens.filter((token) => candidateTokens.has(token)).length;
  return {
    score: queryTokens.length ? 0.75 * overlap / queryTokens.length : 0,
    direct: false,
    reason: overlap ? 'Matches your query' : null,
  };
}

function finiteOption(value, fallback, minimum, maximum) {
  return Number.isFinite(value) ? clamp(value, minimum, maximum) : fallback;
}

/** File-level, project-scoped ranking shared by explicit Lasso and typing. */
export class RecommendationRanking {
  constructor(timeline, { now = Date.now } = {}) {
    this.timeline = timeline;
    this.db = timeline.db;
    this.now = now;
    this.snapshotCache = new BoundedCache({ maxEntries: 16, maxWeight: 120_000,
      weight: (snapshot) => snapshot.files.size + snapshot.objects.size });
  }

  close() { this.snapshotCache.clear(); }
  invalidateSnapshot(snapshotId) { this.snapshotCache.delete(snapshotId); }

  indexedSnapshot(projectId, snapshotId) {
    const cached = this.snapshotCache.get(snapshotId);
    if (cached) return cached.projectId === projectId ? cached : null;
    const row = this.db.prepare(`SELECT s.project_id, i.snapshot_id AS indexed
      FROM snapshots s LEFT JOIN snapshot_object_indexes i ON i.snapshot_id = s.id
      WHERE s.id = ? AND s.project_id = ?`).get(snapshotId, projectId);
    if (!row) return null;
    const files = this.db.prepare('SELECT path, project_file_id FROM snapshot_files WHERE snapshot_id = ?')
      .all(snapshotId);
    const versions = this.db.prepare(`SELECT v.object_id, v.path FROM scientific_object_versions v
      JOIN scientific_objects o ON o.id = v.object_id WHERE v.snapshot_id = ? AND o.project_id = ?`)
      .all(snapshotId, projectId);
    const snapshot = {
      projectId,
      files: new Map(files.map((file) => [file.path, file])),
      pathsById: new Map(files.map((file) => [file.project_file_id, file.path])),
      objects: new Set(versions.map((version) => `${version.object_id}\u0000${version.path}`)),
    };
    // A partially built index can acquire objects later. Cache only completed,
    // immutable snapshots so validation never rejects newly indexed sources.
    if (row.indexed) this.snapshotCache.set(snapshotId, snapshot);
    return snapshot;
  }

  record(projectId, { path: filePath, kind, sessionId, documentPath } = {}) {
    if (!['accept', 'open'].includes(kind)) {
      throw new HttpError(400, 'Recommendation usage must be an acceptance or deliberate open.');
    }
    if (typeof filePath !== 'string' || !filePath.length || filePath.length > 4096) {
      throw new HttpError(400, 'An indexed file path is required.');
    }
    if (sessionId != null && (typeof sessionId !== 'string' || !sessionId.trim()
      || sessionId.length > 128 || /[\u0000-\u001f\u007f]/.test(sessionId))) {
      throw new HttpError(400, 'Recommendation session IDs must contain 1 to 128 printable characters.');
    }
    const project = this.timeline.getProject(projectId);
    const file = this.timeline.snapshotFile(project.currentSnapshotId, filePath);
    if (!file) throw new HttpError(404, 'Recommendation file is not in the current project.');
    const document = typeof documentPath === 'string'
      ? this.timeline.snapshotFile(project.currentSnapshotId, documentPath) : null;
    const time = Math.trunc(this.now());
    const session = sessionId == null ? `time:${Math.floor(time / SESSION_MS)}` : `client:${sessionId.trim()}`;
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO recommendation_usage (
        project_id, project_file_id, kind, session_id, document_project_file_id, occurred_at_ms, last_used_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(projectId, file.projectFileId, kind, session, document?.projectFileId ?? null, time, time);
    if (!Number(result.changes)) {
      this.db.prepare(`UPDATE recommendation_usage SET last_used_at_ms = MAX(last_used_at_ms, ?)
        WHERE project_id = ? AND project_file_id = ? AND kind = ? AND session_id = ?`)
        .run(time, projectId, file.projectFileId, kind, session);
    }
    if (document) {
      this.db.prepare(`INSERT OR IGNORE INTO recommendation_document_usage
        (project_id, project_file_id, kind, session_id, document_project_file_id) VALUES (?, ?, ?, ?, ?)`)
        .run(projectId, file.projectFileId, kind, session, document.projectFileId);
    }
    return { recorded: Number(result.changes) > 0, path: file.path, kind, projectFileId: file.projectFileId };
  }

  // Resolve paths from stable file IDs in one query, so a rename retains usage.
  usage(projectId) {
    const project = this.timeline.getProject(projectId);
    return this.usageForProject(project);
  }

  usageForProject(project) {
    const time = this.now();
    const rows = this.db.prepare(`
      SELECT u.*, sf.path
      FROM recommendation_usage u
      JOIN snapshot_files sf ON sf.project_file_id = u.project_file_id AND sf.snapshot_id = ?
      WHERE u.project_id = ?
      ORDER BY u.last_used_at_ms DESC, u.project_file_id, u.kind, u.session_id
    `).all(project.currentSnapshotId, project.id);
    const documentsByFile = new Map();
    for (const row of this.db.prepare(`SELECT DISTINCT project_file_id, document_project_file_id
      FROM recommendation_document_usage WHERE project_id = ?
      ORDER BY project_file_id, document_project_file_id`).all(project.id)) {
      if (!documentsByFile.has(row.project_file_id)) documentsByFile.set(row.project_file_id, new Set());
      documentsByFile.get(row.project_file_id).add(row.document_project_file_id);
    }
    const byFile = new Map();
    for (const row of rows) {
      let item = byFile.get(row.project_file_id);
      if (!item) {
        item = {
          projectFileId: row.project_file_id, path: row.path, acceptedSessions: 0, openedSessions: 0,
          lastUsedAt: row.last_used_at_ms, recentScore: 0, decayedFrequency: 0,
          documentProjectFileIds: documentsByFile.get(row.project_file_id) ?? new Set(),
        };
        byFile.set(row.project_file_id, item);
      }
      const weight = row.kind === 'accept' ? 1 : 0.35;
      const age = time - row.occurred_at_ms;
      item[row.kind === 'accept' ? 'acceptedSessions' : 'openedSessions'] += 1;
      item.recentScore = Math.max(item.recentScore, weight * decay(time - row.last_used_at_ms, 3));
      item.decayedFrequency += weight * decay(age, 14);
      if (row.document_project_file_id) item.documentProjectFileIds.add(row.document_project_file_id);
    }
    return [...byFile.values()].map((item) => {
      // Saturation keeps a heavily used file from accumulating unlimited weight.
      const frequencyScore = 1 - Math.exp(-item.decayedFrequency / 5);
      return {
        ...item,
        documentProjectFileIds: [...item.documentProjectFileIds],
        frequencyScore,
        usageBoost: Math.min(MAX_USAGE_BOOST, 0.04 * item.recentScore + 0.02 * frequencyScore),
      };
    });
  }

  relatedFilePaths(project, document, relatedPaths) {
    const related = new Set(relatedPaths.filter((item) => typeof item === 'string'));
    if (!document) return related;
    // Select latest versions in bulk, including removals before filtering. Resolve
    // historical source paths back through file identity to survive source renames.
    const rows = this.db.prepare(`
      WITH latest AS (
        SELECT v.*, ROW_NUMBER() OVER (PARTITION BY v.dependency_id ORDER BY s.version DESC, v.rowid DESC) AS position
        FROM claim_dependencies d
        JOIN claim_dependency_versions v ON v.dependency_id = d.id
        JOIN snapshots s ON s.id = v.snapshot_id
        WHERE d.project_id = ? AND d.document_project_file_id = ? AND s.version <= ?
      )
      SELECT current_file.path
      FROM latest v
      JOIN scientific_object_versions ov ON ov.object_id = v.source_object_id AND ov.snapshot_id = v.source_snapshot_id
      JOIN snapshot_files origin_file ON origin_file.snapshot_id = ov.snapshot_id AND origin_file.path = ov.path
      JOIN snapshot_files current_file ON current_file.snapshot_id = ? AND current_file.project_file_id = origin_file.project_file_id
      WHERE v.position = 1 AND v.is_removed = 0 AND v.status != 'BROKEN'
    `).all(project.id, document.projectFileId, project.currentVersion, project.currentSnapshotId);
    for (const row of rows) related.add(row.path);
    return related;
  }

  rank(projectId, candidates, options = {}) {
    const project = this.timeline.getProject(projectId);
    const query = normalized(options.query);
    const limit = Math.trunc(finiteOption(options.limit, 8, 0, candidates.length));
    if (!limit || !candidates.length) return [];
    const minimumScore = finiteOption(options.minimumScore, 0, 0, 1);
    const maxPerFile = Math.trunc(finiteOption(options.maxPerFile, 2, 1, Math.max(1, candidates.length)));
    const document = typeof options.documentPath === 'string'
      ? this.timeline.snapshotFile(project.currentSnapshotId, options.documentPath) : null;
    const related = this.relatedFilePaths(project, document, Array.isArray(options.relatedPaths) ? options.relatedPaths : []);
    const usageByFile = new Map(this.usageForProject(project).map((item) => [item.projectFileId, item]));
    // Validate the actual indexed snapshot, including explicitly pinned sources.
    // Resolve its file identity to the current path for usage and relationships.
    const snapshots = [...new Set([project.currentSnapshotId, ...candidates.map((candidate) =>
      (candidate.object ?? candidate).snapshotId).filter((value) => typeof value === 'string')])];
    const indexed = new Map(snapshots.map((snapshotId) => [snapshotId, this.indexedSnapshot(projectId, snapshotId)]));
    const current = indexed.get(project.currentSnapshotId);
    const objectIdentity = (source) => source.objectId ?? (source.objectType ? source.id : null);
    const prepared = candidates.flatMap((candidate, index) => {
      const source = candidate.object ?? candidate;
      if (source.projectId != null && source.projectId !== projectId) return [];
      const snapshotId = source.snapshotId ?? project.currentSnapshotId;
      const filePath = candidate.path ?? source.path;
      const snapshot = indexed.get(snapshotId);
      const file = snapshot?.files.get(filePath);
      if (!file) return [];
      const sourceId = objectIdentity(source);
      if ((source.objectType || source.objectId != null)
        && !snapshot.objects.has(`${sourceId}\u0000${filePath}`)) return [];
      // Retrieval already supplied the score and explanation for most callers.
      // Preserve direct-match protection without tokenizing the same source a
      // second time merely to calculate an unused fallback score.
      const match = Number.isFinite(candidate.score) && candidate.reasons?.[0] != null
        ? directRecommendationMatch(candidate, query) : textMatch(candidate, query);
      const relevanceScore = Number.isFinite(candidate.score) ? clamp(candidate.score) : match.score;
      if (relevanceScore < minimumScore) return [];
      const usage = usageByFile.get(file.project_file_id);
      const documentUsed = Boolean(document && usage?.documentProjectFileIds.includes(document.projectFileId));
      const relationship = related.has(current?.pathsById.get(file.project_file_id) ?? file.path) || documentUsed;
      const explicitTier = Number.isInteger(candidate.matchTier) && candidate.matchTier >= 0 && candidate.matchTier <= 3;
      const tier = !query ? 3 : match.direct ? 0 : explicitTier ? candidate.matchTier
        : relevanceScore > 0 ? 1 : relationship ? 2 : 3;
      const reason = tier === 0 ? (match.direct ? match.reason : null) ?? candidate.reasons?.[0] ?? 'Direct match'
        : !query && usage?.recentScore > 0.05 ? 'Recently used in this project'
          : !query && usage?.frequencyScore > 0.01 ? 'Frequently used in this project'
        : relationship ? (documentUsed ? 'Used with this document' : 'Used in this document')
          : tier <= 1 ? candidate.reasons?.[0] ?? match.reason ?? 'Matches your context'
            : usage?.recentScore > 0.05 ? 'Recently used in this project'
              : usage?.frequencyScore > 0.01 ? 'Frequently used in this project' : 'Available in this project';
      const ranking = {
        tier, relevanceScore, relevanceBand: Math.floor((relevanceScore + 1e-9) / RELEVANCE_BAND),
        directSpecificity: tier === 0 ? (match.direct && !match.exact ? 1 : 2) : 0,
        usageBoost: usage?.usageBoost ?? 0, relationship, reason,
        recentScore: usage?.recentScore ?? 0, frequencyScore: usage?.frequencyScore ?? 0,
        acceptedSessions: usage?.acceptedSessions ?? 0, openedSessions: usage?.openedSessions ?? 0,
        lastUsedAt: usage?.lastUsedAt ?? null,
      };
      const fileKey = candidate.diversityKey && candidate.diversityKey !== filePath
        ? candidate.diversityKey : source.objectType === 'REFERENCE' ? source.id : file.project_file_id;
      return [{ candidate: { ...candidate, score: candidate.score ?? relevanceScore, ranking }, index, fileKey }];
    });

    prepared.sort((left, right) => {
      const a = left.candidate.ranking;
      const b = right.candidate.ranking;
      return a.tier - b.tier
        || b.directSpecificity - a.directSpecificity
        || (query ? b.relevanceBand - a.relevanceBand : 0)
        || (query ? Number(b.relationship) - Number(a.relationship)
          : b.recentScore - a.recentScore || b.frequencyScore - a.frequencyScore)
        || (query ? (b.relevanceScore + b.usageBoost) - (a.relevanceScore + a.usageBoost)
          : Number(b.relationship) - Number(a.relationship))
        || b.relevanceScore - a.relevanceScore
        // Preserve the caller's established scientific/source tie preferences.
        || left.index - right.index
        || String(left.candidate.path ?? '').localeCompare(String(right.candidate.path ?? ''))
        || String(left.candidate.id ?? '').localeCompare(String(right.candidate.id ?? ''));
    });
    const distinctFiles = new Set(prepared.map((item) => item.fileKey));
    if (options.diversify === false || distinctFiles.size <= 1) {
      return prepared.slice(0, limit).map((item) => item.candidate);
    }

    // Diversity operates within each tier and close relevance band. An extra
    // exact match remains ahead of a weaker context match from another file.
    const groups = new Map();
    for (const item of prepared) {
      const ranking = item.candidate.ranking;
      const key = `${ranking.tier}:${ranking.directSpecificity}:${query ? ranking.relevanceBand : 0}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const counts = new Map();
    const result = [];
    for (const group of groups.values()) {
      const remaining = [...group];
      while (remaining.length && result.length < limit) {
        const usedThisRound = new Set();
        for (let index = 0; index < remaining.length && result.length < limit;) {
          const { candidate, fileKey } = remaining[index];
          if ((counts.get(fileKey) ?? 0) >= maxPerFile) {
            remaining.splice(index, 1);
          } else if (usedThisRound.has(fileKey)) {
            index += 1;
          } else {
            result.push(candidate);
            counts.set(fileKey, (counts.get(fileKey) ?? 0) + 1);
            usedThisRound.add(fileKey);
            remaining.splice(index, 1);
          }
        }
      }
      if (result.length >= limit) break;
    }
    return result;
  }
}
