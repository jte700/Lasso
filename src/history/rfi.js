import { json } from '../db.js';
import { HttpError } from './errors.js';
import { resolveAnchor } from './preview.js';

const UNKNOWN_MESSAGE = 'Lasso cannot determine the origin of this information from the recorded project history.';

function anchorsCompatible(requestAnchor, storedAnchor) {
  if (!storedAnchor) return true;
  if (!requestAnchor || requestAnchor.kind !== storedAnchor.kind) return false;
  const identifyingKeys = ['blockIndex', 'line', 'rowKey', 'column', 'path', 'cellId', 'pageNumber'];
  return identifyingKeys.every((key) => storedAnchor[key] == null || storedAnchor[key] === requestAnchor[key]);
}

export class RfiService {
  constructor(timelineService) {
    this.timeline = timelineService;
    this.db = timelineService.db;
  }

  request(projectId, input) {
    const project = this.timeline.getProject(projectId);
    const snapshotId = input.snapshotId ?? project.currentSnapshotId;
    const selectedSnapshot = this.timeline.getSnapshot(snapshotId);
    if (selectedSnapshot.projectId !== projectId) throw new HttpError(400, 'Snapshot does not belong to this project.');
    const selectedFile = this.timeline.snapshotFile(snapshotId, input.path);
    if (!selectedFile) throw new HttpError(404, 'The selected file is not present in that version.');
    const anchor = input.anchor;
    const selectedValue = resolveAnchor(selectedFile, this.timeline.blobs.get(selectedFile.contentHash), anchor, true);
    if (selectedValue == null || selectedValue === '') throw new HttpError(400, 'The selection could not be resolved in the requested file version.');

    const chain = this.snapshotChain(selectedSnapshot);
    const observations = chain.map((snapshot) => {
      const file = this.db.prepare('SELECT * FROM snapshot_files WHERE snapshot_id = ? AND project_file_id = ?')
        .get(snapshot.id, selectedFile.projectFileId);
      if (!file) return { snapshot, file: null, value: null, event: this.eventForSnapshot(snapshot.id) };
      const normalized = {
        snapshotId: file.snapshot_id,
        projectFileId: file.project_file_id,
        path: file.path,
        contentHash: file.content_hash,
        fileType: file.file_type,
      };
      return {
        snapshot,
        file: normalized,
        value: resolveAnchor(normalized, this.timeline.blobs.get(file.content_hash), anchor, snapshot.id === snapshotId),
        event: this.eventForSnapshot(snapshot.id),
      };
    });

    let previousValue = Symbol('initial');
    const history = [];
    for (const observation of observations) {
      if (observation.value == null || observation.value === previousValue) continue;
      history.push({
        snapshotId: observation.snapshot.id,
        version: observation.snapshot.version,
        path: observation.file?.path ?? null,
        value: observation.value,
        actor: observation.event?.actor ?? null,
        initiatedBy: observation.event?.initiatedBy ?? null,
        occurredAt: observation.event?.occurredAt ?? observation.snapshot.createdAt,
      });
      previousValue = observation.value;
    }

    let originObservation = null;
    for (let index = 0; index < observations.length; index += 1) {
      if (observations[index].value !== selectedValue) continue;
      if (index === 0 || observations[index - 1].value !== selectedValue) originObservation = observations[index];
    }
    originObservation ??= observations.find((observation) => observation.value === selectedValue) ?? null;

    const selectionAnchor = anchor.kind === 'markdown-block'
      ? { ...anchor, kind: 'manuscript-span', start: anchor.selection?.start ?? 0, end: anchor.selection?.end ?? selectedValue.length }
      : anchor;
    const linkedDependency = this.dependencies?.findForSelection(projectId, {
      projectFileId: selectedFile.projectFileId,
      snapshotId,
      anchor: selectionAnchor,
    }) ?? null;
    const links = linkedDependency
      ? this.traverseProvenance(projectId, linkedDependency.snapshotId, linkedDependency.documentPath, linkedDependency.anchor)
      : originObservation
      ? this.traverseProvenance(projectId, originObservation.snapshot.id, originObservation.file.path, anchor)
      : [];
    const originEvent = originObservation?.event ?? null;
    return {
      question: 'Where did this come from?',
      selection: {
        snapshotId,
        version: selectedSnapshot.version,
        path: selectedFile.path,
        anchor,
        value: selectedValue,
      },
      firstRecorded: originObservation ? {
        snapshotId: originObservation.snapshot.id,
        version: originObservation.snapshot.version,
        path: originObservation.file.path,
        actor: originEvent?.actor ?? null,
        initiatedBy: originEvent?.initiatedBy ?? null,
        occurredAt: originEvent?.occurredAt ?? originObservation.snapshot.createdAt,
      } : null,
      provenanceEstablished: links.length > 0,
      provenance: links,
      dependencyStatus: linkedDependency?.status ?? 'UNLINKED',
      dependencyMessage: linkedDependency ? null : 'No dependency linked',
      linkedDependency,
      history,
      message: links.length ? null : UNKNOWN_MESSAGE,
    };
  }

  snapshotChain(snapshot) {
    const chain = [];
    let cursor = snapshot;
    while (cursor) {
      chain.push(cursor);
      cursor = cursor.parentSnapshotId ? this.timeline.getSnapshot(cursor.parentSnapshotId) : null;
    }
    return chain.reverse();
  }

  eventForSnapshot(snapshotId) {
    const row = this.db.prepare(`
      SELECT e.*, a.display_name AS actor_name, a.actor_type,
        i.display_name AS initiator_name, i.actor_type AS initiator_type,
        ps.version AS previous_version, rs.version AS resulting_version,
        (SELECT COUNT(*) FROM file_changes fc WHERE fc.event_id = e.id) AS file_count
      FROM timeline_events e
      JOIN actors a ON a.id = e.actor_id
      LEFT JOIN actors i ON i.id = e.initiated_by_actor_id
      LEFT JOIN snapshots ps ON ps.id = e.previous_snapshot_id
      JOIN snapshots rs ON rs.id = e.resulting_snapshot_id
      WHERE e.resulting_snapshot_id = ?
    `).get(snapshotId);
    return row ? this.timeline.mapEventRow(row) : null;
  }

  traverseProvenance(projectId, snapshotId, filePath, anchor) {
    const queue = [{ snapshotId, path: filePath, anchor, depth: 0 }];
    const visited = new Set();
    const results = [];
    while (queue.length) {
      const node = queue.shift();
      const key = `${node.snapshotId}|${node.path}|${JSON.stringify(node.anchor ?? null)}`;
      if (visited.has(key) || node.depth > 8) continue;
      visited.add(key);
      // A recorded dependency may cross work-directory boundaries. Follow
      // subsequent provenance in the immutable snapshot's owning project.
      const owner = this.db.prepare('SELECT project_id FROM snapshots WHERE id = ?').get(node.snapshotId);
      const ownerId = owner?.project_id ?? projectId;
      const rows = this.db.prepare(`
        SELECT p.*, s.version AS to_version
        FROM provenance_links p LEFT JOIN snapshots s ON s.id = p.to_snapshot_id
        WHERE p.project_id = ? AND p.from_snapshot_id = ? AND p.from_path = ?
        ORDER BY p.created_at
      `).all(ownerId, node.snapshotId, node.path);
      for (const row of rows) {
        const fromAnchor = json(row.from_anchor_json, null);
        if (!anchorsCompatible(node.anchor, fromAnchor)) continue;
        const result = {
          id: row.id,
          depth: node.depth,
          relation: row.relation,
          from: { snapshotId: row.from_snapshot_id, path: row.from_path, anchor: fromAnchor },
          to: {
            snapshotId: row.to_snapshot_id,
            version: row.to_version,
            path: row.to_path,
            anchor: json(row.to_anchor_json, null),
          },
          metadata: json(row.metadata_json, {}),
          createdAt: row.created_at,
        };
        results.push(result);
        if (row.to_snapshot_id && row.to_path) {
          queue.push({
            snapshotId: row.to_snapshot_id,
            path: row.to_path,
            anchor: result.to.anchor,
            depth: node.depth + 1,
          });
        }
      }
    }
    return results;
  }
}

export { UNKNOWN_MESSAGE };
