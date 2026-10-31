// What the writer has already linked in the text being written, and where
// a linked source's values may be offered.

import { fieldCue } from './record-fields.js';
import { lineMentionAtEnd } from './code-lines.js';
import { mapObjectRow } from './object-descriptors.js';
import { acceptedAsValue } from './value-match.js';
import { VALUE_HOLDERS } from './variable-match.js';
import { CLAUSE_JOINER, endsSentence, writingSourceContext } from './writing-context.js';

const isCodeLineReference = (object) => object?.anchor?.kind === 'line-range' && object.metadata?.lineReference === true;

export const linkedContextMethods = {
  linkedDependencyContext(projectId, input, cursor) {
    const sourceScopeBoundary = Number.isInteger(input.sourceScopeBoundary) ? input.sourceScopeBoundary : -1;
    // A caller editing a project document identifies itself by path and block.
    // A caller writing in another application has neither, and supplies its
    // recently linked sources directly instead.
    const blockIndex = Number.isInteger(input.blockIndex) ? input.blockIndex : 0;
    const hasPending = Array.isArray(input.pendingDependencies) && input.pendingDependencies.length > 0;
    if (!input.documentPath && !hasPending) return null;

    const persisted = this.savedBlockLinks(projectId, input)
      .filter((item) => item.anchor.end <= cursor && item.anchor.end > sourceScopeBoundary
        && !['BROKEN', 'NEEDS_REVIEW'].includes(item.status));
    const pending = (Array.isArray(input.pendingDependencies) ? input.pendingDependencies.slice(0, 50) : [])
      .filter((item) => (Number.isInteger(item.blockIndex) ? item.blockIndex : 0) === blockIndex
        && Number.isInteger(item.end)
        && item.end <= cursor && item.end > sourceScopeBoundary && item.sourceObjectId && item.sourceSnapshotId)
      .map((item) => {
        const row = this.sourceVersion(item.sourceObjectId, item.sourceSnapshotId);
        if (!row || (this.workspace && !this.workspace.isActive(row.project_id))) return null;
        const source = mapObjectRow(row);
        return {
          id: item.id ?? `pending:${item.sourceObjectId}`,
          anchor: {
            blockIndex: Number.isInteger(item.blockIndex) ? item.blockIndex : 0,
            start: item.start,
            end: item.end,
          },
          source,
          status: 'PENDING',
          focused: item.focused === true,
          // A focus chosen on typed words ("brac") is replaced by its values.
          replacesText: item.focused === true && item.replacesText === true,
        };
      }).filter(Boolean);
    const dependency = [...persisted, ...pending]
      .filter((item) => !this.workspace || this.workspace.isActive(this.sourceProjectId(item.source)))
      .sort((left, right) => right.anchor.end - left.anchor.end)[0] ?? null;
    if (!dependency || cursor - dependency.anchor.end > 420) return null;
    return dependency;
  },

  /** Links saved in the project document block being edited; none for other callers. */
  savedBlockLinks(projectId, input) {
    if (!input.documentPath || !Number.isInteger(input.blockIndex)) return [];
    const project = this.timeline.getProject(projectId);
    const file = this.timeline.snapshotFile(project.currentSnapshotId, input.documentPath);
    if (!file) return [];
    return this.currentDependencies(projectId, { projectFileId: file.projectFileId })
      .filter((item) => item.anchor.blockIndex === input.blockIndex);
  },

  /**
   * The values inserted with Tab in the sentence being written, by object id,
   * each with the text it was inserted as. A list such as "2026-08-18,
   * 2026-09-12, " goes on with the values not yet written. Every accepted
   * link counts, not only the newest that scopes the suggestions.
   */
  valuesWrittenInSentence(projectId, input, cursor) {
    const text = String(input.text ?? '');
    const { sentenceStart } = writingSourceContext(text, cursor);
    const accepted = Array.isArray(input.acceptedDependencies) ? input.acceptedDependencies : input.pendingDependencies;
    const spans = [
      ...(Array.isArray(accepted) ? accepted.slice(0, 50) : [])
        .map((item) => ({ id: item?.sourceObjectId, start: item?.start, end: item?.end })),
      ...this.savedBlockLinks(projectId, input)
        .map((item) => ({ id: item.source?.id, start: item.anchor.start, end: item.anchor.end })),
    ];
    const written = new Map();
    for (const { id, start, end } of spans) {
      if (typeof id !== 'string' || !Number.isInteger(start) || !Number.isInteger(end)
        || start < sentenceStart || end > cursor || start >= end) continue;
      if (!written.has(id)) written.set(id, new Set());
      written.get(id).add(text.slice(start, end).trim().toLowerCase());
    }
    return written;
  },

  /**
   * Where the newest accepted source was settled by its own value, or -1. A
   * value is as deep as a source goes: every directory answers the words
   * after it, and nothing is offered again for the text it fills.
   */
  settledValueEnd(input, dependency) {
    if (Number.isInteger(input.settledValueEnd)) return input.settledValueEnd;
    // A record's field just written ("on Tuesday, October 27") leads on to its
    // other fields when the next words ask for one ("at").
    if (dependency?.source.metadata?.componentType === 'RECORD_FIELD'
      && fieldCue(String(input.text ?? '').slice(dependency.anchor.end, input.cursor))) return -1;
    // Code lines just written lead on to more of their file ("and lines 50-52").
    const text = String(input.text ?? '');
    if (isCodeLineReference(dependency?.source)
      && lineMentionAtEnd(text, dependency.anchor.end, Number.isInteger(input.cursor) ? input.cursor : text.length)) return -1;
    // An explicit comma continues a table column's value list. Ordinary words
    // after a completed value still return to every directory.
    const tail = dependency && String(input.text ?? '').slice(dependency.anchor.end, input.cursor);
    if (dependency?.source.anchor?.kind === 'table-cell' && /^\s*,\s*$/.test(tail)) return -1;
    return dependency && acceptedAsValue(dependency, input.text) ? dependency.anchor.end : -1;
  },

  /**
   * An accepted data source describes the rest of its own sentence ("Revenue
   * was ..."). A new sentence, or another source named after a joining word
   * ("Revenue and gross pr"), is a new subject and gets its own suggestions.
   * Papers are exempt: "They found that ..." in a later sentence still cites them.
   */
  projectLinkInScope(projectId, input, cursor, dependency) {
    if (!dependency || ['PAPER', 'REFERENCE'].includes(dependency.source.objectType)) return true;
    const tail = String(input.text ?? '').slice(dependency.anchor.end, cursor);
    if (endsSentence(tail)) return false;
    return !this.namesSubjectAfterJoiner(projectId, input, cursor, dependency);
  },

  /**
   * Whether this directory names something after the last joining word that
   * follows an accepted data source: a variable or row ("and gross pr") or a
   * drawing or model ("and the brack"). Asked of every directory, since the
   * new subject need not live beside the accepted source.
   */
  namesSubjectAfterJoiner(projectId, input, cursor, dependency) {
    if (['PAPER', 'REFERENCE'].includes(dependency.source.objectType)) return false;
    const tail = String(input.text ?? '').slice(dependency.anchor.end, cursor);
    const joiner = [...tail.matchAll(CLAUSE_JOINER)].at(-1);
    if (!joiner) return false;
    const subjectStart = dependency.anchor.end + joiner.index + joiner[0].length;
    const fresh = this.progressiveStudyVariable(projectId, input, cursor);
    if (fresh?.fragment && fresh.candidates.length && fresh.fragment.start >= subjectStart) return true;
    const file = this.fileReference(projectId, input, cursor);
    return Boolean(file && file.start >= subjectStart);
  },

  /**
   * The record the newest link belongs to: the record itself when its title
   * was linked, or the record of a field just written, so "on Tuesday,
   * October 27 at" goes on to the same event's time.
   */
  linkedRecord(projectId, dependency) {
    const source = dependency?.source;
    if (!source) return null;
    if (source.metadata?.recordFields?.length) return dependency;
    if (source.metadata?.componentType !== 'RECORD_FIELD') return null;
    const record = this.objectsAt(this.sourceProjectId(source) ?? projectId, source.snapshotId, ['DOCUMENT'])
      .find((object) => object.path === source.path && object.metadata.recordFields?.length);
    return record ? { ...dependency, source: record } : null;
  },

  linkedPaperContext(projectId, input, cursor) {
    const dependency = this.linkedDependencyContext(projectId, input, cursor);
    return dependency && ['PAPER', 'REFERENCE'].includes(dependency.source.objectType) ? dependency : null;
  },

  /**
   * Whether fn+Right on this suggestion has something narrower to show: a
   * part's measurements, a named row's cells or a column's values. A value is
   * as narrow as a suggestion gets, so fn+Right stops there.
   */
  narrowsTo(projectId, object) {
    if (!VALUE_HOLDERS.has(object?.objectType) || !object.snapshotId) return false;
    const objects = this.workspaceRetrievalObjects(this.sourceProjectId(object) ?? projectId, object.snapshotId);
    if (!this.narrowingCache.has(objects)) this.narrowingCache.set(objects, new Map());
    const known = this.narrowingCache.get(objects);
    if (!known.has(object.id)) {
      const focus = { id: `narrowing:${object.id}`, anchor: { blockIndex: 0, start: 0, end: 0 }, source: object };
      const values = this.valuesFromLinkedProjectObject(projectId, { text: '' }, 0, focus);
      known.set(object.id, Boolean(values?.completions.some((value) => value.dependencyCandidate?.id !== object.id)));
    }
    return known.get(object.id);
  },
};
