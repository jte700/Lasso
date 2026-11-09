// Changing a link after it is made: revising it, updating the value it quotes,
// and retiring references.

import { json } from '../db.js';
import { normalizeActor } from '../history/service.js';
import { HttpError, VersionConflictError } from '../history/errors.js';
import { id } from './basics.js';
import { anchorForSpan, mapObjectRow } from './object-descriptors.js';

const STATUS_TYPES = new Set(['PREDICTED', 'LINKED', 'NEEDS_REVIEW', 'STALE', 'BROKEN']);

export const sourceUpdatesMethods = {
  revise(dependencyId, actorInput, input) {
    const currentDependency = this.getDependency(dependencyId);
    const project = this.timeline.getProject(this.db.prepare('SELECT project_id FROM claim_dependencies WHERE id = ?').get(dependencyId).project_id);
    if (input.expectedSnapshotId && input.expectedSnapshotId !== project.currentSnapshotId) {
      throw new VersionConflictError(input.expectedSnapshotId, project.currentSnapshotId);
    }
    let nextSource = currentDependency.source;
    if (input.sourceObjectId) {
      const row = this.sourceVersion(input.sourceObjectId, input.sourceSnapshotId, {
        destinationProjectId: project.id, newLink: input.sourceObjectId !== currentDependency.source.id,
      });
      if (!row) throw new HttpError(404, 'Replacement scientific object not found.');
      nextSource = {
        id: row.object_id, projectId: row.project_id, objectKey: row.object_key, objectType: row.object_type, snapshotId: row.snapshot_id,
        path: row.path, anchor: json(row.anchor_json, null), label: row.label, valueText: row.value_text,
        contentHash: row.content_hash, metadata: json(row.metadata_json, {}),
      };
    }
    const removed = input.action === 'REMOVE';
    // A revision may carry the document text the claim now reads, when the
    // caller rewrote it in the same action. The anchor is recomputed from the
    // current document rather than trusted from the caller.
    let nextSpanText = currentDependency.spanText;
    let nextAnchor = currentDependency.anchor;
    if (typeof input.spanText === 'string' && input.spanText && input.spanText !== currentDependency.spanText) {
      const file = this.timeline.snapshotFile(project.currentSnapshotId, currentDependency.documentPath);
      if (!file) throw new HttpError(409, 'The document holding this claim is no longer present.');
      const blocks = this.editableDocumentModel(project.id, file, project.currentSnapshotId).blocks;
      const blockIndex = blocks.findIndex((block, index) => (index === currentDependency.anchor.blockIndex
        && block.text.includes(input.spanText)));
      const resolvedIndex = blockIndex >= 0 ? blockIndex : blocks.findIndex((block) => block.text.includes(input.spanText));
      if (resolvedIndex < 0) throw new HttpError(409, 'The revised claim text is not present in the document.');
      const block = blocks[resolvedIndex];
      const start = block.text.indexOf(input.spanText);
      nextSpanText = input.spanText;
      nextAnchor = anchorForSpan(resolvedIndex, block.type, block.text, start, start + input.spanText.length);
    }
    const nextStatus = removed ? currentDependency.status
      : input.action === 'KEEP_HISTORICAL' ? 'LINKED'
      : STATUS_TYPES.has(input.status) ? input.status : 'LINKED';
    const changeType = removed ? 'DEPENDENCY_REMOVED'
      : input.action === 'KEEP_HISTORICAL' ? 'DEPENDENCY_REVIEWED' : 'DEPENDENCY_CHANGED';
    const result = this.cloneTransition(project.id, actorInput, {
      source: changeType, title: removed ? `Removed dependency from “${currentDependency.spanText.slice(0, 64)}”`
        : `Updated dependency for “${currentDependency.spanText.slice(0, 64)}”`,
    }, ({ resultingSnapshotId, eventId, timestamp, actor }) => {
      const versionId = id();
      const statusDetails = input.action === 'KEEP_HISTORICAL' ? { pinnedHistoricalVersion: true } : {};
      this.db.prepare(`
        INSERT INTO claim_dependency_versions(
          id, dependency_id, snapshot_id, document_snapshot_id, document_path, document_anchor_json, span_text,
          source_object_id, source_snapshot_id, source_value_text, selection_method, confidence, status,
          status_details_json, created_by_actor_id, created_at, is_removed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        versionId, dependencyId, resultingSnapshotId, resultingSnapshotId, currentDependency.documentPath,
        JSON.stringify(nextAnchor), nextSpanText, nextSource.id, nextSource.snapshotId,
        nextSource.valueText, input.sourceObjectId ? 'MANUAL' : currentDependency.selectionMethod,
        input.confidence ?? currentDependency.confidence, nextStatus, JSON.stringify(statusDetails), actor.id, timestamp, removed ? 1 : 0,
      );
      this.db.prepare(`
        INSERT INTO dependency_changes(id, event_id, dependency_id, before_version_id, after_version_id, change_type, details_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id(), eventId, dependencyId, currentDependency.versionId, versionId, changeType, JSON.stringify({ previousSource: currentDependency.source.label, source: nextSource.label }));
      // A removed claim no longer appears in the share tools, so its links
      // must close with it rather than stay public with no way to revoke them.
      if (removed) {
        this.db.prepare('UPDATE dependency_share_grants SET revoked_at = ? WHERE dependency_id = ? AND revoked_at IS NULL')
          .run(timestamp, dependencyId);
      }
      if (!removed) {
        this.db.prepare(`
          INSERT INTO provenance_links(id, project_id, from_snapshot_id, from_path, from_anchor_json, relation,
            to_snapshot_id, to_path, to_anchor_json, metadata_json, created_by_event_id, created_at)
          VALUES (?, ?, ?, ?, ?, 'DEPENDS_ON', ?, ?, ?, ?, ?, ?)
        `).run(id(), project.id, resultingSnapshotId, currentDependency.documentPath, JSON.stringify(nextAnchor),
          nextSource.snapshotId, nextSource.path, nextSource.anchor ? JSON.stringify(nextSource.anchor) : null,
          JSON.stringify({ dependencyId, objectId: nextSource.id, objectType: nextSource.objectType, label: nextSource.label, value: nextSource.valueText }), eventId, timestamp);
      }
    });
    return { dependency: removed ? null : this.getDependency(dependencyId), ...result };
  },

  /**
   * Locates each block of a document inside its own content, so an edit can be
   * spliced at an exact offset. Blocks are contiguous and in order, so a
   * forward scan is exact even when two paragraphs read identically.
   */
  locatedBlocks(content, blocks) {
    let cursor = 0;
    return blocks.map((block) => {
      const start = content.indexOf(block.text, cursor);
      if (start < 0) return { ...block, start: -1, end: -1 };
      cursor = start + block.text.length;
      return { ...block, start, end: start + block.text.length };
    });
  },

  /**
   * The exact document edits that would bring every reference to one source
   * back in line with it. Returns a plan; nothing is written.
   *
   * A reference whose text does not literally contain the value it was linked
   * to is reported as needing a person, never rewritten on a guess.
   */
  planSourceValueUpdate(projectId, objectId, options = {}) {
    const project = this.timeline.getProject(projectId);
    const source = this.sourceVersion(objectId);
    const current = source ? mapObjectRow(source) : null;
    if (!current) throw new HttpError(404, 'That source is no longer present in the current version.');
    const wanted = options.dependencyIds ? new Set(options.dependencyIds) : null;
    const dependencies = this.currentDependencies(projectId)
      .filter((dependency) => dependency.source.id === objectId)
      .filter((dependency) => !wanted || wanted.has(dependency.id));
    if (current.projectId !== projectId && !dependencies.length) {
      throw new HttpError(404, 'That source is not referenced in this work directory.');
    }

    const documents = new Map();
    const edits = [];
    for (const dependency of dependencies) {
      const linkedValue = dependency.source.valueText ?? null;
      const base = {
        dependencyId: dependency.id,
        documentPath: dependency.documentPath,
        blockIndex: dependency.anchor?.blockIndex ?? null,
        spanText: dependency.spanText,
        linkedValue,
        currentValue: current.valueText ?? null,
        status: dependency.status,
      };
      if (linkedValue != null && current.valueText != null && linkedValue === current.valueText
        && dependency.status === 'LINKED') {
        edits.push({ ...base, action: 'ALREADY_CURRENT' });
        continue;
      }
      if (!documents.has(dependency.documentPath)) {
        const file = this.timeline.snapshotFile(project.currentSnapshotId, dependency.documentPath);
        if (!file) {
          edits.push({ ...base, action: 'MANUAL', reason: 'The document is no longer present.' });
          continue;
        }
        const model = this.editableDocumentModel(projectId, file, project.currentSnapshotId);
        documents.set(dependency.documentPath, {
          file,
          content: model.content,
          blocks: this.locatedBlocks(model.content, model.blocks),
        });
      }
      const document_ = documents.get(dependency.documentPath);
      const block = document_.blocks[dependency.anchor?.blockIndex];
      if (!block || block.start < 0) {
        edits.push({ ...base, action: 'MANUAL', reason: 'The anchored paragraph no longer resolves.' });
        continue;
      }
      const span = block.text.slice(dependency.anchor.start, dependency.anchor.end);
      if (span !== dependency.spanText) {
        edits.push({ ...base, action: 'MANUAL', reason: 'The claim text has moved since it was linked.' });
        continue;
      }
      if (linkedValue == null || current.valueText == null || !span.includes(linkedValue)) {
        edits.push({
          ...base,
          action: 'RELINK',
          reason: linkedValue == null || current.valueText == null
            ? 'This source has no recorded value to substitute.'
            : `The claim does not repeat the linked value ${linkedValue}.`,
        });
        continue;
      }
      const replaced = span.replace(linkedValue, current.valueText);
      edits.push({
        ...base,
        action: 'REWRITE',
        nextSpanText: replaced,
        offset: block.start + dependency.anchor.start,
        length: span.length,
      });
    }

    return {
      object: {
        id: current.id,
        projectId: current.projectId,
        snapshotId: current.snapshotId,
        objectKey: current.objectKey,
        path: current.path,
        label: current.label,
        value: current.valueText ?? null,
      },
      documents: [...documents.keys()],
      edits,
      rewrites: edits.filter((edit) => edit.action === 'REWRITE').length,
      relinks: edits.filter((edit) => edit.action === 'RELINK').length,
      manual: edits.filter((edit) => edit.action === 'MANUAL').length,
      alreadyCurrent: edits.filter((edit) => edit.action === 'ALREADY_CURRENT').length,
    };
  },

  validateSourceValueUpdate(projectId, plan, actorInput) {
    const actor = this.timeline.validateActor(actorInput);
    const changes = plan.edits.filter((edit) => ['REWRITE', 'RELINK'].includes(edit.action));
    if (!changes.length) return actor;
    // Watcher capture is debounced. Check all reviewed files before the first
    // write, since saving one document also captures the rest of its directory.
    const project = this.timeline.getProject(projectId);
    const sourceProject = this.timeline.getProject(plan.object.projectId);
    const sourceFile = this.timeline.snapshotFile(plan.object.snapshotId, plan.object.path);
    this.timeline.assertWorkingFileUnchanged(sourceProject, plan.object.path, sourceFile.contentHash);
    for (const documentPath of new Set(changes.map((edit) => edit.documentPath))) {
      const file = this.timeline.snapshotFile(project.currentSnapshotId, documentPath);
      this.timeline.assertWorkingFileUnchanged(project, documentPath, file.contentHash);
    }
    return actor;
  },

  /**
   * Applies a plan: rewrites the documents, then re-points each dependency at
   * the current source version. Documents are only ever written from an
   * explicit call to this method.
   */
  applySourceValueUpdate(projectId, objectId, actorInput, options = {}) {
    const plan = this.planSourceValueUpdate(projectId, objectId, options);
    const actor = this.validateSourceValueUpdate(projectId, plan, actorInput);
    const rewrites = plan.edits.filter((edit) => edit.action === 'REWRITE');
    const relinks = plan.edits.filter((edit) => edit.action === 'RELINK');
    if (!rewrites.length && !relinks.length) return { ...plan, applied: [], captures: [] };

    const byDocument = new Map();
    for (const edit of rewrites) {
      const list = byDocument.get(edit.documentPath) ?? [];
      list.push(edit);
      byDocument.set(edit.documentPath, list);
    }

    const captures = [];
    for (const [documentPath, documentEdits] of byDocument) {
      const project = this.timeline.getProject(projectId);
      const file = this.timeline.snapshotFile(project.currentSnapshotId, documentPath);
      const model = this.editableDocumentModel(projectId, file, project.currentSnapshotId);
      let content = model.content;
      for (const edit of [...documentEdits].sort((left, right) => right.offset - left.offset)) {
        content = content.slice(0, edit.offset) + edit.nextSpanText + content.slice(edit.offset + edit.length);
      }
      captures.push(this.saveDocument(projectId, {
        path: documentPath,
        content,
        baseSnapshotId: project.currentSnapshotId,
      }, actor));
    }

    const applied = [];
    for (const edit of [...rewrites, ...relinks]) {
      const revision = this.revise(edit.dependencyId, actor, {
        sourceObjectId: objectId,
        sourceSnapshotId: plan.object.snapshotId,
        status: 'LINKED',
        ...(edit.action === 'REWRITE' ? { spanText: edit.nextSpanText } : {}),
      });
      applied.push({
        dependencyId: edit.dependencyId,
        documentPath: edit.documentPath,
        action: edit.action,
        previousSpanText: edit.spanText,
        spanText: edit.action === 'REWRITE' ? edit.nextSpanText : edit.spanText,
        version: revision.resultingVersion ?? null,
      });
    }
    return { ...plan, applied, captures };
  },

  /**
   * Retires references. Removal is a recorded revision, not a deletion: the
   * dependency's history stays intact and the claim simply stops being linked.
   */
  removeReferences(projectId, { objectId = null, dependencyIds = null, unresolvedOnly = false }, actorInput) {
    const actor = normalizeActor(actorInput);
    const wanted = dependencyIds ? new Set(dependencyIds) : null;
    const targets = this.currentDependencies(projectId)
      .filter((dependency) => !objectId || dependency.source.id === objectId)
      .filter((dependency) => !wanted || wanted.has(dependency.id))
      .filter((dependency) => !unresolvedOnly || Boolean(dependency.statusDetails?.anchorIssue));
    const removed = [];
    for (const dependency of targets) {
      this.revise(dependency.id, actor, { action: 'REMOVE' });
      removed.push({
        dependencyId: dependency.id,
        documentPath: dependency.documentPath,
        spanText: dependency.spanText,
        status: dependency.status,
        reason: dependency.statusDetails?.anchorIssue ?? null,
      });
    }
    return { removed };
  },

  keepCurrentValue(projectId, objectId, actorInput, options = {}) {
    const actor = normalizeActor(actorInput);
    const wanted = options.dependencyIds ? new Set(options.dependencyIds) : null;
    const dependencies = this.currentDependencies(projectId)
      .filter((dependency) => dependency.source.id === objectId)
      .filter((dependency) => !wanted || wanted.has(dependency.id))
      .filter((dependency) => dependency.status !== 'LINKED');
    const kept = [];
    for (const dependency of dependencies) {
      this.revise(dependency.id, actor, { action: 'KEEP_HISTORICAL' });
      kept.push({ dependencyId: dependency.id, documentPath: dependency.documentPath, spanText: dependency.spanText });
    }
    return { kept };
  },
};
