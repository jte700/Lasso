// What the workspace suggests while the writer types: each active folder's
// prediction, merged into one ranked list (workspace-ranking.js), with the
// words each suggestion matched and the value change it carries. Installed on
// WorkspaceService by workspace.js.

import { setImmediate as yieldTurn } from 'node:timers/promises';
import { HttpError } from './history/errors.js';
import { currentClauseStart, LINKED_VALUES_SHOWN, namesFocusedFile, SUGGESTIONS_SHOWN, writtenBeforeCaret } from './dependencies/service.js';
import { dictatedNameEnds, hasSuggestions, namesInFull, softenDictatedPauses } from './dependencies/dictation.js';
import { matchedSourceWords, typedSentence } from './dependencies/direct-match.js';
import { focusedDependency, tag, distinctRanked } from './workspace-ranking.js';

export const workspacePredictionMethods = {
  async predict(input = {}) {
    let prediction = await this.predictText(input);
    if (!hasSuggestions(prediction)) prediction = await this.pastEmptySource(input, prediction);
    if (input.dictated !== true || hasSuggestions(prediction)) return prediction;
    const named = await this.predictNamed(input);
    if (named) return named;
    // Dictation's pauses put sentence marks among the words being said ("The
    // other revenue. Was"); read across them, at the same offsets.
    const softened = softenDictatedPauses(input.text, Number.isInteger(input.cursor) ? input.cursor : undefined);
    if (!softened) return prediction;
    const across = { ...input, text: softened };
    const read = await this.predictText(across);
    return hasSuggestions(read) ? read : (await this.predictNamed(across)) ?? prediction;
  },

  /**
   * An accepted source describes the rest of its sentence, so suggestions
   * keep to it. One with nothing to offer for the words after it, such as a
   * heading row with no values ("OPERATING EXPENSES"), no longer holds them
   * once they name something else ("additionally, the other expen"): the
   * name gets its suggestions, as after "and". A focus chosen with fn+Right
   * is kept, and so is a source whose values were all written already.
   */
  async pastEmptySource(input, prediction) {
    if (input.focusSource || !prediction.sourceContext?.source) return prediction;
    const cursor = Number.isInteger(input.cursor) ? input.cursor : String(input.text ?? '').length;
    const ends = (Array.isArray(input.pendingDependencies) ? input.pendingDependencies : [])
      .map((link) => link?.end).filter((end) => Number.isInteger(end) && end <= cursor);
    if (!ends.length) return prediction;
    const boundary = Math.max(...ends);
    const released = await this.predictText({ ...input, sourceScopeBoundary: boundary });
    const namesSomething = (released.claims ?? []).some((claim) => claim.start >= boundary
      && claim.candidates?.length && !['QUANTITATIVE', 'SAMPLE_SIZE'].includes(claim.type));
    return namesSomething ? released : prediction;
  },

  /**
   * Dictation writes a name in full and goes straight on ("Other revenue
   * was"), with no moment to accept it with Tab. A source named in full among
   * the words just said is read as if it had been accepted there. Null when
   * none was, or reading it so offers nothing.
   */
  async predictNamed(input) {
    const named = await this.dictatedName(input);
    if (!named) return null;
    const pending = Array.isArray(input.pendingDependencies) ? input.pendingDependencies : [];
    const linked = await this.predictText({ ...input, pendingDependencies: [...pending, named] });
    return hasSuggestions(linked) ? linked : null;
  },

  /** The link a dictated name would have had, had Tab accepted it; null when none was said in full. */
  async dictatedName(input) {
    if (input.focusSource) return null;
    const text = String(input.text ?? '');
    const cursor = Number.isInteger(input.cursor) ? input.cursor : text.length;
    const pending = Array.isArray(input.pendingDependencies) ? input.pendingDependencies : [];
    // Never a name already accepted, nor one in an earlier clause.
    const linkedEnd = Math.max(0, ...pending.map((link) => (Number.isInteger(link?.end) ? link.end : 0)));
    const from = Math.max(currentClauseStart(text, cursor), linkedEnd);
    for (const end of dictatedNameEnds(text, from, cursor).slice(0, 3)) {
      const said = text.slice(0, end);
      const prediction = await this.predictText({ ...input, text: said, cursor: end });
      for (const claim of prediction.claims ?? []) {
        if (claim.end !== end || claim.start < from) continue;
        const source = (claim.candidates ?? []).find((candidate) => candidate.id && candidate.snapshotId
          && candidate.projectId && namesInFull(said.slice(claim.start, claim.end), candidate.label));
        if (source) return { projectId: source.projectId, blockIndex: 0, start: claim.start, end: claim.end,
          sourceObjectId: source.id, sourceSnapshotId: source.snapshotId };
      }
    }
    return null;
  },

  async predictText(input = {}) {
    const revision = this.revision();
    const projects = this.activeProjects();
    const projectsById = new Map(projects.map((p) => [p.id, p]));
    const owners = new Map();
    const cursor = Number.isInteger(input.cursor) ? input.cursor : String(input.text ?? '').length;
    // A focus chosen with fn+Right stands in for the accepted sources while it lasts.
    const focus = focusedDependency(input.focusSource, input.text, cursor);
    const pending = focus ? [focus] : (Array.isArray(input.pendingDependencies) ? input.pendingDependencies.slice(0, 50) : [])
      .filter((link) => link && typeof link.sourceObjectId === 'string');
    for (const link of pending) {
      const owner = this.db.prepare('SELECT project_id FROM scientific_objects WHERE id = ?').get(link.sourceObjectId);
      if (owner) owners.set(link.sourceObjectId, owner.project_id);
    }
    // Resolve the newest eligible accepted source across all roots before
    // narrowing input per root. Otherwise each root treats its own older link
    // as current and one paragraph receives several conflicting source scopes.
    const documentProject = projectsById.get(input.documentProjectId);
    const contextProject = documentProject ?? projects[0];
    const availablePending = pending.filter((link) => projectsById.has(owners.get(link.sourceObjectId)));
    let linkedContext = contextProject ? this.dependencies.linkedDependencyContext(contextProject.id, {
      ...input, documentPath: documentProject ? input.documentPath : null,
      pendingDependencies: availablePending,
    }, cursor) : null;
    if (linkedContext && !projectsById.has(this.dependencies.sourceProjectId(linkedContext.source))) linkedContext = null;
    // A value is as deep as a source goes. Once the newest accepted source is
    // one ("The Bracket is 100 mm"), every directory answers the words after it.
    const settledAt = this.dependencies.settledValueEnd(input, linkedContext);
    if (settledAt >= 0) linkedContext = null;
    // A subject named after a joining word ends the accepted source's scope
    // whichever directory holds it ("Revenue was 485000 and the brack"). The
    // source's own directory checks this itself, so only the others are asked.
    const linkedOwner = linkedContext && this.dependencies.sourceProjectId(linkedContext.source);
    const namedElsewhere = linkedContext && projects.some((project) => project.id !== linkedOwner
      && this.dependencies.namesSubjectAfterJoiner(project.id, {
        ...input, documentPath: input.documentProjectId === project.id ? input.documentPath : null,
      }, cursor, linkedContext));
    // Every link ends at or before the newest, so one boundary releases them all.
    const predictionInput = namedElsewhere ? { ...input, sourceScopeBoundary: linkedContext.anchor.end }
      : settledAt >= 0 ? { ...input, sourceScopeBoundary: settledAt, settledValueEnd: settledAt } : input;
    if (namedElsewhere) linkedContext = null;
    const currentPending = linkedContext
      ? availablePending.filter((link) => link.sourceObjectId === linkedContext.source.id) : availablePending;
    const predictions = [];
    for (const project of projects) {
      await yieldTurn();
      if (this.closed || revision !== this.revision()) throw new HttpError(409, 'Work directories changed. Request fresh suggestions.');
      const ownDocument = input.documentProjectId === project.id;
      // Every accepted link still tells which values were already written.
      const scopedInput = { ...predictionInput, documentPath: ownDocument ? input.documentPath : null,
        pendingDependencies: ownDocument ? currentPending : currentPending.filter((s) => owners.get(s.sourceObjectId) === project.id),
        acceptedDependencies: availablePending.filter((link) => !link.focused) };
      predictions.push({ project, prediction: this.dependencies.predict(project.id, scopedInput) });
    }
    // An explicitly linked source narrows suggestions to that source's owner.
    const availablePredictions = predictions.filter(({ prediction }) => !prediction.sourceContext?.source
      || projectsById.has(this.dependencies.sourceProjectId(prediction.sourceContext.source)));
    const scoped = availablePredictions.filter(({ prediction }) => prediction.sourceContext?.source
      && (!linkedContext || prediction.sourceContext.source.id === linkedContext.source.id));
    // A file spelled as written ("General-Ledger.cs") is the source being
    // chosen, even after a source linked from another directory. Other
    // directories' guesses about the same words do not outrank it. The file a
    // focus chosen with fn+Right sits in is that focus, not a new choice.
    const naming = availablePredictions.filter(({ prediction }) => prediction.claims?.some((claim) => claim.asWritten
      && claim.candidates?.some((candidate) => candidate.fileReference)
      && (!linkedContext || (claim.start >= linkedContext.anchor.end && !namesFocusedFile(claim, linkedContext)))));
    const pool = naming.length ? naming : scoped.length ? scoped : availablePredictions;
    const limit = pool.some(({ prediction }) => prediction.listsEveryValue) ? LINKED_VALUES_SHOWN : SUGGESTIONS_SHOWN;
    const slots = [];
    for (const { project, prediction } of pool) {
      for (const group of ['sourceCompletions', 'workspaceCompletions']) {
        for (const value of prediction[group] ?? []) slots.push({ ...tag(value, project, projectsById), group,
          ranking: value.dependencyCandidate?.ranking ?? value.ranking,
          score: value.dependencyCandidate?.score ?? value.score ?? value.confidence });
      }
      for (const claim of prediction.claims ?? []) {
        for (const value of claim.candidates ?? []) slots.push({ ...tag(value, project, projectsById), group: 'claim', claim });
      }
      if (prediction.completion) {
        const completion = tag(prediction.completion, project, projectsById);
        slots.push({ ...completion, ranking: completion.dependencyCandidate?.ranking,
          score: completion.dependencyCandidate?.score ?? completion.score, group: 'completion' });
      }
    }
    // Directories can read different words as the subject: in "Revenue was
    // 485000. The brack" one offers the earlier value and another the part
    // being named. A claim in the clause being written wins over earlier ones.
    const clauseStart = currentClauseStart(input.text, cursor);
    const writingClaim = slots.some((slot) => slot.group === 'claim' && slot.claim.end > clauseStart);
    const inClause = writingClaim
      ? slots.filter((slot) => slot.group !== 'claim' || slot.claim.end > clauseStart) : slots;
    // A value written before the words at the caret ("rises from 6% to") is
    // not being typed. When a directory continues the sentence, other
    // directories' sources for that value give up their places to it.
    const continuing = slots.some((slot) => slot.group === 'completion')
      ? inClause.filter((slot) => slot.group !== 'claim' || !writtenBeforeCaret(slot.claim, input.text, cursor)) : inClause;
    // Directories may match different suffixes of the same phrase ("net inc"
    // and "inc", "bracket length" and "length"). The longer match is the one
    // the writer is typing, so the shorter gives up its slots before ranking;
    // otherwise its higher scores could crowd the longer match out entirely.
    const variables = continuing.filter((slot) => slot.group === 'claim' && slot.claim.type === 'STUDY_VARIABLE')
      .map((slot) => slot.claim);
    const nested = (claim) => claim.type === 'STUDY_VARIABLE' && variables.some((other) => other !== claim
      && other.start <= claim.start && other.end >= claim.end && other.end - other.start > claim.end - claim.start);
    const current = continuing.filter((slot) => slot.group !== 'claim' || !nested(slot.claim));
    // Each keeps its place in the one ranked order, which the groups below split
    // up, and the typed words its source has, which the card's preview marks.
    const sentence = typedSentence(input.text, cursor);
    // A video's moment marks the quoted words only, not every word of the sentence around them.
    // A file named by its name is matched as a whole, so its preview marks no words in it.
    const namesWholeFile = (item) => Boolean(item.fileReference ?? item.dependencyCandidate?.fileReference);
    const keepOrder = pool.length > 0 && pool.every(({ prediction }) => prediction.listsInOrder);
    // A value that changed recently says what it was, in the suggestion's own field.
    const withChange = (item) => {
      const object = item.dependencyCandidate ?? item;
      if (item.change || !object?.objectType) return item;
      const change = this.dependencies.suggestionChange(object.projectId ?? item.projectId, object.snapshotId, object);
      return change ? { ...item, change } : item;
    };
    const selected = distinctRanked(current, limit, { keepOrder }).map(withChange).map((item, rankOrder) => ({ ...item, rankOrder,
      matchedWords: namesWholeFile(item) ? [] : matchedSourceWords(item.quotedPhrase ?? sentence, [item.sourceSentence, item.replacementText, item.dependencyCandidate?.valueText,
        item.dependencyCandidate?.label, item.dependencyCandidate?.metadata?.variable, item.valueText, item.label,
        item.metadata?.variable].filter((text) => typeof text === 'string').join(' ')) }));
    // fn+Right opens a suggestion that has values below it, such as a part's measurements.
    const narrowing = (candidate) => this.dependencies.narrowsTo(candidate.projectId, candidate)
      ? { ...candidate, narrowable: true } : candidate;
    const claims = new Map();
    for (const item of selected.filter((s) => s.group === 'claim')) {
      const key = `${item.claim.start}:${item.claim.end}:${item.claim.type}`;
      if (!claims.has(key)) claims.set(key, { ...item.claim, candidates: [] });
      const { group, claim, ...candidate } = item;
      claims.get(key).candidates.push(narrowing(candidate));
    }
    const strip = ({ group, claim, ...value }) => value.dependencyCandidate
      ? { ...value, dependencyCandidate: narrowing(value.dependencyCandidate) } : value;
    const context = pool.find(({ prediction }) => prediction.sourceContext?.source) ?? pool[0];
    return { deterministic: true, generatedText: false, workspaceRevision: revision,
      sourceCompletions: selected.filter((s) => s.group === 'sourceCompletions').map(strip),
      workspaceCompletions: selected.filter((s) => s.group === 'workspaceCompletions').map(strip),
      claims: [...claims.values()], completion: selected.find((s) => s.group === 'completion')
        ? strip(selected.find((s) => s.group === 'completion')) : null,
      ...(context?.prediction.sourceContext ? { sourceContext: { ...context.prediction.sourceContext,
        ...(context.prediction.sourceContext.source ? { source: tag(context.prediction.sourceContext.source, context.project, projectsById) } : {}) } } : {}),
      ...(context?.prediction.workspaceHeading ? { workspaceHeading: context.prediction.workspaceHeading } : {}),
      ...(context?.prediction.notice && !selected.length ? { notice: context.prediction.notice } : {}) };
  },
};
