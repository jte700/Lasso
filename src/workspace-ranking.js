// How suggestions from several folders are merged into one list, and how each
// is told which folder it came from. Shared by the workspace's prediction and
// its terminal answers.

import { currentClauseStart } from './dependencies/service.js';
import { offeredShareScopes } from './sharing/object-share.js';

// A source the writer focused with fn+Right need not be in the text. Chosen
// on the words being typed ("brac" for Bracket), it rests on them and its
// values replace them. Otherwise, or once those words are in an earlier
// clause, it is anchored where the clause being written starts. Either way
// the sentence never ends its scope; fn+Left or another accepted source does.
export function focusedDependency(focusSource, text, cursor) {
  if (!focusSource || typeof focusSource !== 'object') return null;
  const { projectId, sourceObjectId, sourceSnapshotId, start, end } = focusSource;
  if (![projectId, sourceObjectId, sourceSnapshotId].every((value) => typeof value === 'string' && value)) return null;
  const focus = { projectId, blockIndex: 0, sourceObjectId, sourceSnapshotId, focused: true };
  const clauseStart = currentClauseStart(text, cursor);
  const typed = Number.isInteger(start) && Number.isInteger(end) && clauseStart <= start && start < end && end <= cursor;
  return typed ? { ...focus, start, end, replacesText: true } : { ...focus, start: clauseStart, end: clauseStart };
}

// Relevance is calculated by the existing per-project ranker. Merge those
// scores without treating identical relative paths in different roots as one.
// Exact ties keep the order each project produced (the sort is stable), such
// as a row's columns in sheet order. Object ids are random, so ordering ties
// by id made suggestions swap places between keystrokes.
export function compare(a, b) {
  const left = a.ranking ?? {};
  const right = b.ranking ?? {};
  const browsing = (left.tier ?? a.matchTier) === 3 && (right.tier ?? b.matchTier) === 3;
  return (left.tier ?? a.matchTier ?? 1) - (right.tier ?? b.matchTier ?? 1)
    || (right.directSpecificity ?? 0) - (left.directSpecificity ?? 0)
    || (browsing ? (right.recentScore ?? 0) - (left.recentScore ?? 0)
      || (right.frequencyScore ?? 0) - (left.frequencyScore ?? 0) : 0)
    || (right.relevanceBand ?? 0) - (left.relevanceBand ?? 0)
    || (browsing ? 0 : (right.contextScore ?? 0) - (left.contextScore ?? 0))
    || Number(right.relationship ?? false) - Number(left.relationship ?? false)
    || ((right.relevanceScore ?? b.score ?? 0) + (right.usageBoost ?? 0))
      - ((left.relevanceScore ?? a.score ?? 0) + (left.usageBoost ?? 0))
    || String(a.projectId).localeCompare(String(b.projectId));
}

export function tag(value, project, projects = null) {
  if (!value) return value;
  const ownerId = value.projectId ?? value.dependencyCandidate?.projectId ?? value.object?.projectId;
  project = projects?.get(ownerId) ?? project;
  return { ...value, projectId: project.id, projectName: project.name, rootPath: project.rootPath,
    // Whether a share link can be made for it; the Mac app hides Share Link when not.
    ...(typeof value.path === 'string' ? { shareable: offeredShareScopes(value.path, value.anchor).length > 0 } : {}),
    ...(value.object ? { object: tag(value.object, project, projects) } : {}),
    ...(value.dependencyCandidate ? { dependencyCandidate: tag(value.dependencyCandidate, project, projects) } : {}) };
}

export function distinctRanked(items, limit, { keepOrder = false } = {}) {
  const seen = new Set();
  // Full ties keep each directory's own ranked order, which already settles
  // them by source order (a row's columns left to right). Object ids are
  // random, so comparing them would shuffle equal suggestions between runs.
  const ordered = keepOrder ? items : items.map((item, order) => ({ item, order }))
    .sort((left, right) => compare(left.item, right.item) || left.order - right.order)
    .map(({ item }) => item);
  return ordered
    .filter((item) => {
      const key = `${item.projectId}:${item.id ?? item.objectId ?? item.dependencyCandidate?.id}:${item.insertText ?? item.text ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, limit);
}
