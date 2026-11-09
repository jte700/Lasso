// Keeping links true as files change: finding a moved span again, migrating
// anchors, reconciling a project after a capture, and auditing.

import { diffInternals } from '../history/diff.js';
import { id, sha } from './basics.js';
import { detectClaimSpans } from './claim-detection.js';
import { anchorForSpan } from './object-descriptors.js';

/**
 * How much of a recorded neighbour survived, 0..1.
 *
 * The prefix is compared from its end and the suffix from its start, since
 * those are the characters nearest the claim and the last to be disturbed by
 * an edit elsewhere in the paragraph.
 */
export function contextOverlap(recorded, actual, side) {
  const expected = String(recorded ?? '');
  if (!expected) return 1;               // nothing recorded to contradict
  const found = String(actual ?? '');
  let shared = 0;
  const limit = Math.min(expected.length, found.length);
  while (shared < limit) {
    const left = side === 'prefix' ? expected[expected.length - 1 - shared] : expected[shared];
    const right = side === 'prefix' ? found[found.length - 1 - shared] : found[shared];
    if (left !== right) break;
    shared += 1;
  }
  return shared / expected.length;
}

export const reconciliationMethods = {
  /**
   * Where a claim now sits in a document, or nothing.
   *
   * The span text alone is not enough to identify a claim: a document that
   * once said "the supplies cost 400" and now says "i looked at supplies"
   * contains the word but not the claim. Every candidate occurrence is
   * corroborated against the text recorded either side of it, so an edited
   * paragraph still resolves while a deleted one does not quietly reattach to
   * whatever the user types next.
   */
  relocateSpan(dependency, blocks) {
    const anchor = dependency.anchor ?? {};
    const { spanText } = dependency;
    if (!spanText) return null;
    const fingerprint = (text) => sha(String(text).trim().replace(/\s+/g, ' '));

    const candidates = [];
    for (const [index, block] of blocks.entries()) {
      let from = 0;
      for (;;) {
        const start = block.text.indexOf(spanText, from);
        if (start < 0) break;
        from = start + Math.max(1, spanText.length);
        const end = start + spanText.length;
        const before = block.text.slice(Math.max(0, start - 32), start);
        const after = block.text.slice(end, end + 32);
        const prefix = contextOverlap(anchor.prefix, before, 'prefix');
        const suffix = contextOverlap(anchor.suffix, after, 'suffix');
        candidates.push({
          index,
          block,
          start,
          end,
          context: (prefix + suffix) / 2,
          // The paragraph being untouched is the strongest corroboration there
          // is, and it covers a claim that fills its block entirely.
          sameBlock: anchor.blockFingerprint === fingerprint(block.text),
          samePosition: index === anchor.blockIndex && start === anchor.start,
        });
      }
    }
    if (!candidates.length) return null;

    candidates.sort((left, right) => Number(right.sameBlock) - Number(left.sameBlock)
      || right.context - left.context
      || Number(right.samePosition) - Number(left.samePosition)
      || Math.abs(left.index - (anchor.blockIndex ?? 0)) - Math.abs(right.index - (anchor.blockIndex ?? 0)));

    const best = candidates[0];
    // Half the recorded neighbourhood, averaged across both sides, is enough
    // to call it the same claim in an edited paragraph. Less than that and the
    // text around it is somebody else's sentence.
    if (!best.sameBlock && best.context < 0.5) return null;
    // Two equally corroborated occurrences are not one claim.
    const rivals = candidates.filter((candidate) => candidate !== best
      && candidate.sameBlock === best.sameBlock && candidate.context === best.context);
    if (rivals.length && !best.samePosition) return null;
    return best;
  },

  migrateAnchor(dependency, snapshotId) {
    const file = this.timeline.snapshotFileRow(snapshotId,
      this.db.prepare('SELECT document_project_file_id FROM claim_dependencies WHERE id = ?').get(dependency.id).document_project_file_id);
    if (!file) return { status: 'NEEDS_REVIEW', anchor: dependency.anchor, reason: 'Document no longer exists.' };
    // Already evaluated against this document version: nothing new can be
    // learned, so whatever was recorded then still stands. Returning no reason
    // here would erase it on the next pass.
    if (dependency.documentSnapshotId === snapshotId) {
      return {
        status: dependency.status,
        anchor: dependency.anchor,
        reason: dependency.statusDetails?.anchorIssue ?? null,
      };
    }
    const projectId = this.db.prepare('SELECT project_id FROM claim_dependencies WHERE id = ?').get(dependency.id).project_id;
    const blocks = this.editableDocumentModel(projectId, {
      ...file,
      projectFileId: file.project_file_id,
      contentHash: file.content_hash,
      fileType: file.file_type,
    }, snapshotId).blocks;

    const located = this.relocateSpan(dependency, blocks);
    if (!located) {
      return {
        status: 'NEEDS_REVIEW',
        anchor: dependency.anchor,
        reason: blocks.some((block) => block.text.includes(dependency.spanText))
          ? 'The claim text appears in the document, but not in the wording it was linked to.'
          : 'The claim is no longer in the document.',
      };
    }
    return {
      status: dependency.status,
      anchor: anchorForSpan(located.index, located.block.type, located.block.text, located.start, located.end),
    };
  },

  reconcileAfterCapture(capture) {
    if (!capture?.changed || !capture.projectId) return;
    const destinations = this.db.prepare(`
      SELECT DISTINCT d.project_id FROM claim_dependencies d
      LEFT JOIN claim_dependency_versions v ON v.dependency_id = d.id
      LEFT JOIN scientific_objects o ON o.id = v.source_object_id
      WHERE d.project_id = ? OR o.project_id = ?
    `).all(capture.projectId, capture.projectId);
    for (const destination of destinations) {
      if (this.reconcilingProjects.has(destination.project_id)) continue;
      this.reconcilingProjects.add(destination.project_id);
      try {
        this.reconcileProject(destination.project_id,
          destination.project_id === capture.projectId ? capture.snapshot.id : null);
      } finally {
        this.reconcilingProjects.delete(destination.project_id);
      }
    }
  },

  reconcileProject(projectId, sourceSnapshotId = null, options = {}) {
    const project = this.timeline.getProject(projectId);
    const targetSnapshotId = sourceSnapshotId ?? project.currentSnapshotId;
    const dependencies = this.currentDependencies(projectId, { snapshotId: targetSnapshotId });
    if (!dependencies.length) return { changed: false };
    this.ensureIndex(projectId, targetSnapshotId);
    const changes = [];
    for (const dependency of dependencies) {
      const migration = this.migrateAnchor(dependency, targetSnapshotId);
      let status = migration.status;
      let details = migration.reason ? { anchorIssue: migration.reason } : {};
      const ownerId = this.sourceProjectId(dependency.source);
      const currentSource = this.sourceVersion(dependency.source.id,
        ownerId === projectId ? targetSnapshotId : null);
      if (!currentSource) {
        // A re-index passes its own verdict here: the source object is absent
        // from the new reading, not gone from the record.
        status = options.missingSource?.status ?? 'BROKEN';
        details = {
          ...details,
          sourceIssue: options.missingSource?.reason ?? 'The linked scientific object no longer resolves.',
        };
      } else if (!dependency.statusDetails.pinnedHistoricalVersion
        && (currentSource.content_hash !== dependency.source.contentHash || currentSource.value_text !== dependency.source.valueText)) {
        // A claim whose location is unknown stays under review: there is
        // nowhere to apply a new value, so reporting it as merely stale would
        // offer an update that cannot be made.
        if (!migration.reason) status = 'STALE';
        details = {
          ...details,
          linkedSourceValue: dependency.source.valueText,
          currentSourceValue: currentSource.value_text,
          currentSourceContentHash: currentSource.content_hash,
        };
      }
      // A claim the document no longer holds is retired rather than left as a
      // permanent warning: the user deleted the text, so the link to it is
      // gone. The version chain keeps the record, so nothing is lost.
      const retired = Boolean(migration.reason) && migration.reason !== 'Document no longer exists.';
      if (retired) details = { ...details, retiredReason: migration.reason };
      const anchorChanged = JSON.stringify(migration.anchor) !== JSON.stringify(dependency.anchor);
      const detailsChanged = JSON.stringify(details) !== JSON.stringify(dependency.statusDetails);
      if (retired || status !== dependency.status || anchorChanged
        || (['STALE', 'BROKEN', 'NEEDS_REVIEW'].includes(status) && detailsChanged)) {
        changes.push({ dependency, status, details, anchor: migration.anchor, retired });
      }
    }
    if (!changes.length) return { changed: false };
    const system = { id: 'system:lasso', displayName: 'Lasso', actorType: 'SYSTEM' };
    const source = changes.some((change) => change.status === 'STALE') ? 'DEPENDENCY_STALE'
      : changes.some((change) => change.status === 'NEEDS_REVIEW') ? 'DEPENDENCY_CHANGED' : 'DEPENDENCY_CHANGED';
    const title = changes.length === 1
      ? changes[0].retired ? `Dependency retired: “${changes[0].dependency.spanText.slice(0, 56)}”`
        : changes[0].status === 'STALE' ? `Dependency marked stale: “${changes[0].dependency.spanText.slice(0, 56)}”`
        : changes[0].status === 'BROKEN' ? `Dependency broken: “${changes[0].dependency.spanText.slice(0, 56)}”`
        : `Dependency needs review: “${changes[0].dependency.spanText.slice(0, 56)}”`
      : `${changes.length} manuscript dependencies updated`;
    const result = this.cloneTransition(projectId, system, { source, title }, ({ resultingSnapshotId, eventId, timestamp, actor }) => {
      for (const change of changes) {
        const versionId = id();
        this.db.prepare(`
          INSERT INTO claim_dependency_versions(
            id, dependency_id, snapshot_id, document_snapshot_id, document_path, document_anchor_json, span_text,
            source_object_id, source_snapshot_id, source_value_text, selection_method, confidence, status,
            status_details_json, created_by_actor_id, created_at, is_removed
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          versionId, change.dependency.id, resultingSnapshotId, resultingSnapshotId, change.dependency.documentPath,
          JSON.stringify(change.anchor), change.dependency.spanText, change.dependency.source.id,
          change.dependency.source.snapshotId, change.dependency.source.valueText, change.dependency.selectionMethod,
          change.dependency.confidence, change.status, JSON.stringify(change.details), actor.id, timestamp,
          change.retired ? 1 : 0,
        );
        const changeType = change.retired ? 'DEPENDENCY_REMOVED'
          : change.status === 'STALE' ? 'DEPENDENCY_STALE' : 'DEPENDENCY_CHANGED';
        this.db.prepare(`
          INSERT INTO dependency_changes(id, event_id, dependency_id, before_version_id, after_version_id, change_type, details_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id(), eventId, change.dependency.id, change.dependency.versionId, versionId, changeType, JSON.stringify(change.details));
        if (change.retired) continue;
        this.db.prepare(`
          INSERT INTO provenance_links(id, project_id, from_snapshot_id, from_path, from_anchor_json, relation,
            to_snapshot_id, to_path, to_anchor_json, metadata_json, created_by_event_id, created_at)
          VALUES (?, ?, ?, ?, ?, 'DEPENDS_ON', ?, ?, ?, ?, ?, ?)
        `).run(
          id(), projectId, resultingSnapshotId, change.dependency.documentPath, JSON.stringify(change.anchor),
          change.dependency.source.snapshotId, change.dependency.source.path,
          change.dependency.source.anchor ? JSON.stringify(change.dependency.source.anchor) : null,
          JSON.stringify({
            dependencyId: change.dependency.id,
            objectId: change.dependency.source.id,
            objectType: change.dependency.source.objectType,
            label: change.dependency.source.label,
            value: change.dependency.source.valueText,
          }),
          eventId, timestamp,
        );
      }
    });
    return { changed: true, ...result };
  },

  audit(projectId, options = {}) {
    if (options.reconcile !== false) this.reconcileProject(projectId);
    const dependencies = this.currentDependencies(projectId, { projectFileId: options.projectFileId });
    const byStatus = Object.fromEntries(['LINKED', 'STALE', 'NEEDS_REVIEW', 'BROKEN'].map((status) => [status, dependencies.filter((item) => item.status === status).length]));
    const detectedClaims = [];
    if (options.projectFileId) {
      const project = this.timeline.getProject(projectId);
      const file = this.timeline.snapshotFileRow(project.currentSnapshotId, options.projectFileId);
      if (file) {
        const blocks = this.editableDocumentModel(projectId, {
          ...file,
          projectFileId: file.project_file_id,
          contentHash: file.content_hash,
          fileType: file.file_type,
        }, project.currentSnapshotId).blocks;
        blocks.forEach((block, blockIndex) => {
          for (const claim of detectClaimSpans(block.text)) {
            const linked = dependencies.some((dependency) => dependency.anchor.blockIndex === blockIndex
              && dependency.anchor.start < claim.end && dependency.anchor.end > claim.start);
            detectedClaims.push({ ...claim, blockIndex, linked });
          }
        });
      }
    }
    return {
      summary: {
        detected: detectedClaims.length || dependencies.length,
        linked: byStatus.LINKED,
        stale: byStatus.STALE,
        needsReview: byStatus.NEEDS_REVIEW,
        broken: byStatus.BROKEN,
        unlinked: detectedClaims.filter((claim) => !claim.linked).length,
      },
      dependencies,
      detectedClaims,
    };
  },

  predictAgentDependencies(projectId, input) {
    if (!/\.(md|mdx|qmd|rmd)$/i.test(input.path ?? '')) return [];
    const proposals = [];
    for (const [blockIndex, block] of diffInternals.markdownBlocks(String(input.content ?? '')).entries()) {
      for (const claim of detectClaimSpans(block.text)) {
        const candidates = this.candidatesForClaim(projectId, claim, { context: block.text, limit: 3 });
        proposals.push({ blockIndex, blockType: block.type, claim, candidates, verified: candidates.length > 0 });
      }
    }
    return proposals;
  },

  acceptAgentDependencies(execution, capture) {
    const proposals = execution.proposal.dependencyProposals ?? [];
    const accepted = [];
    for (const proposal of proposals.filter((item) => item.candidates?.length)) {
      const project = this.timeline.getProject(execution.projectId);
      const document = this.timeline.snapshotFile(project.currentSnapshotId, execution.proposal.path);
      if (!document) continue;
      const text = this.timeline.blobs.get(document.contentHash).toString('utf8');
      const block = diffInternals.markdownBlocks(text)[proposal.blockIndex];
      if (!block) continue;
      const anchor = anchorForSpan(proposal.blockIndex, block.type, block.text, proposal.claim.start, proposal.claim.end);
      accepted.push(this.link(execution.projectId, {
        documentPath: execution.proposal.path,
        anchor,
        spanText: proposal.claim.text,
        sourceObjectId: proposal.candidates[0].id,
        sourceSnapshotId: proposal.candidates[0].snapshotId,
        selectionMethod: 'SYSTEM_LINKED',
        confidence: proposal.candidates[0].score,
        initiatedBy: execution.initiatedBy,
        expectedSnapshotId: project.currentSnapshotId,
      }, execution.agent));
    }
    return accepted;
  },
};
