// Searching a workspace's sources, and recording which suggestions were used.

import path from 'node:path';
import { HttpError } from '../history/errors.js';
import { directRecommendationMatch } from './ranking.js';
import { normalizedVariable } from './tabular.js';
import { drawingDiscovery, drawingReferenceMatch } from './drawing-discovery.js';
import { isTextPassage } from './object-descriptors.js';
import { wordTokens } from './text-similarity.js';

// How strongly a typed term matches text: a whole word (or its plural), the
// start of a word as it is being typed, or, weakly, a fragment inside a word.
function queryTermMatcher(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const whole = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:s|es)?(?![\\p{L}\\p{N}])`, 'u');
  const start = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}`, 'u');
  return (text) => whole.test(text) ? 1 : start.test(text) ? 0.75 : text.includes(term) ? 0.25 : 0;
}

export const sourceSearchMethods = {
  search(projectId, query, options = {}) {
    const normalizedQuery = String(query ?? '').toLowerCase().trim();
    const terms = normalizedQuery.match(/[\p{L}\p{N}_.%-]+/gu) ?? [];
    const termMatchers = terms.map(queryTermMatcher);
    const contextTerms = wordTokens(options.context);
    // Terminal aliases are names in this workspace, so the editor's source
    // picker finds a source by an alias the same way the terminal does.
    const aliases = this.aliasesForProject?.(projectId) ?? [];
    const aliasedKeys = new Set(aliases
      .filter((alias) => normalizedQuery && normalizedVariable(alias.name) === normalizedVariable(normalizedQuery))
      .map((alias) => alias.objectKey));
    const aliasContextScores = new Map();
    if (terms.length) {
      for (const alias of aliases) {
        const name = String(alias.name).toLowerCase();
        const score = 0.75 * terms.filter((term) => name.includes(term)).length / terms.length;
        if (score) aliasContextScores.set(alias.objectKey, Math.max(score, aliasContextScores.get(alias.objectKey) ?? 0));
      }
    }
    const objects = this.objectsAt(projectId, options.snapshotId)
      .filter((object) => !options.sourcePath || object.path === options.sourcePath);
    const drawingMatches = new Map(objects.flatMap(object => {
      const match = drawingReferenceMatch(object, normalizedQuery);
      return match ? [[object.id, match]] : [];
    }));
    const drawingPaths = new Set(objects.filter(object => drawingMatches.has(object.id)).map(object => object.path));
    const matches = objects
      .map((object) => {
        const drawing = drawingMatches.get(object.id);
        const match = directRecommendationMatch(object, normalizedQuery);
        const aliasMatch = aliasedKeys.has(object.objectKey);
        const direct = match.direct || aliasMatch;
        const searchable = `${object.searchText} ${object.path}`.toLowerCase();
        // A passage is found by its own words. Its file name matches every
        // passage in the file equally, so it counts for little.
        const passage = isTextPassage(object);
        const content = passage ? String(object.valueText ?? '').toLowerCase() : searchable;
        const filePath = object.path.toLowerCase();
        const termScore = termMatchers.reduce((sum, matches) => sum
          + Math.max(matches(content), passage ? matches(filePath) * 0.3 : 0), 0) / Math.max(1, terms.length);
        const contextScore = contextTerms.length
          ? contextTerms.filter((term) => searchable.includes(term)).length / contextTerms.length : 0;
        const aliasScore = aliasContextScores.get(object.objectKey) ?? 0;
        const score = aliasMatch ? 1 : direct && normalizedQuery ? match.score
          : terms.length ? Math.max(aliasScore, termScore)
            : contextScore ? 0.25 + contextScore * 0.35 : 0.2;
        return {
          ...object,
          diversityKey: object.objectType === 'REFERENCE' ? object.id : object.path,
          ...(drawing ? { label: drawing.label, searchAliases: drawingDiscovery(object).aliases } : {}),
          ...((drawing || direct && normalizedQuery) ? { matchTier: 0 }
            : drawingPaths.has(object.path) ? { matchTier: 1 } : {}),
          ...(!normalizedQuery && contextTerms.length ? { matchTier: contextScore ? 1 : 3 } : {}),
          reasons: aliasMatch ? ['Exact alias match'] : drawing ? ['Matches a drawing name or topic']
            : direct && normalizedQuery ? [match.reason]
              : aliasScore ? ['Matches a source alias'] : contextScore ? ['Matches current context'] : [],
          score: drawing ? Math.max(drawing.score, direct ? score : 0)
            : normalizedQuery && !direct && score > 0 ? Math.min(1, score + contextScore * 0.03) : score,
        };
      })
      .filter((object) => !terms.length || object.score > 0)
      .sort((a, b) => b.score - a.score || b.snapshotVersion - a.snapshotVersion || a.label.localeCompare(b.label));
    const sourcePaths = new Set(matches.filter((object) => normalizedQuery
      && [object.path, path.posix.basename(object.path)].some((value) => value.toLowerCase() === normalizedQuery))
      .map((object) => object.path));
    let ranked = this.ranking.rank(projectId, matches, {
      query: normalizedQuery || options.context, documentPath: options.documentPath,
      limit: options.limit ?? 30,
      diversify: options.diversify !== false && !options.sourcePath && sourcePaths.size !== 1,
    });
    // Naming a file asks for that file first, then what it contains.
    if (sourcePaths.size === 1) {
      const whole = (object) => ['DRAWING', 'PAPER', 'DATASET'].includes(object.objectType)
        || (object.objectType === 'DOCUMENT' && !isTextPassage(object));
      ranked = [...ranked.filter(whole), ...ranked.filter((object) => !whole(object))];
    }
    return options.enrich === false ? ranked : ranked.map((object) => this.enrichObject(projectId, object));
  },

  recordRecommendationUsage(projectId, input, { allowMissingSource = false } = {}) {
    if (!input || !['accept', 'open'].includes(input.kind)) {
      throw new HttpError(400, 'Usage must be an accepted suggestion or deliberate source open.');
    }
    let project = this.timeline.getProject(projectId);
    let objectId = input.objectId;
    for (const key of ['objectId', 'dependencyId']) {
      if (Object.hasOwn(input, key) && (typeof input[key] !== 'string' || !input[key].trim()
        || input[key].length > 128 || /[\u0000-\u001f\u007f]/.test(input[key]))) {
        throw new HttpError(400, 'An indexed source or dependency identity is required.');
      }
    }
    if (Object.hasOwn(input, 'path') && (typeof input.path !== 'string' || !input.path
      || input.path.length > 4096)) throw new HttpError(400, 'An indexed file path is required.');
    const suppliedSource = objectId
      ? this.db.prepare('SELECT project_id FROM scientific_objects WHERE id = ?').get(objectId) : null;
    if (objectId && !suppliedSource) throw new HttpError(404, 'Indexed source not found in this project.');
    if (Object.hasOwn(input, 'dependencyId')) {
      const dependency = this.db.prepare('SELECT project_id FROM claim_dependencies WHERE id = ?').get(input.dependencyId);
      if (!dependency || dependency.project_id !== projectId) throw new HttpError(404, 'Dependency not found in this project.');
      const dependencyObjectId = this.latestVersionRow(input.dependencyId)?.source_object_id;
      // A foreign object is valid through a real dependency in this directory.
      // An unrelated foreign identity must still fail before recording usage.
      if (suppliedSource && suppliedSource.project_id !== projectId && objectId !== dependencyObjectId) {
        throw new HttpError(404, 'Indexed source not found in this project.');
      }
      if (objectId && objectId !== dependencyObjectId) throw new HttpError(400, 'Source and dependency identities do not match.');
      objectId = dependencyObjectId;
      if (!objectId && allowMissingSource) return { recorded: false };
      if (!objectId) throw new HttpError(404, 'Dependency source not found in this project.');
    }
    if (objectId) {
      const source = suppliedSource ?? this.db.prepare('SELECT project_id FROM scientific_objects WHERE id = ?').get(objectId);
      if (!source || (source.project_id !== projectId && !Object.hasOwn(input, 'dependencyId'))) {
        throw new HttpError(404, 'Indexed source not found in this project.');
      }
      project = this.timeline.getProject(source.project_id);
    }
    let sourcePath = input.path;
    if (objectId) {
      if (typeof objectId !== 'string') throw new HttpError(400, 'An indexed source identity is required.');
      // Resolve through file identity so an accepted older object follows a rename.
      const latest = this.timeline.objectVersions.latest(objectId);
      const original = latest?.project_id === project.id
        ? this.timeline.snapshotFile(latest.snapshot_id, latest.path) : null;
      const source = original ? this.timeline.snapshotFileById(project.currentSnapshotId, original.projectFileId) : null;
      if (!source && allowMissingSource) return { recorded: false };
      if (!source) throw new HttpError(404, 'Indexed source not found in this project.');
      sourcePath = source.path;
    }
    return this.ranking.record(project.id, {
      path: sourcePath, kind: input.kind, sessionId: input.sessionId,
      documentPath: project.id === projectId ? input.documentPath : null,
    });
  },
};
