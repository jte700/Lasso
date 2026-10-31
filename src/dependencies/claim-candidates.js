// Sources that back a claim in the text, and the sentence completions drawn from them.

import path from 'node:path';
import { buildSentenceCorpus, completeSentence } from './completion.js';
import { markdownBlocks } from '../sharing/markdown.js';
import { humanVariable, normalizedVariable } from './tabular.js';
import { SLIDE_SENTENCE_LIMITS } from './file-objects.js';
import { matchedSourceWords } from './direct-match.js';
import { authorSimilarity, referenceSimilarity, referenceTitleSimilarity } from './reference-match.js';
import { prefixTokenScore, tokenOverlap, wordTokens } from './text-similarity.js';
import { measurementDescriptor, numericDescriptor, valueMatch } from './value-match.js';
import { objectMatchingFeatures, variableSimilarity } from './variable-match.js';
import { isPassageExcerpt } from './workspace-completion.js';
import { writingSourceContext } from './writing-context.js';

function citedAuthor(text) {
  return String(text ?? '').match(/\b([A-Z][A-Za-z'’-]+)\s+et al\./)?.[1] ?? '';
}

// A source backs a reference only when it has a word typed for it: in its own
// text, title, author or file name. The folder it is filed in names nothing.
function namesReference(typed, object) {
  const metadata = object.metadata ?? {};
  const own = [object.label, object.valueText, metadata.author, metadata.title, metadata.subject,
    metadata.textExcerpt, metadata.fileName, path.basename(String(object.path ?? ''))]
    .filter((text) => typeof text === 'string').join(' ');
  return matchedSourceWords(typed, own).length > 0;
}

export const claimCandidatesMethods = {
  completionCorpus(projectId, snapshotId = null) {
    const project = this.timeline.getProject(projectId);
    const target = snapshotId ?? project.currentSnapshotId;
    if (this.completionCorpusCache.has(target)) return this.completionCorpusCache.get(target);
    const snapshot = this.timeline.getSnapshot(target);
    const sources = [];
    const objects = this.objectsAt(projectId, target, new Set(['PAPER', 'DOCUMENT', 'REFERENCE', 'DRAWING']));
    const objectByPath = new Map();
    // Sentence objects must precede their parent and paragraph objects because
    // the corpus deduplicates the same sentence within one file.
    objects.sort((left, right) => Number(right.metadata.excerptType === 'sentence') - Number(left.metadata.excerptType === 'sentence')
      || Number(isPassageExcerpt(right)) - Number(isPassageExcerpt(left)));
    const excerptPaths = new Set(objects.filter(isPassageExcerpt).map(object => object.path));
    for (const object of objects) {
      if (!isPassageExcerpt(object) && (!objectByPath.has(object.path) || isPassageExcerpt(objectByPath.get(object.path))
        || ['PAPER', 'REFERENCE'].includes(object.objectType))) objectByPath.set(object.path, object);
      if (excerptPaths.has(object.path) && !isPassageExcerpt(object)) continue;
      const text = [['PAPER', 'DRAWING'].includes(object.objectType) && /\.pdf$/i.test(object.path) ? this.sourceText(object) : object.metadata.textExcerpt,
        object.metadata.title, object.metadata.subject, object.valueText]
        .filter(Boolean).join('\n');
      if (text) {
        sources.push({ text, path: object.path, snapshotId: target, dependencyCandidate: object,
          ...(object.metadata.format === 'PPTX' && isPassageExcerpt(object) ? { limits: SLIDE_SENTENCE_LIMITS } : {}) });
      }
    }
    for (const file of snapshot.files) {
      const extension = path.extname(file.path).toLowerCase();
      if (file.fileType !== 'markdown' && !(file.fileType === 'text' && ['.txt', '.tex'].includes(extension))) continue;
      if (file.size > 2_000_000) continue;
      const content = this.timeline.blobs.get(file.contentHash).toString('utf8');
      sources.push({
        // Prose in a passage-indexed file already links to its own sentence or
        // paragraph above; only headings still complete from the file itself.
        text: excerptPaths.has(file.path)
          ? markdownBlocks(content).filter(block => block.type === 'heading').map(block => block.text).join('\n')
          : content,
        path: file.path,
        snapshotId: target,
        dependencyCandidate: objectByPath.get(file.path) ?? null,
      });
    }
    const corpus = buildSentenceCorpus(sources);
    this.completionCorpusCache.set(target, corpus);
    return corpus;
  },

  candidatesForClaim(projectId, claim, options = {}) {
    const claimTokens = `${claim.text} ${options.context ?? ''} ${options.section ?? ''}`;
    const claimWords = wordTokens(claimTokens);
    const claimNumber = measurementDescriptor(claim.value);
    const expectedVariable = claim.variable ? normalizedVariable(claim.variable) : null;
    const expectedVariableWords = wordTokens(humanVariable(claim.variable));
    const referenceQuery = claim.type === 'LITERATURE' ? (claim.partial ? claim.value : citedAuthor(claim.text)) : '';
    // A citation cue alone ("studies have") spans the text; only the sentence it ends in is being typed.
    const cueText = String(claim.text ?? '').replace(/[.!?]["'”’)\]]*\s*$/, '');
    const referenceWords = referenceQuery || writingSourceContext(cueText, cueText.length).sentence;
    const referenceYear = String(referenceQuery ?? '').match(/\b((?:19|20)\d{2}[a-z]?)\b/i)?.[1]?.toLowerCase() ?? '';
    const claimAuthor = claim.type === 'LITERATURE'
      ? (citedAuthor(claim.text) || (claim.partial ? claim.value : '')) : '';
    const documentReference = claim.type === 'LITERATURE'
      && /^(?:document|report|file|note|memo|proposal|manuscript|protocol|spreadsheet|workbook|presentation|slides?)$/i.test(claim.referenceKind ?? '');
    const typePreference = claim.type === 'LITERATURE'
      ? new Set(documentReference ? ['REFERENCE', 'PAPER', 'DOCUMENT'] : ['REFERENCE', 'PAPER']) : ({
      QUANTITATIVE: new Set(['RESULT', 'VALUE', 'DATASET_VALUE', 'TABLE', 'PARAMETER', 'VARIABLE', 'DRAWING_ANNOTATION']),
      SAMPLE_SIZE: new Set(['RESULT', 'VALUE', 'DATASET', 'DATASET_VALUE', 'TABLE', 'VARIABLE']),
      // An entity phrase can name a whole spreadsheet row. Keep that semantic
      // object in the result set instead of forcing retrieval down to one of
      // its numeric cells; value claims will still select DATASET_VALUE.
      ENTITY: new Set(['RESULT', 'VALUE', 'DATASET_ROW', 'DATASET_VALUE', 'FIGURE', 'MODEL', 'VARIABLE', 'DRAWING_ANNOTATION']),
      DATASET_REFERENCE: new Set(['DATASET', 'ANALYSIS_RUN']),
      FIGURE: new Set(['FIGURE']), TABLE_REFERENCE: new Set(['TABLE']),
      METHOD: new Set(['METHOD', 'MODEL', 'CODE', 'CODE_BLOCK', 'CODE_LINE', 'NOTEBOOK_CELL', 'PROTOCOL']),
    }[claim.type] ?? new Set());
    const permitted = this.autocompleteFilter(projectId);
    const objects = this.objectsAt(projectId, options.snapshotId, typePreference)
      .filter((object) => (!options.documentPath || object.path !== options.documentPath)
        && (!options.sourcePath || object.path === options.sourcePath)
        && (!typePreference.size || typePreference.has(object.objectType))
        && (options.sourcePath ? true : permitted(object)));
    const variableDefinitions = new Map(objects
      .filter((object) => object.objectType === 'VARIABLE' && object.metadata.dictionary)
      .map((object) => [normalizedVariable(object.metadata.variable), object]));
    const variableProfiles = new Map(objects
      .filter((object) => object.objectType === 'VARIABLE' && !object.metadata.dictionary)
      .map((object) => [normalizedVariable(object.metadata.variable), object]));
    const provenancePaths = new Set(this.db.prepare(`
      SELECT from_path AS path FROM provenance_links WHERE project_id = ?
      UNION SELECT to_path AS path FROM provenance_links WHERE project_id = ? AND to_path IS NOT NULL
    `).all(projectId, projectId).map((row) => row.path));
    const ranked = objects.map((object) => {
      const features = objectMatchingFeatures(object);
      const value = valueMatch(claim, object, claimNumber, features.numeric);
      const entity = Math.max(
        tokenOverlap(claimWords, features.words),
        claim.type === 'ENTITY' ? prefixTokenScore(claim.value ?? claim.text, object.searchText) : 0,
      );
      const directVariable = variableSimilarity(expectedVariable, expectedVariableWords, features);
      const definition = features.definitionKeys.map((key) => variableDefinitions.get(key) ?? variableProfiles.get(key)).find(Boolean);
      const dictionaryVariable = definition
        ? variableSimilarity(expectedVariable, expectedVariableWords, objectMatchingFeatures(definition)) : 0;
      const variable = Math.max(directVariable, dictionaryVariable);
      const type = typePreference.has(object.objectType) ? 1 : 0;
      const author = claim.type === 'LITERATURE' ? authorSimilarity(claimAuthor, object.metadata.author) : 0;
      const titleReference = claim.type === 'LITERATURE' ? referenceTitleSimilarity(referenceQuery, object) : 0;
      const broadReference = claim.type === 'LITERATURE' ? referenceSimilarity(referenceQuery, object) : 0;
      const reference = claim.type !== 'LITERATURE' ? 0
        : claim.referenceMode === 'author' ? author
          : claim.referenceMode === 'title' ? titleReference
            : Math.max(author, titleReference, broadReference);
      const component = ['TABLE_REFERENCE', 'FIGURE'].includes(claim.type)
        ? referenceSimilarity(claim.value ?? claim.text, object) : 0;
      const publicationYear = claim.type === 'LITERATURE' && object.metadata.year
        && String(claim.text).includes(String(object.metadata.year)) ? 1 : 0;
      const graph = provenancePaths.has(object.path) ? 1 : 0;
      let score = Math.min(1, value.score * 0.56 + entity * 0.2 + variable * 0.48 + author * 0.16
        + reference * 0.5 + component * 0.62 + publicationYear * 0.1 + type * 0.09 + graph * 0.03);
      // When the writer is naming an entity, prefer its indexed row over a
      // child cell that happens to repeat the row label. This is schema-driven
      // and applies to every workbook/table, not to any particular row name.
      if (claim.type === 'ENTITY' && object.objectType === 'DATASET_ROW' && entity >= 0.68) {
        score = Math.min(1, score + 0.18);
      }
      const candidateVariable = object.metadata.variable ?? object.metadata.column;
      if (claim.variable && candidateVariable && variable < 0.2) score *= 0.42;
      const reasons = [];
      if (value.score >= 0.8) reasons.push('matching value');
      if (author === 1) reasons.push('matching author');
      else if (author) reasons.push('similar author');
      if (publicationYear) reasons.push('matching publication year');
      if (claim.referenceMode === 'title' && titleReference >= 0.68) reasons.push('matching title');
      else if (claim.referenceMode === 'author' && author >= 0.7 && !reasons.some((reason) => reason.includes('author'))) reasons.push('matching author');
      else if (reference >= 0.9) reasons.push('matching reference prefix');
      else if (reference >= 0.68) reasons.push('similar reference metadata');
      if (component >= 0.9) reasons.push(`matching ${claim.type === 'TABLE_REFERENCE' ? 'table' : 'figure'} identifier`);
      else if (component >= 0.68) reasons.push(`similar ${claim.type === 'TABLE_REFERENCE' ? 'table' : 'figure'} reference`);
      if (variable >= 0.7) reasons.push(object.metadata.dictionary || (definition?.metadata.dictionary && dictionaryVariable >= 0.7)
        ? 'matching data dictionary definition' : 'matching study variable');
      else if (variable > 0) reasons.push('similar study variable');
      if (entity > 0) reasons.push('matching entity');
      if (type) reasons.push(`matching ${object.objectType.toLowerCase()} type`);
      if (graph) reasons.push('connected provenance');
      return {
        ...object,
        displayValue: value.displayValue ?? (numericDescriptor(object.valueText) ? object.valueText : null),
        // A bibliography holds several independently citable works.
        diversityKey: object.objectType === 'REFERENCE' ? object.id : object.path,
        score: Number(score.toFixed(3)),
        reasons,
        matchStrength: Math.max(value.score, entity, variable, reference, component),
        matchTier: (value.score >= 0.8 && (!claim.variable || variable >= 0.7))
          || reference >= 0.9 || author === 1 || component >= 0.9
          || variable >= 0.9 || (['ENTITY', 'METHOD'].includes(claim.type) && entity >= 0.9) ? 0 : 1,
        authorSimilarity: Number(author.toFixed(3)),
        referenceSimilarity: Number(reference.toFixed(3)),
        titleSimilarity: Number(titleReference.toFixed(3)),
        componentSimilarity: Number(component.toFixed(3)),
        referenceRole: claim.referenceMode === 'author' || claim.referenceMode === 'title'
          ? claim.referenceMode : author >= 0.7 && author >= titleReference ? 'author' : 'title',
        variableDefinition: definition ? {
          variable: definition.metadata.variable,
          description: definition.metadata.description ?? definition.metadata.inferredMeaning ?? definition.valueText,
          units: definition.metadata.units ?? null,
          path: definition.path,
          inferred: !definition.metadata.dictionary,
        } : object.metadata.dictionary ? {
          variable: object.metadata.variable,
          description: object.metadata.description ?? object.valueText,
          units: object.metadata.units ?? null,
          path: object.path,
        } : null,
      };
    }).filter((object) => object.score >= (options.minimumScore ?? (claim.type === 'LITERATURE' ? 0.08 : 0.2))
      && (object.matchTier === 0 || object.matchStrength >= (options.minimumMatchStrength ?? 0))
      && (!referenceQuery || object.referenceSimilarity >= 0.68 || object.authorSimilarity >= 0.7)
      && (claim.type !== 'LITERATURE' || object.authorSimilarity >= 0.7 || namesReference(referenceWords, object))
      && (!referenceYear || !object.metadata.year || String(object.metadata.year).toLowerCase() === referenceYear))
      .sort((a, b) => b.score - a.score
        || (Number.parseInt(b.metadata.year, 10) || 0) - (Number.parseInt(a.metadata.year, 10) || 0)
        || b.snapshotVersion - a.snapshotVersion || a.label.localeCompare(b.label));
    return this.ranking.rank(projectId, ranked, {
      query: claimTokens, documentPath: options.documentPath, relatedPaths: options.relatedPaths,
      limit: options.limit ?? 8, diversify: !options.sourcePath,
    }).map((object) => this.enrichObject(projectId, object));
  },

  relatedSourcePaths(projectId, input) {
    const objectIds = (Array.isArray(input.pendingDependencies) ? input.pendingDependencies.slice(0, 50) : [])
      .map((item) => item.sourceObjectId).filter((value) => typeof value === 'string');
    if (!objectIds.length) return [];
    const project = this.timeline.getProject(projectId);
    this.ensureIndex(projectId, project.currentSnapshotId);
    const current = this.timeline.objectVersions.resolved(project.currentSnapshotId).byObject;
    return [...new Set(objectIds.map((objectId) => current.get(objectId))
      .filter((row) => row?.project_id === projectId).map((row) => row.path))];
  },

  rankCompletions(projectId, completions, input, options = {}) {
    const sourceProjectId = completions.length
      ? this.sourceProjectId(completions[0].dependencyCandidate ?? {}) : null;
    const rankingProjectId = sourceProjectId ?? projectId;
    return this.ranking.rank(rankingProjectId, completions.map((completion) => ({
      ...completion.dependencyCandidate,
      score: completion.confidence ?? completion.dependencyCandidate?.score ?? 0,
      completion,
    })), {
      query: input.text, documentPath: rankingProjectId === projectId ? input.documentPath : null,
      relatedPaths: this.relatedSourcePaths(rankingProjectId, input), ...options,
    }).map(({ completion, ranking }) => ({
      ...completion,
      dependencyCandidate: { ...completion.dependencyCandidate, ranking },
    }));
  },

  sentenceSuggestion(projectId, input) {
    const permitted = this.autocompleteFilter(projectId);
    return completeSentence(this.completionCorpus(projectId), input, {
      include: permitted,
      rank: (completions) => this.rankCompletions(projectId, completions.filter((item) => item.dependencyCandidate?.id).map((item) => ({
        ...item,
        dependencyCandidate: {
          ...item.dependencyCandidate,
          matchTier: item.matchKind === 'PREFIX' ? 0 : 1,
        },
      })), input, { limit: 1, diversify: false, minimumScore: 0.54 }),
    });
  },
};
