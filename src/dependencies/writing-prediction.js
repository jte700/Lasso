// The entry points for suggestions while typing: what the text so far offers.

import { indexSentenceCorpus } from './completion.js';
import { runSync } from '../history/work.js';
import { typedWordKeys } from './direct-match.js';
import { detectClaimSpans } from './claim-detection.js';
import { LINKED_VALUES_SHOWN, SUGGESTIONS_SHOWN, WHOLE_FILE_TYPES } from './constants.js';
import { referenceCompletionText } from './reference-match.js';
import { replacingFocusWords, withSameNamed } from './workspace-completion.js';
import { currentClauseStart, namesFocusedFile, writingSourceContext, writtenBeforeCaret } from './writing-context.js';

export const writingPredictionMethods = {
  warmPredictionCaches(projectId, snapshotId = null) {
    return runSync(this.warmPredictionCacheSteps(projectId, snapshotId));
  },

  /** Builds a snapshot's suggestion caches, reading its PDFs' text first, one file per step. */
  *warmPredictionCacheSteps(projectId, snapshotId = null) {
    const project = this.timeline.getProject(projectId);
    const target = snapshotId ?? project.currentSnapshotId;
    yield* this.pdfTextSteps(projectId, target);
    this.retrievalIndexOf(this.workspaceRetrievalObjects(projectId, target));
    yield;
    // Typing a file's name asks for these on the first keystroke.
    this.objectsAt(projectId, target, WHOLE_FILE_TYPES);
    this.variableIndexOf(this.studyVariables(projectId, target));
    yield;
    // Ranking checks every suggestion is still at the snapshot it came from.
    this.ranking.indexedSnapshot(projectId, target);
    yield;
    indexSentenceCorpus(this.completionCorpus(projectId, target));
  },

  predict(projectId, input) {
    const prediction = this.predictionCandidates(projectId, input);
    const explicitSearch = input.surface === 'search';
    const limit = prediction.listsEveryValue ? LINKED_VALUES_SHOWN : SUGGESTIONS_SHOWN;
    let remaining = limit;
    const take = (items) => {
      const selected = (items ?? []).slice(0, remaining);
      remaining -= selected.length;
      return selected;
    };
    const scoped = Boolean(prediction.sourceContext?.source);
    prediction.sourceCompletions = take(this.rankCompletions(projectId,
      prediction.sourceCompletions, input, { limit, diversify: !scoped }));
    // Ranking still fills in each value's reasons; a list that set its own order keeps it.
    const listed = new Map((prediction.workspaceCompletions ?? []).map((item, index) => [item.id, index]));
    const rankedWorkspace = this.rankCompletions(projectId, prediction.workspaceCompletions, input, { limit, diversify: !scoped });
    prediction.workspaceCompletions = take(prediction.listsInOrder
      ? rankedWorkspace.toSorted((left, right) => listed.get(left.id) - listed.get(right.id)) : rankedWorkspace);
    prediction.claims = prediction.claims.map((claim) => {
      const eligible = claim.candidates.filter((candidate) => explicitSearch || candidate.matchTier === 0
        || (candidate.matchStrength ?? candidate.score) >= (claim.type === 'STUDY_VARIABLE' ? 0.68 : 0.4));
      const rankingProjectId = eligible.length ? this.sourceProjectId(eligible[0]) ?? projectId : projectId;
      return { ...claim, candidates: take(withSameNamed(this.ranking.rank(rankingProjectId, eligible, {
        query: claim.text, documentPath: rankingProjectId === projectId ? input.documentPath : null,
        relatedPaths: this.relatedSourcePaths(rankingProjectId, input),
        limit: remaining, diversify: !scoped,
      }))) };
    });
    if (prediction.completion && remaining <= 0) prediction.completion = null;
    return prediction;
  },

  /** The whole file the words at the cursor name, once other readings of the
   * same words have had their say. */
  namedFile(projectId, input, cursor, text, settledAt = -1) {
    const named = this.fileReference(projectId, input, cursor, settledAt);
    if (!named) return null;
    // A citation being written ("from the document placental trans") is the
    // literature path's: it matches documents and papers by title and inserts
    // citation text. Datasets and drawings remain named files.
    const citing = detectClaimSpans(text).some((claim) => claim.type === 'LITERATURE'
      && claim.value != null && claim.end > named.start);
    let candidates = citing ? named.candidates.filter((candidate) => !['DOCUMENT', 'PAPER'].includes(candidate.objectType))
      : named.candidates;
    // Plain words may be a variable's name ("systolic blood pressure"); one
    // matched on as many words wins over any file but a drawing.
    if (!named.asWritten && candidates.some((candidate) => candidate.objectType !== 'DRAWING')) {
      const variable = this.progressiveStudyVariable(projectId, input, cursor, settledAt);
      if (variable?.fragment && variable.candidates.length
        && variable.fragment.end - variable.fragment.start >= named.end - named.start) {
        candidates = candidates.filter((candidate) => candidate.objectType === 'DRAWING');
      }
    }
    return candidates.length ? { ...named, candidates } : null;
  },

  predictionCandidates(projectId, input) {
    const text = String(input.text ?? '');
    const cursor = Number.isInteger(input.cursor) ? input.cursor : text.length;
    // A phrase just closed in quotes is something said: a video that says it
    // word for word is the source. Without one, the words are read as usual.
    const spoken = this.quotedVideoMoments(projectId, input, cursor);
    if (spoken) {
      return { claims: [spoken], completion: null, sourceCompletions: [], workspaceCompletions: [],
        sourceContext: null, deterministic: true, generatedText: false };
    }
    // An explicit model/file reference starts a new source even after another
    // source was linked. It must not depend on scientific-writing intent.
    // The name just accepted ("The Bracket ") is not a new reference to it,
    // nor is the name of the file a focus chosen with fn+Right sits in.
    const newestDependency = this.linkedDependencyContext(projectId, input, cursor);
    const codeLines = this.linesFromCode(projectId, input, cursor, newestDependency);
    if (codeLines) {
      return {
        claims: [], completion: null, sourceCompletions: [],
        workspaceCompletions: codeLines.completions,
        workspaceHeading: codeLines.heading,
        notice: codeLines.notice,
        sourceContext: {
          dependencyId: codeLines.dependencyId, source: codeLines.source, variable: null,
          kind: 'PROJECT_OBJECT', exclusive: true,
        },
        deterministic: true, generatedText: false,
      };
    }
    const linkedRecord = this.fieldsFromLinkedRecord(projectId, input, cursor, newestDependency);
    if (linkedRecord) {
      return {
        claims: [], completion: null, sourceCompletions: [],
        workspaceCompletions: linkedRecord.completions,
        workspaceHeading: linkedRecord.heading,
        notice: null,
        sourceContext: {
          dependencyId: linkedRecord.dependencyId,
          source: linkedRecord.source,
          variable: linkedRecord.variable,
          kind: 'PROJECT_OBJECT',
          exclusive: true,
        },
        deterministic: true, generatedText: false,
      };
    }
    const settledAt = this.settledValueEnd(input, newestDependency);
    const linkedDependency = newestDependency?.anchor.end > settledAt ? newestDependency : null;
    const file = this.namedFile(projectId, input, cursor, text, settledAt);
    if (file && !(linkedDependency && file.end <= linkedDependency.anchor.end)
      && !namesFocusedFile(file, linkedDependency)) return {
      claims: [file], completion: null, sourceCompletions: [], workspaceCompletions: [],
      sourceContext: null, deterministic: true, generatedText: false,
    };
    const linkedPaper = this.findingsFromLinkedPaper(projectId, input, cursor, linkedDependency);
    if (linkedPaper) {
      return {
        claims: [], completion: null,
        sourceCompletions: linkedPaper.completions,
        workspaceCompletions: [],
        sourceContext: {
          dependencyId: linkedPaper.dependencyId,
          source: linkedPaper.source,
          exclusive: true,
        },
        deterministic: true, generatedText: false,
      };
    }
    const linkedProjectObject = this.projectLinkInScope(projectId, input, cursor, linkedDependency)
      ? this.valuesFromLinkedProjectObject(projectId, input, cursor, linkedDependency) : null;
    if (linkedProjectObject) {
      return {
        claims: [], completion: null, sourceCompletions: [],
        workspaceCompletions: replacingFocusWords(linkedProjectObject.completions, linkedDependency, text, cursor),
        workspaceHeading: linkedProjectObject.heading ?? `Values for ${linkedProjectObject.variable}`,
        notice: linkedProjectObject.notice,
        listsEveryValue: true,
        listsInOrder: linkedProjectObject.listsInOrder === true,
        sourceContext: {
          dependencyId: linkedProjectObject.dependencyId,
          source: linkedProjectObject.source,
          variable: linkedProjectObject.variable,
          kind: 'PROJECT_OBJECT',
          exclusive: true,
        },
        deterministic: true, generatedText: false,
      };
    }
    // A value just accepted already fills its claim ("The Bracket is 100 mm").
    const detected = detectClaimSpans(text).filter((claim) => claim.end > settledAt);
    // An amount or citation in an earlier sentence or clause says nothing about
    // the words being typed now ("Revenue was 485000. Gross pr", "... and gross pr").
    const clauseStart = currentClauseStart(text, cursor);
    const current = detected.filter((claim) => claim.end > clauseStart);
    const hasStudyValue = current.some((claim) => ['QUANTITATIVE', 'SAMPLE_SIZE'].includes(claim.type));
    const hasReferenceIntent = current.some((claim) => ['LITERATURE', 'TABLE_REFERENCE', 'FIGURE', 'METHOD', 'DATASET_REFERENCE']
      .includes(claim.type));
    const studyPrediction = hasStudyValue || hasReferenceIntent
      ? null : this.progressiveStudyVariable(projectId, input, cursor, settledAt);
    if (studyPrediction) {
      const { fragment, candidates } = studyPrediction;
      const hasVariableChoices = Boolean(fragment && candidates.length);
      const resultLimit = input.surface === 'search' ? 12 : 8;
      // A project sentence that continues the very words typed is the closest
      // match there is, so it goes before sources that only share words.
      // Study prose alone ("We found that") names no source to continue from.
      const namesSource = typedWordKeys(studyPrediction.context.sentence).length > 0;
      const exactProjectCompletion = hasVariableChoices || !namesSource ? null : this.sentenceSuggestion(projectId, input);
      const completion = exactProjectCompletion?.dependencyCandidate
        && !['PAPER', 'REFERENCE'].includes(exactProjectCompletion.dependencyCandidate.objectType)
        ? exactProjectCompletion : null;
      const workspaceCompletions = hasVariableChoices || completion
        ? [] : this.workspaceSuggestions(projectId, input, cursor, { limit: resultLimit });
      return {
        claims: fragment && candidates.length ? [{
          ...fragment,
          type: 'STUDY_VARIABLE',
          value: fragment.text,
          partial: true,
          studyResult: true,
          candidates,
        }] : [],
        completion,
        sourceCompletions: [],
        workspaceCompletions,
        sourceContext: { kind: 'PROJECT_DATA', exclusive: true },
        deterministic: true,
        generatedText: false,
      };
    }
    const claims = detected
      .sort((a, b) => {
        const aDistance = a.start <= cursor && cursor <= a.end ? 0 : Math.min(Math.abs(cursor - a.start), Math.abs(cursor - a.end));
        const bDistance = b.start <= cursor && cursor <= b.end ? 0 : Math.min(Math.abs(cursor - b.start), Math.abs(cursor - b.end));
        return aDistance - bDistance;
      })
      .map((claim) => {
        const scopedToLinkedPaper = linkedDependency
          && ['PAPER', 'REFERENCE'].includes(linkedDependency.source.objectType)
          && ['TABLE_REFERENCE', 'FIGURE'].includes(claim.type)
          && claim.start >= linkedDependency.anchor.end;
        const sourceProjectId = scopedToLinkedPaper ? this.sourceProjectId(linkedDependency.source) ?? projectId : projectId;
        let candidates = this.candidatesForClaim(sourceProjectId, claim, {
          context: input.context ?? text,
          section: input.section,
          documentPath: sourceProjectId === projectId ? input.documentPath : null,
          relatedPaths: this.relatedSourcePaths(sourceProjectId, input),
          minimumMatchStrength: input.surface === 'search' ? 0 : 0.4,
          limit: input.surface === 'search' ? 12 : 8,
          sourcePath: scopedToLinkedPaper ? linkedDependency.source.path : null,
          snapshotId: scopedToLinkedPaper ? linkedDependency.source.snapshotId : null,
        });
        if (claim.type === 'LITERATURE' && claim.partial) {
          candidates = candidates.map((candidate) => ({
            ...candidate,
            citationText: referenceCompletionText(candidate, claim.value, candidate.referenceRole ?? claim.referenceMode),
          }));
        } else if (claim.partial && ['TABLE_REFERENCE', 'FIGURE'].includes(claim.type)) {
          candidates = candidates.map((candidate) => ({
            ...candidate,
            componentText: candidate.metadata.componentLabel ?? candidate.label,
          }));
        }
        return { ...claim, candidates, scopedToLinkedPaper };
      });
    // Only a value at the caret holds back the rest of the sentence. Once it
    // goes on, the sources of a value written before it are not suggestions.
    const atCaret = claims.filter((claim) => !writtenBeforeCaret(claim, text, cursor));
    const predictedCompletion = atCaret.some((claim) => claim.candidates.length)
      ? null : this.sentenceSuggestion(projectId, input);
    const completion = predictedCompletion?.dependencyCandidate ? predictedCompletion : null;
    // A plain sentence about the work ("The connection pool was raised") names
    // its sources by their words, with no "we" or "our" to say it is a report.
    // Words in a sentence with an accepted source or its value belong to that source.
    const sentenceStart = writingSourceContext(text, cursor, input.section).sentenceStart;
    const acceptedHere = [...(input.pendingDependencies ?? []), ...(input.acceptedDependencies ?? [])]
      .some((link) => Number.isInteger(link?.end) && link.end > sentenceStart);
    const workspaceCompletions = completion || atCaret.some((claim) => claim.candidates.length) || newestDependency || acceptedHere
      ? [] : this.workspaceSuggestions(projectId, input, cursor, { limit: input.surface === 'search' ? 12 : 8 });
    return {
      claims: completion ? atCaret : claims, completion, sourceCompletions: [], workspaceCompletions,
      sourceContext: claims.some((claim) => claim.scopedToLinkedPaper)
        ? {
          dependencyId: linkedDependency.id,
          source: linkedDependency.source,
          kind: 'LINKED_SOURCE',
          exclusive: true,
        } : null,
      deterministic: true, generatedText: false,
    };
  },
};
