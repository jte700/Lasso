// Suggestions for the words being typed, drawn from every object in the workspace.

import { ownWordKeys, typedWordKeys } from './direct-match.js';
import { dependencyFilePriority } from './file-objects.js';
import { variableTokens } from './text-similarity.js';
import {
  contextualCompletionRange, workspaceCompletionText, workspaceSuggestionCategory,
} from './workspace-completion.js';
import { writingSourceContext } from './writing-context.js';

export const workspaceSuggestionsMethods = {
  workspaceRetrievalObjects(projectId, snapshotId = null) {
    const project = this.timeline.getProject(projectId);
    const target = snapshotId ?? project.currentSnapshotId;
    if (this.workspaceRetrievalCache.has(target)) return this.workspaceRetrievalCache.get(target);
    const retrievableTypes = new Set([
      'VARIABLE', 'RESULT', 'VALUE', 'DATASET_ROW', 'DATASET_VALUE', 'DATASET', 'METHOD', 'MODEL',
      'PARAMETER', 'PROTOCOL', 'ANALYSIS_RUN', 'FIGURE', 'TABLE', 'DOCUMENT',
      'DRAWING_ANNOTATION',
    ]);
    const objects = this.objectsAt(projectId, target, retrievableTypes)
      .filter((object) => retrievableTypes.has(object.objectType))
      .map((object) => ({
        ...object,
        retrievalText: workspaceCompletionText(object),
        // Only the object's own words: a sentence never matches where it is filed.
        retrievalTokens: ownWordKeys(object, workspaceCompletionText(object)),
      })).filter((object) => object.retrievalText
        && (object.objectType !== 'VARIABLE' || /[A-Za-z]/.test(object.retrievalText)));
    this.workspaceRetrievalCache.set(target, objects);
    return objects;
  },

  /**
   * Which retrievable objects each word appears in, and what scoring reads of
   * each object besides its words, kept with the list. Every object is scored
   * for a sentence, so this is what keeps a keystroke from reading them all.
   */
  retrievalIndexOf(objects) {
    let index = this.retrievalIndexes.get(objects);
    if (index) return index;
    const places = new Map();
    const features = objects.map((object, position) => {
      for (const token of object.retrievalTokens) {
        if (!places.has(token)) places.set(token, []);
        places.get(token).push(position);
      }
      return {
        resultType: ['VARIABLE', 'RESULT', 'VALUE', 'DATASET_ROW', 'DATASET_VALUE', 'DATASET', 'TABLE'].includes(object.objectType),
        methodType: ['METHOD', 'MODEL', 'PARAMETER', 'PROTOCOL', 'ANALYSIS_RUN'].includes(object.objectType),
        identifier: /^(?:sample|subject|participant|patient)?[_ -]?id$|^(?:group|cohort)$/i.test(object.metadata.variable ?? object.label),
        priority: dependencyFilePriority({ path: object.path }),
      };
    });
    index = { places, features };
    this.retrievalIndexes.set(objects, index);
    return index;
  },

  /**
   * Sources an `exclude from autocomplete` rule tells the prediction surface to
   * skip. Search is deliberately unaffected: the rule suppresses suggestions,
   * not the index, so an explicitly searched source is still reachable.
   */
  autocompleteFilter(projectId) {
    const prefixes = this.suppressedPathPrefixes?.(projectId) ?? [];
    if (!prefixes.length) return () => true;
    return (object) => !prefixes.some((prefix) => object.path === prefix || object.path.startsWith(`${prefix}/`));
  },

  workspaceSuggestions(projectId, input, cursor, options = {}) {
    const context = writingSourceContext(input.text, cursor, input.section);
    if (!context.projectIntent || context.literatureIntent || cursor !== String(input.text ?? '').length) return [];
    const query = `${context.sentence} ${input.context ?? ''} ${input.section ?? ''}`;
    if (context.sentence.trim().length < 6 || variableTokens(context.sentence).length < 2) return [];
    const resultIntent = /\b(?:data|result|finding|found|show|observe|detect|identify|measure|estimate|increase|decrease|reduction|difference|association|effect|mean|median|fold|significant)\w*\b/i.test(context.sentence)
      || /\b(?:results?|findings?|outcomes?)\b/i.test(input.section);
    const sampleSizeIntent = /\b(?:sample|cohort|participant|subject|patient|observation|row|record|included|enrolled|size|count|how many|n\s*=)\w*\b/i.test(context.sentence);
    const methodIntent = /\b(?:method|protocol|procedure|experiment|model|parameter|dose|assay|analysis|analy[sz]ed|using)\w*\b/i.test(context.sentence)
      || /\bmethods?\b/i.test(input.section);
    const permitted = this.autocompleteFilter(projectId);
    const retrievable = this.workspaceRetrievalObjects(projectId, options.snapshotId);
    const { places, features } = this.retrievalIndexOf(retrievable);
    // How many of the typed words each object has itself. An object with none
    // is not offered: the sentence's intent only orders what it does name.
    const typedWords = typedWordKeys(context.sentence);
    const lastWord = typedWords.at(-1);
    const shared = new Uint16Array(retrievable.length);
    for (const word of typedWords) for (const position of places.get(word) ?? []) shared[position] += 1;
    const endsOnMatch = new Set(places.get(lastWord) ?? []);
    const reasons = ['direct word match', resultIntent ? 'study-data context' : methodIntent ? 'methods context' : 'project context'];
    // Ranking keeps only objects that reach its minimum, so the rest are not sorted for it.
    const minimumScore = options.minimumScore ?? 0.54;
    const scored = [];
    retrievable.forEach((object, position) => {
      if (!shared[position]) return;
      if (input.documentPath && object.path === input.documentPath) return;
      if (!permitted(object)) return;
      const { resultType, methodType, identifier, priority } = features[position];
      const coverage = shared[position] / typedWords.length;
      // More of the typed words, and the last one typed, put an object higher.
      let score = 0.46 + coverage * 0.4 + (endsOnMatch.has(position) ? 0.06 : 0);
      if ((resultIntent && resultType) || (methodIntent && methodType)) score += 0.04;
      if (object.metadata.dictionary) score += 0.02;
      if (object.metadata.metric === 'row-count' && !sampleSizeIntent) score -= 0.32;
      if (identifier) score *= 0.38;
      score = Number(Math.min(0.98, score).toFixed(3));
      // The reasons go with the object into ranking, which then has no fallback score to work out.
      if (score >= 0.34 && score >= minimumScore) scored.push({ object: { ...object, score, reasons }, priority });
    });
    const objects = scored.sort((left, right) => right.object.score - left.object.score
        || Number(right.object.objectType === 'RESULT') - Number(left.object.objectType === 'RESULT')
        || Number(right.object.objectType === 'VARIABLE') - Number(left.object.objectType === 'VARIABLE')
        || right.priority - left.priority
        || left.object.retrievalText.localeCompare(right.object.retrievalText))
      .map(({ object }) => object);
    const seen = new Set();
    const suggestions = [];
    for (const object of this.ranking.rank(projectId, objects, {
      query, documentPath: input.documentPath, relatedPaths: this.relatedSourcePaths(projectId, input),
      minimumScore, limit: objects.length,
      diversify: false,
    })) {
      const fingerprint = object.retrievalText.toLowerCase().replace(/\W+/g, ' ').trim();
      if (!fingerprint || seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      const candidate = this.enrichObject(projectId, object);
      suggestions.push({
        id: `${object.id}:workspace:${suggestions.length}`,
        replacementText: object.retrievalText,
        category: workspaceSuggestionCategory(object),
        ...contextualCompletionRange(input.text, cursor, object.retrievalText),
        confidence: object.score,
        dependencyCandidate: candidate,
        generated: false,
      });
    }
    return this.rankCompletions(projectId, suggestions, input, { query, limit: options.limit ?? 8 });
  },
};
