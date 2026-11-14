// Suggestions for the words being typed, drawn from every object in the workspace.

import { ownWordKeys, typedWordKeys, unfinishedWord } from './direct-match.js';
import { sharedWordsEarnCard } from './show-gate.js';
import { variableTokens } from './text-similarity.js';
import { contextualCompletionRange, workspaceSuggestionCategory } from './workspace-completion.js';
import { RETRIEVABLE_TYPES } from './constants.js';
import { retrievalFeatures, retrievalObject, retrievalScore } from './workspace-retrieval.js';
import { currentClauseStart, writingSourceContext } from './writing-context.js';

export const workspaceSuggestionsMethods = {
  workspaceRetrievalObjects(projectId, snapshotId = null) {
    const project = this.timeline.getProject(projectId);
    const target = snapshotId ?? project.currentSnapshotId;
    if (this.workspaceRetrievalCache.has(target)) return this.workspaceRetrievalCache.get(target);
    const objects = this.objectsAt(projectId, target, RETRIEVABLE_TYPES).map(retrievalObject).filter(Boolean);
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
      return retrievalFeatures(object);
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
    if (context.literatureIntent || cursor !== String(input.text ?? '').length) return [];
    const query = `${context.sentence} ${input.context ?? ''} ${input.section ?? ''}`;
    if (context.sentence.trim().length < 6 || variableTokens(context.sentence).length < 2) return [];
    const resultIntent = /\b(?:data|result|finding|found|show|observe|detect|identify|measure|estimate|increase|decrease|reduction|difference|association|effect|mean|median|fold|significant)\w*\b/i.test(context.sentence)
      || /\b(?:results?|findings?|outcomes?)\b/i.test(input.section);
    const sampleSizeIntent = /\b(?:sample|cohort|participant|subject|patient|observation|row|record|included|enrolled|size|count|how many|n\s*=)\w*\b/i.test(context.sentence);
    const methodIntent = /\b(?:method|protocol|procedure|experiment|model|parameter|dose|assay|analysis|analy[sz]ed|using)\w*\b/i.test(context.sentence)
      || /\bmethods?\b/i.test(input.section);
    const permitted = this.autocompleteFilter(projectId);
    // How many of the typed words each object has itself. An object with none
    // is not offered: the sentence's intent only orders what it does name.
    const typedWords = typedWordKeys(context.sentence);
    const lastWord = typedWords.at(-1);
    // Earlier words still order what is offered, but one of the clause being
    // written must be in it: after "no issues and everything is how it is
    // now" the writer has moved past "issues".
    const clauseWords = typedWordKeys(input.text.slice(currentClauseStart(input.text, cursor), cursor));
    const beingTyped = unfinishedWord(context.sentence);
    const reasons = ['direct word match', resultIntent ? 'study-data context' : methodIntent ? 'methods context' : 'project context'];
    // Ranking keeps only objects that reach its minimum, so the rest are not sorted for it.
    const minimumScore = options.minimumScore ?? 0.54;
    // An object that shares `sharedCount` typed words, scored, or null when it is not offered.
    const scoreOf = (object, sharedCount, endsOnMatch, { resultType, methodType, identifier, priority }) => {
      // One everyday word in common ("week") is not the passage being written about.
      const sharedWords = typedWords.filter((word) => object.retrievalTokens.includes(word));
      // The word still being typed is read as the source word it begins ("requ" as "requisitions").
      const begun = beingTyped && object.retrievalTokens.find((token) => token.startsWith(beingTyped) && !sharedWords.includes(token));
      if (!sharedWordsEarnCard(begun ? [...sharedWords, begun] : sharedWords, ownWordKeys({ label: object.label }))) return null;
      if (input.documentPath && object.path === input.documentPath) return null;
      if (!permitted(object)) return null;
      const score = retrievalScore({
        coverage: sharedCount / typedWords.length, endsOnMatch,
        intended: (resultIntent && resultType) || (methodIntent && methodType),
        dictionary: Boolean(object.metadata.dictionary),
        rowCount: object.metadata.metric === 'row-count' && !sampleSizeIntent, identifier,
      });
      // The reasons go with the object into ranking, which then has no fallback score to work out.
      return score >= 0.34 && score >= minimumScore ? { object: { ...object, score, reasons }, priority } : null;
    };
    // A folder too large to hold is searched in its index; only what it finds is read.
    const index = this.searchIndexFor(projectId, options.snapshotId);
    const scored = index ? this.indexedWorkspaceMatches(index, { typedWords, clauseWords, lastWord,
      resultIntent, methodIntent, sampleSizeIntent, minimumScore }, scoreOf) : [];
    if (!index) {
      const retrievable = this.workspaceRetrievalObjects(projectId, options.snapshotId);
      const { places, features } = this.retrievalIndexOf(retrievable);
      const shared = new Uint16Array(retrievable.length);
      for (const word of typedWords) for (const position of places.get(word) ?? []) shared[position] += 1;
      const atCaret = new Set(clauseWords.flatMap((word) => places.get(word) ?? []));
      const endsOnMatch = new Set(places.get(lastWord) ?? []);
      retrievable.forEach((object, position) => {
        if (!shared[position] || !atCaret.has(position)) return;
        const entry = scoreOf(object, shared[position], endsOnMatch.has(position), features[position]);
        if (entry) scored.push(entry);
      });
    }
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
